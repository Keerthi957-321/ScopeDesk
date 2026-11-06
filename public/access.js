// ScopeDesk "Request Additional Access" (browser side). Display and requests only: the SERVER validates every app and folder,
// only the ticket's client can approve, and the client's PC applies the new scope itself.
//   Vendor: "Request additional access" -> pick apps / type folders -> reason -> Send. Sees Waiting / Approved / Denied.
//   Client: a card slides in (bottom left, never blocks the screen): who asks, why, each item with a tick box -> Approve / Deny.
(function () {
  'use strict';
  let deps = null, running = false, isClient = false, loadedOnce = false;
  let catalog = [];
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const shown = new Map();                    // request id -> card element (client)
  let vendorTask = null;                      // ticket the vendor's dialog is about
  let pending = null;                         // vendor: the waiting request on that ticket

  // ---------- CLIENT: approval cards ----------
  function clientCard(r) {
    if (shown.has(r.id)) return;
    const card = el('section', 'access-card');
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-label', 'Request for more access');
    const head = el('header', 'access-card-head');
    head.append(el('span', 'access-card-ico', '\u{1F511}'), el('div', 'access-card-title'));
    head.lastChild.append(el('strong', '', `${r.vendorName || 'Your vendor'} asks for more access`), el('small', '', `Ticket: ${r.taskTitle || '#' + r.taskId}`));
    const why = el('p', 'access-card-why', `“${r.reason}”`);
    const list = el('div', 'access-card-items');
    const boxes = [];
    const item = (kind, value) => {
      const lab = el('label', 'access-item');
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = true; cb.dataset.kind = kind; cb.value = value;
      lab.append(cb, el('span', 'access-item-kind', kind === 'app' ? 'App' : 'Folder'), el('span', 'access-item-name', value));
      boxes.push(cb); list.append(lab);
    };
    r.apps.forEach((a) => item('app', a));
    r.paths.forEach((p) => item('path', p));
    const note = el('p', 'access-card-note', 'Nothing changes unless you approve. Untick anything you do not want to give. The session keeps running.');
    const actions = el('div', 'access-card-actions');
    const deny = el('button', 'btn-ghost', 'Deny'); deny.type = 'button';
    const approve = el('button', 'btn-accent', 'Approve selected'); approve.type = 'button';
    boxes.forEach((b) => b.addEventListener('change', () => { approve.disabled = !boxes.some((x) => x.checked); }));
    const busy = (on) => { deny.disabled = on; approve.disabled = on || !boxes.some((x) => x.checked); };
    deny.addEventListener('click', async () => {
      busy(true);
      try { await deps.api(`/api/access-requests/${r.id}/deny`, { method: 'POST' }); remove(r.id); deps.toast('Request denied. The vendor keeps the access they had.'); }
      catch (err) { deps.toast(err.message, true); busy(false); }
    });
    approve.addEventListener('click', async () => {
      busy(true);
      const apps = boxes.filter((b) => b.checked && b.dataset.kind === 'app').map((b) => b.value);
      const paths = boxes.filter((b) => b.checked && b.dataset.kind === 'path').map((b) => b.value);
      try {
        const res = await deps.api(`/api/access-requests/${r.id}/approve`, { method: 'POST', body: { apps, paths } });
        remove(r.id);
        deps.toast(`Approved: ${[...apps, ...paths].join(', ')}.${res.appliedLive ? ' It works right away.' : ' It applies when remote control starts.'}`);
        if (deps.onScope) deps.onScope(r.taskId);
      } catch (err) { deps.toast(err.message, true); busy(false); }
    });
    actions.append(deny, approve);
    card.append(head, why, list, note, actions);
    $('accessCards').append(card);
    shown.set(r.id, card);
    requestAnimationFrame(() => card.classList.add('in'));
    try { if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification('ScopeDesk: access request', { body: `${r.vendorName || 'Your vendor'} asks for: ${[...r.apps, ...r.paths].join(', ')}` }); } catch (_) { /* fine */ }
  }
  function remove(id) { const c = shown.get(id); if (c) { c.classList.remove('in'); setTimeout(() => c.remove(), 200); shown.delete(id); } }

  // pending requests that arrived while this page was closed
  async function loadClientPending() {
    const open = (deps.getTasks() || []).filter((t) => t.status === 'active' || t.status === 'pending').slice(0, 10);
    for (const t of open) {
      try {
        const r = await deps.api(`/api/tasks/${t.id}/access-requests`);
        (r.requests || []).filter((x) => x.status === 'pending').forEach((x) => clientCard({ ...x, taskTitle: t.title, vendorName: t.vendor_name || t.vendor_username }));
      } catch (_) { /* ticket gone */ }
    }
  }

  // ---------- VENDOR: the request dialog ----------
  async function openDialog(taskId) {
    if (!taskId) { deps.toast('Open a live ticket first.', true); return; }
    vendorTask = Number(taskId);
    const dlg = $('accessDialog');
    $('accessReason').value = ''; $('accessPaths').value = ''; $('accessError').textContent = '';
    $('accessAppSearch').value = '';
    dlg.classList.remove('hidden');
    renderApps();
    await refreshVendor();
    setTimeout(() => $('accessAppSearch').focus(), 0);
  }
  function closeDialog() { $('accessDialog').classList.add('hidden'); }
  let have = { apps: [], paths: [] };
  const picked = new Set();
  function renderApps() {
    const q = $('accessAppSearch').value.trim().toLowerCase();
    const haveKeys = new Set(have.apps.map((a) => a.toLowerCase()));
    const box = $('accessApps');
    box.replaceChildren();
    catalog.filter((a) => !haveKeys.has(a.toLowerCase()) && (!q || a.toLowerCase().includes(q))).slice(0, 40).forEach((a) => {
      const b = el('button', `access-app${picked.has(a) ? ' on' : ''}`, a); b.type = 'button';
      b.setAttribute('aria-pressed', String(picked.has(a)));
      b.addEventListener('click', () => { if (picked.has(a)) picked.delete(a); else picked.add(a); renderApps(); });
      box.append(b);
    });
    if (!box.children.length) box.append(el('p', 'muted', q ? 'No app with that name.' : 'Every app in the list is already allowed.'));
    $('accessPicked').textContent = picked.size ? `Asking for: ${[...picked].join(', ')}` : '';
  }
  async function refreshVendor() {
    if (vendorTask == null) return;
    try {
      const r = await deps.api(`/api/tasks/${vendorTask}/access-requests`);
      have = { apps: r.allowedApps || [], paths: r.allowedPaths || [] };
      pending = (r.requests || []).find((x) => x.status === 'pending') || null;
      $('accessHave').textContent = `Allowed now: ${have.apps.join(', ') || 'none'}${have.paths.length ? ' · Folders: ' + have.paths.join(', ') : ''}`;
      $('accessPending').classList.toggle('hidden', !pending);
      $('accessForm').classList.toggle('hidden', !!pending || !r.open);
      $('accessClosed').classList.toggle('hidden', r.open);
      if (pending) $('accessPendingText').textContent = `Waiting for the client to answer: ${[...pending.apps, ...pending.paths].join(', ')}`;
      const last = (r.requests || []).find((x) => x.status !== 'pending');
      $('accessLast').textContent = last ? `Last request: ${last.status}${last.status === 'approved' ? ' (' + [...last.grantedApps, ...last.grantedPaths].join(', ') + ')' : ''}` : '';
      renderApps();
    } catch (err) { $('accessError').textContent = err.message; }
  }
  async function send(e) {
    e.preventDefault();
    const paths = $('accessPaths').value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    $('accessError').textContent = '';
    const btn = $('accessSend'); btn.disabled = true;
    try {
      await deps.api(`/api/tasks/${vendorTask}/access-requests`, { method: 'POST', body: { apps: [...picked], paths, reason: $('accessReason').value } });
      picked.clear();
      deps.toast('Request sent. Nothing changes until the client approves.');
      await refreshVendor();
    } catch (err) { $('accessError').textContent = err.message; }
    finally { btn.disabled = false; }
  }
  async function cancelPending() {
    if (!pending) return;
    try { await deps.api(`/api/access-requests/${pending.id}/cancel`, { method: 'POST' }); await refreshVendor(); } catch (err) { deps.toast(err.message, true); }
  }

  // ---------- live updates ----------
  function onEvent(r) {
    if (!running || !r) return;
    if (isClient) {
      if (r.status === 'pending') clientCard(r); else remove(r.id);
      return;
    }
    if (r.status === 'approved') {
      deps.toast(`The client approved: ${[...r.grantedApps, ...r.grantedPaths].join(', ')}. You can use it now.`);
      if (deps.onScope) deps.onScope(r.taskId, r);
    } else if (r.status === 'denied') deps.toast('The client denied the request. Keep to the current scope.', true);
    else if (r.status === 'expired') deps.toast('The access request expired because the ticket ended.', true);
    if (vendorTask === r.taskId && !$('accessDialog').classList.contains('hidden')) refreshVendor();
  }

  function bind() {
    $('accessForm').addEventListener('submit', send);
    $('accessClose').addEventListener('click', closeDialog);
    $('accessCancelPending').addEventListener('click', cancelPending);
    $('accessAppSearch').addEventListener('input', renderApps);
    $('accessDialog').addEventListener('click', (e) => { if (e.target === $('accessDialog')) closeDialog(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('accessDialog').classList.contains('hidden')) closeDialog(); });
    $('btnRequestAccess').addEventListener('click', () => openDialog(deps.getSessionTaskId()));
  }

  window.ScopeDeskAccess = {
    init(d) { deps = d; bind(); },
    bindSocket(s) { s.on('access-request', onEvent); s.on('connect', () => { if (running && isClient && loadedOnce) loadClientPending(); }); },
    async start() {
      running = true;
      isClient = deps.getUser() && deps.getUser().role === 'client';
      $('btnRequestAccess').classList.toggle('hidden', isClient);
      if (isClient) loadClientPending();
      else { try { catalog = (await deps.api('/api/apps')).apps || []; } catch (_) { catalog = []; } }
    },
    stop() { running = false; loadedOnce = false; shown.forEach((c) => c.remove()); shown.clear(); closeDialog(); picked.clear(); vendorTask = null; },
    open: openDialog,
    tasksLoaded() { if (running && isClient && !loadedOnce) { loadedOnce = true; loadClientPending(); } }
  };
})();
