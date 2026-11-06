'use strict';
// PROCESS + PATH SECURITY LOOP.
// Runs on the Client's PC, where the vendor's actions really land, so the vendor cannot tamper with it.
//
// A foreground window is "in scope" when BOTH hold:
//   1. its app is in the task policy's allowedApps (or is the task's approved app), and
//   2. if it is a file manager and the policy has allowedPaths: every folder it shows is inside an allowed path.
//
// States:  waiting -> armed -> locked
//   waiting  nothing in scope has been in front yet. Vendor input is ignored (view-only). The Client opens the app/folder.
//   armed    enforcement is on.
//   locked   a violation was reported (or the server halted control). Nothing is applied until the Client resumes.
//
// Two independent checks, so a fast vendor cannot slip between polls:
//   1. POLL:  every POLL_MS read the foreground. Out of scope + vendor input applied within ATTRIBUTION_MS -> violation
//             (a wrong folder at once, a wrong app after STRIKES polls to ignore Alt+Tab flicker).
//   2. GATE:  before applying any click/key/wheel, check again. Out of scope -> drop the input and report. (Pure mouse moves are
//             dropped but never reported, so the Client can still use their own browser to read the alert.)
const { normalize } = require('./config');

class ForegroundMonitor {
  constructor({ policy, probe, pollMs, strikes, attributionMs, onViolation, onState, onDiag, log, debug, ownPid = null }) {
    this.policy = policy; this.probe = probe;
    // ScopeDesk's own window (the desktop app that started this agent). Having it in front is NEUTRAL: never a violation, and
    // the vendor's clicks may go past it to the approved app. The injector separately refuses clicks INSIDE ScopeDesk's window.
    this.ownPid = Number.isInteger(ownPid) && ownPid > 0 ? ownPid : null;
    this.onDiag = typeof onDiag === 'function' ? onDiag : () => {};
    this.lastDiag = null;
    this.pollMs = pollMs; this.strikes = strikes; this.attributionMs = attributionMs;
    this.onViolation = onViolation; this.onState = onState; this.log = log; this.debug = !!debug;
    this.state = 'waiting';
    this.bad = 0;
    this.lastInputAt = 0;
    this.lastLabel = null;
    this.cache = { win: undefined, result: { ok: false }, at: 0 };
    this.timer = null;
    this.activeWindow = null;
  }

  setState(next) {
    if (this.state === next) return;
    this.state = next;
    this.bad = 0;
    this.onState(next);
  }

  async start() {
    // active-win 8.x is CommonJS (module.exports = fn), 9+ is ESM with a named export. import() works for both, but the function lives
    // in a different place: `.activeWindow` is undefined for 8.x, which used to leave this monitor unable to read any window
    // (state stuck on "waiting", vendor input never armed). Look in every place, and fail loudly instead of silently.
    const mod = await import('active-win');
    const fn = [mod.activeWindow, mod.default && mod.default.activeWindow, mod.default].find((f) => typeof f === 'function');
    if (!fn) throw new Error('The active-win package loaded but has no activeWindow() function (installed version is not supported).');
    this.activeWindow = fn;
    this.timer = setInterval(() => this.poll().catch((e) => this.readFailed(e)), this.pollMs);
  }

  // Reported once per change (never every poll). App names only: never window titles, typed text or file contents.
  diag(text) {
    if (text === this.lastDiag) return;
    this.lastDiag = text;
    if (text) this.onDiag(text);
  }
  readFailed(e) {
    const msg = String((e && e.message) || e || 'unknown error').split('\n')[0].slice(0, 160);
    const mac = process.platform === 'darwin' ? ' On macOS, allow ScopeDesk under System Settings > Privacy & Security > Accessibility AND Screen Recording, then reopen ScopeDesk.' : '';
    this.diag(`cannot read which app is in front (${msg}). Vendor input stays paused.${mac}`);
  }
  stop() { clearInterval(this.timer); this.timer = null; if (this.probe) this.probe.close(); }

  // -> { ok } | { ok:false, kind:'app'|'path', name, detail, soft? }   (soft = could not be verified; never reported, input is dropped)
  async evaluate(win) {
    if (!win || !win.owner) return { ok: false, kind: 'app', name: '(no foreground window)' };
    if ((this.ownPid && win.owner.processId === this.ownPid) || /^scopedesk$/i.test(String(win.owner.name || '').trim())) return { ok: false, neutral: true, kind: 'app', name: 'ScopeDesk' };
    const names = [win.owner.name, win.owner.path ? String(win.owner.path).split(/[\\/]/).pop() : ''].filter(Boolean);
    // Windows Store apps (Calculator, Photos, Settings...) run inside "ApplicationFrameHost" on many Windows builds, so the process
    // name never says "Calculator" and the session stayed "waiting" forever on those PCs. For that host only, the window title
    // (which Windows sets to the app's name, e.g. "Calculator") identifies the app.
    if (names.some((n) => /^applicationframehost(\.exe)?$/i.test(String(n).replace(/\s+/g, '')))) {
      const t = String(win.title || '').trim();
      if (t) names.push(t, t.split(/\s[-\u2013\u2014]\s/).pop().trim());
    }
    const norm = names.map(normalize);
    const label = win.owner.name || names[0] || 'unknown';

    if (!norm.some((n) => this.policy.apps.has(n))) return { ok: false, kind: 'app', name: label };

    const fileManager = norm.some((n) => this.policy.fileManagers.has(n));
    if (!fileManager || this.policy.allowedPaths.length === 0) return { ok: true };

    const folders = await this.probe.foldersFor(win);
    if (folders === undefined) return { ok: false, soft: true, kind: 'path', name: label, detail: 'folder could not be read' };
    if (folders.length === 0) {
      // Not a folder window. The desktop and taskbar have no title; a dialog (Properties, Delete...) has one and is allowed.
      const title = (win.title || '').trim();
      return title === '' || title === 'Program Manager' ? { ok: false, kind: 'path', name: label, detail: 'the desktop or taskbar' } : { ok: true };
    }
    const outside = folders.find((f) => !this.policy.pathAllowed(f));
    if (outside) return { ok: false, kind: 'path', name: label, detail: outside.startsWith('::') ? 'This PC or another virtual folder' : outside };
    return { ok: true };
  }

