'use strict';
// ScopeDesk desktop shell (Electron main process).
// Double-click the app: the window opens, the host agent is forked in STANDBY at the same moment (hidden, no terminal),
// and the live ScopeDesk server (Railway) loads in the window. When the Client creates a ticket, the page sends the
// session config with ipcRenderer.send('init-session') and the standby agent starts the session. No server runs on this computer.
//
// Safety rules built in:
//   * remote control exists only while this window is open: closing the window stops the agent (nothing keeps running hidden)
//   * the window title and a system notification say when remote control is active, and the page has a Stop button
//   * only the ScopeDesk page itself can call the agent IPC channels, and it can only send {taskId, token}
//   * the agent still enforces the task's allowed apps/folders and the time window (agent/policy.js, monitor.js)
const { app, BrowserWindow, ipcMain, session, desktopCapturer, shell, Notification, net } = require('electron');
app.setAppUserModelId('com.scopedesk.desktop');   // Windows needs this for native notifications to appear
const path = require('path');
const fs = require('fs');
const { createAgentRunner } = require('./agent-runner');
const { validateAgentConfig, isTrustedSender } = require('./validate');
const { resolveServerUrl } = require('./config');

// The server lives on Railway; nothing is started on this computer except the host agent, and only during a session.
const AGENT_DIR = app.isPackaged ? path.join(process.resourcesPath, 'agent') : path.join(__dirname, '..', 'agent');
const CONFIG_FILE = app.isPackaged ? path.join(process.resourcesPath, 'app-config.json') : path.join(__dirname, '..', 'public', 'app-config.json');
const target = resolveServerUrl({ env: process.env, readConfigFile: () => fs.readFileSync(CONFIG_FILE, 'utf8') });
const SERVER_URL = target.url;   // '' when no valid address is configured

let win = null, runner = null;

// ---------- helpers ----------
async function healthy(url) {
  try {
    const res = await net.fetch(`${url}/api/health`, { signal: AbortSignal.timeout(5000), cache: 'no-store' });
    if (!res.ok) return false;
    const d = await res.json();
    return !!(d && d.app === 'scopedesk');
  } catch (_) { return false; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// A Railway service that is restarting or redeploying can take a while: keep trying before giving up
async function waitForServer(url, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await healthy(url)) return true;
    await sleep(1500);
  }
  return false;
}

// ---------- window ----------
function setTitle(active) { if (win && !win.isDestroyed()) win.setTitle(active ? 'ScopeDesk - REMOTE CONTROL ACTIVE' : 'ScopeDesk'); }

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 980, minHeight: 640, show: false, backgroundColor: '#0b1a24', title: 'ScopeDesk',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
  win.webContents.setWindowOpenHandler(({ url }) => {
    // The Vendor's full-screen workspace is the one window the page may open (same origin, remote-viewport.html only)
    if (isTrustedSender(url, SERVER_URL) && /\/remote-viewport\.html(\?|$)/.test(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 1600, height: 900, autoHideMenuBar: true, backgroundColor: '#000000', title: 'ScopeDesk - Remote workspace', webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } } };
    }
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-create-window', (child) => {
    child.maximize();   // the workspace uses the whole display
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    child.webContents.on('will-navigate', (e, u) => { if (!isTrustedSender(u, SERVER_URL)) e.preventDefault(); });
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:') && !isTrustedSender(url, SERVER_URL)) e.preventDefault(); });
  win.loadFile(path.join(__dirname, 'splash.html'));
}

function showError(message) { if (win) win.loadFile(path.join(__dirname, 'splash.html'), { query: { error: message } }); }

function configureSession() {
  const ses = session.defaultSession;
  const allowed = new Set(['notifications', 'display-capture', 'clipboard-sanitized-write']);
  ses.setPermissionRequestHandler((_wc, permission, cb, details) => cb(allowed.has(permission) && isTrustedSender(details.requestingUrl, SERVER_URL)));
  // "Share my screen": the page asks for the screen; the Client has just confirmed in the app's share dialog.
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!isTrustedSender(request.securityOrigin, SERVER_URL)) return callback({});
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      callback(sources.length ? { video: sources[0] } : {});   // primary screen
    } catch (_) { callback({}); }
  }, { useSystemPicker: false });
}

