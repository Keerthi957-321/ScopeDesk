// VENDOR FULL-SCREEN WORKSPACE (remote-viewport.html).
// Opened by the dashboard the moment the Vendor accepts a task. It owns the whole window: the Client's screen fills 100% of the
// width and height, and every mouse/keyboard event is captured by remote-input.js and sent as JSON to the Client's host agent.
//   pointer position -> { x: 0..1, y: 0..1 } fractions of the Client's screen (see mapToVideo in remote-input.js)
//   the agent multiplies them by the Client's real display size (input-injector.js), so 1920x1080 or any other resolution works.
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
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
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
  function fatal(message) { overlay('Cannot open the workspace', message); $('barStatus').textContent = 'Not connected'; showBar(true); }

  // ---------- status ----------
  function describe(v) {
    const proc = task ? task.target_process : 'the approved app';
    if (v.halted === 'violation' && v.locked) return { msg: ['Locked out', 'Your access ended after a security violation. It cannot be restored in this session.'], badge: 'Locked out', warn: true };
    if (v.halted === 'violation') return { msg: ['Control suspended', 'An app outside the approved scope was detected. The client has been alerted and decides what happens next.'], badge: 'Control suspended', warn: true };
    const stuck = (v.conn === 'connecting' && v.connectSlow) || v.conn === 'lost';
    if (stuck && v.relay === false) return { msg: ['Cannot connect across networks', 'The two computers are on different networks and the ScopeDesk server has no relay (TURN) set up yet, so the screen cannot reach you. Ask the administrator to follow the "Relay" step in RAILWAY.md.'], badge: 'No relay server', warn: true };
    if (v.conn === 'connecting' && v.connectSlow) return { msg: ['Still connecting...', 'This is taking longer than usual. Both computers need internet access, and a strict firewall can block the link. Retrying automatically.'], badge: 'Connecting slowly...', warn: true };
    if (v.conn === 'live') {
      if (v.agent === 'armed') return { badge: 'Live. Remote control active' };
      if (v.agent === 'waiting') return { badge: `Live. Waiting for the client to open ${proc}` };
      if (v.agent === 'locked') return { badge: 'Live. Control locked', warn: true };
      return { badge: "Live view only. The client's host agent is not running", warn: true };
    }
    if (v.conn === 'lost') return { msg: ['Connection lost', 'Trying to reconnect. The timer keeps running.'], badge: 'Reconnecting...', warn: true };
    if (v.conn === 'connecting' || v.conn === 'starting') return { msg: ['Connecting...', 'Setting up the secure connection.'], badge: 'Connecting...' };
    if (v.conn === 'violation') return { msg: ['Locked out', 'An app or folder outside the approved scope was detected. Your access has been revoked.'], badge: 'Locked out', warn: true };
    if (v.conn === 'stopped') return { msg: ['Screen sharing stopped', 'The client stopped sharing their screen.'], badge: 'Sharing stopped', warn: true };
    if (v.conn === 'closed' || v.conn === 'expired') return { msg: ['Session closed', 'This session has ended. You can close this window.'], badge: 'Closed', warn: true };
    return { msg: ['Waiting for the client', 'The client has to click "Share my screen". The remote screen appears here as soon as it is live.'], badge: 'Waiting for the client' };
  }

  function render(v) {
    view = v || view;
    const d = describe(view);
    const stage = $('stage');
    const live = view.conn === 'live' || view.conn === 'lost';
    stage.classList.toggle('live', live);
    stage.classList.toggle('control-on', view.conn === 'live' && view.agent === 'armed' && !view.halted);
    overlay(d.msg ? d.msg[0] : null, d.msg ? d.msg[1] : '');
    const s = $('barStatus');
    s.textContent = d.badge; s.classList.toggle('warn', !!d.warn); s.classList.toggle('ok', !d.warn);
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

    const socket = io({ auth: { token } });
    try {
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('connect_error', (e) => reject(new Error(e && e.message === 'Authentication required' ? 'Your sign-in has expired. Open the workspace again from the dashboard.' : 'Cannot reach the ScopeDesk server.')));
      });
    } catch (e) { return fatal(e.message); }
    socket.on('disconnect', () => overlay('Connection lost', 'Trying to reconnect. The timer keeps running.'));
    socket.on('connect', () => render(view));

    ScopeDeskRTC.init({ api: (p) => api(p), onChange: render });
    ScopeDeskRTC.bindSocket(socket);
    try { await ScopeDeskRTC.startViewer(taskId, { video: $('video'), stage: $('stage') }); }
    catch (e) { return fatal(e.message); }
    render(view);
  }

  window.addEventListener('pagehide', () => { try { ScopeDeskRTC.stop('closed'); } catch (_) { /* nothing to stop */ } });
  boot();
})();
