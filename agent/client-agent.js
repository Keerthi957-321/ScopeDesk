'use strict';
// ScopeDesk host agent. Runs on the CLIENT's PC. Normally started by the desktop app, never by hand.
//
//   STANDBY   The desktop app forks this process the moment its window opens. With no token yet it idles (a few MB of RAM).
//   INIT      When the Client creates a ticket, the page sends {taskId, token} to Electron (ipcRenderer.send('init-session'))
//             and Electron forwards it here as {type:'init'}. The token never touches the command line or environment.
//   SESSION   Applies the vendor's mouse/keyboard (nut.js), watches the focused app (monitor.js), and on any scope violation
//             reports to the server, which alerts the Client and halts the vendor.
//   END       Exits when the session ends or the task window closes. The desktop app then forks a fresh standby agent.
//
// Developers can still run it from a terminal:  SCOPEDESK_AGENT_TOKEN=<token> SERVER_URL=<url> npm start
const { io } = require('socket.io-client');
const cfg = require('./config');
const { ForegroundMonitor } = require('./monitor');
const { InputInjector } = require('./input-injector');
const { loadPolicy } = require('./policy');
const { createPathProbe } = require('./path-probe');
const { createFileReceiver } = require('./file-receiver');
const MAX_FRAME = 20000;
// Version of the agent <-> server / desktop-app protocol. The server refuses older agents with a clear message, and the desktop app
// refuses an agent that does not match it, instead of a stale copy crashing half-way through a session.
const AGENT_PROTOCOL = 9;
const WINDOW_ONLY_REASON = 'You are sharing one window, so the vendor can watch but not control. Share a whole screen to allow control.';   // one input frame from the desktop app (a pasted text can be up to 4000 characters)

const stamp = () => new Date().toLocaleTimeString();
const hasParent = typeof process.send === 'function';
// Status messages travel to the desktop app over IPC (no-op when run from a terminal)
const notify = (msg) => { if (hasParent) { try { process.send(msg); } catch (_) { /* parent gone */ } } };
const log = (level, msg) => (level === 'warn' || level === 'error' ? console.error : console.log)(`[AGENT ${stamp()}] ${msg}`);

// Any error nobody caught used to kill this process with Node's banner ("Node.js v22.x") as the last line, and the desktop app could
// only show that banner. Now the real message is logged, sent to the desktop app ({type:'fatal'}), and the agent ends cleanly.
function fatal(err, where) {
  const message = String((err && err.message) || err || 'unknown error').split('\n')[0].slice(0, 300);
  console.error(`[AGENT ${stamp()}] FATAL (${where}): ${err && err.stack ? err.stack : message}`);
  notify({ type: 'fatal', where, message });
  try { shutdown(1, `The host agent stopped: ${message}`); } catch (_) { setTimeout(() => process.exit(1), 200); }
}
process.on('uncaughtException', (err) => fatal(err, 'uncaughtException'));
process.on('unhandledRejection', (err) => fatal(err, 'unhandledRejection'));

if (!cfg.SERVER_URL) {
  log('error', 'No server address. Set SERVER_URL, or put "serverUrl" in public/app-config.json.');
  process.exit(1);
}

let receiver = null, display = null, ownWindow = null;
let socket = null, monitor = null, injector = null, taskId = null, expiryTimer = null, started = false, ending = false;
let viewOnlyMode = false, blockReason = '', policyName = '';   // set by connect(), read later by onHello() (they are separate functions, so it cannot be a parameter)

async function shutdown(code, why) {
  if (ending) return;
  ending = true;
  log('info', why);
  clearTimeout(expiryTimer);
  try { if (receiver) receiver.closeAll(); if (injector) await injector.releaseAll(); if (monitor) monitor.stop(); if (socket) socket.close(); } catch (_) { /* best effort */ }
  notify({ type: 'ended', code, reason: why });
  setTimeout(() => process.exit(code), hasParent ? 150 : 0); // let the last IPC message out
}

