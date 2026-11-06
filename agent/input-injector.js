'use strict';
// Applies the vendor's mouse/keyboard events on this PC through @nut-tree-fork/nut-js.
// Defence in depth: the server already validated the event, and it is validated again here.
// Mouse x/y arrive normalised (0..1) relative to the shared screen, so the vendor's window size does not matter.
// The shared screen is the PRIMARY display unless the Client picked another one (setDisplay()).
//
// CROSS-OS KEYBOARD (vendor OS comes with each key event as `o`: 'mac' | 'win' | 'linux'):
//   Windows/Linux vendor -> Mac Client : the vendor's Ctrl is pressed as Command, so Ctrl+C / Ctrl+V / Ctrl+Z ... work.
//   Mac vendor -> Windows/Linux Client : Cmd + an editing letter (C, V, X, Z, A, S, F ...) is pressed as Ctrl + that letter.
//   Mac vendor -> Mac Client           : Command is Command.
//   The Windows / Super key itself is never pressed on Windows/Linux.
// Printable characters arrive as text ('text') and are typed as characters, so a different keyboard layout or OS cannot turn
// "é" or "@" into a different key.
//
// Shortcuts that would leave the approved apps or end ScopeDesk are dropped on every OS:
//   Alt+Tab, Alt+F4, Alt+Esc, Ctrl+Esc (Start menu), Ctrl+Shift+Esc (Task Manager), Cmd+Tab, Cmd+Space (Spotlight), Cmd+Q,
//   Cmd+Option+Esc (Force Quit), Ctrl+Cmd+Q (lock), Control+Arrows on a Mac (Mission Control / Spaces).

const fs = require('fs');
const { execFile } = require('child_process');
const { parseInput } = require('./validate');
let nut = null;

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
  const add = (code, ...names) => { const n = names.find((x) => Key[x] !== undefined); if (n) map[code] = Key[n]; };
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
    Semicolon: 'Semicolon', Quote: 'Quote', Comma: 'Comma', Period: 'Period', Slash: 'Slash', Backquote: 'Grave',
    NumpadAdd: 'Add', NumpadSubtract: 'Subtract', NumpadMultiply: 'Multiply', NumpadDivide: 'Divide', NumpadDecimal: 'Decimal'
  }).forEach(([code, name]) => add(code, name));
  // Command (Mac) / Super: used only for the cross-OS mapping below, never pressed on Windows or Linux
  add('MetaLeft', 'LeftCmd', 'LeftSuper', 'LeftWin');
  add('MetaRight', 'RightCmd', 'RightSuper', 'RightWin');
  return map;
}

const CTRL = new Set(['ControlLeft', 'ControlRight']);
const META = new Set(['MetaLeft', 'MetaRight', 'OSLeft', 'OSRight']);
const ALT = new Set(['AltLeft', 'AltRight']);
const ARROWS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']);
// Mac vendor's Cmd + these letters becomes Ctrl + letter on Windows/Linux (copy, paste, cut, undo, redo, select all, find, save...)
const SHORTCUT_LETTERS = new Set(['KeyA', 'KeyC', 'KeyV', 'KeyX', 'KeyZ', 'KeyY', 'KeyF', 'KeyS', 'KeyP', 'KeyN', 'KeyO', 'KeyW', 'KeyT', 'KeyB', 'KeyI', 'KeyU']);

class InputInjector {
  constructor({ monitor, log, viewOnly, policy, launcher = launchFileManager, platform = process.platform, onStats = () => {} }) {
    this.monitor = monitor; this.log = log; this.viewOnly = viewOnly;
    // What happened to the vendor's actions, for the vendor's "Control check" (counts and a reason only, never the content)
    this.stats = { applied: 0, refused: 0, reason: '', appliedAt: 0, refusedAt: 0 };
    this.onStats = onStats;
    this.policy = policy; this.launcher = launcher;
    this.hostMac = platform === 'darwin';
    this.keyMap = null;
    this.down = new Map();     // vendor key code -> the host key code really pressed (so the right key is released)
    this.buttons = new Set();
    this.vendorMeta = false;   // Mac vendor holds Cmd (not pressed on Windows/Linux, see SHORTCUT_LETTERS)
    this.ctrlForMeta = false;  // we pressed Ctrl on the vendor's Cmd behalf
    this.queue = Promise.resolve();
    this.pending = 0;
    this.ready = false;
    this.reason = '';          // why input is off, in words the Client can read
    this.display = null;       // { x, y, width, height, primary } of the shared display (null = primary)
    this.windowOnly = false;   // a single window is shared and cannot be located on this OS: watch only
    this.windowHandle = null;  // a single window is shared: positions are mapped onto THAT window (AnyDesk-style window session)
    this.windowRectCache = { at: 0, rect: null };
    this.ownWindow = null;     // ScopeDesk's own window on screen: the vendor's clicks there are refused (no pressing Stop for the Client)
    this.droppedButtons = new Set();
    this.screenSize = null;
  }

