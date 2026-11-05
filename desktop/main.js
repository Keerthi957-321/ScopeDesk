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
const { app, BrowserWindow, ipcMain, session, desktopCapturer, shell, Notification, net, Menu, dialog, systemPreferences } = require('electron');
app.setAppUserModelId('com.scopedesk.desktop');   // Windows needs this for native notifications to appear
const path = require('path');
const fs = require('fs');
const { createAgentRunner } = require('./agent-runner');
const { validateAgentConfig, isTrustedSender } = require('./validate');
const { resolveServerUrl } = require('./config');
const { installDisplayMediaHandler } = require('./display-media-handler');
const { buildReport } = require('./diagnostics');

// The server lives on Railway; nothing is started on this computer except the host agent, and only during a session.
const AGENT_DIR = app.isPackaged ? path.join(process.resourcesPath, 'agent') : path.join(__dirname, '..', 'agent');
const CONFIG_FILE = app.isPackaged ? path.join(process.resourcesPath, 'app-config.json') : path.join(__dirname, '..', 'public', 'app-config.json');
const target = resolveServerUrl({ env: process.env, readConfigFile: () => fs.readFileSync(CONFIG_FILE, 'utf8') });
const SERVER_URL = target.url;   // '' when no valid address is configured

let win = null, runner = null;
let lastDisplayDenial = '';
let selectedDisplayId = null;  // the display the Client chose to share (null = primary)
let selectedWindowId = null;   // or ONE window the Client chose in the picker (then the vendor can only watch)
let onCaptureGranted = null;   // set in setupAgentIpc: tells the host agent what is being shared   // why the last screen-capture request was refused (shown to the Client so a cancel is never a mystery)

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

// ScopeDesk's own window position, in the same units the agent's mouse uses. The agent refuses vendor clicks inside it, so the
// vendor can never press Stop / Terminate / alert switches in the Client's ScopeDesk.
function ownWindowBounds() {
  if (!win || win.isDestroyed() || win.isMinimized() || !win.isVisible()) return null;
  let r = win.getBounds();
  if (process.platform === 'win32') { try { r = require('electron').screen.dipToScreenRect(win, r); } catch (_) { /* keep DIP */ } }
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}
function reportOwnWindow() { if (runner) runner.setOwnWindow(ownWindowBounds()); }

