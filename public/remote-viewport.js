// VENDOR FULL-SCREEN WORKSPACE (remote-viewport.html).
// Opened by the dashboard the moment the Vendor accepts a task. It owns the whole window: the Client's screen fills 100% of the
// width and height, and every mouse/keyboard event is captured by remote-input.js and sent as JSON to the Client's host agent.
//   pointer position -> { x: 0..1, y: 0..1 } fractions of the Client's screen (see mapToVideo in remote-input.js)
//   the agent multiplies them by the Client's real display size (input-injector.js), so 1920x1080 or any other resolution works.
//
// NETWORKS: the page fetches the server's rtcConfig once (the SAME object webrtc.js hands to new RTCPeerConnection) and passes it in.
// Same Wi-Fi or different networks needs no setting: ICE gathers host + STUN + TURN candidates together and keeps the best path.
// A network drop never shows an error screen: the last frame stays visible, a small "Reconnecting" pill appears, and webrtc.js
// re-gathers ICE paths in the background until the link is back or the session ends.
//
// INPUT: ScopeDeskRTC.startViewer() attaches remote-input.js to #stage, the container that holds the <video>:
//   pointermove / pointerdown / pointerup (these also carry every mouse event), dblclick, wheel, keydown / keyup, blur.
//   Positions are fractions {x: 0..1, y: 0..1} of the picture (letterbox bars excluded), sent over the RTCDataChannel
//   ('ctl' reliable for clicks and keys, 'mv' unordered for moves). The agent expects 0..1 fractions, so they are not scaled to 0..100.
(function () {
  'use strict';
  const TOKEN_KEY = 'scopedesk_token';
  const $ = (id) => document.getElementById(id);
  const taskId = Number(new URLSearchParams(location.search).get('task'));
  let token = null, task = null, clockOffset = 0, endMs = 0;
  let view = { conn: 'idle', agent: 'unknown', halted: null };

  // ---------- small helpers ----------
  async function api(path, opts) {
    const o = opts || {};
    const res = await fetch(path, { ...o, cache: 'no-store', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, ...(o.headers || {}) } });
    const date = res.headers.get('Date');
    if (date) clockOffset = Date.parse(date) - Date.now();
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const err = new Error(data.error || `Request failed (${res.status})`); err.status = res.status; throw err; }
    return data;
  }

  // The sign-in token lives in the dashboard tab's sessionStorage. A window opened from it normally gets a copy;
  // if not, ask the dashboard (same origin only) to hand it over.
  function getToken() {
    return new Promise((resolve) => {
      let t = null;
      try { t = sessionStorage.getItem(TOKEN_KEY); } catch (_) { /* storage blocked */ }
      if (t) return resolve(t);
      if (!window.opener) return resolve(null);
      const onMsg = (e) => {
        if (e.origin !== location.origin || e.source !== window.opener || !e.data || e.data.t !== 'scopedesk-token') return;
        window.removeEventListener('message', onMsg);
        resolve(e.data.token || null);
      };
      window.addEventListener('message', onMsg);
      try { window.opener.postMessage({ t: 'scopedesk-need-token' }, location.origin); } catch (_) { return resolve(null); }
      setTimeout(() => resolve(null), 3000);
    });
  }

  function overlay(title, text) {
    const o = $('overlay');
    if (!title) { o.classList.remove('show'); return; }
    $('ovTitle').textContent = title; $('ovText').textContent = text || '';
    o.classList.add('show');
  }
  // Small, click-through status pill for background reconnects. It never covers the remote screen or blocks input.
  let pill = null;
  function netPill(text) {
    if (!text) { if (pill) pill.style.opacity = '0'; return; }
    if (!pill) {
      pill = document.createElement('div');
      pill.setAttribute('role', 'status');
      pill.style.cssText = 'position:fixed;top:10px;right:12px;z-index:9;padding:5px 12px;border-radius:14px;font:13px "Segoe UI",system-ui,sans-serif;color:#ffb347;background:rgba(11,26,36,.82);border:1px solid #5a4a28;pointer-events:none;transition:opacity .25s;opacity:0';
      document.body.appendChild(pill);
    }
    pill.textContent = text; pill.style.opacity = '1';
  }
  function fatal(message) { overlay('Cannot open the workspace', message); $('barStatus').textContent = 'Not connected'; showBar(true); }

  // ---------- status ----------
  function describe(v) {
    const proc = task ? task.target_process : 'the approved app';
    if (v.halted === 'violation' && v.locked) return { msg: ['Locked out', 'Your access ended after a security violation. It cannot be restored in this session.'], badge: 'Locked out', warn: true };
    if (v.halted === 'violation') return { msg: ['Control suspended', 'An app outside the approved scope was detected. The client has been alerted and decides what happens next.'], badge: 'Control suspended', warn: true };
    // The stream has been live before: a drop is repaired in the background, so show a badge only (no overlay, no error text)
    if (v.everLive && (v.conn === 'lost' || v.conn === 'connecting' || v.conn === 'waiting')) return { badge: v.retrying > 1 ? `Reconnecting... (attempt ${v.retrying})` : 'Reconnecting...', warn: true, soft: true };
    const stuck = (v.conn === 'connecting' && v.connectSlow) || v.conn === 'lost';
    if (stuck && v.relay === false) return { msg: ['Cannot connect across networks', 'The two computers are on different networks and the ScopeDesk server has no relay (TURN) set up yet, so the screen cannot reach you. Ask the administrator to follow the "Relay" step in RAILWAY.md.'], badge: 'No relay server', warn: true };
    if (v.conn === 'connecting' && v.connectSlow) return { msg: ['Still connecting...', 'This is taking longer than usual. Both computers need internet access, and a strict firewall can block the link. Retrying automatically.'], badge: 'Connecting slowly...', warn: true };
    if (v.conn === 'live') {
      const via = v.path === 'local' ? ' (same network)' : v.path === 'relay' ? ' (via relay)' : '';
      if (v.agent === 'armed') return { badge: 'Live. Remote control active' + via };
      if (v.agent === 'waiting') return { badge: `Live. Waiting for the client to open ${proc}` };
      if (v.agent === 'locked') return { badge: 'Live. Control locked', warn: true };
      return { badge: 'Live view only. The client must use the ScopeDesk desktop app to allow control', warn: true };
    }
    if (v.conn === 'lost') return { msg: ['Connecting...', 'Looking for a network path. Retrying automatically.'], badge: 'Reconnecting...', warn: true };
    if (v.conn === 'connecting' || v.conn === 'starting') return { msg: ['Connecting...', 'Setting up the secure connection.'], badge: 'Connecting...' };
    if (v.conn === 'violation') return { msg: ['Locked out', 'An app or folder outside the approved scope was detected. Your access has been revoked.'], badge: 'Locked out', warn: true };
    if (v.conn === 'stopped') return { msg: ['Screen sharing stopped', 'The client stopped sharing their screen.'], badge: 'Sharing stopped', warn: true };
    if (v.conn === 'closed' || v.conn === 'expired') return { msg: ['Session closed', 'This session has ended. You can close this window.'], badge: 'Closed', warn: true };
    return { msg: ['Waiting for the client', 'The client has to click "Share my screen". The remote screen appears here as soon as it is live.'], badge: 'Waiting for the client' };
  }

  // A permanent lockout (security violation) ends the stream on this side too: tracks stop, the picture goes, the lock screen stays.
  // A native OS notification is raised (Electron shows it as a system toast; browsers need the permission granted).
  let lockHandled = false;
  function onPermanentLock(v) {
    if (lockHandled) return;
    lockHandled = true;
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        const n = new Notification('ScopeDesk: access locked', { body: 'An app or folder outside the approved scope was detected. Your access to this session has ended.', tag: 'scopedesk-lock', requireInteraction: true });
        n.onclick = () => { window.focus(); n.close(); };
      }
    } catch (_) { /* the lock screen still shows */ }
    setTimeout(() => { try { ScopeDeskRTC.stop('violation'); } catch (_) { /* already stopped */ } }, 0);
  }
  // Ask once, from a real click, so the alert above is allowed to appear
  document.addEventListener('pointerdown', () => { try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch (_) { /* optional */ } }, { once: true });

  function render(v) {
    view = v || view;
    if (view.halted === 'violation' && view.locked) onPermanentLock(view);
    const d = describe(view);
    const stage = $('stage');
    const live = view.conn === 'live' || view.conn === 'lost' || (!!d.soft && !!view.everLive);
    stage.classList.toggle('live', live);
    stage.classList.toggle('control-on', view.conn === 'live' && view.agent === 'armed' && !view.halted);
    overlay(d.msg ? d.msg[0] : null, d.msg ? d.msg[1] : '');
    const s = $('barStatus');
    s.textContent = d.badge; s.classList.toggle('warn', !!d.warn); s.classList.toggle('ok', !d.warn);
    $('btnShot').disabled = !shotAllowed(view);
    netPill(d.soft ? d.badge : null);
    try { if (window.opener && !window.opener.closed) window.opener.postMessage({ t: 'scopedesk-viewport-state', badge: d.badge, warn: !!d.warn, conn: view.conn }, location.origin); } catch (_) { /* dashboard closed */ }
    if (live && !d.msg) { const vid = $('video'); vid.play().catch(() => {}); stage.focus(); }
  }

  // ---------- clock ----------
  const pad = (n) => String(n).padStart(2, '0');
  let expiredHandled = false;
  function tick() {
    const clock = $('barClock');
    if (!endMs) { clock.textContent = '--:--'; return; }
    const left = endMs - (Date.now() + clockOffset);
    const t = Math.max(0, Math.ceil(left / 1000));
    clock.textContent = `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
    clock.classList.toggle('warn', left < 60000 && left > 0);
    clock.classList.toggle('zero', left <= 0);
    if (left <= 0 && !expiredHandled) {   // the server closes the session at the same moment; this just stops the screen promptly
      expiredHandled = true;
      try { ScopeDeskRTC.stop('expired'); } catch (_) { /* already stopped */ }
      render({ ...view, conn: 'expired' });
    }
  }

  // ---------- toolbar: shows briefly, then hides; reappears at the top edge ----------
  let barTimer = null;
  function showBar(stay) {
    $('bar').classList.add('show');
    clearTimeout(barTimer);
    if (!stay) barTimer = setTimeout(() => $('bar').classList.remove('show'), 4000);
  }
  document.addEventListener('pointermove', (e) => { if (e.clientY < 48) showBar(false); }, { passive: true });
  // ---------- screenshot: the frame being shown right now, saved to THIS computer's Downloads as ScopeDesk_Capture.png ----------
  // Only while the stream is live and control has not been suspended or locked (a halted session must not yield more captures).
  function shotAllowed(v) { return !!v && v.conn === 'live' && !v.halted; }
  function takeScreenshot() {
    const vid = $('video');
    if (!shotAllowed(view) || !vid.videoWidth || !vid.videoHeight) return;
    const c = document.createElement('canvas');
    c.width = vid.videoWidth; c.height = vid.videoHeight;      // the remote screen's real pixel size, not the window's
    c.getContext('2d').drawImage(vid, 0, 0, c.width, c.height);
    c.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'ScopeDesk_Capture.png';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      const f = $('flash'); f.style.opacity = '.55'; setTimeout(() => { f.style.opacity = '0'; }, 120);   // shutter feedback
    }, 'image/png');
  }
  $('btnShot').addEventListener('click', takeScreenshot);

  $('btnFull').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  });
  $('btnClose').addEventListener('click', () => { try { if (window.opener && !window.opener.closed) window.opener.focus(); } catch (_) { /* ignore */ } window.close(); });
  document.addEventListener('fullscreenchange', () => { $('btnFull').textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen'; });

  // ---------- boot ----------
  async function boot() {
    console.log('[ScopeDesk] Remote workspace starting');
    if (!Number.isInteger(taskId) || taskId <= 0) return fatal('This page needs a task. Open it from your ScopeDesk dashboard.');
    token = await getToken();
    if (!token) return fatal('Please open the workspace from your ScopeDesk dashboard (you need to be signed in).');
    try {
      const list = await api('/api/tasks');
      task = (list.tasks || []).find((t) => t.id === taskId) || null;
      if (list.serverTime) clockOffset = list.serverTime - Date.now();
    } catch (e) { return fatal(e.message); }
    if (!task) return fatal('This task is not assigned to your account.');
    $('barTask').textContent = task.title; $('barProc').textContent = `(${task.target_process})`;
    document.title = `ScopeDesk - ${task.title}`;
    endMs = Date.parse(task.window_end);
    setInterval(tick, 1000); tick();
    showBar(false);
    $('hint').classList.add('show'); setTimeout(() => $('hint').classList.remove('show'), 4000);

    const socket = io({ auth: { token }, reconnection: true, reconnectionDelay: 500, reconnectionDelayMax: 5000, timeout: 10000 });
    try {
      await new Promise((resolve, reject) => {
        const giveUp = setTimeout(() => reject(new Error('Cannot reach the ScopeDesk server.')), 60000);
        socket.once('connect', () => { clearTimeout(giveUp); resolve(); });
        socket.on('connect_error', (e) => {
          if (e && e.message === 'Authentication required') { clearTimeout(giveUp); return reject(new Error('Your sign-in has expired. Open the workspace again from the dashboard.')); }
          overlay('Connecting...', 'Reaching the ScopeDesk server. Retrying automatically.');   // transient: socket.io keeps retrying by itself
        });
      });
    } catch (e) { return fatal(e.message); }
    socket.on('disconnect', () => { if (view.everLive) netPill('Reconnecting...'); else overlay('Connecting...', 'Reaching the ScopeDesk server. Retrying automatically.'); });
    socket.on('connect', () => render(view));

    ScopeDeskRTC.init({ api: (p) => api(p), onChange: render });
    ScopeDeskRTC.bindSocket(socket);

    // The server's rtcConfig, exactly as served: iceServers (STUN + TURN), iceTransportPolicy "all", bundle/mux policy.
    // Transient failures (network down, 5xx) are retried with back-off; only a real refusal (401/403/404) is shown to the user.
    const transient = (e) => !e.status || e.status >= 500 || e.status === 429;
    for (let attempt = 0; ; attempt++) {
      try {
        const rtcConfig = await api(`/api/rtc-config?taskId=${taskId}`);
        console.log('[ScopeDesk] rtcConfig loaded:', rtcConfig.iceTransportPolicy, `${rtcConfig.iceServers.length} ICE server entries`, rtcConfig.relayKind ? `relay=${rtcConfig.relayKind}` : 'no relay');
        await ScopeDeskRTC.startViewer(taskId, { video: $('video'), stage: $('stage'), rtcConfig });
        break;
      } catch (e) {
        if (!transient(e) || attempt >= 12 || (endMs && Date.now() + clockOffset > endMs)) return fatal(e.message);
        overlay('Connecting...', 'Setting up the secure connection. Retrying automatically.');
        await new Promise((r) => setTimeout(r, Math.min(10000, 1000 * 2 ** Math.min(attempt, 3))));
      }
    }
    render(view);
  }

  // The dashboard's "Open folder" box asks this window (the one with the live connection) to send the request.
  window.addEventListener('message', (e) => {
    if (e.origin !== location.origin || e.source !== window.opener || !e.data || e.data.t !== 'scopedesk-open-folder') return;
    let ok = false;
    try { ok = !!ScopeDeskRTC.openFolder(e.data.path); } catch (_) { ok = false; }
    try { e.source.postMessage({ t: 'scopedesk-open-folder-result', ok }, location.origin); } catch (_) { /* dashboard closed */ }
  });

  window.addEventListener('pagehide', () => { try { ScopeDeskRTC.stop('closed'); } catch (_) { /* nothing to stop */ } });
  boot();
})();
