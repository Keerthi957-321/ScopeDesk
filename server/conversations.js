'use strict';
/**
 * Client <-> vendor messaging and voice calls, one conversation per ticket.
 *
 * Who may talk: ONLY the ticket's client and the one vendor account it was sent to (tasks.assigned_vendor_user_id).
 *   - read the conversation : always (both parties)
 *   - send a message        : while the ticket is waiting / live, and for 7 days after its time window ended
 *   - call                  : while the ticket is waiting / live
 *   - a vendor the client blocked can neither message nor call
 * Every REST call and every socket event is checked against the database; nothing the browser says about "who" is trusted.
 *
 * Calls are WebRTC audio, peer to peer. The server only relays the offer / answer / ICE candidates, and only between the two
 * sockets of that call. A call is ended by either side, by a disconnect, when the ticket is terminated (kill switch), or when
 * nobody answers within RING_MS.
 */
const crypto = require('crypto');

const SEND_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const RING_MS = 40000;
const MAX_BODY = 2000;
const MAX_SIGNAL = 20000;

function createConversations({ db, io, emitToUser, isVendorBlocked, parseDbDate, logAudit = () => {}, now = () => Date.now() }) {
  const calls = new Map();          // callId -> { id, taskId, callerId, calleeId, callerSocket, calleeSocket, state, startedAt, ring }

  const clean = (v) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[ \t]+\n/g, '\n').trim().slice(0, MAX_BODY);
  const toSocket = (id, ev, payload) => { if (id) io.to(id).emit(ev, payload); };

  /** Is this user one of the two parties of the ticket, and what may they do? null = not a party. */
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
    const open = task.status === 'pending' || task.status === 'active';
    const end = parseDbDate(task.window_end).getTime();
    const recent = Number.isFinite(end) && now() - end < SEND_GRACE_MS;
    const canSend = !blocked && (open || recent);
    const canCall = !blocked && open;
    const why = blocked ? 'The client has ended this vendor\'s access.'
      : !canSend ? 'This conversation is closed: the ticket ended more than 7 days ago.'
      : !canCall ? 'Calls are only possible while the ticket is waiting or live.' : '';
    return {
      task, role, canSend, canCall, why,
      meId: user.userId,
      otherId: role === 'client' ? task.assigned_vendor_user_id : task.client_id,
      otherName: role === 'client' ? task.vendor_name : task.client_name,
      myName: role === 'client' ? task.client_name : task.vendor_name
    };
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
             (SELECT COUNT(*) FROM task_messages m WHERE m.task_id = t.id AND m.sender_id <> ? AND m.read_at IS NULL) AS unread
      FROM tasks t LEFT JOIN users cu ON cu.id = t.client_id LEFT JOIN users vu ON vu.id = t.assigned_vendor_user_id
      WHERE ${mine} AND t.assigned_vendor_user_id IS NOT NULL
      ORDER BY COALESCE(last_at, t.created_at) DESC LIMIT 200`, [user.userId, user.userId]);
    const t = now();
    return rows.map((r) => {
      const end = parseDbDate(r.window_end).getTime();
      const open = r.status === 'pending' || r.status === 'active';
      return {
        taskId: r.id, title: r.title, status: r.status,
        otherName: user.role === 'client' ? r.vendor_name : r.client_name,
        lastBody: r.last_body || '', lastKind: r.last_kind || null, lastMine: r.last_sender === user.userId, lastAt: r.last_at || null,
        createdAt: r.created_at, unread: Number(r.unread) || 0,
        canSend: open || (Number.isFinite(end) && t - end < SEND_GRACE_MS), canCall: open
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
          clientId: a.task.client_id, vendorId: a.task.assigned_vendor_user_id, state: 'ringing', startedAt: 0
        };
        calls.set(call.id, call);
        call.ring = setTimeout(() => finish(call, 'missed'), RING_MS);
        if (call.ring.unref) call.ring.unref();
        const reached = emitToUser(a.otherId, 'call-incoming', { callId: call.id, taskId: call.taskId, title: a.task.title, fromName: a.myName, fromRole: a.role });
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
      if (!['offer', 'answer', 'candidate'].includes(p.type)) return;
      if (JSON.stringify(p).length > MAX_SIGNAL) return;
      const to = socket.id === call.callerSocket ? call.calleeSocket : socket.id === call.calleeSocket ? call.callerSocket : null;
      if (!to) return;
      toSocket(to, 'call-signal', { callId: call.id, type: p.type, sdp: p.sdp, candidate: p.candidate });
    });

    socket.on('disconnect', () => {
      for (const call of [...calls.values()]) if (call.callerSocket === socket.id || call.calleeSocket === socket.id) finish(call, 'disconnected', user.userId);
    });
  }

  /** The ticket ended (kill switch, breach, expiry): hang up its call at once. */
  function endCallsForTask(taskId, reason = 'session-ended') {
    for (const call of [...calls.values()]) if (call.taskId === Number(taskId)) finish(call, reason);
  }

  return { access, list, messages, send, markRead, unreadTotal, registerBrowser, endCallsForTask, activeCalls: () => calls.size, RING_MS };
}

module.exports = { createConversations, SEND_GRACE_MS };