// ---------- messages from the desktop app ----------
process.on('message', (m) => {
  if (!m || typeof m !== 'object') return;
  if (m.type === 'init') return connect(String(m.token || ''), m.viewOnly === true, String(m.blockReason || ''));                       // start the session
  if (m.type === 'stop') return shutdown(0, 'Stopped by the Client.');
  // Vendor input that arrived on the WebRTC data channel in the Client's window, forwarded by Electron's main process.
  // It is schema-checked again in injector.handle(), exactly like input from any other path.
  // The Client chose which display is shared: map the vendor's positions onto it
  if (m.type === 'display') { display = m.display || null; if (injector) { injector.setDisplay(display); announce(); } return; }
  if (m.type === 'own-window') {
    const was = ownWindow;
    ownWindow = m.bounds || null; if (injector) injector.setOwnWindow(ownWindow);
    // ScopeDesk just stepped aside (minimised to the control bar): bring the approved app forward so the vendor can work in it
    if (injector && monitor && monitor.state === 'waiting' && (!was || (ownWindow && ownWindow.width < was.width))) setTimeout(bringApprovedForward, 500);
    return;
  }
  if (m.type === 'input' && injector && !ending && typeof m.data === 'string' && m.data.length <= MAX_FRAME) {
    let ev; try { ev = JSON.parse(m.data); } catch (_) { return; }
    injector.handle(ev);
  }
  if (m.type === 'freeze' && monitor) monitor.lock();                                  // the desktop app cut the data channel
});
process.on('SIGINT', () => shutdown(0, 'Stopped by the Client.'));
process.on('SIGTERM', () => shutdown(0, 'Stopped.'));

// ---------- what this PC can do right now, told to the desktop app, the server and both screens ----------
let baseInputReason = '';
let livePolicy = null, lastHello = null;
let lastDetail = '';
// the facts the vendor's "Control check" needs (this OS, can input be applied and why not, what is shared, which app waits in front)
function sendDiag() {
  if (!socket || !started || !injector) return;
  const share = injector.windowHandle !== null ? 'window' : injector.windowOnly ? 'window-only' : 'screen';
  const st = injector.stats || {};
  const now = Date.now();
  socket.emit('agent-diag', {
    taskId, detail: lastDetail, inputReady: canInput(), inputReason: inputReasonNow(), os: process.platform, share, apps: livePolicy ? livePolicy.appList.slice(0, 30) : [],
    applied: st.applied || 0, refused: st.refused || 0, refusal: st.reason || '',
    lastApplied: st.appliedAt ? Math.round((now - st.appliedAt) / 1000) : -1, lastRefused: st.refusedAt ? Math.round((now - st.refusedAt) / 1000) : -1
  });
}
function bringApprovedForward() {
  if (!injector || !monitor || monitor.state !== 'waiting' || !livePolicy) return;
  injector.focusApproved(livePolicy.appList).then((ok) => { if (ok) monitor.poll().catch(() => {}); }).catch(() => {});
}
// at most one report a second while the vendor is working
let diagTimer = null;
function diagSoon() { if (diagTimer) return; diagTimer = setTimeout(() => { diagTimer = null; sendDiag(); }, 800); }   // the running session's policy (widened in place by 'scope-updated')
const canInput = () => !!injector && injector.ready && !injector.windowOnly;
const inputReasonNow = () => (canInput() ? '' : (injector && injector.ready && injector.windowOnly ? WINDOW_ONLY_REASON : baseInputReason));
// Re-announces the current state (after a reconnect, or when the Client switches between a screen and a single window)
function announce() {
  if (!monitor || !injector || !socket || !started) return;
  const shown = monitor.state !== 'locked' && !canInput() ? 'view-only' : monitor.state;
  notify({ type: 'input', ready: canInput(), reason: inputReasonNow() });
  notify({ type: 'state', state: shown, policy: policyName });
  socket.emit('agent-state', { taskId, state: shown, policy: policyName });
  sendDiag();
}