function isRazorpayUrl(url) {
  try { const u = new URL(url); return u.protocol === 'https:' && (u.hostname === 'razorpay.com' || u.hostname.endsWith('.razorpay.com')); } catch (_) { return false; }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 980, minHeight: 640, show: false, backgroundColor: '#0b1a24', title: 'ScopeDesk',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; reportOwnWindow(); });
  ['move', 'resize', 'minimize', 'restore', 'maximize', 'unmaximize', 'show', 'hide', 'enter-full-screen', 'leave-full-screen'].forEach((ev) => win.on(ev, reportOwnWindow));
  win.webContents.setWindowOpenHandler(({ url }) => {
    // The Vendor's full-screen workspace is the one window the page may open (same origin, remote-viewport.html only)
    if (isTrustedSender(url, SERVER_URL) && /\/remote-viewport\.html(\?|$)/.test(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 1600, height: 900, autoHideMenuBar: true, backgroundColor: '#000000', title: 'ScopeDesk - Remote workspace', webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } } };
    }
    // Razorpay Checkout opens its own popup for netbanking / card 3-D Secure. It must stay inside the app (an external browser
    // cannot report the result back to the page). Isolated, no preload, no Node: it is just a web page from Razorpay.
    if (isRazorpayUrl(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 480, height: 720, autoHideMenuBar: true, title: 'Secure payment', webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } } };
    }
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-create-window', (child, details) => {
    if (details && isRazorpayUrl(details.url)) {
      // Payment popup: the bank's pages are on other domains, so navigation inside it is allowed, but it never opens more windows
      child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      return;
    }
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
  // 'media' is what Chromium asks for when a page calls getDisplayMedia(); without it the share is refused with
  // 'permission "media" refused' and the Share button never works. It is allowed ONLY for the trusted ScopeDesk page and
  // never for the microphone or camera (audio/video capture devices are still denied).
  const allowed = new Set(['notifications', 'display-capture', 'media', 'clipboard-sanitized-write']);
  const mayUse = (permission, url, details) => {
    if (!allowed.has(permission) || !isTrustedSender(url, SERVER_URL)) return false;
    if (permission === 'media') {
      const types = (details && details.mediaTypes) || [];
      if (types.includes('audio')) return false;                       // no microphone
      if (details && details.mediaType === 'audio') return false;
    }
    return true;
  };
  ses.setPermissionRequestHandler((_wc, permission, cb, details) => {
    const ok = mayUse(permission, details && details.requestingUrl, details);
    if (!ok) lastDisplayDenial = `permission "${permission}" refused for ${String((details && details.requestingUrl) || 'unknown')}`.slice(0, 200);
    cb(ok);
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) =>
    mayUse(permission, requestingOrigin || (details && details.requestingUrl) || '', details));
  // "Share my screen": the page asks for the screen; the Client has just confirmed in the app's share dialog.
  // The primary screen is offered directly (no picker to operate). A refusal records its reason for the page.
  installDisplayMediaHandler({
    session: ses, desktopCapturer,
    screen: { getPrimaryDisplay: () => require('electron').screen.getPrimaryDisplay() },   // 'screen' may only be touched after app ready
    preferredDisplayId: () => selectedDisplayId,
    preferredWindowId: () => selectedWindowId,
    // Only what is REALLY being captured decides how the host agent maps input: a screen (control) or one window (watch only)
    onGrant: (g) => { if (onCaptureGranted) onCaptureGranted(g); },
    allowedOrigins: SERVER_URL ? [SERVER_URL] : [],
    log: (m) => console.log(m),
    onDeny: (why) => { lastDisplayDenial = String(why || '').slice(0, 200); }
  });
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
    log: (line) => console.log(line),          // the host agent's own log (states, reasons; never typed text) in the terminal
    onViolation: onScopeViolation,
    onStatus: (s) => {
      const active = ['connected', 'running', 'starting'].includes(s.phase);
      setTitle(active);
      if (active && !wasActive) notify('ScopeDesk', 'Remote control is active for the approved task. Close ScopeDesk or press Stop to end it.');
      if (!active && wasActive) {
        // Say WHY: "ended" is for a normal end, an error gets its real reason
        if (s.phase === 'error') notify('ScopeDesk', `Remote control could not run: ${String(s.detail || 'the host agent stopped').slice(0, 200)}`);
        else notify('ScopeDesk', 'Remote control has ended.');
      }
      wasActive = active;
      if (win && !win.isDestroyed()) win.webContents.send('agent:status', s);
    }
  });
  const trusted = (event) => isTrustedSender(event.senderFrame ? event.senderFrame.url : '', SERVER_URL);

  // Page -> main: "a ticket was created/accepted, run this session". Fire-and-forget (ipcRenderer.send).
  ipcMain.on('init-session', (event, cfg) => {
    if (!trusted(event)) return;
    const v = validateAgentConfig(cfg);
    let r = v;
    // Remote control starts only on the Client's explicit action (approval dialog or Start button): the page marks that with manual: true.
    // Anything else (a refresh, an old page, a reconnect) is ignored here, whatever the page does.
    if (v.ok && !v.value.manual) { console.log('[ScopeDesk] init-session ignored: not an explicit start by the Client'); return; }
    if (v.ok) {
      const value = { ...v.value };
      // macOS refuses synthetic mouse/keyboard input until the Client switches ScopeDesk on under Privacy & Security > Accessibility.
      // Without this check the vendor would see the screen and every click would vanish without a word.
      // Linux: Wayland sessions do not allow one program to move the mouse or type into another (and cannot report the window in
      // front). Screen sharing still works; control needs an "X11 / Xorg" session.
      if (process.platform === 'linux' && /wayland/i.test(String(process.env.XDG_SESSION_TYPE || '')) ) {
        value.viewOnly = true;
        value.blockReason = 'This Linux desktop runs Wayland, which does not let ScopeDesk control the mouse and keyboard. Log out, click the gear icon on the login screen, choose "Ubuntu on Xorg" (or "GNOME on Xorg"), log in and start again.';
      }
      if (process.platform === 'darwin') {
        let trustedMac = true;
        try { trustedMac = systemPreferences.isTrustedAccessibilityClient(value.manual); } catch (_) { /* old Electron: assume allowed */ }   // manual start also shows the macOS prompt
        if (!trustedMac) {
          value.viewOnly = true;
          value.blockReason = 'macOS has not allowed ScopeDesk to control this Mac. Open System Settings > Privacy & Security > Accessibility, switch ScopeDesk on, then quit and reopen ScopeDesk.';
        }
      }
      r = runner.init(value);
      reportOwnWindow();
    }
    if (!r.ok) runner.fail(r.error);                      // goes through the runner so it gets a proper sequence number
  });
  ipcMain.handle('agent:end-task', (event, taskId) => { if (trusted(event)) runner.endTask(Number(taskId), 'ended'); return { ok: true }; });
  // Vendor input frames from the Client window's data channel. High frequency, so no reply and no logging.
  ipcMain.on('agent:input', (event, frame) => { if (trusted(event) && typeof frame === 'string') runner.input(frame); });
  ipcMain.on('agent:freeze', (event) => { if (trusted(event)) runner.freeze(); });
  ipcMain.handle('agent:stop', (event) => (trusted(event) ? runner.stop('stopped by the Client') : { ok: false, error: 'Untrusted sender.' }));
  ipcMain.handle('agent:status', (event) => (trusted(event) ? runner.status() : null));
  // Multi-monitor. The list holds ids, sizes and positions only. Bounds are in the same units the agent's mouse uses.
  // On Windows the input library works in physical pixels, Electron in scaled (DIP) units: convert so a 150 % display maps exactly.
  const displayInfo = (d, primaryId) => {
    let r = d.bounds;
    if (process.platform === 'win32') { try { r = require('electron').screen.dipToScreenRect(null, d.bounds); } catch (_) { /* keep DIP */ } }
    return { id: String(d.id), label: d.label || '', x: r.x, y: r.y, width: r.width, height: r.height, primary: d.id === primaryId };
  };
  onCaptureGranted = (g) => {
    const { screen } = require('electron');
    const primaryId = screen.getPrimaryDisplay().id;
    if (g.windowId) {
      // "window:<native handle>:0" -> the agent maps the vendor's positions onto that window and brings it to the front on a click
      const handle = Number(String(g.windowId).split(':')[1]);
      runner.setDisplay(Number.isFinite(handle) ? { window: { handle } } : { windowOnly: true });
      console.log('[ScopeDesk] sharing one window' + (Number.isFinite(handle) ? ' (vendor input mapped onto it)' : ' (watch only)'));
      return;
    }
    const d = screen.getAllDisplays().find((x) => String(x.id) === String(g.displayId)) || screen.getPrimaryDisplay();
    runner.setDisplay(displayInfo(d, primaryId));
    console.log(`[ScopeDesk] sharing screen ${d.bounds.width}x${d.bounds.height}${d.id === primaryId ? ' (primary)' : ''}`);
  };
  ipcMain.handle('displays:list', (event) => {
    if (!trusted(event)) return [];
    const { screen } = require('electron');
    const primaryId = screen.getPrimaryDisplay().id;
    return screen.getAllDisplays().map((d) => displayInfo(d, primaryId));
  });
  ipcMain.handle('displays:select', (event, id) => {
    if (!trusted(event)) return { ok: false };
    const { screen } = require('electron');
    const primaryId = screen.getPrimaryDisplay().id;
    const d = screen.getAllDisplays().find((x) => String(x.id) === String(id));
    if (!d) return { ok: false, error: 'That display is not connected.' };
    selectedWindowId = null;
    selectedDisplayId = d.id;
    console.log(`[ScopeDesk] chosen display: ${d.bounds.width}x${d.bounds.height}${d.id === primaryId ? ' (primary)' : ''}`);
    return { ok: true };
  });
  // SCREEN / WINDOW PICKER (Electron has no built-in picker on Windows/Linux). The page shows these as tiles; the Client clicks one.
  // Screens allow remote control. A single window can only be WATCHED: positions inside a window cannot be mapped safely onto the
  // real desktop (it moves, overlaps, changes size), so the host agent turns input off while a window is shared.
  ipcMain.handle('sources:list', async (event) => {
    if (!trusted(event)) return [];
    const { screen } = require('electron');
    const primaryId = String(screen.getPrimaryDisplay().id);
    const own = new Set(BrowserWindow.getAllWindows().map((w) => { try { return w.getMediaSourceId(); } catch (_) { return ''; } }));
    let sources = [];
    try { sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: false }); }
    catch (err) { console.log('[ScopeDesk] picker: could not list sources: ' + (err && err.message)); return []; }
    let n = 0;
    return sources
      .filter((s) => s && !own.has(s.id) && !(s.id.startsWith('window:') && /^ScopeDesk\b/.test(s.name || '')))   // never ScopeDesk itself
      .map((s) => {
        const screenSrc = s.id.startsWith('screen:');
        return {
          id: s.id, type: screenSrc ? 'screen' : 'window',
          name: screenSrc ? `Screen ${++n}${String(s.display_id) === primaryId ? ' (main)' : ''}` : String(s.name || 'Window').slice(0, 80),
          displayId: screenSrc ? String(s.display_id || '') : '', primary: screenSrc && String(s.display_id) === primaryId,
          thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : ''
        };
      });
  });
  ipcMain.handle('sources:select', (event, choice) => {
    if (!trusted(event) || !choice || typeof choice.id !== 'string') return { ok: false };
    const { screen } = require('electron');
    const primaryId = screen.getPrimaryDisplay().id;
    if (choice.id.startsWith('window:')) {
      selectedWindowId = choice.id;
      console.log('[ScopeDesk] picker: one window chosen');
      return { ok: true, windowOnly: true };
    }
    const d = screen.getAllDisplays().find((x) => String(x.id) === String(choice.displayId)) || screen.getPrimaryDisplay();
    selectedWindowId = null;
    selectedDisplayId = d.id;
    console.log(`[ScopeDesk] picker: screen ${d.bounds.width}x${d.bounds.height}${d.id === primaryId ? ' (primary)' : ''}`);
    return { ok: true, windowOnly: false };
  });
  ipcMain.handle('display-media:last-denial', (event) => (trusted(event) ? lastDisplayDenial : ''));
}

