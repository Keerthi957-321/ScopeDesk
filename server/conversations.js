'use strict';
/**
 * Client <-> vendor messaging and voice calls, one conversation per ticket.
 *
 * Who may talk: ONLY the ticket's client and the one vendor account it was sent to (tasks.assigned_vendor_user_id).
 *   - read the conversation : always (both parties)
 *   - text and call         : only during the ticket's time window (status waiting / live)
 *   - "Always-On Access" (VIP): a vendor the client approved (client_vendor_contacts) may text and call that client at any time,
 *                             on any of their conversations, also after the ticket ended. Only the client grants or removes it.
 *   - a vendor the client blocked can neither message nor call (blocking always wins over approval)
 * Every REST call and every socket event is checked against the database; nothing the browser says about "who" is trusted.
 *
 * Calls are WebRTC audio, peer to peer. The server only relays the offer / answer / ICE candidates, and only between the two
 * sockets of that call. A call is ended by either side, by a disconnect, when the ticket is terminated (kill switch), or when
 * nobody answers within RING_MS.
 */
const crypto = require('crypto');

const RING_MS = 40000;
const MAX_BODY = 2000;
const MAX_SIGNAL = 20000;

function createConversations({ db, io, emitToUser, isVendorBlocked, parseDbDate, logAudit = () => {}, now = () => Date.now() }) {
  const calls = new Map();          // callId -> { id, taskId, callerId, calleeId, callerSocket, calleeSocket, state, startedAt, ring }

  const clean = (v) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[ \t]+\n/g, '\n').trim().slice(0, MAX_BODY);
  const toSocket = (id, ev, payload) => { if (id) io.to(id).emit(ev, payload); };

  /** Is this user one of the two parties of the ticket, and what may they do? null = not a party. */
  // Texting and calling are open only while the ticket's time window runs (waiting or live, and not past its end time),
  // unless the client approved this vendor for Always-On Access.
  function inWindow(t) {
    if (t.status !== 'pending' && t.status !== 'active') return false;
    if (!t.window_end) return true;
    const end = parseDbDate(t.window_end);
    return !(end instanceof Date) || Number.isNaN(end.getTime()) || end.getTime() > now();
  }
  const LOCKED_CLIENT = 'Locked: texting and calling are available only during an active task. Approve this vendor for Always-On Access to talk any time.';
  const LOCKED_VENDOR = 'Locked: texting and calling are available only during an active task. The client can approve you for Always-On Access.';

  async function access(user, taskId) {
    const id = Number(taskId);
    if (!Number.isInteger(id)) return null;
    const task = await db.get(`
      SELECT t.id, t.title, t.status, t.client_id, t.assigned_vendor_user_id, t.window_end,
             cu.username AS client_username, COALESCE(NULLIF(cu.organization, ''), cu.username) AS client_name,
             vu.username AS vendor_username, COALESCE(NULLIF(vu.organization, ''), 'Independent Vendor') || ' (' || vu.username || ')' AS vendor_name
      FROM tasks t LEFT JOIN users cu ON cu.id = t.client_id LEFT JOIN users vu ON vu.id = t.assigned_vendor_user_id
      WHERE t.id = ?`, [id]);
    if (!task || !task.assigned_vendor_user_id) return null;
    let role = null;
    if (user.role === 'client' && task.client_id === user.userId) role = 'client';
    else if (user.role === 'vendor' && task.assigned_vendor_user_id === user.userId) role = 'vendor';
    if (!role) return null;
    const blocked = await isVendorBlocked(task.client_id, task.assigned_vendor_user_id);
    const trusted = await isTrusted(task.client_id, task.assigned_vendor_user_id);
    const open = inWindow(task);
    const canSend = !blocked && (open || trusted);
    const canCall = canSend;
    const why = blocked ? 'The client has ended this vendor\'s access.'
      : canSend ? ''
      : role === 'client' ? LOCKED_CLIENT
      : LOCKED_VENDOR;
    return {
      task, role, canSend, canCall, why, trusted, open,
      meId: user.userId,
      otherId: role === 'client' ? task.assigned_vendor_user_id : task.client_id,
      vendorId: task.assigned_vendor_user_id,
      otherName: role === 'client' ? task.vendor_name : task.client_name,
      myName: role === 'client' ? task.client_name : task.vendor_name
    };
  }

  async function isTrusted(clientId, vendorId) {
    const r = await db.get('SELECT 1 AS ok FROM client_vendor_contacts WHERE client_id = ? AND vendor_user_id = ?', [clientId, vendorId]);
    return !!r;
  }
  /** The client approves (or stops approving) a vendor as an anytime contact. Both sides' open pages are told at once. */
  async function contact(clientId, vendorId) {
    const r = await db.get('SELECT auto_answer FROM client_vendor_contacts WHERE client_id = ? AND vendor_user_id = ?', [clientId, vendorId]);
    return { trusted: !!r, autoAnswer: !!(r && r.auto_answer) };
  }
  async function setTrusted(clientUser, vendorId, on, opts = {}) {
    const vid = Number(vendorId);
    const vendor = Number.isInteger(vid) ? await db.get("SELECT id FROM users WHERE id = ? AND role = 'vendor'", [vid]) : null;
    if (!vendor) return { status: 404, error: 'Vendor not found.' };
    // only a vendor this client actually works with (has sent a ticket to)
    const works = await db.get('SELECT 1 AS ok FROM tasks WHERE client_id = ? AND assigned_vendor_user_id = ? LIMIT 1', [clientUser.userId, vid]);
    if (!works) return { status: 404, error: 'You have no tickets with this vendor.' };
    if (on) {
      await db.run('INSERT OR IGNORE INTO client_vendor_contacts (client_id, vendor_user_id) VALUES (?, ?)', [clientUser.userId, vid]);
      if (typeof opts.autoAnswer === 'boolean') await db.run('UPDATE client_vendor_contacts SET auto_answer = ? WHERE client_id = ? AND vendor_user_id = ?', [opts.autoAnswer ? 1 : 0, clientUser.userId, vid]);
    }
    else await db.run('DELETE FROM client_vendor_contacts WHERE client_id = ? AND vendor_user_id = ?', [clientUser.userId, vid]);
    if (!on) for (const call of [...calls.values()]) {
      // contact taken back: a call on an ENDED ticket between them stops now (calls on a running ticket stay)
      if (call.clientId === clientUser.userId && call.vendorId === vid) {
        const t = await db.get('SELECT status FROM tasks WHERE id = ?', [call.taskId]);
        if (!t || !['pending', 'active'].includes(t.status)) finish(call, 'contact-removed', clientUser.userId);
      }
    }
    const payload = { vendorId: vid, clientId: clientUser.userId, trusted: !!on, autoAnswer: on ? (await contact(clientUser.userId, vid)).autoAnswer : false };
    emitToUser(clientUser.userId, 'contact-changed', payload);
    emitToUser(vid, 'contact-changed', payload);
    logAudit(clientUser.userId, on ? 'CONTACT_APPROVED' : 'CONTACT_REMOVED', { vendorId: vid });
    return { status: 200, trusted: !!on, autoAnswer: payload.autoAnswer };
  }

  const row = (m) => ({ id: m.id, taskId: m.task_id, senderId: m.sender_id, kind: m.kind, body: m.body, createdAt: m.created_at, readAt: m.read_at });

  async function record(taskId, senderId, kind, body) {
    const r = await db.run('INSERT INTO task_messages (task_id, sender_id, kind, body, created_at) VALUES (?, ?, ?, ?, ?)', [taskId, senderId, kind, body, new Date(now()).toISOString()]);
    return row(await db.get('SELECT * FROM task_messages WHERE id = ?', [r.lastInsertRowid]));
  }
  // A new message (or call record) reaches every tab of both parties
  function broadcast(a, message) {
    emitToUser(a.task.client_id, 'chat-message', { taskId: a.task.id, message });
    emitToUser(a.task.assigned_vendor_user_id, 'chat-message', { taskId: a.task.id, message });
  }

  /** Conversation list: one entry per ticket the user is a party of, newest activity first. */
  async function list(user) {
    const mine = user.role === 'client' ? 't.client_id = ?' : 't.assigned_vendor_user_id = ?';
    const rows = await db.all(`
      SELECT t.id, t.title, t.status, t.window_end, t.created_at, t.client_id, t.assigned_vendor_user_id,
             COALESCE(NULLIF(cu.organization, ''), cu.username) AS client_name,
             COALESCE(NULLIF(vu.organization, ''), 'Independent Vendor') || ' (' || vu.username || ')' AS vendor_name,
             (SELECT m.body FROM task_messages m WHERE m.task_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_body,
             (SELECT m.kind FROM task_messages m WHERE m.task_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_kind,
             (SELECT m.sender_id FROM task_messages m WHERE m.task_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_sender,
             (SELECT m.created_at FROM task_messages m WHERE m.task_id = t.id ORDER BY m.id DESC LIMIT 1) AS last_at,
             (SELECT COUNT(*) FROM task_messages m WHERE m.task_id = t.id AND m.sender_id <> ? AND m.read_at IS NULL) AS unread,
             EXISTS (SELECT 1 FROM client_vendor_contacts k WHERE k.client_id = t.client_id AND k.vendor_user_id = t.assigned_vendor_user_id) AS trusted,
             EXISTS (SELECT 1 FROM client_vendor_blocks b WHERE b.client_id = t.client_id AND b.vendor_user_id = t.assigned_vendor_user_id) AS blocked
      FROM tasks t LEFT JOIN users cu ON cu.id = t.client_id LEFT JOIN users vu ON vu.id = t.assigned_vendor_user_id
      WHERE ${mine} AND t.assigned_vendor_user_id IS NOT NULL
      ORDER BY COALESCE(last_at, t.created_at) DESC LIMIT 200`, [user.userId, user.userId]);
    return rows.map((r) => {
      const open = inWindow(r);
      const can = !r.blocked && (open || !!r.trusted);
      return {
        taskId: r.id, title: r.title, status: r.status,
        otherName: user.role === 'client' ? r.vendor_name : r.client_name,
        lastBody: r.last_body || '', lastKind: r.last_kind || null, lastMine: r.last_sender === user.userId, lastAt: r.last_at || null,
        createdAt: r.created_at, unread: Number(r.unread) || 0,
        vendorId: r.assigned_vendor_user_id, trusted: !!r.trusted, open,
        canSend: can, canCall: can, windowEnd: r.window_end || null
      };
    });
  }

  async function messages(user, taskId) {
    const a = await access(user, taskId);
    if (!a) return null;
    const rows = await db.all('SELECT * FROM (SELECT * FROM task_messages WHERE task_id = ? ORDER BY id DESC LIMIT 200) ORDER BY id ASC', [a.task.id]);
    return { access: a, messages: rows.map(row) };
  }

  async function send(user, taskId, body) {
    const a = await access(user, taskId);
    if (!a) return { status: 404, error: 'Conversation not found.' };
    if (!a.canSend) return { status: 403, error: a.why };
    const text = clean(body);
    if (!text) return { status: 400, error: 'Type a message first.' };
    const message = await record(a.task.id, user.userId, 'text', text);
    broadcast(a, message);
    return { status: 201, message };
  }

  async function markRead(user, taskId) {
    const a = await access(user, taskId);
    if (!a) return { status: 404, error: 'Conversation not found.' };
    const at = new Date(now()).toISOString();
    const r = await db.run('UPDATE task_messages SET read_at = ? WHERE task_id = ? AND sender_id <> ? AND read_at IS NULL', [at, a.task.id, user.userId]);
    if (r.changes) emitToUser(a.otherId, 'chat-read', { taskId: a.task.id, readAt: at });
    return { status: 200, updated: r.changes };
  }

  async function unreadTotal(user) {
    const mine = user.role === 'client' ? 't.client_id = ?' : 't.assigned_vendor_user_id = ?';
    const r = await db.get(`SELECT COUNT(*) AS n FROM task_messages m JOIN tasks t ON t.id = m.task_id WHERE ${mine} AND m.sender_id <> ? AND m.read_at IS NULL`, [user.userId, user.userId]);
    return Number(r && r.n) || 0;
  }

  // ---------- calls ----------
  const busy = (userId) => [...calls.values()].some((c) => c.callerId === userId || c.calleeId === userId);
  const fmt = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

  async function finish(call, reason, byUserId) {
    if (!calls.has(call.id)) return;
    calls.delete(call.id);
    clearTimeout(call.ring);
    const payload = { callId: call.id, taskId: call.taskId, reason };
    // the caller's one socket and every tab of the callee (a ringing call shows in all of them)
    toSocket(call.callerSocket, 'call-ended', payload);
    if (call.calleeSocket) toSocket(call.calleeSocket, 'call-ended', payload);
    else emitToUser(call.calleeId, 'call-ended', payload);
    let body;
    if (call.state === 'active') body = `Voice call · ${fmt(now() - call.startedAt)}`;
    else if (reason === 'declined') body = 'Call declined';
    else body = 'Missed voice call';
    try {
      const a = { task: { id: call.taskId, client_id: call.clientId, assigned_vendor_user_id: call.vendorId } };
      broadcast(a, await record(call.taskId, call.callerId, 'call', body));
    } catch (_) { /* the record is a nicety */ }
    logAudit(byUserId || null, 'CALL_ENDED', { taskId: call.taskId, reason, answered: call.state === 'active' });
  }

  function findCall(callId) { return calls.get(String(callId || '')) || null; }

  function registerBrowser(socket, user) {
    const reply = (ack, body) => { if (typeof ack === 'function') ack(body); };

    socket.on('call-invite', async (p, ack) => {
      try {
        const a = await access(user, p && p.taskId);
        if (!a) return reply(ack, { ok: false, error: 'Conversation not found.' });
        if (!a.canCall) return reply(ack, { ok: false, error: a.why });
        if (busy(user.userId)) return reply(ack, { ok: false, error: 'You are already in a call.' });
        if (busy(a.otherId)) return reply(ack, { ok: false, error: `${a.otherName} is on another call.` });
        const call = {
          id: crypto.randomBytes(9).toString('hex'), taskId: a.task.id, title: a.task.title,
          callerId: user.userId, calleeId: a.otherId, callerSocket: socket.id, calleeSocket: null,
          clientId: a.task.client_id, vendorId: a.task.assigned_vendor_user_id, state: 'ringing', startedAt: 0, video: !!(p && p.video)
        };
        // A vendor calling the client: a normal vendor's call is a REQUEST the client must approve. A vendor the client approved for
        // Always-On Access rings like a phone call, and is answered by itself only if the client switched on "Answer automatically"
        // for that vendor (audio only: the client's camera is never switched on by anyone but the client).
        const vendorCalling = a.role === 'vendor';
        const c = vendorCalling ? await contact(a.task.client_id, user.userId) : { trusted: false, autoAnswer: false };
        calls.set(call.id, call);
        call.ring = setTimeout(() => finish(call, 'missed'), RING_MS);
        if (call.ring.unref) call.ring.unref();
        const reached = emitToUser(a.otherId, 'call-incoming', {
          callId: call.id, taskId: call.taskId, title: a.task.title, fromName: a.myName, fromRole: a.role, video: call.video,
          fromId: user.userId, request: vendorCalling && !c.trusted, trusted: vendorCalling && c.trusted, autoAnswer: vendorCalling && c.trusted && c.autoAnswer
        });
        if (!reached) { await finish(call, 'offline', user.userId); return reply(ack, { ok: false, error: `${a.otherName} is not online right now. Your call was left as a missed call.` }); }
        logAudit(user.userId, 'CALL_STARTED', { taskId: call.taskId });
        reply(ack, { ok: true, callId: call.id, otherName: a.otherName });
      } catch (err) { reply(ack, { ok: false, error: 'Server error.' }); }
    });

    socket.on('call-accept', (p, ack) => {
      const call = findCall(p && p.callId);
      if (!call || call.calleeId !== user.userId || call.state !== 'ringing') return reply(ack, { ok: false, error: 'This call is no longer ringing.' });
      call.state = 'active'; call.calleeSocket = socket.id; call.startedAt = now();
      clearTimeout(call.ring);
      emitToUser(call.calleeId, 'call-taken', { callId: call.id, bySocket: socket.id });   // other tabs stop ringing
      toSocket(call.callerSocket, 'call-accepted', { callId: call.id });
      reply(ack, { ok: true });
    });

    socket.on('call-decline', (p, ack) => {
      const call = findCall(p && p.callId);
      if (!call || call.calleeId !== user.userId || call.state !== 'ringing') return reply(ack, { ok: false });
      finish(call, 'declined', user.userId);
      reply(ack, { ok: true });
    });

    socket.on('call-end', (p, ack) => {
      const call = findCall(p && p.callId);
      if (!call || (call.callerId !== user.userId && call.calleeId !== user.userId)) return reply(ack, { ok: false });
      finish(call, call.state === 'ringing' && call.callerId === user.userId ? 'cancelled' : 'hangup', user.userId);
      reply(ack, { ok: true });
    });

    // offer / answer / ICE candidates, only between the two sockets of an answered call
    socket.on('call-signal', (p) => {
      const call = findCall(p && p.callId);
      if (!call || call.state !== 'active') return;
      // 'cam' = "my camera is now on/off" (instant UI); 'relay' = "the direct link failed, send the call through the server"
      if (!['offer', 'answer', 'candidate', 'cam', 'relay'].includes(p.type)) return;
      if (JSON.stringify(p).length > MAX_SIGNAL) return;
      const to = socket.id === call.callerSocket ? call.calleeSocket : socket.id === call.calleeSocket ? call.callerSocket : null;
      if (!to) return;
      toSocket(to, 'call-signal', { callId: call.id, type: p.type, sdp: p.sdp, candidate: p.candidate, on: p.type === 'cam' ? p.on === true : undefined });
    });

    // CALL MEDIA THROUGH THE SERVER: used when the two computers cannot reach each other directly (no TURN relay configured,
    // strict NAT / firewall / Wi-Fi isolation). Audio: 16 kHz PCM chunks; video: small JPEG frames. Only between the two sockets
    // of an ACTIVE call, size- and rate-limited, never stored, never logged. Volatile: a late chunk is dropped, not queued.
    let mediaWindow = 0, mediaCount = 0;
    socket.on('call-media', (p) => {
      const call = findCall(p && p.callId);
      if (!call || call.state !== 'active' || (p.k !== 'a' && p.k !== 'v')) return;
      const d = p.d;
      const len = d && (d.byteLength !== undefined ? d.byteLength : d.length);
      if (!(len > 0) || len > (p.k === 'a' ? 16384 : 65536)) return;
      const t = now();
      if (t - mediaWindow > 1000) { mediaWindow = t; mediaCount = 0; }
      if (++mediaCount > 40) return;                                 // ~8 audio + 5 video chunks per second are normal
      const to = socket.id === call.callerSocket ? call.calleeSocket : socket.id === call.calleeSocket ? call.callerSocket : null;
      if (!to) return;
      const target = io.to(to);
      (target.volatile || target).emit('call-media', { callId: call.id, k: p.k, d, s: Number(p.s) || 0 });
    });

    socket.on('disconnect', () => {
      for (const call of [...calls.values()]) if (call.callerSocket === socket.id || call.calleeSocket === socket.id) finish(call, 'disconnected', user.userId);
    });
  }

  /** The ticket ended (kill switch, breach, expiry): hang up its call at once. */
  function endCallsForTask(taskId, reason = 'session-ended') {
    for (const call of [...calls.values()]) if (call.taskId === Number(taskId)) finish(call, reason);
  }

  return { access, contact, list, messages, send, markRead, unreadTotal, registerBrowser, endCallsForTask, setTrusted, isTrusted, activeCalls: () => calls.size, RING_MS };
}

module.exports = { createConversations };