// ---------- session ----------
function connect(token, viewOnly = false, why = '') {
  if (socket || ending) return;                      // one session per agent process
  if (!token) return shutdown(1, 'No agent token was provided.');
  viewOnlyMode = viewOnly === true;
  blockReason = String(why || '').slice(0, 300);
  socket = io(cfg.SERVER_URL, { auth: { token }, reconnectionDelayMax: 5000 });

  socket.on('connect', () => {
    log('info', 'Connected to ScopeDesk.');
    notify({ type: 'connected' });
    socket.emit('agent-hello', { protocol: AGENT_PROTOCOL }, (res) => { onHello(res).catch((e) => fatal(e, 'session-start')); });
  });
  // Every server event carries a taskId. Anything about ANOTHER task is ignored: it used to stop (or even unlock) this agent when a
  // different ticket of the same Client expired or was terminated.
  const mine = (d) => !(d && d.taskId !== undefined && taskId !== null && Number(d.taskId) !== taskId);
  socket.on('remote-input', (ev) => { if (injector && !ending) injector.handle(ev); });   // server-relay fallback path
  socket.on('control-halt', (d) => {
    if (!mine(d)) return;
    if (monitor) monitor.lock();
    if (d && d.reason === 'ended') shutdown(0, 'Session ended.');
    else if (d && d.reason === 'revoked') shutdown(0, 'Remote control was stopped by the Client.');
  });
  socket.on('control-resume', (d) => { if (mine(d) && monitor) monitor.rearm(); });
  // The Client approved more apps / folders during the session ("Request Additional Access"). Only the server can send this, and
  // only after the Client clicked Approve. The new scope replaces the old one in place: the monitor, the input gate and the file
  // receiver all hold this same policy object, so the very next check uses it. The session keeps running.
  socket.on('scope-updated', (d) => {
    if (!mine(d) || !started || ending || !livePolicy) return;
    try {
      const next = loadPolicy({ taskType: lastHello.taskType, targetProcess: lastHello.targetProcess, taskId, extra: { allowedPaths: d.allowedPaths, allowedApps: d.allowedApps }, sessionConfigFile: cfg.SESSION_CONFIG, log });
      if (next.allowedPaths.length && !createPathProbe(log).supported) { log('warn', 'New folders were approved, but this OS cannot report folders: keeping the old scope.'); return; }
      cfg.ALWAYS_ALLOW.forEach((a) => { next.apps.add(cfg.normalize(a)); next.appList.push(a); });
      Object.assign(livePolicy, next);
      policyName = livePolicy.name;
      log('info', `Scope widened by the Client: apps ${livePolicy.appList.join(', ')}${livePolicy.allowedPaths.length ? '; folders ' + livePolicy.allowedPaths.join(', ') : ''}`);
      notify({ type: 'scope', apps: livePolicy.appList.slice(0, 50), paths: livePolicy.allowedPaths.slice(0, 50) });
      if (monitor) monitor.cache.at = 0;                                             // judge the window in front again, now
      if (monitor && monitor.state === 'waiting') monitor.poll().catch(() => {});   // the app in front may be approved now
      socket.emit('scope-applied', { taskId, apps: livePolicy.appList.length, paths: livePolicy.allowedPaths.length });
      sendDiag();
    } catch (e) { log('warn', 'Could not apply the new scope: ' + e.message); }
  });
  socket.on('session-ended', (d) => { if (mine(d)) shutdown(0, 'Session ended.'); });
  // Vendor -> Client file, relayed by the server (only into the task's approved folders, see file-receiver.js)
  socket.on('file-chunk', (c, ack) => {
    const ok = !ending && !!receiver && mine(c) && receiver.chunk(c);
    if (typeof ack === 'function') ack({ ok });
  });
  socket.on('connect_error', (e) => {
    if (e.message === 'Authentication required') return shutdown(1, 'This agent token is expired or invalid. Create the ticket again.');
    log('warn', `Cannot reach ${cfg.SERVER_URL} (${e.message}). Retrying...`);
  });
  socket.on('disconnect', (reason) => log('warn', `Disconnected (${reason}). Vendor input is paused until the connection returns.`));
}

