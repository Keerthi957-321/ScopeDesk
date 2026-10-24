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

const stamp = () => new Date().toLocaleTimeString();
const hasParent = typeof process.send === 'function';
// Status messages travel to the desktop app over IPC (no-op when run from a terminal)
const notify = (msg) => { if (hasParent) { try { process.send(msg); } catch (_) { /* parent gone */ } } };
const log = (level, msg) => (level === 'warn' || level === 'error' ? console.error : console.log)(`[AGENT ${stamp()}] ${msg}`);

if (!cfg.SERVER_URL) {
  log('error', 'No server address. Set SERVER_URL, or put "serverUrl" in public/app-config.json.');
  process.exit(1);
}

let socket = null, monitor = null, injector = null, taskId = null, expiryTimer = null, started = false, ending = false;

async function shutdown(code, why) {
  if (ending) return;
  ending = true;
  log('info', why);
  clearTimeout(expiryTimer);
  try { if (injector) await injector.releaseAll(); if (monitor) monitor.stop(); if (socket) socket.close(); } catch (_) { /* best effort */ }
  notify({ type: 'ended', code, reason: why });
  setTimeout(() => process.exit(code), hasParent ? 150 : 0); // let the last IPC message out
}

// ---------- messages from the desktop app ----------
process.on('message', (m) => {
  if (!m || typeof m !== 'object') return;
  if (m.type === 'init') return connect(String(m.token || ''), m.viewOnly === true);                       // start the session
  if (m.type === 'stop') return shutdown(0, 'Stopped by the Client.');
  // Vendor input that arrived on the WebRTC data channel in the Client's window, forwarded by Electron's main process.
  // It is schema-checked again in injector.handle(), exactly like input from any other path.
  if (m.type === 'input' && injector && typeof m.data === 'string' && m.data.length <= 600) {
    let ev; try { ev = JSON.parse(m.data); } catch (_) { return; }
    injector.handle(ev);
  }
  if (m.type === 'freeze' && monitor) monitor.lock();                                  // the desktop app cut the data channel
});
process.on('SIGINT', () => shutdown(0, 'Stopped by the Client.'));
process.on('SIGTERM', () => shutdown(0, 'Stopped.'));

// ---------- session ----------
function connect(token, viewOnly = false) {
  if (socket || ending) return;                      // one session per agent process
  if (!token) return shutdown(1, 'No agent token was provided.');
  socket = io(cfg.SERVER_URL, { auth: { token }, reconnectionDelayMax: 5000 });

  socket.on('connect', () => {
    log('info', 'Connected to ScopeDesk.');
    notify({ type: 'connected' });
    socket.emit('agent-hello', {}, async (res) => {
      if (!res || !res.ok) return shutdown(1, (res && res.error) || 'The server refused this agent.');
      if (started) return; // reconnect: the monitor is already running
      started = true;
      taskId = res.taskId;

      let policy;
      try { policy = loadPolicy({ taskType: res.taskType, targetProcess: res.targetProcess, taskId: res.taskId, extra: { allowedPaths: res.allowedPaths, allowedApps: res.allowedApps }, sessionConfigFile: cfg.SESSION_CONFIG, log }); }
      catch (e) { return shutdown(1, 'Could not load the security policy: ' + e.message); }
      cfg.ALWAYS_ALLOW.forEach((a) => { policy.apps.add(cfg.normalize(a)); policy.appList.push(a); });
      const probe = createPathProbe(log);
      if (policy.allowedPaths.length && !probe.supported) {
        return shutdown(1, `Policy "${policy.name}" restricts folders, but this operating system cannot report which folder a window shows. Refusing to start (a weaker check would be unsafe).`);
      }
      monitor = new ForegroundMonitor({
        policy, probe, pollMs: cfg.POLL_MS, strikes: cfg.STRIKES, attributionMs: cfg.ATTRIBUTION_MS, log,
        debug: cfg.DEBUG_FOREGROUND,
        onState: (state) => { log('info', `State: ${state}`); notify({ type: 'state', state, policy: policy.name }); socket.emit('agent-state', { taskId, state, policy: policy.name }); if (state === 'locked') injector.releaseAll(); },
        onViolation: ({ processName, kind, detail }) => {
          log('error', `VIOLATION (${kind}): ${processName}${detail ? ' -> ' + detail : ''}. Input locked, reporting.`);
          // The desktop app reacts to this at once (before any server round trip): it freezes the data channel,
          // closes the WebRTC link and shows a native OS notification.
          notify({ type: 'violation', kind, processName, detail });
          socket.emit('host-violation', { taskId, processName, kind, detail }, (ack) => { if (ack && !ack.ok) log('warn', 'Server did not accept the report: ' + ack.error); });
        }
      });
      injector = new InputInjector({ monitor, log, viewOnly: cfg.VIEW_ONLY || viewOnly, policy });
      injector.init();

      await monitor.start();
      if (res.halted) monitor.lock();
      log('info', `Task #${taskId} "${res.title}". Policy: ${policy.name}. Allowed apps: ${policy.appList.join(', ')}.` + (policy.allowedPaths.length ? ` Allowed folders: ${policy.allowedPaths.join(' | ')}.` : ''));
      socket.emit('agent-state', { taskId, state: monitor.state, policy: policy.name });
      notify({ type: 'state', state: monitor.state, policy: policy.name });

      // Defence in depth: also stop locally when the window ends, even if the server cannot be reached
      const msLeft = Date.parse(res.windowEnd) - (Date.now() + (res.serverTime - Date.now()));
      if (Number.isFinite(msLeft)) expiryTimer = setTimeout(() => shutdown(0, 'The approved time window has ended.'), Math.max(0, msLeft));
    });
  });

  socket.on('remote-input', (ev) => { if (injector) injector.handle(ev); });   // server-relay fallback path
  socket.on('control-halt', (d) => { if (monitor) monitor.lock(); if (d && d.reason === 'ended') shutdown(0, 'Session ended.'); });
  socket.on('control-resume', () => { if (monitor) monitor.rearm(); });
  socket.on('session-ended', () => shutdown(0, 'Session ended.'));
  socket.on('connect_error', (e) => {
    if (e.message === 'Authentication required') return shutdown(1, 'This agent token is expired or invalid. Create the ticket again.');
    log('warn', `Cannot reach ${cfg.SERVER_URL} (${e.message}). Retrying...`);
  });
  socket.on('disconnect', (reason) => log('warn', `Disconnected (${reason}). Vendor input is paused until the connection returns.`));
}

// ---------- start ----------
if (cfg.TOKEN) connect(cfg.TOKEN);                       // terminal / legacy start with a token already known
else if (hasParent) { log('info', 'Standby: waiting for the desktop app to start a session.'); notify({ type: 'standby' }); }
else { log('error', 'No agent token. Run this through the ScopeDesk desktop app, or set SCOPEDESK_AGENT_TOKEN for development.'); process.exit(1); }
