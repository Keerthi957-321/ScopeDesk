'use strict';
// Owns the host agent (agent/client-agent.js) as a hidden background process. The Client never sees a terminal.
//
//   warm()   fork the agent in STANDBY the moment the app opens (no token needed yet)
//   init()   hand it {taskId, token} over the IPC channel when the Client creates/accepts a ticket
//   input()  forward one vendor input frame (from the WebRTC data channel) to the agent
//   freeze() lock input at once (violation); stop() end the session
// The token travels over IPC only: not on the command line and not in the environment, where other programs could read it.
// After every session the agent exits and a fresh standby agent is forked, so the next ticket starts instantly.
const path = require('path');
const { fork } = require('child_process');

const MAX_FRAME = 20000;
const AGENT_PROTOCOL = 9;   // must equal AGENT_PROTOCOL in agent/client-agent.js (checked when the agent reports standby)   // one vendor input frame (a pasted text can be up to 4000 characters)
const IDLE = { phase: 'stopped', uiState: 'offline', taskId: null, policy: '', detail: '', inputReady: false, inputReason: '' };

// When a Node process dies on an uncaught error, the LAST line it prints is the banner "Node.js v22.21.1". That used to be the
// only thing shown ("Host agent: could not start: Node.js v22.21.1"). Remove banners and stack frames and explain the cause.
function explainCrash(lines, code) {
  const clean = lines.map((l) => String(l).replace(/^\[AGENT [^\]]*\]\s*/, '').trim())
    .filter((l) => l && !/^Node\.js v\d+\.\d+\.\d+/.test(l) && !/^at\s/.test(l) && !/^\^+$/.test(l));
  const text = clean.join('\n');
  const first = (re) => (clean.find((l) => re.test(l)) || '').slice(0, 240);
  if (/NODE_MODULE_VERSION|compiled against a different Node\.js version|ERR_DLOPEN_FAILED|is not a valid Win32 application|The specified module could not be found/i.test(text)) {
    return 'A native add-on does not match this app\'s Node/Electron version. Run "npm run rebuild:agent" in the desktop folder. (' + first(/NODE_MODULE_VERSION|compiled against|DLOPEN|Win32|specified module/i) + ')';
  }
  const missing = /Cannot find module '([^']+)'/.exec(text);
  if (missing) return `The module "${missing[1]}" is not installed in the agent folder. Run "npm run prepare:agent" in the desktop folder.`;
  const msg = first(/FATAL|error|cannot|failed|invalid|denied|refus/i) || clean[clean.length - 1];
  return (msg || `The host agent stopped (code ${code}).`).slice(0, 300);
}