// ---------- Help > Save diagnostics report ----------
// One click gives the Client a text file (no passwords or tokens) that shows whether the host agent and its modules are installed,
// its current state and its last log lines. Send that file to whoever supports ScopeDesk.
function saveDiagnostics() {
  try {
    const canResolve = (m) => { try { require.resolve(m, { paths: [AGENT_DIR] }); return true; } catch (_) { return false; } };
    const text = buildReport({
      appVersion: app.getVersion(), versions: process.versions, platform: process.platform, arch: process.arch, packaged: app.isPackaged,
      serverUrl: SERVER_URL, agentDir: AGENT_DIR, exists: (p) => fs.existsSync(p), canResolve,
      agentStatus: runner ? runner.status() : {}, agentLogs: runner ? runner.logs() : [], lastDisplayDenial,
      accessibilityTrusted: process.platform === 'darwin' ? (() => { try { return systemPreferences.isTrustedAccessibilityClient(false); } catch (_) { return null; } })() : null
    });
    const file = path.join(app.getPath('desktop'), 'ScopeDesk-diagnostics.txt');
    fs.writeFileSync(file, text, 'utf8');
    shell.showItemInFolder(file);
    dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, { type: 'info', title: 'ScopeDesk', message: 'Diagnostics report saved', detail: file + '\n\nIt contains no passwords or tokens. Send this file to your ScopeDesk support contact.' });
  } catch (err) {
    dialog.showErrorBox('ScopeDesk', 'Could not save the report: ' + String((err && err.message) || err));
  }
}

function installMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
    { label: 'Help', submenu: [{ label: 'Save diagnostics report', click: saveDiagnostics }] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---------- lifecycle ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    configureSession();
    setupAgentIpc();
    installMenu();
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