  async read(maxAgeMs = 0) {
    if (Date.now() - this.cache.at <= maxAgeMs) return this.cache;
    const win = await this.activeWindow();
    const result = await this.evaluate(win);
    this.cache = { win, result, at: Date.now() };
    return this.cache;
  }

  async poll() {
    if (this.state === 'locked') return;
    const { win, result } = await this.read();

    if (this.debug) {
      const label = win && win.owner ? `${win.owner.name} | ${win.owner.path} | id ${win.id} | "${win.title}"` : '(no foreground window)';
      const verdict = result.ok ? 'in scope' : `OUT OF SCOPE (${result.kind}: ${result.detail || result.name})`;
      if (label + verdict !== this.lastLabel) { this.lastLabel = label + verdict; this.log('info', `Foreground: ${label}  ->  ${verdict}`); }
    }

    if (this.state === 'waiting') {
      if (result.ok) { this.log('info', 'An in-scope window is in front. Enforcement is ON.'); this.diag(''); this.setState('armed'); }
      else if (result.neutral) this.diag('waiting: ScopeDesk is in front. Click the approved app (the vendor can also click it in the shared picture).');
      else if (!result.soft && Date.now() - this.lastInputAt <= this.attributionMs && (result.kind === 'path' || ++this.bad >= this.strikes)) this.flag(result);   // the vendor's click opened something else
      else {
        const front = (win && win.owner && win.owner.name) || result.name || 'nothing';
        const name = String(front).slice(0, 60);
        this.diag(result.kind === 'path'
          ? `waiting: "${name}" is in front but does not show an approved folder. Open an approved folder.`
          : `waiting: "${name}" is in front, which is not an approved app (${(this.policy.appList || []).join(', ')}). Bring an approved app to the front.`);
      }
      return;
    }
    if (result.ok || result.soft || result.neutral) { this.bad = 0; return; }   // ScopeDesk itself in front is never a violation
    if (Date.now() - this.lastInputAt > this.attributionMs) { this.bad = 0; return; } // the Client switched windows, not the vendor
    if (result.kind === 'path' || ++this.bad >= this.strikes) this.flag(result);
  }

  flag(result) {
    this.setState('locked');
    this.onViolation({ processName: result.name || 'unknown', kind: result.kind, detail: result.detail || '' });
  }

  // Called by the injector before it applies an event. Returns true if the event may be applied.
  async permit(event) {
    if (this.state === 'locked') { this.lastRefusal = 'Control is locked after a scope alert on the client\'s PC.'; return false; }
    const { win, result } = await this.read(150);
    const mouse = ['move', 'down', 'up', 'wheel'].includes(event.t);
    // why the action is refused, in words the vendor's Control check shows (app names only, never titles or typed text)
    const front = String((win && win.owner && win.owner.name) || result.name || 'nothing').slice(0, 60);
    const allowed = (this.policy.appList || []).filter((a) => !/^scopedesk$/i.test(a)).join(', ');
    this.lastRefusal = result.neutral
      ? 'Keys are not sent while the client\'s ScopeDesk window is in front. Click the approved app in the picture first, then type.'
      : result.kind === 'path'
        ? `"${front}" shows a folder that is not approved${result.detail ? ' (' + String(result.detail).slice(0, 80) + ')' : ''}.`
        : `"${front}" is in front on the client's PC, and it is not an approved app (${allowed}). Click the approved app in the picture, or ask the client to open it.`;
    if (result.ok) {
      if (this.state === 'waiting') { this.log('info', 'An in-scope window is in front. Enforcement is ON.'); this.diag(''); this.setState('armed'); }
      if (event.t !== 'move') this.lastInputAt = Date.now();
      return true;
    }
    // ScopeDesk is in front (the Client just used it): mouse input may go to the approved app behind it, like AnyDesk. Keys never
    // (they would type into ScopeDesk). Whatever the click brings to front is checked by poll(); an unapproved app is a violation.
    if (result.neutral) {
      if (!mouse) return false;
      if (event.t !== 'move') this.lastInputAt = Date.now();
      return true;
    }
    if (this.state !== 'armed') return false;
    if (event.t !== 'move' && !result.soft) this.flag(result); // a click/key/scroll aimed at an out-of-scope window
    return false;
  }

  lock() { this.setState('locked'); }
  rearm() { this.setState('waiting'); } // after the Client resumes: wait for an in-scope window to be in front again
}

module.exports = { ForegroundMonitor };
