// ScopeDesk server status monitor.
// Shows ONE in-page banner, and only when the backend is confirmed unreachable. No popup dialogs are used.
//
// How it avoids false alarms:
//   * The banner is hidden by default (class + hidden attribute + inline display:none) and is created hidden.
//   * A failed request / socket drop / "offline" event is only a SUSPICION. The monitor re-checks /api/health
//     several times (each with a timeout) and shows the banner only if every check fails.
//   * The background health loop starts only after the frontend has located the server (ScopeDeskStatus.start()),
//     so the initial connection attempt can never trigger the banner.
(function () {
  const BACKOFF = [5, 10];           // seconds between probes while the banner is showing (5s, then every 10s)
  const CONFIRM_TRIES = 2;           // health checks that must ALL fail before the banner appears
  const CONFIRM_GAP_MS = 1200;       // pause between those checks
  const PROBE_TIMEOUT_MS = 3000;     // a health check that takes longer than this counts as "no response"
  const WATCH_MS = 10000;            // background health check while everything is fine

  const S = { online: true, attempt: 0, secondsLeft: 0, wait: null, tick: null, watch: null,
              probing: false, confirming: false, downSince: null, justRecovered: false };
  const listeners = [];
  let getBase = () => '';
  let liveSession = () => false;
  let beforeProbe = null;            // optional async hook: lets the page re-locate the server before each check
  let banner;


  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; }
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

  function setVisible(b, visible) {
    b.classList.toggle('hidden', !visible);
    b.hidden = !visible;
    b.style.display = visible ? '' : 'none';
  }

  function ensureBanner() {
    if (banner) return banner;
    banner = el('div', 'srv-status hidden');
    banner.setAttribute('role', 'alert');
    banner.setAttribute('aria-live', 'assertive');
    setVisible(banner, false);                 // hidden by default
    document.body.prepend(banner);
    return banner;
  }

  function render() {
    const b = ensureBanner();
    b.textContent = '';
    if (S.online && !S.justRecovered) { setVisible(b, false); return; }
    setVisible(b, true);
    b.classList.toggle('srv-ok', S.online);
    b.classList.toggle('srv-down', !S.online);

    if (S.online) { b.append(el('strong', '', 'Back online.'), el('span', '', ' Reconnected to the ScopeDesk server.')); return; }

    const text = el('div', 'srv-text');
    text.append(el('strong', '', 'Can\u2019t reach the ScopeDesk server.'));
    text.append(el('p', '', 'Your account and tasks are safe. The page reconnects by itself once the server is running again.'));
    if (liveSession()) {
      text.append(el('p', 'srv-live', 'A live session is open: screen sharing and remote control are paused, and the session timer keeps running on the server.'));
    }
    const steps = el('ol', 'srv-steps');
    ['Check that this computer is online.', 'Make sure you opened the address of your ScopeDesk server (your Railway address), not a copy of the page on another site.', 'If both are fine, the service may be restarting. This page reconnects by itself, nothing to run or install.']
      .forEach((t) => steps.append(el('li', '', t)));
    text.append(steps);

    const side = el('div', 'srv-side');
    side.append(el('span', 'srv-retry', S.probing ? 'Checking\u2026' : `Retrying in ${S.secondsLeft}s`));
    const btn = el('button', 'srv-btn', 'Retry now');
    btn.type = 'button';
    btn.disabled = S.probing;
    btn.addEventListener('click', () => probe());
    side.append(btn);
    b.append(text, side);
  }

  function emit(online) { listeners.forEach((fn) => { try { fn(online); } catch (_) { /* a listener must not break the monitor */ } }); }

  // One health check. Resolves true only if the ScopeDesk server answers in time.
  async function healthOnce() {
    if (beforeProbe) { try { await beforeProbe(); } catch (_) { /* keep going with the current address */ } }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
    try {
      const r = await fetch(getBase() + '/api/health', { cache: 'no-store', signal: ctrl.signal });
      const d = await r.json();
      return !!(d && d.app === 'scopedesk');
    } catch (_) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  // Something looked wrong (failed request, socket drop, offline event). Only show the banner if the server
  // really does not answer: all CONFIRM_TRIES health checks must fail.
  async function reportDown() {
    if (!S.online || S.confirming) return;
    S.confirming = true;
    try {
      for (let i = 0; i < CONFIRM_TRIES; i++) {
        if (await healthOnce()) return;        // server answered: false alarm, banner stays hidden
        if (i < CONFIRM_TRIES - 1) await sleep(CONFIRM_GAP_MS);
      }
    } finally {
      S.confirming = false;
    }
    if (!S.online) return;
    markDown();
  }

  function markDown() {
    S.online = false; S.attempt = 0; S.downSince = Date.now();
    emit(false);
    scheduleProbe();
    render();
  }

  function reportUp() {
    if (S.online) return;
    clearTimeout(S.wait); clearInterval(S.tick);
    S.online = true; S.justRecovered = true; S.attempt = 0;
    render(); emit(true);
    setTimeout(() => { S.justRecovered = false; render(); }, 3500);
  }

  function scheduleProbe() {
    clearTimeout(S.wait); clearInterval(S.tick);
    S.secondsLeft = BACKOFF[Math.min(S.attempt, BACKOFF.length - 1)];
    S.tick = setInterval(() => { S.secondsLeft = Math.max(0, S.secondsLeft - 1); render(); }, 1000);
    S.wait = setTimeout(probe, S.secondsLeft * 1000);
  }

  // Recovery probe, used while the banner is showing (and by its "Retry now" button)
  async function probe() {
    if (S.probing) return;
    clearTimeout(S.wait); clearInterval(S.tick);
    S.probing = true; render();
    const ok = await healthOnce();
    S.probing = false;
    if (ok) return reportUp();
    S.attempt++;
    scheduleProbe(); render();
  }

  // Background health loop. Called by script.js once the server address is known, never before.
  function start() {
    clearInterval(S.watch);
    S.watch = setInterval(async () => {
      if (!S.online || S.confirming || document.hidden) return;
      if (!(await healthOnce())) reportDown();
    }, WATCH_MS);
  }

  // Socket.IO link: connect_error that is not an auth problem, or a dropped connection, means the server may be gone
  function attachSocket(socket) {
    socket.on('connect_error', (err) => { if (err && err.message !== 'Authentication required') reportDown(); });
    socket.on('disconnect', (reason) => { if (reason !== 'io client disconnect') reportDown(); });
    socket.on('connect', () => reportUp());
  }

  // Failed fetches and stray rejections about the network are verified with /api/health before anything is shown
  const looksLikeNetwork = (e) => e && (e.name === 'TypeError' || /Failed to fetch|NetworkError|Load failed|Cannot reach/i.test(String(e.message || e)));
  window.addEventListener('unhandledrejection', (ev) => { if (looksLikeNetwork(ev.reason)) { ev.preventDefault(); reportDown(); } });
  window.addEventListener('offline', reportDown);
  window.addEventListener('online', () => { if (!S.online) probe(); });

  window.ScopeDeskStatus = {
    configure(opts) { if (opts.getBase) getBase = opts.getBase; if (opts.liveSession) liveSession = opts.liveSession; if (opts.beforeProbe) beforeProbe = opts.beforeProbe; },
    attachSocket,
    reportDown,   // call from any failed API request (verified before the banner shows)
    reportUp,
    start,
    onChange(fn) { listeners.push(fn); },
    isOnline: () => S.online,
    probe
  };

  // Create the (hidden) banner container on load. No request is made here.
  document.addEventListener('DOMContentLoaded', () => { ensureBanner(); });
})();
