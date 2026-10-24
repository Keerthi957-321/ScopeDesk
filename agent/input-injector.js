'use strict';
// Applies the vendor's mouse/keyboard events on this PC through @nut-tree-fork/nut-js.
// Defence in depth: the server already validated the event, and it is validated again here.
// Mouse x/y arrive normalised (0..1) relative to the shared screen, so the vendor's window size does not matter.
// Assumes the Client shares their PRIMARY, ENTIRE screen (the web UI asks for that).

const fs = require('fs');
const { execFile } = require('child_process');
const { parseInput } = require('./validate');
let nut = null;
let screenSize = null;

function loadNut() {
  if (nut) return nut;
  nut = require('@nut-tree-fork/nut-js');
  nut.mouse.config.autoDelayMs = 0;
  nut.keyboard.config.autoDelayMs = 0;
  return nut;
}

// KeyboardEvent.code -> nut-js Key. Built defensively: a name missing in this nut-js version is simply not mapped.
function buildKeyMap(Key) {
  const map = {};
  const add = (code, name) => { if (Key[name] !== undefined) map[code] = Key[name]; };
  for (let c = 65; c <= 90; c++) { const L = String.fromCharCode(c); add('Key' + L, L); }
  for (let d = 0; d <= 9; d++) { add('Digit' + d, 'Num' + d); add('Numpad' + d, 'NumPad' + d); }
  for (let f = 1; f <= 12; f++) add('F' + f, 'F' + f);
  Object.entries({
    Enter: 'Enter', NumpadEnter: 'Enter', Escape: 'Escape', Tab: 'Tab', Space: 'Space', Backspace: 'Backspace', Delete: 'Delete',
    Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', CapsLock: 'CapsLock',
    ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
    ShiftLeft: 'LeftShift', ShiftRight: 'RightShift', ControlLeft: 'LeftControl', ControlRight: 'RightControl',
    AltLeft: 'LeftAlt', AltRight: 'RightAlt',
    Minus: 'Minus', Equal: 'Equal', BracketLeft: 'LeftBracket', BracketRight: 'RightBracket', Backslash: 'Backslash',
    Semicolon: 'Semicolon', Quote: 'Quote', Comma: 'Comma', Period: 'Period', Slash: 'Slash', Backquote: 'Grave'
  }).forEach(([code, name]) => add(code, name));
  return map;
}

class InputInjector {
  constructor({ monitor, log, viewOnly, policy, launcher = launchFileManager }) {
    this.monitor = monitor; this.log = log; this.viewOnly = viewOnly;
    this.policy = policy; this.launcher = launcher;
    this.keyMap = null;
    this.down = new Set();     // keys currently held, so they can all be released on halt
    this.buttons = new Set();
    this.queue = Promise.resolve();
    this.pending = 0;
    this.ready = false;
  }

  init() {
    if (this.viewOnly) { this.log('info', 'VIEW_ONLY=true: vendor input will not be applied.'); return false; }
    try {
      loadNut();
      this.keyMap = buildKeyMap(nut.Key);
      this.ready = true;
    } catch (err) {
      this.log('warn', `Remote control is OFF (could not load nut-js: ${err.message}). The vendor can watch but not control.`);
    }
    return this.ready;
  }

  // Events are applied strictly in order; if the queue backs up, mouse moves are dropped first
  handle(raw) {
    const event = parseInput(raw);
    if (!event || this.state === 'locked') return;
    if (event.t === 'open') { this.openFolder(event.p).catch((e) => this.log('warn', 'Open folder error: ' + e.message)); return; }
    if (!this.ready) return;
    if (this.pending > 150 && event.t === 'move') return;
    this.pending++;
    this.queue = this.queue
      .then(() => this.apply(event))
      .catch((e) => this.log('warn', 'Input error: ' + e.message))
      .finally(() => { this.pending--; });
  }

  get state() { return this.monitor.state; }

  async apply(event) {
    if (!(await this.monitor.permit(event))) return;
    const { mouse, keyboard, screen, Point, Button } = nut;

    if (event.t === 'key') return this.applyKey(event);

    if (event.t === 'wheel') {
      const steps = Math.max(1, Math.round(Math.abs(event.dy || event.dx) / 40));
      if (event.dy > 0) await mouse.scrollDown(steps); else if (event.dy < 0) await mouse.scrollUp(steps);
      else if (event.dx > 0) await mouse.scrollRight(steps); else if (event.dx < 0) await mouse.scrollLeft(steps);
      return;
    }

    if (!screenSize) screenSize = { w: await screen.width(), h: await screen.height() };
    await mouse.setPosition(new Point(Math.round(event.x * (screenSize.w - 1)), Math.round(event.y * (screenSize.h - 1))));
    if (event.t === 'down' || event.t === 'up') {
      const button = [Button.LEFT, Button.MIDDLE, Button.RIGHT][event.b];
      if (event.t === 'down') { await mouse.pressButton(button); this.buttons.add(button); }
      else { await mouse.releaseButton(button); this.buttons.delete(button); }
    }
  }

  // Vendor asked to open a folder. The check is case-insensitive (policy.js normalises "C:\\BillingData", "c:\\billingdata", ...)
  // and compares whole path segments. Anything outside the task's allowed folders is a scope violation: the monitor locks
  // input, the server is told, and the desktop app freezes the data channel and shows a system notification.
  async openFolder(requested) {
    if (this.viewOnly) return;
    const p = String(requested || '').trim();
    const allowed = this.policy && this.policy.allowedPaths.length > 0 && this.policy.pathAllowed(p);
    if (!allowed) {
      this.log('warn', `Vendor asked for a folder outside the approved paths: ${p}`);
      this.monitor.flag({ kind: 'path', name: 'File Manager', detail: p });
      return;
    }
    const stat = await fs.promises.stat(p).catch(() => null);
    if (!stat || !stat.isDirectory()) return this.log('info', `Folder does not exist, nothing opened: ${p}`);
    this.log('info', `Opening approved folder: ${p}`);
    this.launcher(p);
  }

  async applyKey({ k, d }) {
    // Never let the vendor press the Windows/Command key, or use Alt+Tab / Alt+F4 / Ctrl+Esc to leave the approved app
    if (/^Meta|^OS/.test(k)) return;
    const alt = this.down.has('AltLeft') || this.down.has('AltRight');
    const ctrl = this.down.has('ControlLeft') || this.down.has('ControlRight');
    if ((alt && (k === 'Tab' || k === 'F4' || k === 'Escape')) || (ctrl && k === 'Escape')) return;

    const key = this.keyMap[k];
    if (key === undefined) return;
    if (d) { await nut.keyboard.pressKey(key); this.down.add(k); }
    else { await nut.keyboard.releaseKey(key); this.down.delete(k); }
  }

  // Called on halt/exit so no key or mouse button stays stuck down on the Client's PC
  async releaseAll() {
    if (!this.ready) return;
    try {
      for (const code of [...this.down]) { if (this.keyMap[code] !== undefined) await nut.keyboard.releaseKey(this.keyMap[code]); }
      for (const b of [...this.buttons]) await nut.mouse.releaseButton(b);
    } catch (_) { /* best effort */ }
    this.down.clear(); this.buttons.clear();
  }
}

// execFile with an argument array: the path is never passed through a shell, so it cannot inject commands
function launchFileManager(folder) {
  const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [folder]]
    : process.platform === 'darwin' ? ['open', [folder]] : ['xdg-open', [folder]];
  execFile(cmd, args, { windowsHide: false }, () => { /* explorer.exe exits with code 1 even on success */ });
}

module.exports = { InputInjector, buildKeyMap };