function createAgentRunner({ agentDir, serverUrl, forkFn = fork, execPath = process.execPath, onStatus = () => {}, onViolation = () => {}, log = () => {}, rewarmMs = 500 }) {
  let child = null, inited = false, quitting = false, rewarmTimer = null;
  let display = null;    // the display the Client shares ({x, y, width, height, primary}); the agent maps positions onto it
  let ownWindow = null;  // ScopeDesk's own window rectangle: the agent refuses vendor clicks inside it
  let lastReason = '';
  let mismatch = '';     // set when the forked agent is not this app's version: Start is refused with this text   // the agent's own explanation ({type:'fatal'} or {type:'ended'}), better than anything parsed from stderr
  let status = { ...IDLE, seq: 0 };
  let seq = 0;
  // Tasks whose remote control must NOT be started again by the page on its own: the Client pressed Stop, the session ended,
  // or the agent failed. Only an explicit Start (init with manual: true) removes a task from this set.
  const blocked = new Map();   // taskId -> why
  const tail = [];

  // ONE authoritative status. Every change gets a higher `seq` (so a late event can never overwrite a newer one) and an update that
  // changes nothing is not announced at all (so the page is not told "something happened" when nothing did).
  const SAME_KEYS = ['phase', 'uiState', 'taskId', 'policy', 'detail', 'inputReady', 'inputReason'];
  function set(patch) {
    const next = { ...status, ...patch };
    if (SAME_KEYS.every((k) => next[k] === status[k])) return;
    seq += 1;
    status = { ...next, seq };
    onStatus({ ...status });
  }
  const ACTIVE_PHASES = ['starting', 'connected', 'running'];
  function remember(line) { tail.push(line); if (tail.length > 200) tail.shift(); log(line); }

  function spawn() {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', SERVER_URL: serverUrl };
    delete env.SCOPEDESK_AGENT_TOKEN;   // never inherit a token from the parent environment
    const c = forkFn(path.join(agentDir, 'client-agent.js'), [], { cwd: agentDir, env, execPath, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child = c; inited = false; lastReason = '';

    const pipeLines = (stream) => stream && stream.on('data', (b) => String(b).split(/\r?\n/).filter(Boolean).forEach(remember));
    pipeLines(c.stdout); pipeLines(c.stderr);

    c.on('message', (m) => {
      if (c !== child || !m || typeof m !== 'object') return;
      if (m.type === 'standby') {
        // An agent from another version (a partial copy, an old build left in the app folder) is not used: say so plainly
        if (m.protocol !== AGENT_PROTOCOL) {
          mismatch = `The host agent inside this ScopeDesk app is a different version (protocol ${m.protocol || 'old'}, expected ${AGENT_PROTOCOL}). Copy the whole agent folder from the latest update, run "npm run prepare:agent" in the desktop folder, then restart ScopeDesk (or install the latest build).`;
          set({ ...IDLE, phase: 'error', uiState: 'error', detail: mismatch });
          return;
        }
        mismatch = '';
        if (!inited && status.phase !== 'error') set({ ...IDLE, phase: 'standby' });   // an error stays on screen until the next Start
      }
      // A socket RE-connect also sends 'connected'. It must not pull a running session back to 'connected': input() only forwards in
      // 'running', so that used to cut the WebRTC fast path for the rest of the session. The agent re-announces its state anyway.
      else if (m.type === 'connected') { if (inited && status.phase !== 'running') set({ phase: 'connected', uiState: 'waiting' }); }
      else if (m.type === 'diag') { if (inited) set({ detail: String(m.detail || '').slice(0, 300) }); }   // why input is not applied yet (app names only)
      else if (m.type === 'state') { if (inited) set({ phase: 'running', uiState: String(m.state), policy: String(m.policy || ''), ...(m.state === 'armed' ? { detail: '' } : {}) }); }
      else if (m.type === 'input') { if (inited) set({ inputReady: m.ready === true, inputReason: String(m.reason || '').slice(0, 400) }); }
      else if (m.type === 'violation') {
        set({ detail: `Scope violation (${m.kind}): ${m.processName || 'unknown app'}` });
        try { onViolation({ kind: m.kind === 'path' ? 'path' : 'app', processName: String(m.processName || 'unknown'), detail: String(m.detail || '') }); } catch (_) { /* a listener must not break the runner */ }
      }
      else if (m.type === 'fatal') { lastReason = String(m.message || '').slice(0, 300); set({ detail: lastReason }); }
      else if (m.type === 'ended') { lastReason = String(m.reason || '').slice(0, 300); set({ detail: lastReason }); }
    });
    c.on('error', (e) => { if (c !== child) return; child = null; set({ phase: 'error', uiState: 'error', detail: e.message }); scheduleWarm(); });
    c.on('exit', (code) => {
      if (c !== child) return;
      const wasInited = inited;
      const endedTask = status.taskId;
      child = null; inited = false;
      // Whatever ended it (server closed the session, time ran out, crash), the page must not start it again by itself.
      if (wasInited && endedTask != null) blocked.set(endedTask, code === 0 || code === null ? 'ended' : 'failed');
      if (code === 0 || code === null) set({ ...IDLE, detail: wasInited ? lastReason : '' });
      else set({ phase: 'error', uiState: 'error', inputReady: false, detail: lastReason || explainCrash(tail, code) });
      scheduleWarm();
    });
    return c;
  }

  // Bring a fresh standby agent up for the next ticket (keeps an error message on screen until the next init)
  function scheduleWarm() {
    if (quitting) return;
    clearTimeout(rewarmTimer);
    rewarmTimer = setTimeout(() => { if (!child && !quitting) { try { spawn(); } catch (e) { log('warm failed: ' + e.message); } } }, rewarmMs);
    if (rewarmTimer.unref) rewarmTimer.unref();
  }

  function warm() {
    if (child || quitting) return { ok: true };
    try { spawn(); } catch (e) { set({ phase: 'error', uiState: 'error', detail: e.message }); return { ok: false, error: 'Could not start the host agent: ' + e.message }; }
    set({ ...IDLE, phase: 'standby' });
    return { ok: true };
  }

  /**
   * Start remote control for a task. Idempotent:
   *   - already starting/running for THIS task  -> nothing happens (no restart, no second agent)
   *   - the Client stopped it / it ended / it failed, and this is not a manual Start -> refused quietly (no automatic restart)
   *   - another task is running -> that one is stopped first
   * `manual` must be true only for an explicit action by the Client (pressing Share my screen / Start remote control).
   */
  function init({ taskId, token, viewOnly = false, manual = false, blockReason = '' }) {
    if (mismatch) { set({ phase: 'error', uiState: 'error', taskId, detail: mismatch }); return { ok: false, error: mismatch }; }
    if (blocked.has(taskId) && !manual) return { ok: true, skipped: blocked.get(taskId) };
    if (manual) blocked.delete(taskId);
    if (child && inited && status.taskId === taskId && ACTIVE_PHASES.includes(status.phase)) return { ok: true, already: true };
    if (child && inited) stop('restart');                 // a different ticket replaces the running one
    if (!child) { try { spawn(); } catch (e) { set({ phase: 'error', uiState: 'error', taskId, detail: e.message }); return { ok: false, error: 'Could not start the host agent: ' + e.message }; } }
    inited = true;
    set({ phase: 'starting', uiState: 'starting', taskId, policy: '', detail: '', inputReady: false, inputReason: '' });
    try {
      child.send(blockReason ? { type: 'init', token, viewOnly: !!viewOnly, blockReason: String(blockReason).slice(0, 300) } : { type: 'init', token, viewOnly: !!viewOnly });
      if (display) child.send({ type: 'display', display });
      if (ownWindow) child.send({ type: 'own-window', bounds: ownWindow });
    } catch (e) { return { ok: false, error: 'The host agent is not reachable: ' + e.message }; }
    return { ok: true };
  }

  function input(data) {
    if (!child || !inited || status.phase !== 'running' || typeof data !== 'string' || data.length > MAX_FRAME) return false;   // not running: nothing is executed
    try { child.send({ type: 'input', data }); return true; } catch (_) { return false; }
  }

  /** The Client picked which display is shared (multi-monitor). Sent to the running agent at once and to every later one. */
  function setDisplay(d) {
    display = d || null;
    if (child && inited) { try { child.send({ type: 'display', display }); } catch (_) { /* gone */ } }
  }

  function setOwnWindow(b) {
    ownWindow = b || null;
    if (child && inited) { try { child.send({ type: 'own-window', bounds: ownWindow }); } catch (_) { /* gone */ } }
  }

  function freeze() { if (child && inited) { try { child.send({ type: 'freeze' }); } catch (_) { /* gone */ } } }

  function stop(reason = 'stopped', { hard = false } = {}) {
    const c = child;
    if (!c) return { ok: true };                          // already stopped: stopping twice is harmless
    const taskId = status.taskId;
    child = null; inited = false;
    if (reason !== 'restart' && taskId != null && !blocked.has(taskId)) blocked.set(taskId, 'stopped');   // no automatic restart after a Stop
    try { c.send({ type: 'stop' }); } catch (_) { /* already gone */ }   // lets the agent release held keys and buttons
    // The agent refuses input from the moment it reads 'stop'. The forced kill is the backstop; a hard stop (kill switch,
    // termination, breach) only leaves it time to release held keys and mouse buttons.
    const killer = setTimeout(() => { try { c.kill(); } catch (_) { /* ignore */ } }, hard ? 600 : 1500);
    if (killer.unref) killer.unref();
    c.once('exit', () => clearTimeout(killer));
    set({ ...IDLE, detail: reason === 'restart' ? '' : status.detail });
    scheduleWarm();
    return { ok: true };
  }

  /** Shows an error in the one authoritative status (used for a rejected Start). */
  function fail(message) { set({ phase: 'error', uiState: 'error', inputReady: false, detail: String(message || 'The host agent could not start.').slice(0, 300) }); }

  /** The server ended the session (expiry, termination, breach): same as a stop, and the page cannot restart it. */
  function endTask(taskId, why = 'ended') {
    if (taskId == null) return;
    blocked.set(taskId, why);
    if (status.taskId === taskId && child && inited) stop(why, { hard: true });
  }

  function shutdown() { quitting = true; clearTimeout(rewarmTimer); const c = child; if (c) { child = null; try { c.send({ type: 'stop' }); } catch (_) { /* gone */ } setTimeout(() => { try { c.kill(); } catch (_) { /* gone */ } }, 300).unref(); } }

  return { warm, init, start: init, input, freeze, setDisplay, setOwnWindow, stop, endTask, fail, isBlocked: (id) => blocked.has(id), shutdown, status: () => ({ ...status }), logs: () => tail.slice() };
}

module.exports = { createAgentRunner, explainCrash };
