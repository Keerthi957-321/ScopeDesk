/**
 * ScopeDeskScreenShare: a defensive wrapper around navigator.mediaDevices.getDisplayMedia().
 *
 * The contract that fixes "Screen sharing was cancelled ... click the screen preview first, then press Share":
 *   - start() NEVER throws and NEVER touches the signaling socket, the task, the peer connection or the session timer.
 *     It only reports what happened, so the dialog stays open and the person can press Share again.
 *   - Cancelling the browser / OS picker (NotAllowedError, AbortError), or pressing Share before clicking the screen preview,
 *     is a normal, retryable outcome: a calm tip is shown, nothing is torn down. Whoever calls start() must not call
 *     terminate / hardStop / socket.disconnect on a { ok:false, retryable:true } result.
 *   - If the person picks a window or a tab although the whole screen is required, the capture is stopped and the tip says
 *     what to choose (the browser reports this through track.getSettings().displaySurface).
 *   - Unknown constraint keys (older Chromium / Electron) fall back to the plain { video: true } request.
 *   - Double clicks while the picker is open are ignored (one prompt at a time).
 *
 * Load it BEFORE the script that calls it (plain <script src="screen-share.js"></script>); it also works with require().
 *
 *   const share = ScopeDeskScreenShare.create({
 *     onTip: ScopeDeskScreenShare.bindTipElement(document.getElementById('screenShareError')),
 *     onState: (state, info) => console.log('screen share:', state, info)
 *   });
 *   const result = await share.start();
 *   if (!result.ok) return;                 // keep everything else exactly as it is; the person can try again
 *   attachToPeerConnection(result.stream);  // your existing code
 *   share.onEnded(() => { ... });           // the person pressed "Stop sharing" in the browser bar
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScopeDeskScreenShare = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TIP_PICK_SCREEN = 'In the window that opened, click the picture of your screen first so it is highlighted, then press Share. The Share button stays grey until you pick one.';
  var TIP_ENTIRE_SCREEN = 'Please choose "Entire screen" (not a window or a tab), click the picture of your screen so it is highlighted, then press Share.';
  var TIP_ONE_WINDOW = 'You chose "Specific Window Only", but a whole screen was picked, so nothing was shared. Open the "Window" tab in the picker, click the window to share, then press Share. (To share everything, switch to "Entire Screen" in Remote Connection.)';

  /**
   * Maps a DOMException (or anything thrown) to a stable result.
   * @returns {{ code:string, retryable:boolean, message:string, tip:string }}
   */
  function classifyError(err) {
    var name = (err && err.name) || '';
    var text = String((err && err.message) || '');

    if (name === 'NotAllowedError' || name === 'AbortError') {
      if (/system|operating system|os-level|screen recording/i.test(text)) {
        return {
          code: 'system-permission', retryable: true, message: 'The operating system blocked screen capture.',
          tip: 'Your computer is blocking screen capture for ScopeDesk. On Mac: System Settings > Privacy & Security > Screen Recording, switch ScopeDesk on, restart the app, then press Share again. On Windows: Settings > Privacy > Screen capture / Graphics capture must allow desktop apps.'
        };
      }
      if (/user gesture|transient activation|user activation/i.test(text)) {
        return { code: 'no-gesture', retryable: true, message: 'The browser needs a fresh click.', tip: 'The browser wants a fresh click. Press the Share my screen button once more.' };
      }
      return { code: 'cancelled', retryable: true, message: 'Screen sharing was cancelled.', tip: TIP_PICK_SCREEN };
    }
    if (name === 'NotFoundError') {
      return { code: 'no-source', retryable: true, message: 'No screen was available to share.', tip: 'No screen was offered to share. Check that a display is connected and press Share my screen again. ' + TIP_PICK_SCREEN };
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return { code: 'not-readable', retryable: true, message: 'The screen could not be read.', tip: 'Another program may be blocking screen capture. Close other screen-recording or screen-sharing apps and press Share my screen again.' };
    }
    if (name === 'SecurityError') {
      return { code: 'insecure', retryable: false, message: 'Screen sharing is not allowed on this page.', tip: 'Screen sharing only works on a secure (https) page or inside the ScopeDesk desktop app. Open ScopeDesk from its https address.' };
    }
    if (name === 'NotSupportedError') {
      return { code: 'unsupported', retryable: false, message: 'This app or browser cannot share the screen.', tip: 'This version of ScopeDesk or your browser cannot share the screen. Update ScopeDesk, or use a current Chrome, Edge or Firefox.' };
    }
    if (name === 'OverconstrainedError' || name === 'TypeError') {
      return { code: 'bad-constraints', retryable: true, message: 'The screen request was not accepted.', tip: 'The screen request was not accepted. Press Share my screen again.' };
    }
    return { code: 'unknown', retryable: true, message: text || 'Screen sharing failed.', tip: 'Screen sharing did not start. Press Share my screen again. ' + TIP_PICK_SCREEN };
  }

  /** Returns a function(tipText|null) that shows / hides a tip in a DOM element (role=status so screen readers announce it). */
  function bindTipElement(el) {
    return function (tip) {
      if (!el) return;
      if (el.setAttribute) el.setAttribute('role', 'status');
      if (el.setAttribute) el.setAttribute('aria-live', 'polite');
      if (tip) { el.textContent = tip; el.hidden = false; if (el.style) el.style.display = ''; } else { el.textContent = ''; el.hidden = true; if (el.style) el.style.display = 'none'; }
    };
  }

  // ---------- every capture this page ever started, so a drop signal can really switch all of them off ----------
  var openStreams = [];
  function remember(s) { if (s && openStreams.indexOf(s) === -1) openStreams.push(s); }
  function stopStream(s) {
    if (!s || typeof s.getTracks !== 'function') return;
    try { s.getTracks().forEach(function (t) { try { t.stop(); } catch (_) { /* already stopped */ } }); } catch (_) { /* stream gone */ }
  }
  /** Stops every media track of every capture started through this module. Never throws. Returns how many streams were stopped. */
  function stopAll() {
    var list = openStreams; openStreams = [];
    list.forEach(stopStream);
    return list.length;
  }

  var isDesktopApp = function () {
    try { return !!(typeof window !== 'undefined' && window.scopedeskDesktop && window.scopedeskDesktop.isDesktop); } catch (_) { return false; }
  };

  // ---------- friendly "the session has closed" notice ----------
  var END_TEXT = {
    time_expired: { title: 'Your support session has ended', body: 'The approved time ran out, so screen sharing and remote control were switched off automatically. Nothing more can be seen or done on your computer.', tone: 'info' },
    security_violation: { title: 'We closed the session to keep you safe', body: 'The vendor tried to go outside what you approved, so screen sharing and remote control were stopped straight away. Your computer is no longer visible or controllable by them.', tone: 'warn' },
    client_terminated: { title: 'You ended the session', body: 'Screen sharing and remote control are off. Nobody can see or control your computer now.', tone: 'info' },
    completed: { title: 'The session is finished', body: 'The vendor marked the task as complete. Screen sharing and remote control are off.', tone: 'info' }
  };
  var END_DEFAULT = { title: 'The session has closed safely', body: 'Screen sharing and remote control were switched off. Nobody can see or control your computer now.', tone: 'info' };

  /** Pure: what to tell the person for an end reason. */
  function describeEnd(info) {
    var reason = info && info.reason;
    var t = (reason && END_TEXT[reason]) || END_DEFAULT;
    return { title: t.title, body: t.body, tone: t.tone, task: info && info.title ? String(info.title).slice(0, 80) : '' };
  }

  var lastEndShown = { key: '', at: 0 };
  var STYLE_ID = 'scopedesk-session-closed-style';
  var CSS = '.sd-closed{position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483000;width:min(560px,calc(100vw - 24px));' +
    'display:flex;gap:12px;align-items:flex-start;padding:14px 16px;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.35);' +
    'font:14px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#10222e;background:#ecf8f1;border:1px solid #9fd6b8;animation:sdIn .22s ease-out}' +
    '.sd-closed.warn{background:#fff4e5;border-color:#f0b35f}' +
    '.sd-closed .sd-ico{flex:none;width:30px;height:30px;border-radius:50%;display:grid;place-items:center;background:#1c9e63;color:#fff;font-weight:700}' +
    '.sd-closed.warn .sd-ico{background:#d9780f}' +
    '.sd-closed .sd-txt{flex:1;min-width:0}.sd-closed .sd-h{font-weight:700;font-size:15px;margin:0 0 2px}.sd-closed .sd-b{margin:0}' +
    '.sd-closed .sd-t{margin:6px 0 0;font-size:12px;opacity:.7}' +
    '.sd-closed button{flex:none;border:0;border-radius:10px;padding:8px 14px;font:inherit;font-weight:600;cursor:pointer;background:#10222e;color:#fff}' +
    '.sd-closed button:focus-visible{outline:3px solid #6aa9ff;outline-offset:2px}' +
    '@keyframes sdIn{from{opacity:0;transform:translate(-50%,-8px)}to{opacity:1;transform:translate(-50%,0)}}' +
    '@media (prefers-reduced-motion:reduce){.sd-closed{animation:none}}';

  /**
   * Shows the notice at the top of the app window. Switches off every capture first, then draws.
   * Safe to call from any event handler: it catches its own errors, ignores duplicates for the same event
   * (several signals arrive for one ending) and does nothing outside a browser.
   */
  function showSessionClosed(info) {
    var stopped = 0;
    try { stopped = stopAll(); } catch (_) { /* nothing to stop */ }
    try {
      if (typeof document === 'undefined' || !document.body) return { shown: false, stopped: stopped };
      var key = String((info && info.taskId) == null ? '' : info.taskId) + '|' + String((info && info.reason) || '');
      var now = Date.now();
      if (lastEndShown.key === key && now - lastEndShown.at < 6000) return { shown: false, stopped: stopped };
      lastEndShown = { key: key, at: now };

      var d = describeEnd(info);
      if (!document.getElementById(STYLE_ID)) {
        var st = document.createElement('style'); st.id = STYLE_ID; st.textContent = CSS; document.head.appendChild(st);
      }
      var old = document.getElementById('scopedeskSessionClosed');
      if (old && old.parentNode) old.parentNode.removeChild(old);

      var box = document.createElement('div');
      box.id = 'scopedeskSessionClosed';
      box.className = 'sd-closed' + (d.tone === 'warn' ? ' warn' : '');
      box.setAttribute('role', 'alert');
      box.setAttribute('aria-live', 'assertive');
      var ico = document.createElement('div'); ico.className = 'sd-ico'; ico.setAttribute('aria-hidden', 'true'); ico.textContent = d.tone === 'warn' ? '!' : '\u2713';
      var txt = document.createElement('div'); txt.className = 'sd-txt';
      var h = document.createElement('p'); h.className = 'sd-h'; h.textContent = d.title;
      var b = document.createElement('p'); b.className = 'sd-b'; b.textContent = d.body;
      txt.appendChild(h); txt.appendChild(b);
      if (d.task) { var t = document.createElement('p'); t.className = 'sd-t'; t.textContent = 'Task: ' + d.task; txt.appendChild(t); }
      var btn = document.createElement('button'); btn.type = 'button'; btn.textContent = 'OK, got it';
      btn.addEventListener('click', function () { if (box.parentNode) box.parentNode.removeChild(box); });
      box.appendChild(ico); box.appendChild(txt); box.appendChild(btn);
      document.body.appendChild(box);
      try { btn.focus({ preventScroll: true }); } catch (_) { /* focus is a nicety */ }
      return { shown: true, stopped: stopped };
    } catch (_) {
      return { shown: false, stopped: stopped };      // a notice problem must never break the page
    }
  }

  function create(options) {
    var opts = options || {};
    var log = opts.log || function () {};
    var onTip = opts.onTip || function () {};
    var onState = opts.onState || function () {};
    var requireEntireScreen = opts.requireEntireScreen !== false;
    // getMode(): 'window' | 'screen' | null. When given, the picker is steered to that kind of surface AND the result is checked:
    // in 'window' mode a whole monitor is released at once, before any picture leaves this computer.
    var getMode = typeof opts.getMode === 'function' ? opts.getMode : null;
    var mediaDevices = opts.mediaDevices || (typeof navigator !== 'undefined' ? navigator.mediaDevices : null);

    var state = 'idle';
    var inFlight = null;
    var stream = null;
    var attempts = 0;
    var endedHandlers = [];

    function setState(next, info) {
      state = next;
      try { onState(next, info || {}); } catch (err) { log('[screen-share] onState failed: ' + err.message); }
    }
    function tip(text) {
      try { onTip(text || null); } catch (err) { log('[screen-share] onTip failed: ' + err.message); }
    }
    function stopTracks(s) {
      if (!s || !s.getTracks) return;
      s.getTracks().forEach(function (t) { try { t.stop(); } catch (_) { /* already stopped */ } });
    }

    function currentMode() { try { var m = getMode && getMode(); return m === 'window' || m === 'screen' ? m : null; } catch (_) { return null; } }
    function request() {
      var m = currentMode();
      var rich = {
        video: { displaySurface: m === 'window' ? 'window' : 'monitor', frameRate: { ideal: 30, max: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'exclude',
        monitorTypeSurfaces: m === 'window' ? 'exclude' : 'include'   // window mode: the browser hides the "Entire screen" choices
      };
      return mediaDevices.getDisplayMedia(rich).catch(function (err) {
        // Old engines reject unknown keys; the cancel / deny cases must NOT be retried (it would open a second picker).
        var n = err && err.name;
        if (n === 'TypeError' || n === 'OverconstrainedError') return mediaDevices.getDisplayMedia({ video: true, audio: false });
        throw err;
      });
    }

    function fail(err) {
      var c = classifyError(err);
      if (isDesktopApp() && (c.code === 'cancelled' || c.code === 'no-source' || c.code === 'unknown')) {
        // The desktop app shares the main screen directly: there is no picture to click, so the browser advice would only confuse.
        c = { code: c.code, retryable: true, message: c.message, tip: 'ScopeDesk could not start sharing your screen just now. Press Share my screen again. If it keeps happening, close and reopen ScopeDesk.' };
      }
      log('[screen-share] ' + (err && err.name) + ': ' + (err && err.message));
      var extra = attempts >= 3 && c.retryable ? ' If this keeps happening, press "Not yet" and try again in a moment.' : '';
      tip(c.tip + extra);
      setState(c.retryable ? 'needs-retry' : 'failed', { code: c.code, name: err && err.name });
      return { ok: false, code: c.code, retryable: c.retryable, message: c.message, tip: c.tip + extra };
    }

    async function run() {
      attempts += 1;
      tip(null);

      if (!mediaDevices || typeof mediaDevices.getDisplayMedia !== 'function') {
        var e = new Error('getDisplayMedia is not available'); e.name = 'NotSupportedError';
        return fail(e);
      }
      if (typeof window !== 'undefined' && window.isSecureContext === false) {
        var se = new Error('insecure context'); se.name = 'SecurityError';
        return fail(se);
      }
      if (stream) { stopTracks(stream); stream = null; }

      setState('prompting', { attempt: attempts });
      tip(isDesktopApp() ? 'Starting screen sharing...' : 'A window will open: click the picture of your screen first, then press Share.');

      var got;
      try {
        got = await request();
      } catch (err) {
        return fail(err);
      }

      var track = got && got.getVideoTracks && got.getVideoTracks()[0];
      if (!track) {
        stopTracks(got);
        var ne = new Error('The capture contained no video'); ne.name = 'NotFoundError';
        return fail(ne);
      }

      var surface;
      try { surface = track.getSettings && track.getSettings().displaySurface; } catch (_) { surface = undefined; }
      var mode = currentMode();
      if (mode === 'window' && surface === 'monitor') {
        stopTracks(got);                                  // privacy: a whole screen in window mode is never used
        log('[screen-share] window mode, but a monitor was picked');
        tip(TIP_ONE_WINDOW);
        setState('needs-retry', { code: 'wrong-surface', surface: surface, mode: mode });
        return { ok: false, code: 'wrong-surface', retryable: true, message: 'A whole screen was picked, but "Specific Window Only" is on.', tip: TIP_ONE_WINDOW };
      }
      if (mode !== 'window' && requireEntireScreen && surface && surface !== 'monitor') {
        stopTracks(got);                                  // the person chose a window or a tab: release it, ask again
        log('[screen-share] wrong surface: ' + surface);
        tip(TIP_ENTIRE_SCREEN);
        setState('needs-retry', { code: 'wrong-surface', surface: surface });
        return { ok: false, code: 'wrong-surface', retryable: true, message: 'A window or tab was shared instead of the entire screen.', tip: TIP_ENTIRE_SCREEN };
      }

      stream = got;
      remember(got);
      track.addEventListener('ended', function () {
        // "Stop sharing" in the browser bar, or the display went away. Reported only; ending the session is the caller's decision.
        if (stream !== got) return;
        stream = null;
        setState('stopped', { reason: 'track-ended' });
        endedHandlers.slice().forEach(function (fn) { try { fn(); } catch (err) { log('[screen-share] onEnded handler failed: ' + err.message); } });
      });
      tip(null);
      setState('sharing', { surface: surface || 'unknown' });
      return { ok: true, stream: got, surface: surface || 'unknown' };
    }

    return {
      /** Opens the picker. Resolves { ok:true, stream } or { ok:false, code, retryable, message, tip }. Never rejects. */
      start: function () {
        if (inFlight) return inFlight;                    // ignore double clicks while the picker is open
        inFlight = run().catch(function (err) { return fail(err); }).then(function (r) { inFlight = null; return r; });
        return inFlight;
      },
      /** Stops sharing (normal end of a session). */
      stop: function () {
        var s = stream; stream = null;
        stopTracks(s);
        tip(null);
        setState('idle', { reason: 'stopped' });
      },
      /** Registers a callback for "the person stopped sharing from the browser bar". */
      onEnded: function (fn) { if (typeof fn === 'function') endedHandlers.push(fn); },
      getStream: function () { return stream; },
      getState: function () { return state; },
      isBusy: function () { return inFlight !== null; }
    };
  }

  return { create: create, stopAll: stopAll, showSessionClosed: showSessionClosed, describeEnd: describeEnd, classifyError: classifyError, bindTipElement: bindTipElement, TIP_PICK_SCREEN: TIP_PICK_SCREEN, TIP_ENTIRE_SCREEN: TIP_ENTIRE_SCREEN, TIP_ONE_WINDOW: TIP_ONE_WINDOW };
}));
