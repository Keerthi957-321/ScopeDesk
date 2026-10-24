'use strict';
// Remote-control relay: Vendor browser -> (this server) -> Host agent on the Client's PC.
//
// A web page cannot synthesise OS-level mouse/keyboard input, so the Client's PC runs agent/client-agent.js.
// Input travels over the authenticated Socket.IO connection instead of straight peer-to-peer so that the server
// can enforce the rules on EVERY event: task still active, vendor owns the session, not halted, rate-limited.
// When time runs out or a violation is flagged, halt() stops the flow instantly.

const MAX_EVENTS_PER_SEC = 400;
const AUTH_CACHE_MS = 2000;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const unit = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1 ? v : null);

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
      return { t: 'key', k: e.k, d: e.d };
    }
    case 'open': {   // vendor asks the host to open a folder in the file manager; the HOST AGENT checks it against the task's allowed paths
      if (typeof e.p !== 'string' || e.p.length === 0 || e.p.length > 260 || /[\u0000-\u001f]/.test(e.p)) return null;
      return { t: 'open', p: e.p };
    }
    default: return null;
  }
}

const parseList = (s) => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch (_) { return []; } };

module.exports = function createRemoteControl({ io, db, authorizeRtc, emitToTask, verifyToken }) {
  const agents = new Map(); // taskId -> Set<socketId>
  const halted = new Map(); // taskId -> 'violation' | 'ended'
  const agentState = new Map(); // taskId -> 'waiting' | 'armed' | 'locked'

  const agentCount = (taskId) => (agents.get(taskId) ? agents.get(taskId).size : 0);
  const agentOnline = (taskId) => agentCount(taskId) > 0;

  function sendToAgents(taskId, event, payload) {
    (agents.get(taskId) || new Set()).forEach((id) => io.to(id).emit(event, payload));
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

  // The agent connects with a short-lived, task-scoped token (see POST /api/tasks/:id/agent-token)
  function registerAgent(socket) {
    const { taskId } = socket.data.agent;

    socket.on('agent-hello', async (_payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        const task = await db.get('SELECT id, title, target_process, task_type, allowed_paths, allowed_apps, window_end, status FROM tasks WHERE id = ?', [taskId]);
        if (!task || !['pending', 'active'].includes(task.status)) return reply({ ok: false, error: 'This task is not open any more.' });
        if (!agents.has(taskId)) agents.set(taskId, new Set());
        agents.get(taskId).add(socket.id);
        reply({
          ok: true, taskId, title: task.title, targetProcess: task.target_process, taskType: task.task_type || '',
          allowedPaths: parseList(task.allowed_paths), allowedApps: parseList(task.allowed_apps),
          windowEnd: task.window_end, serverTime: Date.now(), halted: halted.get(taskId) || null
        });
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

    // The agent reports waiting / armed / locked so both UIs can show what is going on
    socket.on('agent-state', (p) => {
      if (!p || Number(p.taskId) !== taskId || !['waiting', 'armed', 'locked'].includes(p.state)) return;
      agentState.set(taskId, p.state);
      const policy = typeof p.policy === 'string' ? p.policy.replace(/[^\w .()\-]/g, '').slice(0, 64) : '';
      emitToTask(taskId, 'agent-state', { taskId, state: p.state, policy }).catch(() => {});
    });

    socket.on('disconnect', () => {
      const set = agents.get(taskId);
      if (set) { set.delete(socket.id); if (set.size === 0) agents.delete(taskId); }
      if (!agentOnline(taskId)) agentState.delete(taskId);
      if (!agentOnline(taskId)) emitToTask(taskId, 'agent-status', { taskId, online: false }).catch(() => {});
    });
  }

  // Every browser socket (client or vendor) can ask "is the host agent running?"
  // and the vendor can send input events.
  function registerBrowser(socket, user) {
    let windowStart = 0, count = 0;      // per-socket rate limit
    let authOk = { taskId: null, until: 0 };

    socket.on('agent-status', async (payload, ack) => {
      const taskId = Number(payload && payload.taskId);
      const role = await authorizeRtc(user, taskId).catch(() => null);
      if (typeof ack === 'function') ack({ ok: !!role, online: !!role && agentOnline(taskId), state: agentState.get(taskId) || null, halted: halted.get(taskId) || null });
    });

    socket.on('remote-input', async (msg) => {
      try {
        if (user.role !== 'vendor' || !msg) return;
        const taskId = Number(msg.taskId);
        if (!Number.isInteger(taskId) || halted.has(taskId)) return;

        const now = Date.now();
        if (now - windowStart > 1000) { windowStart = now; count = 0; }
        if (++count > MAX_EVENTS_PER_SEC) return;

        if (authOk.taskId !== taskId || authOk.until < now) { // hit the database at most every 2 s, not per mouse move
          const role = await authorizeRtc(user, taskId);
          authOk = { taskId, until: role === 'vendor' ? now + AUTH_CACHE_MS : 0 };
        }
        if (authOk.until < now || halted.has(taskId)) return;

        const event = parseInput(msg.e);
        if (event) sendToAgents(taskId, 'remote-input', event);
      } catch (err) { /* a malformed event must never crash the server */ }
    });
  }

  return { registerAgent, registerBrowser, halt, resume, agentOnline, isHalted: (id) => halted.has(id) };
};