// ---------- agent + IPC ----------
function notify(title, body, opts = {}) {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body, ...opts });
    n.on('click', () => { if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
    n.show();
  } catch (_) { /* optional */ }
}

// The vendor left the approved scope (an app or a folder outside the task). The agent has already locked input on this PC.
// Here, in this order and without waiting for the server: (1) tell the page to freeze the data channel and close the WebRTC
// link, (2) raise a native OS notification, (3) bring the window forward so the lockout controls are visible.
function onScopeViolation({ kind, processName, detail }) {
  const clean = (v) => String(v || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200);
  const p = clean(processName), d = clean(detail);
  if (runner) runner.freeze();
  if (win && !win.isDestroyed()) win.webContents.send('agent:lockout', { kind, processName: p, detail: d });
  const what = kind === 'path' ? `a folder outside the approved scope${d ? ` (${d})` : ''}` : `${p || 'an application'} that is not approved for this task`;
  notify('ScopeDesk security alert', `The vendor tried to open ${what}. Remote control was cut and the session is locked.`, { urgency: 'critical', timeoutType: 'never' });
  if (win && !win.isDestroyed()) { win.show(); win.focus(); }
}

function setupAgentIpc() {
  let wasActive = false;
  runner = createAgentRunner({
    agentDir: AGENT_DIR, serverUrl: SERVER_URL,
    onViolation: onScopeViolation,
    onStatus: (s) => {
      const active = ['connected', 'running', 'starting'].includes(s.phase);
      setTitle(active);
      if (active && !wasActive) notify('ScopeDesk', 'Remote control is active for the approved task. Close ScopeDesk or press Stop to end it.');
      if (!active && wasActive) notify('ScopeDesk', 'Remote control has ended.');
      wasActive = active;
      if (win && !win.isDestroyed()) win.webContents.send('agent:status', s);
    }
  });
  const trusted = (event) => isTrustedSender(event.senderFrame ? event.senderFrame.url : '', SERVER_URL);

  // Page -> main: "a ticket was created/accepted, run this session". Fire-and-forget (ipcRenderer.send).
  ipcMain.on('init-session', (event, cfg) => {
    if (!trusted(event)) return;
    const v = validateAgentConfig(cfg);
    const r = v.ok ? runner.init(v.value) : v;
    if (!r.ok && win && !win.isDestroyed()) win.webContents.send('agent:status', { phase: 'error', uiState: 'error', taskId: null, policy: '', detail: r.error });
  });
  // Vendor input frames from the Client window's data channel. High frequency, so no reply and no logging.
  ipcMain.on('agent:input', (event, frame) => { if (trusted(event) && typeof frame === 'string') runner.input(frame); });
  ipcMain.on('agent:freeze', (event) => { if (trusted(event)) runner.freeze(); });
  ipcMain.handle('agent:stop', (event) => (trusted(event) ? runner.stop('stopped by the Client') : { ok: false, error: 'Untrusted sender.' }));
  ipcMain.handle('agent:status', (event) => (trusted(event) ? runner.status() : null));
}

// ---------- lifecycle ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    configureSession();
    setupAgentIpc();
    createWindow();
    runner.warm();   // the same instant the window opens: the hidden background agent is already running, waiting for a ticket
    if (target.error) return showError(target.error);
    if (!(await waitForServer(SERVER_URL, 60000))) return showError(`Cannot reach ScopeDesk at ${SERVER_URL}. Check your internet connection, then open the app again.`);
    if (win) await win.loadURL(SERVER_URL);
  });
  app.on('window-all-closed', () => app.quit());       // every platform: closing the window ends everything
  app.on('before-quit', () => {
    if (runner) runner.shutdown();
  });
}
