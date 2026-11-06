// ScopeDesk workspace pages: Command Center, Boards, Analytics, Settings & Billing, the top bar and the Ctrl/Cmd+K palette.
// Reads the app's state through the functions script.js passes to init(); it never changes tickets or sessions itself.
// Everything that comes from the server is written with textContent / DOM nodes, never as HTML.
(function () {
  const $ = (id) => document.getElementById(id);
  const SVG = 'http://www.w3.org/2000/svg';
  let deps = null;
  let running = false;
  let alerts = [];                  // client only: security events (GET /api/alerts)
  let rangeDays = 30;
  let plan = null;                  // from ScopeDeskPlans
  let currentPanel = '';
  let boardTaskSig = '';

  // ---------- THEME (light / dark / match the computer) ----------
  // The choice is a per-device preference, so it lives in localStorage (guarded: it can be blocked). index.html applies it before
  // the first paint; this keeps it in sync, follows the computer when "system" is chosen, and drives every toggle on the page.
  const THEME_KEY = 'scopedesk_theme';
  const sysLight = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  function themePref() { try { const v = localStorage.getItem(THEME_KEY); return v === 'light' || v === 'dark' ? v : 'system'; } catch (_) { return 'system'; } }
  const resolveTheme = (pref) => (pref === 'light' || pref === 'dark' ? pref : (sysLight && sysLight.matches ? 'light' : 'dark'));
  function applyTheme(pref, animate) {
    const root = document.documentElement;
    const theme = resolveTheme(pref);
    if (animate) { root.classList.add('theme-switching'); clearTimeout(applyTheme.t); applyTheme.t = setTimeout(() => root.classList.remove('theme-switching'), 350); }
    root.setAttribute('data-theme', theme);
    document.querySelectorAll('[data-theme-toggle]').forEach((b) => {
      const label = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode';
      b.setAttribute('aria-label', label); b.title = label;
    });
    document.querySelectorAll('[data-theme-choice]').forEach((c) => c.setAttribute('aria-checked', String(c.dataset.themeChoice === pref)));
  }
  function setTheme(pref) {
    try { if (pref === 'system') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, pref); } catch (_) { /* remembered for this page only */ }
    currentThemePref = pref;
    applyTheme(pref, true);
  }
  let currentThemePref = themePref();
  applyTheme(currentThemePref, false);
  if (sysLight) {
    const follow = () => { if (currentThemePref === 'system') applyTheme('system', true); };
    if (sysLight.addEventListener) sysLight.addEventListener('change', follow); else if (sysLight.addListener) sysLight.addListener(follow);
  }
  // The quick toggle flips between light and dark (an explicit choice); "Match my computer" is in Settings > Appearance
  document.querySelectorAll('[data-theme-toggle]').forEach((b) => b.addEventListener('click', () => setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark')));
  document.querySelectorAll('[data-theme-choice]').forEach((c) => c.addEventListener('click', () => setTheme(c.dataset.themeChoice)));
  // keyboard: arrows move between the three theme cards (radio group)
  const picker = document.getElementById('themePicker');
  if (picker) picker.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const cards = [...picker.querySelectorAll('[data-theme-choice]')];
    const i = cards.indexOf(document.activeElement);
    const next = cards[(i + (e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? cards.length - 1 : 1)) % cards.length];
    next.focus(); setTheme(next.dataset.themeChoice);
  });

  // ---------- tiny DOM helpers ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    kids.flat().forEach((c) => { if (c == null || c === false) return; el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c); });
    return el;
  }
  function s(tag, attrs, ...kids) {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
    kids.flat().forEach((c) => c && el.appendChild(c));
    return el;
  }
  const ICONS = {
    ticket: 'M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4z',
    live: 'M2 12h4l3-8 4 16 3-8h6',
    clock: 'M12 7v5l3 2M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z',
    shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
    check: 'M20 6L9 17l-5-5',
    plus: 'M12 5v14M5 12h14',
    board: 'M3 3h18v18H3zM9 3v18M15 3v18',
    chart: 'M3 3v18h18M7 15l4-4 3 3 5-6',
    spark: 'M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z',
    card: 'M2 6h20v12H2zM2 10h20',
    monitor: 'M2 3h20v14H2zM8 21h8M12 17v4',
    grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
    settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12h2M3 12h2M12 3v2M12 19v2M17 7l1.4-1.4M5.6 18.4 7 17M17 17l1.4 1.4M5.6 5.6 7 7',
    trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
    alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
    logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
    arrowL: 'M15 18l-6-6 6-6', arrowR: 'M9 18l6-6-6-6',
    search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM21 21l-4.3-4.3'
  };
  const icon = (name, cls = 'ico') => s('svg', { class: cls, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, s('path', { d: ICONS[name] }));

  // ---------- data helpers ----------
  const DAY = 86400000;
  const toMs = (v) => { if (!v) return NaN; const str = String(v); return new Date(str.includes('T') || str.endsWith('Z') ? str : str.replace(' ', 'T') + 'Z').getTime(); };
  const dayKey = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };
  const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const isClient = () => { const u = deps && deps.getUser(); return !!u && u.role === 'client'; };
  const tasks = () => (deps ? deps.getTasks() : []);
  const listOf = (col) => { try { const v = JSON.parse(col || '[]'); return Array.isArray(v) ? v.map(String) : []; } catch (_) { return []; } };
  const appsOf = (t) => { const a = listOf(t.allowed_apps); return a.length ? a : (t.target_process ? [t.target_process] : []); };
  const counterparty = (t) => (isClient() ? (t.session_vendor_name || t.vendor_name || 'Vendor') : (t.client_org || t.client_username || 'Client'));
  const fmtNum = (n) => Number(n || 0).toLocaleString('en-IN');
  const fmtMinutes = (m) => (m >= 120 ? `${(m / 60).toFixed(m % 60 ? 1 : 0)} h` : `${m} min`);
  const timeAgo = (ms) => {
    const d = Date.now() - ms;
    if (!Number.isFinite(d)) return '';
    if (d < 60000) return 'just now';
    if (d < 3600000) return `${Math.floor(d / 60000)} min ago`;
    if (d < DAY) return `${Math.floor(d / 3600000)} h ago`;
    if (d < 7 * DAY) return `${Math.floor(d / DAY)} d ago`;
    return new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  };
  const STATUS = {
    pending: { label: 'Waiting for vendor', tone: 'amber' },
    active: { label: 'Live', tone: 'green' },
    completed: { label: 'Completed', tone: 'blue' },
    terminated: { label: 'Terminated', tone: 'red' },
    expired: { label: 'Expired', tone: 'slate' }
  };

  // Counts per day for the last n days (oldest first)
  function perDay(items, getMs, n, getValue = () => 1) {
    const today = startOfDay(Date.now());
    const buckets = Array.from({ length: n }, (_, i) => ({ start: today - (n - 1 - i) * DAY, value: 0 }));
    const index = new Map(buckets.map((b, i) => [dayKey(b.start), i]));
    items.forEach((it) => { const ms = getMs(it); const i = index.get(dayKey(ms)); if (i != null) buckets[i].value += getValue(it); });
    return buckets;
  }

  // ---------- top bar ----------
  const TITLES = { messagesPanel: 'Messages', remoteHubPanel: 'Remote Connection', clientDashboardPanel: 'Tickets', vendorDashboardPanel: 'My Tasks', boardsPanel: 'Boards', analyticsPanel: 'Analytics', settingsPanel: 'Settings & Billing', sessionMonitorPanel: 'Remote Desktop' };
  const PLAN_LABEL = { trial: 'Free trial', free: 'Free', member: 'Member', legacy: 'All features' };
  function renderTopbar() {
    const u = deps && deps.getUser();
    // Vendors have no plan or billing: their page is just "Settings"
    const setLabel = isClient() ? 'Settings & Billing' : 'Settings';
    TITLES.settingsPanel = setLabel;
    const navSpan = $('navSettingsLink') && $('navSettingsLink').querySelector('span');
    if (navSpan) navSpan.textContent = setLabel;
    const setTitle = document.querySelector('#settingsPanel .page-title');
    if (setTitle) setTitle.textContent = setLabel;
    const setSub = document.querySelector('#settingsPanel .page-sub');
    if (setSub) setSub.textContent = isClient() ? 'Your account, your plan, and how ScopeDesk protects your computer.' : 'Your account and the rules every session follows.';
    $('topbarTitle').textContent = TITLES[currentPanel] || 'ScopeDesk';
    $('topAvatar').textContent = u ? u.username.charAt(0).toUpperCase() : 'U';
    $('btnTopAssistant').classList.remove('hidden');                     // clients (by plan) and vendors both have the assistant
    $('navRemoteLink').classList.toggle('hidden', !isClient());          // vendors use Remote Desktop instead
    const pill = $('topPlanPill');
    pill.classList.toggle('hidden', !isClient() || !plan);
    if (plan) {
      pill.className = `plan-pill plan-pill-${plan.plan}${!isClient() ? ' hidden' : ''}`;
      $('topPlanName').textContent = PLAN_LABEL[plan.plan] || plan.plan;
      const left = (ms) => Math.max(0, Math.ceil((ms - Date.now()) / DAY));
      $('topPlanName').textContent = plan.plan === 'member' ? 'Premium Member' : plan.plan === 'trial' ? 'Premium Trial' : plan.plan === 'free' ? 'Free plan' : 'All features';
      $('topPlanSub').textContent = plan.plan === 'trial' ? `${left(plan.trialEndsAt)} days left`
        : plan.plan === 'member' ? `until ${new Date(plan.memberUntil).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`
        : plan.plan === 'free' ? `${plan.freeLeft} of ${plan.freeLimit} free tasks left` : 'payments off';
      $('topPlanCta').textContent = plan.plan === 'free' ? 'Upgrade' : plan.plan === 'trial' ? 'Keep Premium' : '';
      $('topPlanCta').classList.toggle('hidden', !(plan.plan === 'free' || plan.plan === 'trial') || !plan.paymentsEnabled);
    }
    $('cmdkHint').textContent = /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘ K' : 'Ctrl K';
  }

  // ---------- REMOTE CONNECTION HUB ----------
  // One clear answer to "what can my vendor see right now?", plus the share-mode choice (share-mode.js) and the session buttons.
  const SM = () => window.ScopeDeskShareMode;
  let hubSig = '';                  // buttons are rebuilt only when this changes (the 1-second clock must not steal focus)
  function renderHub() {
    if (!isClient() || !SM()) return;
    const live = deps.getLive();
    const share = deps.getShare();
    const mode = SM().get();
    const sharing = !!share.kind && ['waiting', 'connecting', 'live', 'lost'].includes(share.conn);
    const status = $('hubStatus');
    const facts = $('hubFacts');
    const actions = $('hubActions');
    facts.replaceChildren();
    let tone, kicker, title, text;
    if (live && sharing) {
      const win = share.kind === 'window';
      tone = win ? 'safe' : 'wide';
      kicker = share.conn === 'live' ? 'Live now' : share.conn === 'lost' ? 'Reconnecting' : 'Waiting for the vendor to connect';
      title = `Remote Access Enabled: ${win ? 'Specific Window Only' : 'Entire Screen'}`;
      text = win ? 'Your vendor sees only the window you picked. The rest of your desktop is private.'
        : 'Your vendor can see everything on your screen. Close anything private, or switch to Specific Window Only.';
    } else if (live) {
      tone = 'ready';
      kicker = 'Vendor is ready';
      title = 'Not sharing yet';
      text = `When you share, your vendor will see: ${SM().label(mode)}.`;
    } else {
      tone = 'off';
      kicker = 'Status';
      title = 'Remote access is off';
      text = 'Nothing on this computer is shared. When a vendor accepts one of your tickets, you can share from here.';
    }
    status.className = `hub-status hub-${tone}`;
    $('hubKicker').textContent = kicker;
    $('hubTitle').textContent = title;
    $('hubText').textContent = text;

    const fact = (k, v) => { if (v) facts.append(h('div', {}, h('dt', { text: k }), h('dd', { text: v }))); };
    const btn = (label, cls, fn) => h('button', { type: 'button', class: cls, onclick: fn, text: label });
    const lt = live ? deps.getLiveText() : null;
    if (live) {
      fact('Vendor', live.vendor);
      fact('Task', live.title);
      fact('Time left', lt.clock && lt.clock !== '--:--' ? lt.clock : '');
      fact('Remote control', String(lt.agent || '').split(' (')[0].split(':')[0]);
    }
    const sig = [tone, live ? live.taskId : '', sharing, mode, lt ? lt.canControl : '', lt ? lt.controlLabel : ''].join('|');
    if (sig !== hubSig) {
    hubSig = sig;
    actions.replaceChildren();
    if (live) {
      actions.append(btn(sharing ? 'Change what I share' : (mode === 'window' ? 'Share a window' : 'Share my screen'), 'btn-accent', deps.openShareDialog));
      if (lt.canControl && sharing) actions.append(btn(lt.controlLabel || 'Start remote control', 'btn-ghost-dark', deps.toggleRemoteControl));
      if (window.ScopeDeskMessages) actions.append(btn('Message vendor', 'btn-ghost-dark', () => ScopeDeskMessages.open(live.taskId)));
      actions.append(btn('Terminate Session Now', 'btn-danger hub-kill', () => { if (confirm('End the session now? The vendor is disconnected immediately.')) deps.terminateLive(); }));
    } else {
      actions.append(btn('Go to tickets', 'btn-ghost-dark', () => deps.route('overview-panel')), btn('+ New support task', 'btn-accent', deps.openNewTask));
    }
    }

    // mode cards
    document.querySelectorAll('#hubModes [data-share-choice]').forEach((c) => c.setAttribute('aria-checked', String(c.dataset.shareChoice === mode)));
    // sharing with the other mode than the one selected: offer to switch now
    const mismatch = sharing && share.kind !== mode;
    $('hubApply').classList.toggle('hidden', !mismatch);
    if (mismatch) $('hubApplyText').textContent = `You are sharing ${share.kind === 'window' ? 'one window' : 'your entire screen'} right now. Switch to ${SM().label(mode)}?`;
  }

  // ---------- BOARDS ----------
  // One state object; every change goes: update state -> render -> save to the server (in order, per card).
  // The board never re-draws while you are typing in it or dragging a card (that used to wipe edits); it catches up right after.
  const COLUMNS = [
    { key: 'todo', label: 'To do', hint: 'Things to start', empty: 'Nothing waiting. Add a card with + below.' },
    { key: 'doing', label: 'In progress', hint: 'Working on it', empty: 'Drag a card here, or press → on a card, when you start.' },
    { key: 'done', label: 'Done', hint: 'Finished', empty: 'Tick a card and it lands here.' }
  ];
  const STARTERS = {
    client: ['Check the fix works after the session', 'Send the vendor the error screenshot', 'Back up the files before the next session', 'Review what the vendor changed'],
    vendor: ['Ask the client for the error screenshot', 'Test the fix before ending the session', 'Write a short summary of what I changed', 'Follow up with the client tomorrow']
  };
  const PRIORITY = { high: 'High', normal: 'Normal', low: 'Low' };
  const PRIO_RANK = { high: 0, normal: 1, low: 2 };
  const BOARD_PREFS = 'scopedesk_board_prefs';
  const B = {
    items: [], loaded: false, error: '',
    view: 'kanban',
    filter: { q: '', priority: '', ticket: '', hideDone: false },
    busy: 0,                 // > 0 while the user is typing in the board or dragging: renders wait
    dirty: false,            // a render was skipped while busy
    dragId: null,
    queues: new Map(),       // card id -> promise chain, so saves for one card reach the server in order
    undo: null,              // { card, timer } after a delete
    loadSeq: 0
  };
  try { const p = JSON.parse(localStorage.getItem(BOARD_PREFS) || '{}'); if (p.view === 'list' || p.view === 'kanban') B.view = p.view; if (p.filter) Object.assign(B.filter, { priority: p.filter.priority || '', hideDone: !!p.filter.hideDone }); } catch (_) { /* blocked storage: defaults */ }
  function savePrefs() { try { localStorage.setItem(BOARD_PREFS, JSON.stringify({ view: B.view, filter: { priority: B.filter.priority, hideDone: B.filter.hideDone } })); } catch (_) { /* fine */ } }

  const ticketTitle = (id) => { const t = tasks().find((x) => x.id === id); return t ? t.title : null; };
  const byPos = (a, b) => a.position - b.position || a.id - b.id;
  const inCol = (status) => B.items.filter((c) => c.status === status).sort(byPos);
  function matches(c) {
    const f = B.filter;
    if (f.hideDone && c.status === 'done') return false;
    if (f.priority && c.priority !== f.priority) return false;
    if (f.ticket === 'none' && c.taskId) return false;
    if (f.ticket && f.ticket !== 'none' && String(c.taskId) !== f.ticket) return false;
    if (f.q) { const hay = `${c.title} ${(c.taskId && ticketTitle(c.taskId)) || ''}`.toLowerCase(); if (!hay.includes(f.q)) return false; }
    return true;
  }
  const filtering = () => !!(B.filter.q || B.filter.priority || B.filter.ticket || B.filter.hideDone);

  // ----- busy guard: hold renders while typing / dragging -----
  function holdRender() { B.busy += 1; }
  function releaseRender() { B.busy = Math.max(0, B.busy - 1); if (!B.busy && B.dirty) { B.dirty = false; renderBoard(); } }
  function requestRender() { if (B.busy) { B.dirty = true; return; } renderBoard(); }

  // ----- server sync -----
  async function loadBoard() {
    const seq = ++B.loadSeq;
    try {
      const items = (await deps.api('/api/board')).items || [];
      if (seq !== B.loadSeq) return;                 // a newer load already answered
      B.items = items; B.loaded = true; B.error = '';
    } catch (err) {
      if (seq !== B.loadSeq) return;
      B.error = err.message; B.loaded = true;
    }
    requestRender();
  }
  // Saves for the same card run one after another; if one fails, the board reloads from the server (the source of truth)
  function enqueue(id, job) {
    const prev = B.queues.get(id) || Promise.resolve();
    const next = prev.then(job, job).catch((err) => { deps.toast(err.message, true); loadBoard(); });
    B.queues.set(id, next);
    next.finally(() => { if (B.queues.get(id) === next) B.queues.delete(id); });
    return next;
  }
  function updateCard(card, changes) {
    Object.assign(card, changes, { updatedAt: new Date().toISOString() });
    requestRender();
    return enqueue(card.id, async () => {
      const res = await deps.api(`/api/board/${card.id}`, { method: 'PATCH', body: changes });
      const live = B.items.find((c) => c.id === card.id);
      if (live && res.item) { live.updatedAt = res.item.updatedAt; }   // keep local order/state; it is what we just sent
    });
  }
  async function addCard(title, { status = 'todo', priority = 'normal', taskId = null, position } = {}) {
    const res = await deps.api('/api/board', { method: 'POST', body: { title, status, priority, taskId } });
    const item = res.item;
    B.items.push(item);
    if (position !== undefined) { item.position = position; enqueue(item.id, () => deps.api(`/api/board/${item.id}`, { method: 'PATCH', body: { position } })); }
    requestRender();
    return item;
  }
  function deleteCard(card) {
    B.items = B.items.filter((c) => c !== card);
    showUndo(card);
    requestRender();
    enqueue(card.id, () => deps.api(`/api/board/${card.id}`, { method: 'DELETE' }));
  }
  function showUndo(card) {
    if (B.undo) clearTimeout(B.undo.timer);
    const bar = $('boardUndo');
    $('boardUndoText').textContent = `Deleted "${card.title.length > 48 ? card.title.slice(0, 48) + '...' : card.title}".`;
    bar.classList.remove('hidden');
    B.undo = { card, timer: setTimeout(hideUndo, 6000) };
  }
  function hideUndo() { if (B.undo) clearTimeout(B.undo.timer); B.undo = null; $('boardUndo').classList.add('hidden'); }
  async function undoDelete() {
    const u = B.undo; hideUndo();
    if (!u) return;
    const c = u.card;
    try { await addCard(c.title, { status: c.status, priority: c.priority, taskId: c.taskId, position: c.position }); }
    catch (err) { deps.toast(err.message, true); }
  }

  // ----- positions -----
  // Position for a card placed before `beforeId` (or at the end) in a column. Uses neighbours that are on screen, so it
  // works the same with or without filters. Re-numbers the column when the gaps get too small.
  function positionBefore(status, beforeId, movingId) {
    const list = inCol(status).filter((c) => c.id !== movingId);
    const i = beforeId == null ? list.length : list.findIndex((c) => c.id === beforeId);
    const at = i === -1 ? list.length : i;
    const prev = list[at - 1], next = list[at];
    if (!prev && !next) return 0;
    if (!prev) return next.position - 1;
    if (!next) return prev.position + 1;
    if (next.position - prev.position < 1e-6) { renumber(status, movingId); return positionBefore(status, beforeId, movingId); }
    return (prev.position + next.position) / 2;
  }
  function renumber(status, skipId) {
    inCol(status).filter((c) => c.id !== skipId).forEach((c, i) => { if (c.position !== i) updateCard(c, { position: i }); });
  }
  function moveTo(card, status, beforeId) {
    if (card.status === status && beforeId === card.id) return;
    updateCard(card, { status, position: positionBefore(status, beforeId, card.id) });
  }
  function step(card, dir) {
    const i = COLUMNS.findIndex((c) => c.key === card.status);
    const to = COLUMNS[i + dir];
    if (!to) return;
    const first = inCol(to.key)[0];
    moveTo(card, to.key, first ? first.id : null);
    focusCardSoon(card.id);
  }
  function reorder(card, dir) {
    const list = inCol(card.status).filter(matches);
    const i = list.indexOf(card);
    const j = i + dir;
    if (i === -1 || j < 0 || j >= list.length) return;
    const before = dir < 0 ? list[j].id : (list[j + 1] ? list[j + 1].id : null);
    moveTo(card, card.status, before);
    focusCardSoon(card.id);
  }
  function focusCardSoon(id) {
    const go = () => { const el = document.querySelector(`.kcard[data-id="${id}"]`); if (el && document.activeElement !== el) el.focus({ preventScroll: false }); };
    go(); requestAnimationFrame(go);                    // now (so fast key presses are not lost) and after any held render
  }
  function toggleDone(card, done) {
    const to = done ? 'done' : 'todo';
    const first = inCol(to)[0];
    moveTo(card, to, first ? first.id : null);
  }

  // ----- inline editors (hold renders while open) -----
  function inlineInput({ value = '', placeholder = '', label, cls, onDone }) {
    const input = h('input', { class: cls, value, maxlength: '140', placeholder, 'aria-label': label });
    let closed = false;
    holdRender();
    const finish = (save) => {
      if (closed) return; closed = true;
      const v = input.value.trim();
      Promise.resolve(onDone(save ? v : null)).finally(releaseRender);
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();                               // board shortcuts and the app's "G x" keys stay quiet while typing
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true));
    return input;
  }
  function titleEl(card) {
    const span = h('span', { class: 'card-title', text: card.title, title: 'Double-click to rename' });
    span.addEventListener('dblclick', () => startRename(card, span));
    return span;
  }
  function startRename(card, span) {
    const input = inlineInput({ value: card.title, label: 'Card title', cls: 'card-edit', onDone: (v) => {
      if (v && v !== card.title) updateCard(card, { title: v }); else B.dirty = true;
    } });
    span.replaceWith(input); input.focus(); input.select();
  }

  // ----- drawing -----
  function cardEl(card) {
    const done = card.status === 'done';
    const colIndex = COLUMNS.findIndex((c) => c.key === card.status);
    const tName = card.taskId ? ticketTitle(card.taskId) : null;
    const el = h('article', { class: `kcard${done ? ' is-done' : ''} prio-edge-${card.priority}`, draggable: 'true', tabindex: '0', dataset: { id: String(card.id) },
      'aria-label': `${card.title}. ${COLUMNS[colIndex].label}${card.priority !== 'normal' ? `, ${PRIORITY[card.priority]} priority` : ''}. Arrows move it, Enter renames, Delete removes.` },
      h('div', { class: 'kcard-top' },
        h('label', { class: 'check', title: done ? 'Mark as not done' : 'Mark as done' },
          h('input', { type: 'checkbox', checked: done, 'aria-label': `Done: ${card.title}`, onchange: (e) => toggleDone(card, e.target.checked) }),
          h('span', { class: 'check-box', 'aria-hidden': 'true' }, icon('check'))),
        titleEl(card)),
      tName ? h('button', { type: 'button', class: 'kcard-ticket', title: 'Open the ticket', onclick: () => deps.route('overview-panel') }, icon('ticket'), h('span', { text: tName })) : null,
      h('div', { class: 'kcard-foot' },
        h('button', { type: 'button', class: `prio prio-${card.priority} prio-btn`, title: 'Change priority', text: PRIORITY[card.priority] || card.priority,
          onclick: () => updateCard(card, { priority: card.priority === 'normal' ? 'high' : card.priority === 'high' ? 'low' : 'normal' }) }),
        h('span', { class: 'kcard-time', text: timeAgo(toMs(card.updatedAt)) }),
        h('span', { class: 'kcard-tools' },
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Move left', title: 'Move left', disabled: colIndex === 0, onclick: () => step(card, -1) }, icon('arrowL')),
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Move right', title: 'Move right', disabled: colIndex === COLUMNS.length - 1, onclick: () => step(card, 1) }, icon('arrowR')),
          h('button', { type: 'button', class: 'icon-btn danger', 'aria-label': `Delete ${card.title}`, title: 'Delete', onclick: () => deleteCard(card) }, icon('trash')))));
    el.addEventListener('keydown', (e) => {
      if (e.target !== el) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); step(card, 1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); step(card, -1); }
      else if (e.key === 'ArrowUp' && e.altKey) { e.preventDefault(); reorder(card, -1); }
      else if (e.key === 'ArrowDown' && e.altKey) { e.preventDefault(); reorder(card, 1); }
      else if (e.key === 'Enter') { e.preventDefault(); const t = el.querySelector('.card-title'); if (t) startRename(card, t); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteCard(card); }
      else if (e.key === ' ') { e.preventDefault(); toggleDone(card, card.status !== 'done'); focusCardSoon(card.id); }
    });
    el.addEventListener('dragstart', (e) => {
      if (e.target !== el) return;
      B.dragId = card.id; holdRender();
      e.dataTransfer.setData('text/plain', String(card.id)); e.dataTransfer.effectAllowed = 'move';
      requestAnimationFrame(() => el.classList.add('dragging'));
    });
    el.addEventListener('dragend', endDrag);
    return el;
  }
  function endDrag() {
    document.querySelectorAll('.kcard.dragging').forEach((c) => c.classList.remove('dragging'));
    document.querySelectorAll('.kcol.drop').forEach((c) => c.classList.remove('drop'));
    document.querySelectorAll('.drop-mark').forEach((m) => m.remove());
    if (B.dragId != null) { B.dragId = null; releaseRender(); }
  }
  // the card the drop lands before, from the pointer height
  function dropBefore(body, y) {
    const cards = [...body.querySelectorAll('.kcard:not(.dragging)')];
    const hit = cards.find((c) => { const r = c.getBoundingClientRect(); return y < r.top + r.height / 2; });
    return hit || null;
  }

  function quickAdd(col) {
    const btn = h('button', { type: 'button', class: 'kcol-add', text: '+ Add a card' });
    btn.addEventListener('click', () => {
      const input = inlineInput({ placeholder: 'Card title, then Enter', label: `New card in ${col.label}`, cls: 'kcol-add-input', onDone: async (v) => {
        B.dirty = true;
        if (v) { try { await addCard(v, { status: col.key }); } catch (err) { deps.toast(err.message, true); } }
      } });
      btn.replaceWith(input); input.focus();
    });
    return btn;
  }

  function column(col) {
    const all = inCol(col.key);
    const cards = all.filter(matches);
    const emptyText = all.length && !cards.length ? 'No cards match the filter.' : col.empty;
    const body = h('div', { class: 'kcol-body' }, cards.length ? cards.map(cardEl) : h('p', { class: 'kcol-empty', text: emptyText }));
    const count = filtering() && cards.length !== all.length ? `${cards.length}/${all.length}` : String(all.length);
    const clearDone = col.key === 'done' && all.length > 1
      ? h('button', { type: 'button', class: 'kcol-clear', title: 'Delete every card in Done', text: 'Clear', onclick: () => {
        if (!confirm(`Delete all ${all.length} finished cards?`)) return;
        all.forEach((c) => { B.items = B.items.filter((x) => x !== c); enqueue(c.id, () => deps.api(`/api/board/${c.id}`, { method: 'DELETE' })); });
        requestRender();
      } }) : null;
    const sec = h('section', { class: `kcol kcol-${col.key}`, 'aria-label': col.label, dataset: { col: col.key } },
      h('header', { class: 'kcol-head' }, h('span', { class: 'kcol-dot', 'aria-hidden': 'true' }),
        h('div', { class: 'kcol-title' }, h('h3', { text: col.label }), h('small', { text: col.hint })),
        clearDone, h('span', { class: 'kcol-count', text: count })),
      body, quickAdd(col));
    sec.addEventListener('dragover', (e) => {
      if (B.dragId == null) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      sec.classList.add('drop');
      let mark = body.querySelector('.drop-mark') || h('div', { class: 'drop-mark', 'aria-hidden': 'true' });
      const before = dropBefore(body, e.clientY);
      if (before) { if (mark.nextSibling !== before) body.insertBefore(mark, before); } else if (body.lastChild !== mark) body.appendChild(mark);
    });
    sec.addEventListener('dragleave', (e) => { if (!sec.contains(e.relatedTarget)) { sec.classList.remove('drop'); const m = body.querySelector('.drop-mark'); if (m) m.remove(); } });
    sec.addEventListener('drop', (e) => {
      e.preventDefault();
      const id = B.dragId != null ? B.dragId : Number(e.dataTransfer.getData('text/plain'));
      const card = B.items.find((c) => c.id === id);
      const before = dropBefore(body, e.clientY);
      endDrag();                                          // releases the render hold
      if (card) moveTo(card, col.key, before ? Number(before.dataset.id) : null);
    });
    return sec;
  }

  function listView() {
    const rows = COLUMNS.flatMap((c) => inCol(c.key)).filter(matches)
      .sort((a, b) => (a.status === 'done') - (b.status === 'done') || PRIO_RANK[a.priority] - PRIO_RANK[b.priority] || byPos(a, b));
    if (!rows.length) return h('p', { class: 'muted pad', text: B.items.length ? 'No cards match the filter.' : 'No cards yet. Add one above, or pick a starter card.' });
    return h('table', { class: 'dtable' },
      h('thead', {}, h('tr', {}, h('th', { text: '' }), h('th', { text: 'Card' }), h('th', { text: 'Ticket' }), h('th', { text: 'Status' }), h('th', { text: 'Priority' }), h('th', { text: 'Updated' }), h('th', { text: '' }))),
      h('tbody', {}, rows.map((card) => h('tr', { class: card.status === 'done' ? 'is-done' : '', dataset: { id: String(card.id) } },
        h('td', {}, h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: card.status === 'done', 'aria-label': `Done: ${card.title}`, onchange: (e) => toggleDone(card, e.target.checked) }), h('span', { class: 'check-box', 'aria-hidden': 'true' }, icon('check')))),
        h('td', { class: 'td-title' }, titleEl(card)),
        h('td', { class: 'muted', text: (card.taskId && ticketTitle(card.taskId)) || '-' }),
        h('td', {}, h('select', { class: 'mini-select', 'aria-label': 'Status', onchange: (e) => moveTo(card, e.target.value, (inCol(e.target.value)[0] || {}).id ?? null) },
          COLUMNS.map((c) => h('option', { value: c.key, selected: c.key === card.status, text: c.label })))),
        h('td', {}, h('select', { class: 'mini-select', 'aria-label': 'Priority', onchange: (e) => updateCard(card, { priority: e.target.value }) },
          Object.entries(PRIORITY).map(([k, v]) => h('option', { value: k, selected: k === card.priority, text: v })))),
        h('td', { class: 'muted', text: timeAgo(toMs(card.updatedAt)) }),
        h('td', {}, h('button', { type: 'button', class: 'icon-btn danger', 'aria-label': `Delete ${card.title}`, onclick: () => deleteCard(card) }, icon('trash')))))));
  }

  // ticket pickers (add form + filter): open tickets first
  let pickerSig = '';
  function fillTicketPickers() {
    const open = (t) => (['active', 'pending'].includes(t.status) ? 1 : 0);
    const list = tasks().slice().sort((a, b) => open(b) - open(a)).slice(0, 30);
    const sig = list.map((t) => `${t.id}:${t.title}`).join('|');
    if (sig === pickerSig) return;
    pickerSig = sig;
    const opt = (t) => h('option', { value: String(t.id), text: `${t.title.slice(0, 40)}${t.title.length > 40 ? '...' : ''}` });
    const add = $('boardAddTicket'), flt = $('boardFilterTicket');
    const keepA = add.value, keepF = flt.value;
    add.replaceChildren(h('option', { value: '', text: 'No ticket' }), ...list.map(opt));
    flt.replaceChildren(h('option', { value: '', text: 'All tickets' }), h('option', { value: 'none', text: 'Not linked' }), ...list.map(opt));
    if ([...add.options].some((o) => o.value === keepA)) add.value = keepA;
    if ([...flt.options].some((o) => o.value === keepF)) flt.value = keepF; else B.filter.ticket = '';
    add.classList.toggle('hidden', list.length === 0);
    flt.classList.toggle('hidden', list.length === 0);
  }

  function renderBoard() {
    if (!deps || !running) return;
    if (B.busy) { B.dirty = true; return; }
    const kan = $('boardKanban'), list = $('boardList');
    kan.classList.toggle('hidden', B.view !== 'kanban');
    list.classList.toggle('hidden', B.view !== 'list');
    document.querySelectorAll('#boardsPanel .seg-btn').forEach((x) => { const on = x.dataset.view === B.view; x.classList.toggle('active', on); x.setAttribute('aria-selected', String(on)); });
    $('boardFilterPrio').value = B.filter.priority;
    $('boardHideDone').checked = B.filter.hideDone;
    fillTicketPickers();
    if (!B.loaded) { kan.replaceChildren(h('p', { class: 'muted', text: 'Loading your board...' })); $('boardTools').classList.add('hidden'); return; }
    if (B.error && !B.items.length) {
      kan.replaceChildren(h('div', { class: 'board-error' }, h('p', { text: `The board could not be loaded: ${B.error}` }), h('button', { type: 'button', class: 'btn-accent small', text: 'Try again', onclick: () => { B.loaded = false; renderBoard(); loadBoard(); } })));
      return;
    }
    const empty = B.items.length === 0;
    $('boardWelcome').classList.toggle('hidden', !empty);
    $('boardTools').classList.toggle('hidden', empty);
    if (empty) {
      const role = isClient() ? 'client' : 'vendor';
      $('boardStarters').replaceChildren(...STARTERS[role].map((t) => h('button', { type: 'button', class: 'board-starter', onclick: async (e) => {
        e.currentTarget.disabled = true;
        try { await addCard(t); } catch (err) { deps.toast(err.message, true); e.currentTarget.disabled = false; }
      } }, h('span', { class: 'board-starter-plus', 'aria-hidden': 'true', text: '+' }), h('span', { text: t }))));
    }
    const shown = B.items.filter(matches).length;
    $('boardCount').textContent = filtering() ? `Showing ${shown} of ${B.items.length}` : `${B.items.length} card${B.items.length === 1 ? '' : 's'}`;
    $('boardClearFilters').classList.toggle('hidden', !filtering());
    // keep focus on the card that had it
    const focusedId = document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('kcard') ? document.activeElement.dataset.id : null;
    if (B.view === 'kanban') kan.replaceChildren(...COLUMNS.map(column)); else list.replaceChildren(listView());
    if (focusedId) focusCardSoon(focusedId);
  }

  function bindBoard() {
    $('boardAddForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('boardAddTitle');
      const title = input.value.trim();
      if (!title) { input.focus(); return; }
      input.value = '';
      const ticket = $('boardAddTicket').value;
      try {
        await addCard(title, { priority: $('boardAddPriority').value, taskId: ticket ? Number(ticket) : null });
        $('boardAddPriority').value = 'normal';
      } catch (err) { input.value = title; deps.toast(err.message, true); }
      input.focus();
    });
    document.querySelectorAll('#boardsPanel .seg-btn').forEach((b) => b.addEventListener('click', () => { B.view = b.dataset.view; savePrefs(); renderBoard(); }));
    let qTimer = null;
    $('boardSearch').addEventListener('input', (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { B.filter.q = e.target.value.trim().toLowerCase(); renderBoard(); }, 120); });
    $('boardSearch').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') { e.target.value = ''; B.filter.q = ''; renderBoard(); } });
    $('boardFilterPrio').addEventListener('change', (e) => { B.filter.priority = e.target.value; savePrefs(); renderBoard(); });
    $('boardFilterTicket').addEventListener('change', (e) => { B.filter.ticket = e.target.value; renderBoard(); });
    $('boardHideDone').addEventListener('change', (e) => { B.filter.hideDone = e.target.checked; savePrefs(); renderBoard(); });
    $('boardClearFilters').addEventListener('click', () => { B.filter = { q: '', priority: '', ticket: '', hideDone: false }; $('boardSearch').value = ''; $('boardFilterTicket').value = ''; savePrefs(); renderBoard(); });
    $('boardUndoBtn').addEventListener('click', undoDelete);
    // a drag cancelled outside the window (Esc, dropped on nothing) never leaves the board frozen
    document.addEventListener('drop', () => { if (B.dragId != null) setTimeout(endDrag, 0); });
    window.addEventListener('blur', () => { if (B.dragId != null) endDrag(); });
  }
  function resetBoard() { B.items = []; B.loaded = false; B.error = ''; B.busy = 0; B.dirty = false; B.dragId = null; B.queues.clear(); B.loadSeq += 1; pickerSig = ''; hideUndo(); }

  // ---------- ANALYTICS ----------
  function chartTooltip(container) {
    let tip = container.querySelector('.chart-tip');
    if (!tip) { tip = h('div', { class: 'chart-tip', role: 'status' }); container.appendChild(tip); }
    return {
      show(text, x, y) { tip.textContent = text; tip.style.left = `${x}px`; tip.style.top = `${y}px`; tip.classList.add('on'); },
      hide() { tip.classList.remove('on'); }
    };
  }
  function barChart(container, buckets, labelFor) {
    const W = 640, H = 220, padL = 28, padB = 22, padT = 10;
    const max = Math.max(1, ...buckets.map((b) => b.value));
    const step = (W - padL) / buckets.length;
    const bw = Math.max(3, Math.min(26, step * 0.62));
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': 'Bar chart' });
    const ticks = [0, Math.ceil(max / 2), max];
    ticks.forEach((t) => {
      const y = H - padB - (t / max) * (H - padB - padT);
      svg.appendChild(s('line', { x1: padL, x2: W, y1: y, y2: y, class: 'grid-line' }));
      const tx = s('text', { x: padL - 8, y: y + 4, class: 'axis-text', 'text-anchor': 'end' }); tx.textContent = String(t); svg.appendChild(tx);
    });
    const tip = chartTooltip(container);
    const every = Math.ceil(buckets.length / 8);
    buckets.forEach((b, i) => {
      const x = padL + i * step + (step - bw) / 2;
      const bh = (b.value / max) * (H - padB - padT);
      const rect = s('rect', { x, y: H - padB - bh, width: bw, height: Math.max(bh, b.value ? 2 : 0), rx: '3', class: 'bar' });
      const hit = s('rect', { x: padL + i * step, y: padT, width: step, height: H - padB - padT, class: 'hit', tabindex: '0', 'aria-label': `${labelFor(b)}: ${b.value}` });
      const show = () => { rect.classList.add('on'); const r = hit.getBoundingClientRect(), c = container.getBoundingClientRect(); tip.show(`${labelFor(b)} · ${b.value} ticket${b.value === 1 ? '' : 's'}`, r.left - c.left + r.width / 2, r.top - c.top + (H - padB - bh) / H * r.height - 8); };
      const hide = () => { rect.classList.remove('on'); tip.hide(); };
      hit.addEventListener('mouseenter', show); hit.addEventListener('focus', show);
      hit.addEventListener('mouseleave', hide); hit.addEventListener('blur', hide);
      svg.appendChild(rect); svg.appendChild(hit);
      if (i % every === 0) { const tx = s('text', { x: padL + i * step + step / 2, y: H - 6, class: 'axis-text', 'text-anchor': 'middle' }); tx.textContent = new Date(b.start).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }); svg.appendChild(tx); }
    });
    container.replaceChildren(svg, container.querySelector('.chart-tip') || h('div', { class: 'chart-tip' }));
  }
  function lineChart(container, points) {
    const W = 640, H = 200, padL = 40, padB = 22, padT = 12;
    const max = Math.max(1, ...points.map((p) => p.value));
    const step = points.length > 1 ? (W - padL - 10) / (points.length - 1) : 0;
    const xy = points.map((p, i) => [padL + i * step, H - padB - (p.value / max) * (H - padB - padT)]);
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img', 'aria-label': 'Line chart of approved minutes per week' });
    [0, Math.round(max / 2), max].forEach((t) => {
      const y = H - padB - (t / max) * (H - padB - padT);
      svg.appendChild(s('line', { x1: padL, x2: W, y1: y, y2: y, class: 'grid-line' }));
      const tx = s('text', { x: padL - 8, y: y + 4, class: 'axis-text', 'text-anchor': 'end' }); tx.textContent = String(t); svg.appendChild(tx);
    });
    const d = xy.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    svg.appendChild(s('defs', {}, s('linearGradient', { id: 'lineFill', x1: '0', x2: '0', y1: '0', y2: '1' }, s('stop', { offset: '0%', class: 'line-stop-a' }), s('stop', { offset: '100%', class: 'line-stop-b' }))));
    if (xy.length) svg.appendChild(s('path', { d: `${d} L${xy[xy.length - 1][0]},${H - padB} L${xy[0][0]},${H - padB} Z`, fill: 'url(#lineFill)' }));
    svg.appendChild(s('path', { d, class: 'line', fill: 'none' }));
    const tip = chartTooltip(container);
    xy.forEach((p, i) => {
      const dot = s('circle', { cx: p[0], cy: p[1], r: '4', class: 'line-dot', tabindex: '0', 'aria-label': `${points[i].label}: ${points[i].value} minutes` });
      const show = () => { dot.classList.add('on'); const r = dot.getBoundingClientRect(), c = container.getBoundingClientRect(); tip.show(`${points[i].label} · ${fmtMinutes(points[i].value)}`, r.left - c.left + r.width / 2, r.top - c.top - 10); };
      const hide = () => { dot.classList.remove('on'); tip.hide(); };
      dot.addEventListener('mouseenter', show); dot.addEventListener('focus', show);
      dot.addEventListener('mouseleave', hide); dot.addEventListener('blur', hide);
      svg.appendChild(dot);
      if (i % Math.ceil(points.length / 7) === 0 || i === points.length - 1) { const tx = s('text', { x: p[0], y: H - 6, class: 'axis-text', 'text-anchor': 'middle' }); tx.textContent = points[i].short; svg.appendChild(tx); }
    });
    container.replaceChildren(svg, container.querySelector('.chart-tip') || h('div', { class: 'chart-tip' }));
  }

  function renderAnalytics() {
    const since = Date.now() - rangeDays * DAY;
    const created = (t) => toMs(t.created_at || t.window_start);
    const inRange = tasks().filter((t) => created(t) >= since);
    // Tickets per day (per week for 90 days)
    let buckets = perDay(inRange, created, rangeDays);
    let label = (b) => new Date(b.start).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
    if (rangeDays > 45) {
      const weeks = [];
      for (let i = 0; i < buckets.length; i += 7) weeks.push({ start: buckets[i].start, value: buckets.slice(i, i + 7).reduce((n, b) => n + b.value, 0) });
      buckets = weeks;
      label = (b) => `Week of ${new Date(b.start).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`;
    }
    $('anBarsNote').textContent = rangeDays > 45 ? 'per week' : 'per day';
    barChart($('anBars'), buckets, label);

    // Approved minutes per week
    const weeksN = Math.max(2, Math.ceil(rangeDays / 7));
    const thisWeekStart = startOfDay(Date.now()) - ((new Date().getDay() + 6) % 7) * DAY;   // Monday
    const weeks = Array.from({ length: weeksN }, (_, i) => { const st = thisWeekStart - (weeksN - 1 - i) * 7 * DAY; return { st, value: 0 }; });
    tasks().forEach((t) => { const ms = created(t); const w = weeks.find((x) => ms >= x.st && ms < x.st + 7 * DAY); if (w) w.value += Number(t.duration_minutes) || 0; });
    lineChart($('anLine'), weeks.map((w) => ({ value: w.value, label: `Week of ${new Date(w.st).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`, short: new Date(w.st).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) })));

    // Outcomes
    const order = ['completed', 'active', 'pending', 'expired', 'terminated'];
    const counts = order.map((k) => ({ k, n: inRange.filter((t) => t.status === k).length })).filter((c) => c.n);
    const total = counts.reduce((n, c) => n + c.n, 0);
    const out = $('anOutcomes');
    out.replaceChildren();
    if (!total) out.appendChild(h('p', { class: 'muted', text: 'No tickets in this period.' }));
    else {
      out.appendChild(h('div', { class: 'stack', role: 'img', 'aria-label': counts.map((c) => `${STATUS[c.k].label}: ${c.n}`).join(', ') },
        counts.map((c) => h('span', { class: `stack-seg tone-${STATUS[c.k].tone}`, style: `flex:${c.n}`, title: `${STATUS[c.k].label}: ${c.n}` }))));
      out.appendChild(h('ul', { class: 'legend' }, counts.map((c) => h('li', {},
        h('span', { class: `legend-dot tone-${STATUS[c.k].tone}`, 'aria-hidden': 'true' }), h('span', { text: STATUS[c.k].label }),
        h('strong', { text: `${c.n}` }), h('span', { class: 'muted', text: `${Math.round((c.n / total) * 100)}%` })))));
    }

    // Top apps
    const appCount = new Map();
    inRange.forEach((t) => appsOf(t).forEach((a) => appCount.set(a, (appCount.get(a) || 0) + 1)));
    const top = [...appCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    const maxA = Math.max(1, ...top.map((x) => x[1]));
    $('anApps').replaceChildren(top.length
      ? h('ul', { class: 'hbars' }, top.map(([name, n]) => h('li', {}, h('div', { class: 'hbar-row' }, h('span', { text: name }), h('strong', { text: String(n) })),
        h('div', { class: 'hbar' }, h('span', { style: `width:${(n / maxA) * 100}%` })))))
      : h('p', { class: 'muted', text: 'No apps approved in this period.' }));
  }

  // ---------- SETTINGS & BILLING ----------
  let settingsTab = 'billing';
  function renderSettings() {
    const u = deps.getUser();
    if (!u) return;
    const tabs = [...document.querySelectorAll('#setTabs .seg-btn')];
    if (!isClient() && settingsTab === 'billing') settingsTab = 'account';
    tabs.forEach((b) => {
      if (b.dataset.tab === 'billing') b.classList.toggle('hidden', !isClient());
      const on = b.dataset.tab === settingsTab;
      b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll('#settingsPanel .set-section').forEach((sec) => sec.classList.toggle('hidden', sec.dataset.section !== settingsTab));
    applyTheme(currentThemePref, false);

    // Plan & billing
    if (isClient()) {
      const st = plan;
      const usage = $('setUsage');
      usage.replaceChildren();
      if (!st) usage.appendChild(h('p', { class: 'muted', text: 'Loading your plan...' }));
      else {
        const left = (ms) => Math.max(0, Math.ceil((ms - Date.now()) / DAY));
        const item = (k, v, tone) => h('div', { class: `usage-item${tone ? ' ' + tone : ''}` }, h('span', { class: 'usage-k', text: k }), h('strong', { class: 'usage-v', text: v }));
        usage.append(...[
          item('Current plan', PLAN_LABEL[st.plan] || st.plan, `tone-text-${st.plan}`),
          st.plan === 'trial' ? item('Trial ends', `${new Date(st.trialEndsAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })} (${left(st.trialEndsAt)} days)`) : null,
          st.plan === 'member' ? item('Membership until', new Date(st.memberUntil).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })) : null,
          st.plan === 'free' ? item('Free tasks left', `${st.freeLeft} of ${st.freeLimit} this month`) : item('Tasks', st.plan === 'legacy' ? 'Unlimited' : 'Unlimited, any length'),
          item('AI assistant', st.chatbot ? (st.chatbotConfigured ? 'Included' : 'Included (not set up on server)') : 'Not included')].filter(Boolean));
      }
      const tiers = $('setTiers');
      tiers.replaceChildren();
      const monthly = st && (st.memberships || []).find((m) => m.plan === 'monthly');
      const yearly = st && (st.memberships || []).find((m) => m.plan === 'yearly');
      const inr = (v) => Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
      const feat = (on, text) => h('li', { class: on ? 'yes' : 'no' }, h('span', { class: 'feat-ico', 'aria-hidden': 'true' }, on ? '✓' : '✕'), h('span', { text }));
      const tier = ({ name, price, per, blurb, features, current, cta, glow, badge, onBuy }) => h('article', { class: `tier${glow ? ' tier-glow tier-' + glow : ''}${current ? ' tier-current' : ''}` },
        badge ? h('span', { class: 'tier-badge', text: badge }) : null,
        h('h3', { text: name }),
        h('p', { class: 'tier-price' }, h('strong', { text: price }), per ? h('span', { text: per }) : null),
        h('p', { class: 'tier-blurb', text: blurb }),
        h('ul', { class: 'tier-feats' }, features),
        current ? h('div', { class: 'tier-cta current', text: 'Current plan' })
          : onBuy ? h('button', { type: 'button', class: `tier-cta tier-buy${glow ? ' accent' : ''}`, text: cta, onclick: onBuy })
          : h('div', { class: 'tier-cta muted', text: cta }));
      const freeN = st ? st.freeLimit : 3, freeMin = st ? st.freeMaxMinutes : 15;
      const paymentsOn = !!(st && st.paymentsEnabled);
      tiers.append(
        tier({ name: 'Free', price: '₹0', per: '/ forever', blurb: 'For occasional fixes.', current: st && st.plan === 'free', cta: 'After your trial',
          features: [feat(true, `${freeN} free tasks a month (up to ${freeMin} min)`), feat(true, 'Pay per task for longer or extra tasks'), feat(true, 'Full scope enforcement + kill switch'), feat(false, 'AI assistant')] }),
        tier({ name: 'Free trial', price: '₹0', per: `/ ${st ? st.trialDays : 30} days`, blurb: 'Everything included for new accounts.', current: st && st.plan === 'trial', cta: 'For new accounts',
          features: [feat(true, 'Every task free, any length'), feat(true, 'AI assistant included'), feat(true, 'Full scope enforcement + kill switch'), feat(true, 'Then moves to Free automatically')] }),
        tier({ name: 'Member · Monthly', price: monthly ? `₹${inr(monthly.priceInr)}` : '₹299', per: '/ month', blurb: 'For offices that need help often.', glow: 'indigo', badge: 'Popular',
          current: false, cta: !paymentsOn ? 'Payments are off' : st && st.plan === 'member' ? 'Add 30 days' : 'Upgrade monthly', onBuy: paymentsOn ? () => ScopeDeskPlans.buy('monthly') : null,
          features: [feat(true, 'Unlimited tasks, any length'), feat(true, 'AI assistant'), feat(true, 'No per-task payments'), feat(true, 'Renew early and the days add on')] }),
        tier({ name: 'Member · Yearly', price: yearly ? `₹${inr(yearly.priceInr)}` : '₹2,999', per: '/ year', glow: 'emerald',
          badge: monthly && yearly && monthly.priceInr * 12 > yearly.priceInr ? `Save ₹${inr(Math.round(monthly.priceInr * 12 - yearly.priceInr))}` : 'Best value',
          blurb: 'Best price for the whole year.', current: false, cta: !paymentsOn ? 'Payments are off' : st && st.plan === 'member' ? 'Add 365 days' : 'Upgrade yearly', onBuy: paymentsOn ? () => ScopeDeskPlans.buy('yearly') : null,
          features: [feat(true, 'Everything in Monthly'), feat(true, '12 months for the price of about 10'), feat(true, 'One payment, no renewals to remember'), feat(true, 'Days stack on a current membership')] })
      );
      $('setBillingNote').textContent = st && !st.paymentsEnabled
        ? 'Payments are switched off on this server, so every feature is free for everyone.'
        : 'Payments are processed by Razorpay. ScopeDesk never sees your card details. Memberships do not renew automatically.';
    }

    // Account
    const row = (k, v) => h('div', { class: 'kv' }, h('span', { class: 'kv-k', text: k }), h('span', { class: 'kv-v', text: v || '-' }));
    $('setAccount').replaceChildren(
      h('div', { class: 'acct-head' }, h('div', { class: 'acct-avatar', text: u.username.charAt(0).toUpperCase() }), h('div', {}, h('h3', { text: u.username }), h('p', { class: 'muted', text: isClient() ? 'Client account (office admin)' : 'Vendor account (support engineer)' }))),
      row('Username', u.username), row('Organisation', u.organization || 'Not set'), row('Account type', isClient() ? 'Client' : 'Vendor'),
      h('div', { class: 'acct-actions' }, h('button', { type: 'button', class: 'btn-ghost-dark', onclick: deps.logout }, icon('logout', 'btn-ico'), 'Sign out')));

    // Security
    const rule = (title, text) => h('li', {}, h('span', { class: 'rule-ico' }, icon('shield')), h('div', {}, h('strong', { text: title }), h('p', { class: 'muted', text })));
    $('setSecurity').replaceChildren(h('ul', { class: 'rules' },
      rule('Task-bounded access', 'A vendor can only connect with the one-time token of a ticket that was sent to their account, inside its time window.'),
      rule('Only approved apps and folders', 'The host agent on the client\'s PC watches the window in front. Any app or folder outside the ticket\'s scope stops input at once and ends the session.'),
      rule('Kill switch', '"Terminate Session Now" stops remote control on this PC first, then revokes the token and disconnects the vendor, even if the internet is slow.'),
      rule('Revoked tokens stay revoked', 'A terminated, expired or completed ticket can never be reopened with its token.'),
      rule('Private board and assistant', 'Your board cards and assistant conversations are yours only. Never paste passwords, OTPs or tokens into the assistant.')));

    // Shortcuts
    const mod = /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘' : 'Ctrl';
    const sc = (keys, text) => h('li', {}, h('span', { class: 'keys' }, keys.map((k) => h('kbd', { text: k }))), h('span', { text }));
    $('setShortcuts').replaceChildren(h('ul', { class: 'shortcuts' },
      sc([mod, 'K'], 'Search and commands'), sc(['T'], 'Switch light / dark mode'), sc(['G', 'R'], 'Go to Remote Connection'), sc(['G', 'M'], 'Go to Messages'), sc(['G', 'T'], 'Go to Tickets'), sc(['G', 'B'], 'Go to Boards'),
      sc(['G', 'A'], 'Go to Analytics'), sc(['G', 'S'], 'Go to Settings & Billing'), sc(['N'], 'New support task (clients)'), sc(['Esc'], 'Close a dialog or the assistant')));
  }

  // ---------- COMMAND PALETTE ----------
  let cmdItems = [], cmdIndex = 0;
  function commands() {
    const list = [
      { group: 'Go to', label: isClient() ? 'Tickets' : 'My Tasks', icon: 'ticket', run: () => deps.route('overview-panel') },
      { group: 'Go to', label: 'Messages', icon: 'ticket', run: () => deps.route('messagesPanel') },
      { group: 'Go to', label: 'Boards', icon: 'board', run: () => deps.route('boardsPanel') },
      { group: 'Go to', label: 'Analytics', icon: 'chart', run: () => deps.route('analyticsPanel') },
      { group: 'Go to', label: isClient() ? 'Settings & Billing' : 'Settings', icon: 'settings', run: () => deps.route('settingsPanel') }
    ];
    list.push({ group: 'Appearance', label: 'Switch to light mode', icon: 'settings', hint: 'T', run: () => setTheme('light') });
    list.push({ group: 'Appearance', label: 'Switch to dark mode', icon: 'settings', run: () => setTheme('dark') });
    list.push({ group: 'Appearance', label: 'Match my computer (light or dark)', icon: 'settings', run: () => setTheme('system') });
    if (isClient()) {
      list.splice(1, 0, { group: 'Go to', label: 'Remote Connection', icon: 'monitor', run: () => deps.route('remoteHubPanel') });
      list.push({ group: 'Remote access', label: 'Share: Specific Window Only', icon: 'monitor', run: () => { SM().set('window'); deps.route('remoteHubPanel'); } });
      list.push({ group: 'Remote access', label: 'Share: Entire Screen', icon: 'monitor', run: () => { SM().set('screen'); deps.route('remoteHubPanel'); } });
      list.push({ group: 'Actions', label: 'New support task', icon: 'plus', hint: 'N', run: deps.openNewTask });
      list.push({ group: 'Actions', label: 'Ask the AI assistant', icon: 'spark', run: deps.openAssistant });
      list.push({ group: 'Actions', label: 'View plans & upgrade', icon: 'card', run: () => { settingsTab = 'billing'; deps.route('settingsPanel'); } });
    } else {
      list.push({ group: 'Actions', label: 'Open Remote Desktop', icon: 'monitor', run: deps.openSession });
      list.push({ group: 'Actions', label: 'Ask the AI assistant (draft a reply, summarise a task)', icon: 'spark', run: deps.openAssistant });
    }
    list.push({ group: 'Actions', label: 'Add a card to my board', icon: 'board', run: () => { deps.route('boardsPanel'); setTimeout(() => $('boardAddTitle').focus(), 50); } });
    list.push({ group: 'Actions', label: 'Sign out', icon: 'logout', run: deps.logout });
    if (window.ScopeDeskMessages) tasks().filter((t) => t.status === 'pending' || t.status === 'active').slice(0, 10).forEach((t) => {
      list.push({ group: 'Messages', label: `Message ${counterparty(t)}`, sub: t.title, icon: 'ticket', search: `message chat text call ${counterparty(t)} ${t.title}`, run: () => ScopeDeskMessages.open(t.id) });
      list.push({ group: 'Messages', label: `Call ${counterparty(t)}`, sub: t.title, icon: 'monitor', search: `call phone voice ${counterparty(t)} ${t.title}`, run: () => ScopeDeskMessages.call(t.id) });
    });
    tasks().slice(0, 200).forEach((t) => {
      const st = STATUS[t.status] || { label: t.status };
      list.push({ group: isClient() ? 'Tickets' : 'Tasks', label: t.title, sub: `${counterparty(t)} · ${st.label}${t.token ? ' · ' + t.token : ''}`, icon: 'ticket', search: `${t.title} ${counterparty(t)} ${t.token || ''} ${st.label} ${appsOf(t).join(' ')}`, run: () => (t.status === 'active' && !isClient() ? deps.openSession() : deps.route('overview-panel')) });
    });
    return list;
  }
  function score(item, q) {
    if (!q) return item.group === 'Tickets' || item.group === 'Tasks' ? 1 : 2;
    const hay = (item.search || `${item.label} ${item.group}`).toLowerCase();
    const label = item.label.toLowerCase();
    if (label.startsWith(q)) return 10;
    if (label.includes(q)) return 7;
    if (hay.includes(q)) return 5;
    let i = 0; for (const ch of q) { i = hay.indexOf(ch, i); if (i === -1) return 0; i += 1; }   // letters in order
    return 2;
  }
  function renderCmdk() {
    const q = $('cmdkInput').value.trim().toLowerCase();
    const all = commands().map((it) => ({ it, sc: score(it, q) })).filter((x) => x.sc > 0);
    if (!q) { all.forEach((x) => { if (x.it.group === 'Tickets' || x.it.group === 'Tasks') x.keep = false; }); }
    const searchOnly = (g) => g === 'Tickets' || g === 'Tasks' || g === 'Messages';   // shown once you type
    let shown = all.filter((x) => q || !searchOnly(x.it.group));
    if (!q) shown = shown.concat(all.filter((x) => x.it.group === 'Tickets' || x.it.group === 'Tasks').slice(0, 5));
    shown.sort((a, b) => (q ? b.sc - a.sc : 0));
    cmdItems = shown.slice(0, 40).map((x) => x.it);
    cmdIndex = Math.min(cmdIndex, Math.max(0, cmdItems.length - 1));
    const list = $('cmdkList');
    list.replaceChildren();
    if (!cmdItems.length) { list.appendChild(h('li', { class: 'cmdk-empty', text: `Nothing matches "${$('cmdkInput').value}".` })); return; }
    let lastGroup = '';
    cmdItems.forEach((it, i) => {
      if (it.group !== lastGroup) { list.appendChild(h('li', { class: 'cmdk-group', role: 'presentation', text: it.group })); lastGroup = it.group; }
      list.appendChild(h('li', { class: `cmdk-item${i === cmdIndex ? ' on' : ''}`, role: 'option', id: `cmdk-${i}`, 'aria-selected': String(i === cmdIndex),
        onmousemove: () => { if (cmdIndex !== i) { cmdIndex = i; paintCmdk(); } }, onclick: () => runCmd(i) },
        h('span', { class: 'cmdk-item-ico' }, icon(it.icon)),
        h('span', { class: 'cmdk-item-text' }, h('span', { text: it.label }), it.sub ? h('small', { text: it.sub }) : null),
        it.hint ? h('kbd', { text: it.hint }) : h('span', { class: 'cmdk-enter', text: '↵' })));
    });
    $('cmdkInput').setAttribute('aria-activedescendant', `cmdk-${cmdIndex}`);
  }
  function paintCmdk() {
    document.querySelectorAll('.cmdk-item').forEach((el) => { const on = el.id === `cmdk-${cmdIndex}`; el.classList.toggle('on', on); el.setAttribute('aria-selected', String(on)); if (on) el.scrollIntoView({ block: 'nearest' }); });
    $('cmdkInput').setAttribute('aria-activedescendant', `cmdk-${cmdIndex}`);
  }
  function runCmd(i) { const it = cmdItems[i]; closeCmdk(); if (it) it.run(); }
  let lastFocus = null;
  function openCmdk() {
    if (!running) return;
    lastFocus = document.activeElement;
    $('cmdk').classList.remove('hidden');
    $('cmdkInput').value = '';
    cmdIndex = 0;
    renderCmdk();
    setTimeout(() => $('cmdkInput').focus(), 0);
  }
  function closeCmdk() {
    if ($('cmdk').classList.contains('hidden')) return;
    $('cmdk').classList.add('hidden');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  // ---------- keyboard ----------
  let gPressed = 0;
  const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
  const anyModalOpen = () => !!document.querySelector('.modal-overlay.open') || !$('terminationOverlay').hidden;
  function onKey(e) {
    if (!running) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); $('cmdk').classList.contains('hidden') ? openCmdk() : closeCmdk(); return; }
    if (!$('cmdk').classList.contains('hidden')) {
      if (e.key === 'Escape') { e.preventDefault(); closeCmdk(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); cmdIndex = Math.min(cmdItems.length - 1, cmdIndex + 1); paintCmdk(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); cmdIndex = Math.max(0, cmdIndex - 1); paintCmdk(); }
      else if (e.key === 'Enter') { e.preventDefault(); runCmd(cmdIndex); }
      return;
    }
    if (typing(document.activeElement) || e.ctrlKey || e.metaKey || e.altKey || anyModalOpen()) return;
    const k = e.key.toLowerCase();
    if (gPressed && Date.now() - gPressed < 1200) {
      gPressed = 0;
      const to = { r: isClient() ? 'remoteHubPanel' : null, m: 'messagesPanel', t: 'overview-panel', b: 'boardsPanel', a: 'analyticsPanel', s: 'settingsPanel' }[k];
      if (to) { e.preventDefault(); deps.route(to); }
      return;
    }
    if (k === 'g') { gPressed = Date.now(); return; }
    if (k === 'n' && isClient()) { e.preventDefault(); deps.openNewTask(); }
    if (k === 't') { e.preventDefault(); setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'); }
  }

  // ---------- data loading ----------
  async function loadAlerts() {
    if (!isClient()) { alerts = []; return; }
    try { alerts = (await deps.api('/api/alerts')).alerts || []; } catch (_) { /* keep the last list */ }
  }
  function renderCurrent() {
    if (!running) return;
    renderTopbar();
    if (currentPanel === 'remoteHubPanel') renderHub();
    else if (currentPanel === 'analyticsPanel') renderAnalytics();
    else if (currentPanel === 'boardsPanel') renderBoard();
    else if (currentPanel === 'settingsPanel') renderSettings();
  }

  function bind() {
    $('btnOpenCmdk').addEventListener('click', openCmdk);
    // Remote Connection: the two big mode cards (radio group with arrow keys) and "Switch now"
    const modeCards = [...document.querySelectorAll('#hubModes [data-share-choice]')];
    modeCards.forEach((c) => c.addEventListener('click', () => { if (SM()) SM().set(c.dataset.shareChoice); }));
    $('hubModes').addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault();
      const next = modeCards[(modeCards.indexOf(document.activeElement) + 1) % modeCards.length];
      next.focus(); if (SM()) SM().set(next.dataset.shareChoice);
    });
    $('hubApplyBtn').addEventListener('click', () => deps.openShareDialog());
    if (SM()) SM().onChange(() => { if (currentPanel === 'remoteHubPanel') renderHub(); });
    $('btnTopAssistant').addEventListener('click', () => deps.openAssistant());
    $('topPlanPill').addEventListener('click', () => { settingsTab = 'billing'; deps.route('settingsPanel'); });
    $('cmdk').addEventListener('mousedown', (e) => { if (e.target === $('cmdk')) closeCmdk(); });
    $('cmdkInput').addEventListener('input', () => { cmdIndex = 0; renderCmdk(); });
    document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => deps.route(b.dataset.go)));
    document.addEventListener('keydown', onKey);

    bindBoard();
    document.querySelectorAll('#anRange .seg-btn').forEach((b) => b.addEventListener('click', () => {
      rangeDays = Number(b.dataset.days);
      document.querySelectorAll('#anRange .seg-btn').forEach((x) => { const on = x === b; x.classList.toggle('active', on); x.setAttribute('aria-selected', String(on)); });
      renderAnalytics();
    }));
    document.querySelectorAll('#setTabs .seg-btn').forEach((b) => b.addEventListener('click', () => { settingsTab = b.dataset.tab; renderSettings(); }));
    if (window.ScopeDeskPlans) ScopeDeskPlans.onChange((st) => { plan = st; renderTopbar(); if (currentPanel === 'settingsPanel') renderSettings(); });
    setInterval(() => { if (running && currentPanel === 'remoteHubPanel' && !document.hidden) renderHub(); }, 1000);   // the time-left clock
  }

  window.ScopeDeskWorkspace = {
    init(d) { if (deps) return; deps = d; bind(); },
    async start() {
      running = true;
      resetBoard();
      renderTopbar();
      await loadAlerts();
      renderCurrent();
      loadBoard();
    },
    stop() { running = false; hubSig = ''; alerts = []; resetBoard(); plan = null; closeCmdk(); },
    onRoute(panelId) {
      currentPanel = panelId;
      document.body.dataset.panel = panelId;           // CSS: e.g. no floating assistant button over the Messages composer
      if (!running) return;
      if (panelId === 'analyticsPanel') loadAlerts().then(renderCurrent);
      renderCurrent();
      const main = document.querySelector('.main-content'); if (main) main.scrollTop = 0;
    },
    onTasks() {
      if (!running) return;
      if (currentPanel === 'boardsPanel') {
        // tickets changed: the board only needs a redraw if ticket names it shows changed (never while you type or drag)
        const sig = tasks().map((t) => `${t.id}:${t.title}`).join('|');
        renderTopbar();
        if (sig !== boardTaskSig) { boardTaskSig = sig; requestRender(); }
        return;
      }
      renderCurrent();
    },
    // after the live bar has updated in the same tick (the hub reads its clock and remote-control text)
    onRtc() { if (running && currentPanel === 'remoteHubPanel') setTimeout(renderHub, 0); },
    openPalette: openCmdk
  };
})();
