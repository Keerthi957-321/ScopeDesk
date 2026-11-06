'use strict';
// The control bar (main.js), with a fake Electron: when remote control starts, ScopeDesk minimises and a small always-on-top bar
// appears WITHOUT taking keyboard focus; the agent is then told the bar's rectangle (not the big window's); only the bar's own
// page can press its buttons; Stop / End go to the main page; when control ends everything comes back.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const Module = require('module');

const windows = [];
const ipcHandlers = {};
let runnerOpts = null;
const ownWindowCalls = [];

class FakeWin {
  constructor(opts) {
    this.opts = opts || {}; this.listeners = {}; this.once_ = {}; this.minimized = false; this.visible = false; this.destroyed = false;
    this.bounds = { x: opts.x || 0, y: opts.y || 0, width: opts.width || 800, height: opts.height || 600 };
    this.sent = []; this.calls = [];
    this.webContents = { send: (ch, p) => this.sent.push([ch, p]), setWindowOpenHandler() {}, on() {}, session: {} };
    windows.push(this);
  }
  on(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); return this; }
  once(ev, fn) { this.once_[ev] = fn; return this; }
  emit(ev) { (this.listeners[ev] || []).forEach((f) => f()); if (this.once_[ev]) { const f = this.once_[ev]; delete this.once_[ev]; f(); } }
  show() { this.calls.push('show'); this.visible = true; this.emit('show'); }
  showInactive() { this.calls.push('showInactive'); this.visible = true; this.emit('show'); }
  focus() { this.calls.push('focus'); }
  minimize() { this.calls.push('minimize'); this.minimized = true; this.emit('minimize'); }
  restore() { this.calls.push('restore'); this.minimized = false; this.emit('restore'); }
  isMinimized() { return this.minimized; }
  isVisible() { return this.visible; }
  isDestroyed() { return this.destroyed; }
  close() { this.calls.push('close'); this.destroyed = true; this.visible = false; this.emit('closed'); }
  getBounds() { return { ...this.bounds }; }
  setTitle() {} setAlwaysOnTop(...a) { this.calls.push(['setAlwaysOnTop', ...a]); }
  loadFile(f) { this.file = f; setImmediate(() => this.emit('ready-to-show')); return Promise.resolve(); }
  loadURL() { return Promise.resolve(); }
  maximize() {}
}

const electron = {
  app: { requestSingleInstanceLock: () => true, on() {}, quit() {}, whenReady: () => Promise.resolve(), getPath: () => '/tmp', getVersion: () => '0.0.0', isPackaged: false, setAppUserModelId() {} },
  BrowserWindow: FakeWin,
  ipcMain: { on: (ch, fn) => { ipcHandlers[ch] = fn; }, handle: (ch, fn) => { ipcHandlers[ch] = fn; } },
  session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDisplayMediaRequestHandler() {}, webRequest: { onHeadersReceived() {} } } },
  desktopCapturer: { getSources: async () => [] },
  shell: { openExternal() {} },
  Notification: class { static isSupported() { return false; } show() {} on() {} },
  net: { fetch: async () => ({ ok: true, status: 200, json: async () => ({ app: 'scopedesk' }) }) },
  Menu: { setApplicationMenu() {}, buildFromTemplate: () => ({}) },
  dialog: { showErrorBox() {} },
  systemPreferences: { isTrustedAccessibilityClient: () => true },
  screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 }, bounds: { x: 0, y: 0, width: 1920, height: 1080 } }), dipToScreenRect: (_w, r) => r, getAllDisplays: () => [] }
};
const fakeRunner = {
  warm() {}, shutdown() {}, init: () => ({ ok: true }), fail() {}, status: () => ({ phase: 'stopped' }), input() {}, setDisplay() {}, endTask() {}, stop() {}, freeze() {},
  setOwnWindow: (b) => ownWindowCalls.push(b)
};

const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electron;
  if (request === './agent-runner' && parent && /desktop[\\/]main\.js$/.test(parent.filename)) return { createAgentRunner: (opts) => { runnerOpts = opts; return fakeRunner; } };
  return realLoad.call(this, request, parent, isMain);
};
process.env.SCOPEDESK_SERVER_URL = process.env.SCOPEDESK_SERVER_URL || 'https://scopedesk.example.com';
require(path.join(__dirname, '..', 'main.js'));
// the fake stays: main.js also loads electron lazily inside functions

const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (pred, ms = 2000) => { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await tick(10); } };

test('control bar: remote control running -> ScopeDesk steps aside, bar never takes focus, agent protects the bar; ends -> all back', async () => {
  await until(() => runnerOpts && windows.length >= 1);
  const main = windows[0];
  main.show();
  main.bounds = { x: 0, y: 0, width: 1920, height: 1040 };          // maximised
  runnerOpts.onStatus({ phase: 'running', uiState: 'waiting' });
  await until(() => windows.length >= 2);
  const bar = windows[1];
  assert.equal(bar.opts.focusable, false, 'the bar must never take keyboard focus from the approved app');
  assert.equal(bar.opts.alwaysOnTop, true);
  assert.equal(bar.opts.skipTaskbar, true);
  assert.match(bar.file, /mini-bar\.html$/);
  assert.match(bar.opts.webPreferences.preload, /mini-preload\.js$/);
  assert.equal(bar.opts.webPreferences.nodeIntegration, false);
  await until(() => bar.calls.includes('showInactive'));
  assert.ok(!bar.calls.includes('show') && !bar.calls.includes('focus'), 'shown without activating');
  await until(() => main.calls.includes('minimize'), 1500);
  const last = ownWindowCalls.at(-1);
  assert.deepEqual(last, bar.getBounds(), 'the agent now protects the bar, not the (minimised) big window');

  // only the bar's own page may press its buttons
  const fromBar = { sender: bar.webContents }, fromElsewhere = { sender: main.webContents };
  ipcHandlers['mini:action'](fromElsewhere, 'terminate');
  assert.equal(main.sent.filter(([c]) => c === 'mini:action').length, 0);
  ipcHandlers['mini:action'](fromBar, 'rm -rf');
  assert.equal(main.sent.filter(([c]) => c === 'mini:action').length, 0);
  ipcHandlers['mini:action'](fromBar, 'stop');
  assert.deepEqual(main.sent.filter(([c]) => c === 'mini:action').at(-1), ['mini:action', 'stop']);
  assert.ok(main.calls.includes('restore'), 'pressing a bar button brings ScopeDesk back');

  // what the bar shows comes from the trusted page only
  ipcHandlers['mini:info']({ senderFrame: { url: 'https://evil.example.com/' } }, { apps: 'Everything', endsAt: 1 });
  assert.ok(!bar.sent.some(([c, p]) => c === 'mini:info' && p.apps === 'Everything'));

  // control ends -> bar closes, window comes back, the big window is protected again
  runnerOpts.onStatus({ phase: 'stopped', uiState: 'idle' });
  assert.ok(bar.destroyed, 'bar closed');
  assert.ok(main.calls.lastIndexOf('restore') > main.calls.indexOf('minimize'));
  assert.deepEqual(ownWindowCalls.at(-1), main.getBounds());

  // a second session steps aside again
  runnerOpts.onStatus({ phase: 'running', uiState: 'waiting' });
  await until(() => windows.length >= 3);
  runnerOpts.onStatus({ phase: 'stopped' });
});
