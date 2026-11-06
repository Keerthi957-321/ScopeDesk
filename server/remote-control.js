'use strict';
// Remote-control relay: Vendor browser -> (this server) -> Host agent on the Client's PC.
//
// A web page cannot synthesise OS-level mouse/keyboard input, so the Client's PC runs agent/client-agent.js.
// Input travels over the authenticated Socket.IO connection instead of straight peer-to-peer so that the server
// can enforce the rules on EVERY event: task still active, vendor owns the session, not halted, rate-limited.
// When time runs out or a violation is flagged, halt() stops the flow instantly.

const { checkPathScope, readList } = require('./task-scope');

const MAX_EVENTS_PER_SEC = 400;
const ENDED_MARK_MS = 10 * 60 * 1000;   // how long a finished task is remembered as 'ended' before its memory is released
const AUTH_CACHE_MS = 2000;
const scopeVersion = new Map();   // taskId -> n, bumped when the client approves more access: cached scope checks are redone at once
const UNDELIVERED_NOTE_MS = 3000;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const unit = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null);
const VENDOR_OS = new Set(['mac', 'win', 'linux']);
const MAX_CLIP = 4000;   // characters

// Accepts only the exact shapes below; anything else is dropped.
function parseInput(e) {
  if (!e || typeof e !== 'object') return null;
  switch (e.t) {
    case 'move': {
      const x = unit(e.x), y = unit(e.y);
      return x === null || y === null ? null : { t: 'move', x, y };
    }
    case 'down':
    case 'up': {
      const x = unit(e.x), y = unit(e.y);
      if (x === null || y === null || ![0, 1, 2].includes(e.b)) return null;
      return { t: e.t, x, y, b: e.b };
    }
    case 'wheel': {
      if (!Number.isFinite(e.dx) || !Number.isFinite(e.dy)) return null;
      return { t: 'wheel', dx: clamp(Math.round(e.dx), -2000, 2000), dy: clamp(Math.round(e.dy), -2000, 2000) };
    }
    case 'key': {
      if (typeof e.k !== 'string' || !/^[A-Za-z0-9]{1,20}$/.test(e.k) || typeof e.d !== 'boolean') return null;
      const out = { t: 'key', k: e.k, d: e.d };
      if (VENDOR_OS.has(e.o)) out.o = e.o;   // the vendor's OS, so Ctrl/Cmd shortcuts can be translated for the Client's OS
      return out;
    }
    case 'text': {   // printable characters typed by the vendor: typed as characters, so any keyboard layout and OS works
      if (typeof e.s !== 'string' || e.s.length === 0 || [...e.s].length > 8 || /[\u0000-\u001f\u007f]/.test(e.s)) return null;
      return { t: 'text', s: e.s };
    }
    case 'clip': {   // vendor pasted text (vendor -> Client only). Put on the Client's clipboard, then pasted inside the approved app
      if (typeof e.s !== 'string' || e.s.length > MAX_CLIP || /\u0000/.test(e.s)) return null;
      const out = { t: 'clip', s: e.s };
      if (VENDOR_OS.has(e.o)) out.o = e.o;
      return out;
    }
    case 'open': {   // vendor asks the host to open a folder in the file manager; the HOST AGENT checks it against the task's allowed paths
      if (typeof e.p !== 'string' || e.p.length === 0 || e.p.length > 260 || /[\u0000-\u001f]/.test(e.p)) return null;
      return { t: 'open', p: e.p };
    }
    default: return null;
  }
}

const parseList = (s) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch (_) { return []; } };

const MAX_FILE_BYTES = 25 * 1024 * 1024;   // keep in sync with agent/file-receiver.js
// Oldest host agent this server works with (agent/client-agent.js AGENT_PROTOCOL). Older ones are refused with a message the Client
// sees ("install the latest ScopeDesk app") instead of running code that no longer matches the server or crashes.
const MIN_AGENT_PROTOCOL = 9;
const OLD_AGENT_MESSAGE = 'This ScopeDesk desktop app is out of date (its host agent is older than the server). Install or build the latest ScopeDesk app, then press Start remote control again.';
const MAX_CHUNK_BYTES = 256 * 1024;

