// ScopeDesk desktop bridge (page side). Works only inside the Electron app; in a normal browser it does nothing.
// The preload script exposes window.scopedeskDesktop. This module wraps it for script.js:
//   ScopeDeskDesktop.ensureAgent({ taskId, getToken, setToken, manual })  start the host agent for a task (token never shown or copied)
//   ScopeDeskDesktop.stopAgent()                                          stop it immediately
//   ScopeDeskDesktop.endTask(taskId)                                      HARD KILL: stop the agent AND block it from restarting for this task
//   ScopeDeskDesktop.onStatus(fn)                                         live agent status: { phase, uiState, policy, detail, taskId, seq }
(function () {
  const bridge = window.scopedeskDesktop;
  const available = !!(bridge && bridge.isDesktop);
  const ACTIVE = ['starting', 'connected', 'running'];
  let status = { phase: 'stopped', uiState: 'offline', taskId: null, policy: '', detail: '' };
  let lastSeq = -Infinity;
  let startingFor = null;
  const listeners = [];

  // One authoritative status: an event with an older (or the same) sequence number arrived late or twice and is ignored,
  // so a stale "starting" can never flip a running agent back on screen.
  function publish(next) {
    if (!next) return;
    if (typeof next.seq === 'number') {
      if (next.seq <= lastSeq) return;
      lastSeq = next.seq;
    }
    status = next;
    listeners.forEach((fn) => { try { fn(status); } catch (_) { /* a listener must not break the bridge */ } });
  }

  if (available) {
    bridge.onAgentStatus(publish);
    Promise.resolve(bridge.getAgentStatus && bridge.getAgentStatus()).then((s) => { if (s) publish(s); }).catch(() => {});
    console.log('[ScopeDesk] Desktop bridge ready');
  }

  async function ensureAgent({ taskId, getToken, setToken, manual }) {
    if (!available) return { ok: false, error: 'not-desktop' };
    if (status.taskId === taskId && ACTIVE.includes(status.phase)) return { ok: true, already: true };
    if (startingFor === taskId) return { ok: true, already: true };
    startingFor = taskId;
    try {
      const token = await getToken(taskId);   // fetched from the server into memory only
      setToken(token);                        // so the page can pass the vendor's input to the agent
      return await bridge.initializeAgent({ taskId, token, manual: !!manual });
    } finally {
      startingFor = null;
    }
  }

  async function stopAgent() {
    if (!available) return { ok: true };
    try { return await bridge.stopAgent(); } catch (_) { return { ok: false }; }
  }

  // Kill switch path. Uses the desktop app's end-task (agent stops and that task can never start it again);
  // falls back to a plain stop on an older desktop app that does not have it. Never throws.
  async function endTask(taskId) {
    if (!available) return { ok: true };
    try {
      if (typeof bridge.endTask === 'function' && taskId != null) return await bridge.endTask(Number(taskId));
      return await bridge.stopAgent();
    } catch (_) {
      try { return await bridge.stopAgent(); } catch (__) { return { ok: false }; }
    }
  }

  window.ScopeDeskDesktop = {
    available,
    ensureAgent,
    stopAgent,
    endTask,
    getStatus: () => status,
    onStatus(fn) { listeners.push(fn); if (available && status.phase !== 'stopped') fn(status); }
  };
})();