  init() {
    if (this.viewOnly) { this.reason = 'View-only mode: the vendor can watch but not control.'; this.log('info', 'VIEW_ONLY=true: vendor input will not be applied.'); return false; }
    try {
      loadNut();
      this.keyMap = buildKeyMap(nut.Key);
      this.ready = true;
    } catch (err) {
      // Most common cause on a SECOND computer: the ScopeDesk folder was copied with the first computer's installed packages, which
      // are built for that operating system only. Say how to fix it, in the words the client (and the vendor's Control check) reads.
      const script = process.platform === 'win32' ? 'start-desktop-windows.bat' : 'start-desktop-mac-linux.command';
      const sep = process.platform === 'win32' ? '\\' : '/';
      this.reason = `The input library could not start on this computer (${String(err && err.message || err).split('\n')[0].slice(0, 60)}). `
        + `Fix: run desktop${sep}${script} once on this PC (copied from another computer? delete agent${sep}node_modules first).`;
      this.log('warn', `Remote control is OFF (could not load nut-js: ${err.message}). The vendor can watch but not control.`);
    }
    return this.ready;
  }

  /** The Client chose which display is shared. Positions are then mapped onto THAT display. */
  setDisplay(d) {
    // One WINDOW is shared (not a screen): the vendor may watch, but input is off. A window moves, overlaps and resizes, so a
    // position in the vendor's picture cannot be mapped safely onto this desktop.
    this.windowOnly = !!(d && d.windowOnly);
    this.windowHandle = d && d.window && Number.isFinite(Number(d.window.handle)) ? Number(d.window.handle) : null;
    this.windowRectCache = { at: 0, rect: null };
    if (this.windowHandle !== null) {
      this.display = null; this.screenSize = null;
      // The OS input library must be able to find the window; otherwise fall back to watch-only (never guess positions)
      if (!nut || typeof nut.getWindows !== 'function') { this.windowHandle = null; this.windowOnly = true; this.log('warn', 'Shared: one window, but this input library cannot locate windows: watch only'); return; }
      this.log('info', 'Shared: one window (vendor input is mapped onto it)');
      return;
    }
    if (this.windowOnly) { this.display = null; this.screenSize = null; this.log('info', 'Shared: one window (vendor input is off)'); return; }
    const ok = d && [d.x, d.y, d.width, d.height].every((n) => Number.isFinite(n)) && d.width > 0 && d.height > 0;
    this.display = ok ? { x: d.x, y: d.y, width: d.width, height: d.height, primary: d.primary === true } : null;
    this.screenSize = null;
    this.log('info', this.display && !this.display.primary ? `Shared display: ${d.width}x${d.height} at ${d.x},${d.y}` : 'Shared display: primary');
  }

  // Events are applied strictly in order; if the queue backs up, mouse moves are dropped first
  refuse(event, reason) {
    if (event && event.t === 'move') return false;                 // pointer moves are not "actions"
    this.stats.refused += 1; this.stats.reason = String(reason || '').slice(0, 240); this.stats.refusedAt = Date.now();
    this.onStats(this.stats);
    return false;
  }
  done(event) {
    if (event && event.t === 'move') return;
    this.stats.applied += 1; this.stats.appliedAt = Date.now();
    this.onStats(this.stats);
  }
  handle(raw) {
    const event = parseInput(raw);
    if (!event) return;
    if (this.state === 'locked') return this.refuse(event, 'Control is locked after a scope alert on the client\'s PC.');
    if (this.windowOnly) return this.refuse(event, 'Only one window is shared and this PC cannot locate it: ask the client to share the Entire Screen.');
    if (event.t === 'open') { this.openFolder(event.p).catch((e) => this.log('warn', 'Open folder error: ' + e.message)); return; }
    if (!this.ready) return this.refuse(event, this.reason || 'The client\'s PC cannot apply input.');
    if (this.pending > 150 && event.t === 'move') return;
    this.pending++;
    this.queue = this.queue
      .then(() => this.apply(event).then((ok) => { if (ok) this.done(event); }))
      .catch((e) => this.log('warn', `Input error (${event.t}): ` + e.message))   // the event type only, never its content
      .finally(() => { this.pending--; });
  }