module.exports = function createRemoteControl({ io, db, authorizeRtc, emitToTask, verifyToken, timers, onBreach, onControlChange, onAudit, log = (m) => console.log(m) }) {
  const agents = new Map(); // taskId -> Set<socketId>
  const halted = new Map(); // taskId -> 'violation' | 'ended'
  const agentState = new Map(); // taskId -> 'waiting' | 'armed' | 'locked'
  // The Client's explicit decision. 'stopped' = the Client pressed "Stop remote control": every input event for the task is refused
  // here at once, whatever the host agent or the vendor's page still does. Cleared only by the Client's own Start.
  const control = new Map(); // taskId -> { active: boolean, reason, at }
  const isStopped = (taskId) => !!(control.get(taskId) && control.get(taskId).active === false);

  // Privacy-safe diagnostics: stages, ids and reasons only, never the content of an input event.
  const diag = (taskId, stage, value) => log(`[RC] task ${taskId}: ${stage}: ${value}`);

  const agentCount = (taskId) => (agents.get(taskId) ? agents.get(taskId).size : 0);
  const agentOnline = (taskId) => agentCount(taskId) > 0;

  function sendToAgents(taskId, event, payload) {
    const ids = agents.get(taskId) || new Set();
    ids.forEach((id) => io.to(id).emit(event, payload));
    return ids.size;                                   // how many agents received it (0 = nobody is listening)
  }

  // Stops input for a task right now. 'ended' is permanent; 'violation' can be lifted by the Client.
  function halt(taskId, reason, extra = {}) {
    halted.set(taskId, reason);
    sendToAgents(taskId, 'control-halt', { taskId, reason, ...extra });
    emitToTask(taskId, 'control-halt', { taskId, reason, ...extra }).catch(() => {});
  }

  function resume(taskId) {
    if (halted.get(taskId) !== 'violation') return false;
    halted.delete(taskId);
    sendToAgents(taskId, 'control-resume', { taskId });
    emitToTask(taskId, 'control-resume', { taskId }).catch(() => {});
    return true;
  }

  /**
   * ONE place that closes remote access for a task. Safe to call more than once.
   *   1. stops all input at once (halt),
   *   2. tells the host agent(s) to lock down, then drops their sockets,
   *   3. forgets the per-task state (agent list, agent state, the countdown),
   *   4. keeps a short 'ended' mark so a late event from a slow vendor tab is still refused, then releases that too.
   * The caller (terminateTask in server.js) has already updated the database and notified both browsers.
   */
  function teardown(taskId, reason = 'ended', extra = {}) {
    diag(taskId, 'session closed', reason);
    halt(taskId, 'ended', { endReason: reason, ...extra });
    control.delete(taskId);
    if (timers && typeof timers.cancel === 'function') timers.cancel(taskId);
    const ids = [...(agents.get(taskId) || [])];
    agents.delete(taskId);
    agentState.delete(taskId);
    if (ids.length) {
      const drop = setTimeout(() => {
        ids.forEach((id) => {
          try { const sock = io.sockets && io.sockets.sockets && io.sockets.sockets.get(id); if (sock) sock.disconnect(true); } catch (_) { /* already gone */ }
        });
      }, 250);                                   // lets the 'control-halt' packet reach the agent first
      if (drop.unref) drop.unref();
    }
    const forget = setTimeout(() => { if (halted.get(taskId) === 'ended') halted.delete(taskId); }, ENDED_MARK_MS);
    if (forget.unref) forget.unref();
  }

  // The agent connects with a short-lived, task-scoped token (see POST /api/tasks/:id/agent-token)
  function registerAgent(socket) {
    const { taskId } = socket.data.agent;

    socket.on('agent-hello', async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        if (!(Number(payload && payload.protocol) >= MIN_AGENT_PROTOCOL)) {
          diag(taskId, 'host agent refused', `out of date (protocol ${Number(payload && payload.protocol) || 'none'})`);
          return reply({ ok: false, error: OLD_AGENT_MESSAGE });
        }
        const task = await db.get('SELECT id, title, target_process, task_type, allowed_paths, allowed_apps, window_end, status FROM tasks WHERE id = ?', [taskId]);
        if (!task || !['pending', 'active'].includes(task.status)) return reply({ ok: false, error: 'This task is not open any more.' });
        // A stale agent (an old process, a delayed reconnect) must not bring control back after the Client pressed Stop
        if (isStopped(taskId)) { diag(taskId, 'host agent refused', 'remote control was stopped by the client'); return reply({ ok: false, error: 'Remote control was stopped by the Client. Press "Start remote control" to allow it again.' }); }
        if (!agents.has(taskId)) agents.set(taskId, new Set());
        agents.get(taskId).add(socket.id);
        if (timers && typeof timers.ensure === 'function') await timers.ensure(taskId).catch((e) => console.error('[RC] timer:', e.message));   // the countdown exists from the moment a connection forms
        reply({
          ok: true, taskId, title: task.title, targetProcess: task.target_process, taskType: task.task_type || '',
          allowedPaths: parseList(task.allowed_paths), allowedApps: parseList(task.allowed_apps),
          windowEnd: task.window_end, serverTime: Date.now(), halted: halted.get(taskId) || null
        });
        diag(taskId, 'host agent', `connected (${agentCount(taskId)} online)`);
        emitToTask(taskId, 'agent-status', { taskId, online: true }).catch(() => {});
      } catch (err) {
        console.error('[RC] agent-hello:', err.message);
        reply({ ok: false, error: 'Server error.' });
      }
    });

    // The local bridge asks: is this pairing token (sent by the Client's browser) really valid for THIS agent's task and user?
    socket.on('bridge-verify', (p, ack) => {
      const t = verifyToken(p && p.token);
      const ok = !!t && t.scope === 'agent' && Number(t.taskId) === taskId && Number(t.userId) === socket.data.user.userId && !halted.has(taskId);
      if (typeof ack === 'function') ack({ ok });
    });

    // Why input is (not) applied on the client's PC, in plain words (which app is in front, a missing OS permission...), so the
    // VENDOR's "Control check" can say exactly which link is broken. App names and reasons only: never window titles or typed text.
    socket.on('agent-diag', (p) => {
      if (!p || Number(p.taskId) !== taskId) return;
      const txt = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]+/g, ' ').slice(0, n);
      emitToTask(taskId, 'agent-diag', {
        taskId, detail: txt(p.detail, 300), inputReady: p.inputReady === true, inputReason: txt(p.inputReason, 300),
        os: ['win32', 'darwin', 'linux'].includes(p.os) ? p.os : 'other', share: ['screen', 'window', 'window-only', 'none'].includes(p.share) ? p.share : 'none',
        apps: Array.isArray(p.apps) ? p.apps.slice(0, 30).map((a) => txt(a, 60)) : []
      }).catch(() => {});
    });

    // The agent reports waiting / armed / locked so both UIs can show what is going on
    socket.on('agent-state', (p) => {
      if (!p || Number(p.taskId) !== taskId || !['waiting', 'armed', 'locked', 'view-only'].includes(p.state)) return;
      agentState.set(taskId, p.state);
      const policy = typeof p.policy === 'string' ? p.policy.replace(/[^\w .()\-]/g, '').slice(0, 64) : '';
      emitToTask(taskId, 'agent-state', { taskId, state: p.state, policy }).catch(() => {});
    });

    // The agent saved (or refused) a file the vendor sent. Both screens are told; the audit log records name and result.
    socket.on('file-result', (r) => {
      if (!r || Number(r.taskId) !== taskId) return;
      const clean = (v, n) => String(v || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, n);
      const out = { taskId, id: clean(r.id, 64), ok: r.ok === true, name: clean(r.name, 180), folder: clean(r.folder, 260), error: clean(r.error, 200) };
      diag(taskId, 'file transfer', out.ok ? 'saved' : `refused (${out.error})`);
      emitToTask(taskId, 'file-result', out).catch(() => {});
      if (typeof onAudit === 'function') Promise.resolve(onAudit(socket.data.user.userId, out.ok ? 'FILE_RECEIVED' : 'FILE_REFUSED', { taskId, name: out.name, folder: out.folder, error: out.error })).catch(() => {});
    });

    socket.on('disconnect', (why) => {
      const set = agents.get(taskId);
      if (set && set.has(socket.id)) diag(taskId, 'host agent', `disconnected (${why})`);
      if (set) { set.delete(socket.id); if (set.size === 0) agents.delete(taskId); }
      if (!agentOnline(taskId)) agentState.delete(taskId);
      if (!agentOnline(taskId)) emitToTask(taskId, 'agent-status', { taskId, online: false }).catch(() => {});
    });
  }

  // Every browser socket (client or vendor) can ask "is the host agent running?"
  // and the vendor can send input events.
  function registerBrowser(socket, user) {
    let windowStart = 0, count = 0;      // per-socket rate limit
    let authOk = { taskId: null, until: 0, allowedPaths: [] };
    let lastUndeliveredNote = 0;

    socket.on('agent-status', async (payload, ack) => {
      const taskId = Number(payload && payload.taskId);
      const role = await authorizeRtc(user, taskId).catch(() => null);
      if (typeof ack === 'function') ack({ ok: !!role, online: !!role && agentOnline(taskId), state: agentState.get(taskId) || null, halted: halted.get(taskId) || null, stopped: !!role && isStopped(taskId) });
    });

    // CLIENT: "Start remote control" / "Stop remote control". The ONE server-side record of the Client's decision.
    //   start: only for the owning Client of an ACTIVE task (approved vendor, task, scope and time window), never after it ended.
    //   stop:  input for the task is refused immediately (relay below), the host agent is told to lock and exit, both screens
    //          are told, and the reason is recorded. Idempotent: a second stop (or start) changes nothing and announces nothing.
    socket.on('remote-control', async (payload, ack) => {
      const reply = (b) => { if (typeof ack === 'function') ack(b); };
      try {
        const taskId = Number(payload && payload.taskId);
        const action = payload && payload.action;
        if (user.role !== 'client') return reply({ ok: false, error: 'Only the Client can start or stop remote control.' });
        if (action !== 'start' && action !== 'stop') return reply({ ok: false, error: 'Unknown action.' });
        const role = await authorizeRtc(user, taskId).catch(() => null);
        if (role !== 'client') return reply({ ok: false, error: 'This task is not active or is not yours.' });
        if (action === 'start' && halted.has(taskId)) return reply({ ok: false, error: halted.get(taskId) === 'violation' ? 'Remote control is locked after a security violation.' : 'This session has ended.' });
        const active = action === 'start';
        const prev = control.get(taskId);
        if (prev && prev.active === active) return reply({ ok: true, active, unchanged: true });
        const reason = active ? 'client_started' : 'client_stopped';
        control.set(taskId, { active, reason, at: Date.now() });
        diag(taskId, 'remote control', active ? 'started by the client' : 'stopped by the client');
        if (!active) sendToAgents(taskId, 'control-halt', { taskId, reason: 'revoked' });
        emitToTask(taskId, 'control-state', { taskId, active, reason }).catch(() => {});
        if (typeof onControlChange === 'function') Promise.resolve(onControlChange({ taskId, userId: user.userId, active, reason })).catch(() => {});
        reply({ ok: true, active });
      } catch (err) {
        console.error('[RC] remote-control:', err.message);
        reply({ ok: false, error: 'Server error.' });
      }
    });

    // VENDOR -> Client file, in chunks (only into the task's approved folders; the agent checks again). Each chunk waits for the
    // agent's answer, so the vendor's page sends the next one only when this one is written (natural flow control).
    const transfers = new Map();   // id -> bytes so far
    socket.on('file-chunk', async (c, ack) => {
      const reply = (b) => { if (typeof ack === 'function') ack(b); };
      try {
        const taskId = Number(c && c.taskId);
        if (user.role !== 'vendor') return reply({ ok: false, error: 'Only the vendor can send files.' });
        if (!Number.isInteger(taskId) || halted.has(taskId) || isStopped(taskId)) return reply({ ok: false, error: 'Remote control is not active.' });
        const id = String((c && c.id) || '');
        const data = c && c.data;
        const len = data && (data.byteLength !== undefined ? data.byteLength : data.length);
        if (!/^[A-Za-z0-9_-]{6,64}$/.test(id) || !Number.isInteger(c.seq) || !(len >= 0) || len > MAX_CHUNK_BYTES) return reply({ ok: false, error: 'Invalid file chunk.' });
        const total = (transfers.get(id) || 0) + len;
        if (total > MAX_FILE_BYTES || Number(c.size) > MAX_FILE_BYTES) return reply({ ok: false, error: 'Files up to 25 MB only.' });
        transfers.set(id, total);
        if (c.last) transfers.delete(id);
        if ((await authorizeRtc(user, taskId).catch(() => null)) !== 'vendor') return reply({ ok: false, error: 'This session is not active.' });
        if (c.seq === 0) {
          const row = await db.get('SELECT allowed_paths FROM tasks WHERE id = ?', [taskId]);
          if (!readList(row && row.allowed_paths).length) return reply({ ok: false, error: 'This task has no approved folders, so files cannot be sent.' });
          diag(taskId, 'file transfer', 'started by the vendor');
        }
        const id0 = [...(agents.get(taskId) || [])][0];
        const agentSock = id0 && io.sockets && io.sockets.sockets && io.sockets.sockets.get(id0);
        if (!agentSock) return reply({ ok: false, error: "The client's ScopeDesk is not running remote control." });
        const payload = { taskId, id, seq: c.seq, last: !!c.last, size: Number(c.size), name: String(c.name || '').slice(0, 255), folder: String(c.folder || '').slice(0, 260), data };
        agentSock.timeout(15000).emit('file-chunk', payload, (err, res) => reply(err ? { ok: false, error: 'The client did not answer.' } : (res && res.ok ? { ok: true } : { ok: false, error: 'The client refused the file.' })));
      } catch (err) {
        console.error('[RC] file-chunk:', err.message);
        reply({ ok: false, error: 'Server error.' });
      }
    });

    socket.on('remote-input', async (msg) => {
      try {
        if (user.role !== 'vendor' || !msg) return;
        const taskId = Number(msg.taskId);
        if (!Number.isInteger(taskId) || halted.has(taskId) || isStopped(taskId)) return;   // stopped by the Client: refused at once

        const now = Date.now();
        if (now - windowStart > 1000) { windowStart = now; count = 0; }
        if (++count > MAX_EVENTS_PER_SEC) return;

        if (authOk.taskId !== taskId || authOk.until < now || authOk.ver !== (scopeVersion.get(taskId) || 0)) { // hit the database at most every 2 s, not per mouse move
          const role = await authorizeRtc(user, taskId);
          let allowedPaths = [];
          if (role === 'vendor') {
            const row = await db.get('SELECT allowed_paths, window_end FROM tasks WHERE id = ?', [taskId]);
            allowedPaths = readList(row && row.allowed_paths);
          }
          authOk = { taskId, until: role === 'vendor' ? now + AUTH_CACHE_MS : 0, allowedPaths, ver: scopeVersion.get(taskId) || 0 };
        }
        if (authOk.until < now || halted.has(taskId) || isStopped(taskId)) return;

        const event = parseInput(msg.e);
        if (!event) return;

        // Scope check on the server, before the event ever reaches the Client's PC: a folder outside the approved
        // paths is a breach, not just a refused click. (The host agent checks again on the PC itself.)
        if (event.t === 'open' && checkPathScope(event.p, authOk.allowedPaths) === 'outside') {
          halt(taskId, 'violation', { permanent: true });      // synchronous: nothing more can pass while the teardown runs
          authOk = { taskId: null, until: 0, allowedPaths: [] };
          if (typeof onBreach === 'function') {
            Promise.resolve(onBreach({ taskId, user, kind: 'path', processName: 'File Manager', detail: event.p.slice(0, 200) }))
              .catch((e) => console.error('[RC] breach handler failed:', e.message));
          }
          return;
        }
        const delivered = sendToAgents(taskId, 'remote-input', event);
        if (delivered === 0 && now - lastUndeliveredNote > UNDELIVERED_NOTE_MS) {
          // Nobody on the Client's PC can receive this. Say so (rarely) instead of dropping it silently.
          lastUndeliveredNote = now;
          socket.emit('input-undeliverable', { taskId, reason: 'agent-offline' });
          diag(taskId, 'input', 'not delivered, host agent offline');
        }
      } catch (err) { /* a malformed event must never crash the server */ }
    });
  }

  const invalidateScope = (taskId) => { scopeVersion.set(Number(taskId), (scopeVersion.get(Number(taskId)) || 0) + 1); };
  return { invalidateScope, MIN_AGENT_PROTOCOL, registerAgent, registerBrowser, halt, resume, teardown, agentOnline, isHalted: (id) => halted.has(id), isStopped, sendToAgents };
};
