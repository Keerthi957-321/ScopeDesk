// What the Client shares with the vendor: 'window' (one specific window, the private default) or 'screen' (the entire screen).
// One small store so every part of the page agrees: the Remote Connection hub, the share dialog, the desktop source picker
// and the capture itself (screen-share.js / webrtc.js), which also VERIFIES the result and refuses a whole screen in window mode.
//   ScopeDeskShareMode.get()          -> 'window' | 'screen'
//   ScopeDeskShareMode.set(mode)      saves the choice on this device and tells every listener
//   ScopeDeskShareMode.onChange(fn)   fn(mode) on every change
//   ScopeDeskShareMode.label(mode)    'Specific Window Only' | 'Entire Screen'
//   ScopeDeskShareMode.surfaceMatches(mode, surface)   is a captured displaySurface allowed in this mode?
(function (root) {
  var KEY = 'scopedesk_share_mode';
  var listeners = [];
  var mode = 'window';
  try { var saved = root.localStorage && root.localStorage.getItem(KEY); if (saved === 'screen' || saved === 'window') mode = saved; } catch (_) { /* storage blocked: private default */ }

  var api = {
    get: function () { return mode; },
    set: function (next) {
      if (next !== 'screen' && next !== 'window') return mode;
      if (next === mode) return mode;
      mode = next;
      try { root.localStorage && root.localStorage.setItem(KEY, mode); } catch (_) { /* remembered for this page only */ }
      listeners.slice().forEach(function (fn) { try { fn(mode); } catch (_) { /* a listener must not break the store */ } });
      return mode;
    },
    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); },
    label: function (m) { return (m || mode) === 'screen' ? 'Entire Screen' : 'Specific Window Only'; },
    // Window mode accepts only a window. A browser tab ('browser') is a single surface too, so it is allowed; a whole monitor
    // never is. Unknown (engines that do not report it, e.g. Electron) is decided by the desktop source picker instead.
    surfaceMatches: function (m, surface) {
      if (!surface) return true;
      if ((m || mode) === 'window') return surface === 'window' || surface === 'browser';
      return surface === 'monitor';
    },
    // getDisplayMedia hints for the browser's own picker (Chrome / Edge honour them; others ignore unknown keys)
    captureHints: function (m) {
      var w = (m || mode) === 'window';
      return { displaySurface: w ? 'window' : 'monitor', monitorTypeSurfaces: w ? 'exclude' : 'include' };
    }
  };
  root.ScopeDeskShareMode = api;
})(typeof window !== 'undefined' ? window : globalThis);