  get state() { return this.monitor.state; }

  /** ScopeDesk's own window rectangle (same units as positions) or null when it is minimised / hidden. */
  setOwnWindow(b) {
    const ok = b && [b.x, b.y, b.width, b.height].every((n) => Number.isFinite(n)) && b.width > 0 && b.height > 0;
    this.ownWindow = ok ? { x: b.x, y: b.y, width: b.width, height: b.height } : null;
  }
  insideOwnWindow(p) {
    const w = this.ownWindow;
    return !!w && p.x >= w.x && p.x < w.x + w.width && p.y >= w.y && p.y < w.y + w.height;
  }

  // The shared window's current rectangle (it may have moved or been resized since the last event). Cached for 250 ms.
  async windowRect() {
    if (Date.now() - this.windowRectCache.at < 250 && this.windowRectCache.rect) return this.windowRectCache.rect;
    const wins = await nut.getWindows();
    const w = (wins || []).find((x) => Number(x.windowHandle) === this.windowHandle);
    if (!w) return null;
    const r = typeof w.getRegion === 'function' ? await w.getRegion() : await w.region;
    const rect = r && r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, width: r.width, height: r.height, win: w } : null;
    this.windowRectCache = { at: Date.now(), rect };
    return rect;
  }

  async point(x, y) {
    if (this.windowHandle !== null) {
      const r = await this.windowRect();
      if (!r) return null;                                            // the shared window was closed or minimised
      return new nut.Point(Math.round(r.x + x * (r.width - 1)), Math.round(r.y + y * (r.height - 1)));
    }
    const d = this.display;
    if (d && !d.primary) return new nut.Point(Math.round(d.x + x * (d.width - 1)), Math.round(d.y + y * (d.height - 1)));
    if (!this.screenSize) this.screenSize = { w: await nut.screen.width(), h: await nut.screen.height() };
    return new nut.Point(Math.round(x * (this.screenSize.w - 1)), Math.round(y * (this.screenSize.h - 1)));
  }

  async apply(event) {
    if (!(await this.monitor.permit(event))) return this.refuse(event, this.monitor.lastRefusal || 'Not inside the approved scope.');
    return (await this.applyNow(event)) !== false;
  }
  async applyNow(event) {
    const { mouse, Button } = nut;

    if (event.t === 'key') return this.applyKey(event);
    if (event.t === 'text') return nut.keyboard.type(event.s);
    if (event.t === 'clip') return this.paste(event);

    if (event.t === 'wheel') {
      const steps = Math.max(1, Math.round(Math.abs(event.dy || event.dx) / 40));
      if (event.dy > 0) await mouse.scrollDown(steps); else if (event.dy < 0) await mouse.scrollUp(steps);
      else if (event.dx > 0) await mouse.scrollRight(steps); else if (event.dx < 0) await mouse.scrollLeft(steps);
      return;
    }

    const p = await this.point(event.x, event.y);
    if (!p) return this.refuse(event, 'The shared window was closed or minimised on the client\'s PC.');
    // Never let the vendor click INSIDE ScopeDesk's own window (Stop / Terminate / alert switches belong to the Client)
    if (event.t === 'down' && this.insideOwnWindow(p)) { this.droppedButtons.add(event.b); this.log('info', 'Vendor click on the ScopeDesk window ignored'); return this.refuse(event, 'That click was on the client\'s ScopeDesk window, which you may not use. Click the approved app instead.'); }
    if (event.t === 'up' && this.droppedButtons.delete(event.b)) return false;
    await mouse.setPosition(p);
    if (event.t === 'down' && this.windowHandle !== null) {
      // Window session: bring the shared window to the front first, so the click lands on it and not on whatever covers it
      const r = await this.windowRect();
      if (r && r.win && typeof r.win.focus === 'function') { try { await r.win.focus(); } catch (_) { /* best effort */ } }
    }
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

  held(set) { for (const host of this.down.values()) if (set.has(host)) return true; return false; }

  /**
   * Pure decision for one key event: which HOST key to press/release, or null to drop it. Exported behaviour is tested.
   * @returns {{ host: string|null, ctrlFirst?: boolean, why?: string }}
   */
  translateKey({ k, d, o }) {
    const vendorMac = o ? o === 'mac' : this.hostMac;
    if (CTRL.has(k)) return { host: this.hostMac && !vendorMac ? (k === 'ControlLeft' ? 'MetaLeft' : 'MetaRight') : k };
    if (META.has(k)) {
      if (this.hostMac && vendorMac) return { host: k.endsWith('Right') ? 'MetaRight' : 'MetaLeft' };
      if (vendorMac) { this.vendorMeta = d; return { host: null, why: 'held as Cmd' }; }
      return { host: null, why: 'The Windows / Super key is not allowed.' };
    }
    if (!d) return { host: k };
    const alt = this.held(ALT), ctrl = this.held(CTRL), cmd = this.held(META);
    if (alt && (k === 'Tab' || k === 'F4' || k === 'Escape')) return { host: null, why: 'Alt+Tab / Alt+F4 / Alt+Esc are not allowed.' };
    if (!this.hostMac && ctrl && k === 'Escape') return { host: null, why: 'Ctrl+Esc / Ctrl+Shift+Esc are not allowed.' };
    if (this.hostMac && cmd && (k === 'Tab' || k === 'Space' || k === 'KeyQ' || (alt && k === 'Escape'))) return { host: null, why: 'This Command shortcut is not allowed.' };
    if (this.hostMac && ctrl && ARROWS.has(k)) return { host: null, why: 'Mission Control / Spaces shortcuts are not allowed.' };
    if (!this.hostMac && this.vendorMeta) {
      if (SHORTCUT_LETTERS.has(k)) return { host: k, ctrlFirst: true };
      return { host: null, why: 'This Command shortcut has no Windows/Linux equivalent here.' };
    }
    return { host: k };
  }

  async applyKey(ev) {
    const { k, d } = ev;
    const r = this.translateKey(ev);
    if (!d) {
      if (META.has(k) && !this.hostMac && this.ctrlForMeta) { await nut.keyboard.releaseKey(this.keyMap.ControlLeft); this.ctrlForMeta = false; }
      const host = this.down.get(k);
      if (host === undefined) return;
      this.down.delete(k);
      if (this.keyMap[host] !== undefined) await nut.keyboard.releaseKey(this.keyMap[host]);
      return;
    }
    if (!r.host || this.keyMap[r.host] === undefined) return;
    if (r.ctrlFirst && !this.ctrlForMeta) { await nut.keyboard.pressKey(this.keyMap.ControlLeft); this.ctrlForMeta = true; }
    await nut.keyboard.pressKey(this.keyMap[r.host]);
    this.down.set(k, r.host);
  }

  // Vendor pasted text: it goes on THIS PC's clipboard, then the paste shortcut is pressed inside the approved app.
  // Only vendor -> Client: nothing on the Client's clipboard is ever sent to the vendor.
  async paste(ev) {
    if (ev.s && nut.clipboard && typeof nut.clipboard.setContent === 'function') await nut.clipboard.setContent(ev.s);
    const modifierHeld = this.held(this.hostMac ? META : CTRL) || this.ctrlForMeta || (!this.hostMac && this.vendorMeta);
    if (modifierHeld) { await this.applyKey({ k: 'KeyV', d: true, o: ev.o }); await this.applyKey({ k: 'KeyV', d: false, o: ev.o }); return; }
    const mod = this.keyMap[this.hostMac ? 'MetaLeft' : 'ControlLeft'];   // pasted from a menu: press the paste shortcut ourselves
    await nut.keyboard.pressKey(mod); await nut.keyboard.pressKey(this.keyMap.KeyV);
    await nut.keyboard.releaseKey(this.keyMap.KeyV); await nut.keyboard.releaseKey(mod);
  }

  // Called on halt/exit so no key or mouse button stays stuck down on the Client's PC
  async releaseAll() {
    if (!this.ready) return;
    try {
      for (const host of [...this.down.values()]) { if (this.keyMap[host] !== undefined) await nut.keyboard.releaseKey(this.keyMap[host]); }
      if (this.ctrlForMeta) await nut.keyboard.releaseKey(this.keyMap.ControlLeft);
      for (const b of [...this.buttons]) await nut.mouse.releaseButton(b);
    } catch (_) { /* best effort */ }
    this.down.clear(); this.buttons.clear(); this.ctrlForMeta = false; this.vendorMeta = false;
  }
}

// execFile with an argument array: the path is never passed through a shell, so it cannot inject commands
function launchFileManager(folder) {
  const [cmd, args] = process.platform === 'win32' ? ['explorer.exe', [folder]]
    : process.platform === 'darwin' ? ['open', [folder]] : ['xdg-open', [folder]];
  execFile(cmd, args, { windowsHide: false }, () => { /* explorer.exe exits with code 1 even on success */ });
}

module.exports = { InputInjector, buildKeyMap, SHORTCUT_LETTERS };
