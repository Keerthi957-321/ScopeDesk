// ScopeDesk workspace pages: Workspace (projects & groups), Analytics, Settings & Billing, the top bar and the Ctrl/Cmd+K palette.
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
    board: 'M3 3h18v18H3zM9 3v18M15 3v18', workspace: 'M3 3h8v8H3zM13 3h8v5h-8zM13 10h8v11h-8zM3 13h8v8H3z',
    message: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z', edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
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

  // ---------- WORKSPACE (projects / groups; replaced the old Boards) ----------
  // The server says who sees what (GET /api/workspace): the client edits, vendors only see their own tickets in the groups.
  // Redraws are skipped while the "new group" form or a rename is open, so typing is never wiped by a live update.
  const WS = { data: null, loaded: false, error: '', q: '', hideEnded: false, seq: 0, editing: 0, dirty: false, newColor: 'indigo', timer: null };
  const STAGE_ORDER = { live: 0, waiting: 1, done: 2, stopped: 3, ended: 4 };
  try { WS.hideEnded = localStorage.getItem('scopedesk_ws_hide') === '1'; } catch (_) { /* fine */ }

  async function loadWorkspace() {
    const seq = ++WS.seq;
    try { const d = await deps.api('/api/workspace'); if (seq !== WS.seq) return; WS.data = d; WS.error = ''; }
    catch (err) { if (seq !== WS.seq) return; WS.error = err.message; }
    WS.loaded = true;
    wsRender();
  }
  // live updates come in bursts (a ticket starts, a message, a move): one reload for the burst
  function wsSoon() { clearTimeout(WS.timer); WS.timer = setTimeout(() => { if (running && currentPanel === 'workspacePanel') loadWorkspace(); else WS.loaded = false; }, 250); }
  const wsHold = () => { WS.editing += 1; };
  const wsRelease = () => { WS.editing = Math.max(0, WS.editing - 1); if (!WS.editing && WS.dirty) { WS.dirty = false; wsRender(); } };

  const wsMatch = (t) => (!WS.hideEnded || t.stage === 'live' || t.stage === 'waiting')
    && (!WS.q || `${t.title} ${t.owner} ${t.apps.join(' ')}`.toLowerCase().includes(WS.q));
  const sortTasks = (list) => list.slice().sort((a, b) => STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage] || b.id - a.id);

  function stageChip(t) {
    const left = (t.stage === 'live' || t.stage === 'waiting') && t.minutesLeft != null ? ` · ${t.minutesLeft} min left` : '';
    return h('span', { class: `ws-stage ws-stage-${t.stage}`, text: t.stageLabel + left });
  }
  function taskRow(t, editable) {
    const row = h('div', { class: `ws-task ws-task-${t.stage}`, dataset: { id: String(t.id) } },
      h('span', { class: `ws-dot ws-dot-${t.stage}`, 'aria-hidden': 'true' }),
      h('div', { class: 'ws-task-main' },
        h('strong', { class: 'ws-task-title', text: t.title }),
        h('div', { class: 'ws-task-meta' },
          stageChip(t),
          h('span', { class: 'ws-owner', title: t.ownerRole === 'vendor' ? 'Vendor working on it' : 'Client', text: `${t.ownerRole === 'vendor' ? 'Vendor' : 'Client'}: ${t.owner}` }),
          h('span', { class: 'ws-scope', title: 'Allowed in this ticket', text: `Scope: ${t.apps.join(', ') || '-'}${t.folders ? ` + ${t.folders} folder${t.folders === 1 ? '' : 's'}` : ''}` }))),
      h('div', { class: 'ws-task-actions' },
        h('button', { type: 'button', class: 'icon-btn', title: 'Open the conversation', 'aria-label': `Message about ${t.title}`, onclick: () => { if (window.ScopeDeskMessages) ScopeDeskMessages.open(t.id); } }, icon('message')),
        editable ? groupPicker(t) : null));
    return row;
  }
  function groupPicker(t) {
    const projects = (WS.data && WS.data.projects) || [];
    const sel = h('select', { class: 'mini-select ws-move', 'aria-label': `Group for ${t.title}`, title: 'Move to another group' },
      h('option', { value: '', text: 'Not grouped', selected: !t.projectId }),
      ...projects.map((p) => h('option', { value: String(p.id), text: p.name, selected: p.id === t.projectId })));
    sel.addEventListener('focus', wsHold); sel.addEventListener('blur', wsRelease);
    sel.addEventListener('change', async () => {
      const projectId = sel.value ? Number(sel.value) : null;
      try { await deps.api(`/api/tasks/${t.id}/project`, { method: 'PUT', body: { projectId } }); t.projectId = projectId; sel.blur(); loadWorkspace(); }
      catch (err) { deps.toast(err.message, true); }
    });
    return sel;
  }

  function progress(tasks) {
    const total = tasks.length;
    const done = tasks.filter((t) => t.stage === 'done').length;
    const live = tasks.filter((t) => t.stage === 'live').length;
    const waiting = tasks.filter((t) => t.stage === 'waiting').length;
    return { total, done, live, waiting, pct: total ? Math.round((done / total) * 100) : 0 };
  }

  function groupCard(p, editable) {
    const all = p.tasks || [];
    const shown = sortTasks(all.filter(wsMatch));
    const pr = progress(all);
    const title = h('h3', { class: 'ws-group-name', text: p.name, title: editable ? 'Double-click to rename' : '' });
    if (editable) title.addEventListener('dblclick', () => renameGroup(p, title));
    const card = h('section', { class: `ws-group ws-c-${p.color}${pr.live ? ' has-live' : ''}`, 'aria-label': p.name, dataset: { id: String(p.id) } },
      h('header', { class: 'ws-group-head' },
        h('span', { class: 'ws-swatch', 'aria-hidden': 'true' }),
        h('div', { class: 'ws-group-title' }, title,
          h('small', { class: 'muted', text: `${pr.total} ticket${pr.total === 1 ? '' : 's'}${pr.live ? ` · ${pr.live} live` : ''}${pr.waiting ? ` · ${pr.waiting} waiting` : ''}` })),
        editable ? h('div', { class: 'ws-group-tools' },
          h('button', { type: 'button', class: 'icon-btn', title: 'Change colour', 'aria-label': `Change colour of ${p.name}`, onclick: () => cycleColor(p) }, h('span', { class: 'ws-swatch small', 'aria-hidden': 'true' })),
          h('button', { type: 'button', class: 'icon-btn', title: 'Rename', 'aria-label': `Rename ${p.name}`, onclick: () => renameGroup(p, title) }, icon('edit')),
          h('button', { type: 'button', class: 'icon-btn danger', title: 'Delete group (tickets are kept)', 'aria-label': `Delete ${p.name}`, onclick: () => deleteGroup(p) }, icon('trash'))) : null),
      h('div', { class: 'ws-progress', title: `${pr.pct}% done`, role: 'progressbar', 'aria-valuenow': String(pr.pct), 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('span', { style: `width:${pr.pct}%` })),
      h('div', { class: 'ws-tasks' }, shown.length ? shown.map((t) => taskRow(t, editable))
        : h('p', { class: 'ws-empty', text: all.length ? 'Nothing matches.' : (editable ? 'No tickets yet. Move a ticket here with its group menu.' : 'No tickets of yours in this group.') })));
    return card;
  }

  function wsRender() {
    if (!deps || !running || currentPanel !== 'workspacePanel') return;
    if (WS.editing) { WS.dirty = true; return; }
    const grid = $('wsGrid');
    const editable = !!(WS.data && WS.data.canEdit);
    $('wsNewGroup').classList.toggle('hidden', !editable);
    $('wsHideEnded').checked = WS.hideEnded;
    $('wsSub').textContent = isClient()
      ? 'Your tickets grouped by project. You and your vendors see, live, what is being worked on in each group.'
      : 'The groups your clients made, with only your own tickets in them. You see, live, what is waiting and what is being worked on.';
    if (!WS.loaded) { grid.replaceChildren(h('p', { class: 'muted', text: 'Loading the workspace...' })); return; }
    if (WS.error && !WS.data) { grid.replaceChildren(h('div', { class: 'board-error' }, h('p', { text: `The workspace could not be loaded: ${WS.error}` }), h('button', { type: 'button', class: 'btn-accent small', text: 'Try again', onclick: loadWorkspace }))); return; }
    const d = WS.data;
    const everything = [...d.projects.flatMap((p) => p.tasks), ...d.ungrouped];
    const pr = progress(everything);
    $('wsSummary').replaceChildren(
      h('span', { class: 'ws-sum ws-sum-live', text: `${pr.live} live` }),
      h('span', { class: 'ws-sum ws-sum-waiting', text: `${pr.waiting} waiting` }),
      h('span', { class: 'ws-sum', text: `${pr.done} done` }),
      h('span', { class: 'ws-sum', text: `${d.projects.length} group${d.projects.length === 1 ? '' : 's'}` }));
    // what is being worked on right now, across every group
    const live = everything.filter((t) => t.stage === 'live' && wsMatch(t));
    $('wsNow').classList.toggle('hidden', !live.length);
    const groupOf = (t) => d.projects.find((p) => p.id === t.projectId);
    $('wsNowList').replaceChildren(...live.map((t) => {
      const g = groupOf(t);
      return h('button', { type: 'button', class: `ws-now-card ws-c-${g ? g.color : 'slate'}`, onclick: () => { if (!isClient()) deps.openSession && deps.openSession(); else deps.route('remoteHubPanel'); } },
        h('span', { class: 'ws-now-group', text: g ? g.name : 'Not grouped' }),
        h('strong', { text: t.title }),
        h('span', { class: 'muted', text: `${t.ownerRole === 'vendor' ? 'Vendor' : 'Client'}: ${t.owner} · ${t.minutesLeft != null ? t.minutesLeft + ' min left' : 'live'} · ${t.apps.join(', ')}` }));
    }));
    const cards = d.projects.map((p) => groupCard(p, editable));
    if (d.ungrouped.length || !d.projects.length) {
      cards.push(groupCard({ id: 0, name: 'Not grouped', color: 'slate', tasks: d.ungrouped }, false));
      if (editable) {
        // the "Not grouped" cluster still lets the client move tickets out of it
        const last = cards[cards.length - 1];
        last.classList.add('ws-ungrouped');
        last.querySelector('.ws-tasks').replaceChildren(...(sortTasks(d.ungrouped.filter(wsMatch)).map((t) => taskRow(t, true))));
        if (!d.ungrouped.length) last.querySelector('.ws-tasks').append(h('p', { class: 'ws-empty', text: 'Every ticket is in a group.' }));
      }
    }
    if (!everything.length && !d.projects.length) {
      grid.replaceChildren(h('div', { class: 'ws-welcome' },
        h('h2', { text: isClient() ? 'Group your tickets into projects' : 'Nothing here yet' }),
        h('p', { class: 'muted', text: isClient() ? 'Create a group (for example "Accounts" or "Office network"), then move tickets into it. Your vendors see the group and the live status of their own tickets.' : 'When a client sends you a ticket it appears here, inside the client’s group.' }),
        isClient() ? h('button', { type: 'button', class: 'btn-accent', text: '+ Create your first group', onclick: openNewGroup }) : null));
      return;
    }
    grid.replaceChildren(...cards);
  }

  // ----- client edits -----
  function colorButtons() {
    const box = $('wsNewColors');
    box.replaceChildren(...((WS.data && WS.data.colors) || ['indigo']).map((c) => {
      const b = h('button', { type: 'button', class: `ws-color ws-c-${c}${c === WS.newColor ? ' on' : ''}`, role: 'radio', 'aria-checked': String(c === WS.newColor), 'aria-label': c, title: c });
      b.addEventListener('click', () => { WS.newColor = c; colorButtons(); });
      return b;
    }));
  }
  function openNewGroup() {
    const f = $('wsNewForm');
    if (!f.classList.contains('hidden')) { $('wsNewName').focus(); return; }
    f.classList.remove('hidden'); wsHold(); colorButtons(); $('wsNewName').value = ''; $('wsNewName').focus();
  }
  function closeNewGroup() { const f = $('wsNewForm'); if (f.classList.contains('hidden')) return; f.classList.add('hidden'); wsRelease(); }
  async function createGroup(e) {
    e.preventDefault();
    const name = $('wsNewName').value.trim();
    if (!name) { $('wsNewName').focus(); return; }
    try { await deps.api('/api/projects', { method: 'POST', body: { name, color: WS.newColor } }); closeNewGroup(); await loadWorkspace(); deps.toast(`Group "${name}" created. Move tickets into it with their group menu.`); }
    catch (err) { deps.toast(err.message, true); }
  }
  function renameGroup(p, titleEl) {
    const input = h('input', { class: 'card-edit ws-rename', value: p.name, maxlength: '60', 'aria-label': 'Group name' });
    let done = false;
    wsHold();
    const finish = async (save) => {
      if (done) return; done = true;
      const v = input.value.trim();
      if (save && v && v !== p.name) { try { await deps.api(`/api/projects/${p.id}`, { method: 'PATCH', body: { name: v } }); p.name = v; } catch (err) { deps.toast(err.message, true); } }
      WS.dirty = true; wsRelease(); loadWorkspace();
    };
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); finish(true); } if (e.key === 'Escape') finish(false); });
    input.addEventListener('blur', () => finish(true));
    titleEl.replaceWith(input); input.focus(); input.select();
  }
  async function cycleColor(p) {
    const colors = (WS.data && WS.data.colors) || [];
    const next = colors[(colors.indexOf(p.color) + 1) % colors.length];
    try { await deps.api(`/api/projects/${p.id}`, { method: 'PATCH', body: { color: next } }); p.color = next; wsRender(); } catch (err) { deps.toast(err.message, true); }
  }
  async function deleteGroup(p) {
    if (!confirm(`Delete the group "${p.name}"? Its ${p.tasks.length} ticket(s) are kept and move to "Not grouped".`)) return;
    try { await deps.api(`/api/projects/${p.id}`, { method: 'DELETE' }); await loadWorkspace(); } catch (err) { deps.toast(err.message, true); }
  }

  function bindWorkspace() {
    $('wsNewGroup').addEventListener('click', openNewGroup);
    $('wsNewCancel').addEventListener('click', closeNewGroup);
    $('wsNewForm').addEventListener('submit', createGroup);
    $('wsNewName').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') closeNewGroup(); });
    let t = null;
    $('wsSearch').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { WS.q = e.target.value.trim().toLowerCase(); wsRender(); }, 120); });
    $('wsSearch').addEventListener('keydown', (e) => e.stopPropagation());
    $('wsHideEnded').addEventListener('change', (e) => { WS.hideEnded = e.target.checked; try { localStorage.setItem('scopedesk_ws_hide', WS.hideEnded ? '1' : '0'); } catch (_) { /* fine */ } wsRender(); });
  }
  function resetWorkspace() { WS.data = null; WS.loaded = false; WS.error = ''; WS.editing = 0; WS.dirty = false; WS.seq += 1; clearTimeout(WS.timer); }


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
      rule('Private assistant', 'Your assistant conversations are yours only. Never paste passwords, OTPs or tokens into the assistant.')));

    // Shortcuts
    const mod = /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘' : 'Ctrl';
    const sc = (keys, text) => h('li', {}, h('span', { class: 'keys' }, keys.map((k) => h('kbd', { text: k }))), h('span', { text }));
    $('setShortcuts').replaceChildren(h('ul', { class: 'shortcuts' },
      sc([mod, 'K'], 'Search and commands'), sc(['T'], 'Switch light / dark mode'), sc(['G', 'R'], 'Go to Remote Connection'), sc(['G', 'M'], 'Go to Messages'), sc(['G', 'T'], 'Go to Tickets'), sc(['G', 'W'], 'Go to Workspace'),
      sc(['G', 'A'], 'Go to Analytics'), sc(['G', 'S'], 'Go to Settings & Billing'), sc(['N'], 'New support task (clients)'), sc(['Esc'], 'Close a dialog or the assistant')));
  }

  // ---------- COMMAND PALETTE ----------
  let cmdItems = [], cmdIndex = 0;
  function commands() {
    const list = [
      { group: 'Go to', label: isClient() ? 'Tickets' : 'My Tasks', icon: 'ticket', run: () => deps.route('overview-panel') },
      { group: 'Go to', label: 'Messages', icon: 'ticket', run: () => deps.route('messagesPanel') },
      { group: 'Go to', label: 'Workspace (projects & groups)', icon: 'workspace', run: () => deps.route('workspacePanel') },
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
    if (isClient()) list.push({ group: 'Actions', label: 'New workspace group', icon: 'workspace', run: () => { deps.route('workspacePanel'); setTimeout(openNewGroup, 80); } });
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
      const to = { r: isClient() ? 'remoteHubPanel' : null, m: 'messagesPanel', t: 'overview-panel', w: 'workspacePanel', a: 'analyticsPanel', s: 'settingsPanel' }[k];
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
    else if (currentPanel === 'workspacePanel') { if (!WS.loaded) { wsRender(); loadWorkspace(); } else wsRender(); }
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

    bindWorkspace();
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
      resetWorkspace();
      renderTopbar();
      await loadAlerts();
      renderCurrent();
    },
    stop() { running = false; hubSig = ''; alerts = []; resetWorkspace(); plan = null; closeCmdk(); },
    // a group or a ticket in it changed (this tab, another tab, or the other side): refresh
    workspaceChanged() { if (running) wsSoon(); },
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
      if (currentPanel === 'workspacePanel') { renderTopbar(); wsSoon(); return; }   // ticket states changed: reload the groups once
      renderCurrent();
    },
    // after the live bar has updated in the same tick (the hub reads its clock and remote-control text)
    onRtc() { if (running && currentPanel === 'remoteHubPanel') setTimeout(renderHub, 0); },
    openPalette: openCmdk
  };
})();