// The server accepted this agent: load the policy, start the foreground monitor and the input injector.
async function onHello(res) {
      if (!res || !res.ok) return shutdown(started ? 0 : 1, (res && res.error) || 'The server refused this agent.');
      if (started) {
        // Reconnect: the monitor is already running. The server forgot this agent's state when the socket dropped, and the desktop
        // app saw 'connected' again, so announce the CURRENT state once more (it used to stay "waiting"/"connected" for good, which
        // also cut the WebRTC fast path because input is only forwarded in the 'running' phase).
        log('info', 'Reconnected.');
        announce();
        return;
      }
      started = true;
      taskId = res.taskId;

      lastHello = res;
      let policy;
      try { policy = loadPolicy({ taskType: res.taskType, targetProcess: res.targetProcess, taskId: res.taskId, extra: { allowedPaths: res.allowedPaths, allowedApps: res.allowedApps }, sessionConfigFile: cfg.SESSION_CONFIG, log }); }
      catch (e) { return shutdown(1, 'Could not load the security policy: ' + e.message); }
      cfg.ALWAYS_ALLOW.forEach((a) => { policy.apps.add(cfg.normalize(a)); policy.appList.push(a); });
      policyName = policy.name;
      livePolicy = policy;
      const probe = createPathProbe(log);
      if (policy.allowedPaths.length && !probe.supported) {
        return shutdown(1, `Policy "${policy.name}" restricts folders, but this operating system cannot report which folder a window shows. Refusing to start (a weaker check would be unsafe).`);
      }
      monitor = new ForegroundMonitor({
        policy, probe, pollMs: cfg.POLL_MS, ownPid: hasParent ? process.ppid : null, strikes: cfg.STRIKES, attributionMs: cfg.ATTRIBUTION_MS, log,
        debug: cfg.DEBUG_FOREGROUND,
        // Why vendor input is not being applied yet (which app is in front, or why the window cannot be read). App names only.
        onDiag: (detail) => { log('info', `Monitor: ${detail}`); notify({ type: 'diag', detail }); lastDetail = detail; sendDiag(); },
        onState: (state) => {
          // The server and both screens are told the truth: when this PC cannot apply input (view-only, no nut-js, macOS refused) the
          // state is 'view-only', never 'armed'. A locked state always wins.
          const shown = state !== 'locked' && !canInput() ? 'view-only' : state;
          log('info', `State: ${state}${shown !== state ? ' (reported as ' + shown + ')' : ''}`);
          notify({ type: 'state', state: shown, policy: policy.name });
          socket.emit('agent-state', { taskId, state: shown, policy: policy.name });
          if (state === 'armed') lastDetail = '';
          sendDiag();
          if (state === 'locked') injector.releaseAll();
        },
        onViolation: ({ processName, kind, detail }) => {
          log('error', `VIOLATION (${kind}): ${processName}${detail ? ' -> ' + detail : ''}. Input locked, reporting.`);
          // The desktop app reacts to this at once (before any server round trip): it freezes the data channel,
          // closes the WebRTC link and shows a native OS notification.
          notify({ type: 'violation', kind, processName, detail });
          socket.emit('host-violation', { taskId, processName, kind, detail }, (ack) => { if (ack && !ack.ok) log('warn', 'Server did not accept the report: ' + ack.error); });
        }
      });
      injector = new InputInjector({ monitor, log, viewOnly: !!(cfg.VIEW_ONLY || viewOnlyMode), policy, onStats: () => diagSoon() });
      injector.init();
      if (display) injector.setDisplay(display);
      if (ownWindow) injector.setOwnWindow(ownWindow);
      receiver = createFileReceiver({
        policy, log, isLocked: () => !monitor || monitor.state === 'locked' || viewOnlyMode,
        report: (r) => { socket.emit('file-result', { taskId, ...r }); notify({ type: 'file', ok: r.ok, name: r.name || '', folder: r.folder || '', error: r.error || '' }); }
      });
      // Tell the desktop app whether input can really be applied, and why not. (Used to fail silently: "Remote control is OFF" was only logged.)
      const inputReason = blockReason || injector.reason || (viewOnlyMode || cfg.VIEW_ONLY ? 'View-only mode was requested.' : '');
      baseInputReason = injector.ready ? '' : (inputReason || 'The input library could not be loaded.');
      notify({ type: 'input', ready: canInput(), reason: inputReasonNow() });

      try { await monitor.start(); }
      catch (e) {
        // Without a working foreground monitor the scope cannot be enforced, so the session must not run (fail closed).
        return shutdown(1, `Could not start the scope monitor: ${e.message}`);
      }
      if (res.halted) monitor.lock();
      log('info', `Task #${taskId} "${res.title}". Policy: ${policy.name}. Allowed apps: ${policy.appList.join(', ')}.` + (policy.allowedPaths.length ? ` Allowed folders: ${policy.allowedPaths.join(' | ')}.` : ''));
      announce();                                    // the real state: view-only when this PC cannot apply input (or one window is shared)
      setTimeout(bringApprovedForward, 1200);        // put the approved app (e.g. Calculator) in front, ready for the vendor

      // Defence in depth: also stop locally when the window ends, even if the server cannot be reached
      const msLeft = Date.parse(res.windowEnd) - (Date.now() + (res.serverTime - Date.now()));
      if (Number.isFinite(msLeft)) expiryTimer = setTimeout(() => shutdown(0, 'The approved time window has ended.'), Math.max(0, msLeft));
}

// ---------- start ----------
if (cfg.TOKEN) connect(cfg.TOKEN);                       // terminal / legacy start with a token already known
else if (hasParent) { log('info', 'Standby: waiting for the desktop app to start a session.'); notify({ type: 'standby', protocol: AGENT_PROTOCOL }); }
else { log('error', 'No agent token. Run this through the ScopeDesk desktop app, or set SCOPEDESK_AGENT_TOKEN for development.'); process.exit(1); }
