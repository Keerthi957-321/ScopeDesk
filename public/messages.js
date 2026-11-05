// ScopeDesk messages + voice calls between a ticket's client and its vendor (server/conversations.js decides who may do what).
//   ScopeDeskMessages.init(deps)        once, from script.js   deps: { api, toast, getUser, route }
//   ScopeDeskMessages.bindSocket(s)     every time script.js (re)creates its Socket.IO connection
//   ScopeDeskMessages.start() / stop()  after sign-in / on sign-out
//   ScopeDeskMessages.open(taskId)      open the Messages page on one ticket's conversation
//   ScopeDeskMessages.call(taskId)      start a voice call on that ticket
//   ScopeDeskMessages.onRoute(panelId)  the page that is shown changed
// Messages are rendered with textContent only. Calls are WebRTC audio, peer to peer; the server only relays the handshake.
(function () {
  const $ = (id) => document.getElementById(id);
  let deps = null;
  let socket = null;
  let running = false;
  let convs = [];
  let unread = 0;
  let activeTask = null;            // taskId of the open thread
  let thread = null;                // { taskId, me, title, status, otherName, canSend, canCall, why, messages: [] }
  let onPage = false;
  let loadingList = null;

  const isClient = () => { const u = deps && deps.getUser(); return !!u && u.role === 'client'; };
  const toMs = (v) => { if (!v) return NaN; const s = String(v); return new Date(s.includes('T') || s.endsWith('Z') ? s : s.replace(' ', 'T') + 'Z').getTime(); };
  const timeOf = (ms) => new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  const dayOf = (ms) => {
    const d = new Date(ms), today = new Date(); const y = new Date(); y.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'Today';
    if (d.toDateString() === y.toDateString()) return 'Yesterday';
    return d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  };
  const shortAgo = (ms) => {
    const d = Date.now() - ms; if (!Number.isFinite(d)) return '';
    if (d < 60000) return 'now'; if (d < 3600000) return `${Math.floor(d / 60000)}m`; if (d < 86400000) return `${Math.floor(d / 3600000)}h`;
    return new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
  };
  const initial = (name) => (String(name || '?').replace(/^Independent Vendor \(/, '').trim().charAt(0) || '?').toUpperCase();
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  const STATUS = { pending: 'Waiting for vendor', active: 'Live', completed: 'Completed', terminated: 'Terminated', expired: 'Expired' };

  // ---------- unread badge ----------
  function setUnread(n) {
    unread = Math.max(0, n | 0);
    const b = $('navMsgBadge');
    b.textContent = unread > 99 ? '99+' : String(unread);
    b.classList.toggle('hidden', unread === 0);
  }

  // ---------- conversation list ----------
  async function loadList() {
    if (!running) return;
    if (loadingList) return loadingList;
    loadingList = deps.api('/api/conversations').then((r) => {
      convs = r.conversations || [];
      setUnread(r.unread || 0);
      renderList();
    }).catch(() => { /* the list keeps its last state */ }).finally(() => { loadingList = null; });
    return loadingList;
  }

  function renderList() {
    const box = $('msgList');
    const q = $('msgFilter').value.trim().toLowerCase();
    const shown = convs.filter((c) => !q || `${c.title} ${c.otherName}`.toLowerCase().includes(q));
    box.replaceChildren();
    if (!shown.length) {
      box.appendChild(el('li', 'msg-list-empty', convs.length ? 'No conversation matches.' : (isClient() ? 'No conversations yet. Create a ticket for a vendor, then message them here.' : 'No conversations yet. They appear when a client sends you a ticket.')));
      return;
    }
    shown.forEach((c) => {
      const li = el('li', `msg-conv${c.taskId === activeTask ? ' on' : ''}${c.unread ? ' unread' : ''}`);
      li.setAttribute('role', 'option'); li.setAttribute('tabindex', '0'); li.setAttribute('aria-selected', String(c.taskId === activeTask));
      const av = el('span', 'msg-avatar small', initial(c.otherName));
      const body = el('span', 'msg-conv-body');
      const top = el('span', 'msg-conv-top');
      top.append(el('strong', 'msg-conv-name', c.otherName), el('time', 'msg-conv-time', c.lastAt ? shortAgo(toMs(c.lastAt)) : ''));
      const preview = c.lastBody ? `${c.lastMine && c.lastKind === 'text' ? 'You: ' : ''}${c.lastBody}` : 'No messages yet';
      const bottom = el('span', 'msg-conv-bottom');
      bottom.append(el('span', 'msg-conv-preview', preview));
      if (c.unread) bottom.append(el('span', 'msg-unread', String(c.unread)));
      const ticket = el('span', 'msg-conv-ticket');
      ticket.append(el('span', `msg-dot st-${c.status}`), document.createTextNode(c.title));
      body.append(top, ticket, bottom);
      li.append(av, body);
      const go = () => openThread(c.taskId);
      li.addEventListener('click', go);
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      box.appendChild(li);
    });
  }

  // ---------- thread ----------
  async function openThread(taskId) {
    activeTask = Number(taskId);
    $('msgThread').classList.add('has-thread');
    renderList();
    try {
      const r = await deps.api(`/api/tasks/${activeTask}/messages`);
      if (activeTask !== r.taskId) return;
      thread = { ...r };
      renderThread(true);
      markRead();
    } catch (err) {
      deps.toast(err.message, true);
    }
  }

  function renderHead() {
    const t = thread;
    $('msgEmpty').classList.toggle('hidden', !!t);
    ['msgHead', 'msgItems'].forEach((id) => $(id).classList.toggle('hidden', !t));
    if (!t) { $('msgCompose').classList.add('hidden'); $('msgClosed').classList.add('hidden'); return; }
    $('msgAvatar').textContent = initial(t.otherName);
    $('msgName').textContent = t.otherName;
    $('msgSub').textContent = `${t.title} · ${STATUS[t.status] || t.status}`;
    const inCall = call && call.taskId === t.taskId;
    $('msgCallBtn').disabled = !t.canCall || (!!call && !inCall);
    $('msgCallBtn').title = !t.canCall ? (t.why || 'Calls are not possible on this ticket') : call ? (inCall ? 'On a call' : 'You are on another call') : `Call ${t.otherName}`;
    $('msgCallBtn').classList.toggle('in-call', !!inCall);
    $('msgCallBtn').querySelector('span').textContent = inCall ? 'On call' : 'Call';
    $('msgCompose').classList.toggle('hidden', !t.canSend);
    $('msgClosed').classList.toggle('hidden', t.canSend);
    $('msgClosed').textContent = t.canSend ? '' : (t.why || 'This conversation is closed.');
  }

  function renderThread(scrollToEnd) {
    renderHead();
    if (!thread) return;
    const list = $('msgItems');
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 80;
    list.replaceChildren();
    if (!thread.messages.length) {
      list.appendChild(el('li', 'msg-hint', `Say hello to ${thread.otherName}. Messages stay with this ticket.`));
    }
    let lastDay = '';
    const lastMine = [...thread.messages].reverse().find((m) => m.senderId === thread.me && m.kind === 'text');
    thread.messages.forEach((m) => {
      const ms = toMs(m.createdAt);
      const day = dayOf(ms);
      if (day !== lastDay) { list.appendChild(el('li', 'msg-day', day)); lastDay = day; }
      if (m.kind === 'call') {
        const li = el('li', `msg-call${/Missed|declined/.test(m.body) ? ' missed' : ''}`);
        li.append(el('span', 'msg-call-ico', '☎'), el('span', '', m.body), el('time', '', timeOf(ms)));
        list.appendChild(li);
        return;
      }
      const mine = m.senderId === thread.me;
      const li = el('li', `msg-row ${mine ? 'mine' : 'theirs'}`);
      const bubble = el('div', 'msg-bubble', m.body);
      const meta = el('span', 'msg-meta', timeOf(ms));
      if (mine && lastMine && m.id === lastMine.id && m.readAt) meta.textContent += ' · Seen';
      li.append(bubble, meta);
      list.appendChild(li);
    });
    if (scrollToEnd || nearBottom) list.scrollTop = list.scrollHeight;
  }

  async function markRead() {
    if (!thread || !onPage || document.hidden) return;
    const had = convs.find((c) => c.taskId === thread.taskId);
    if (!thread.messages.some((m) => m.senderId !== thread.me && !m.readAt)) return;
    thread.messages.forEach((m) => { if (m.senderId !== thread.me && !m.readAt) m.readAt = new Date().toISOString(); });
    if (had) { setUnread(unread - had.unread); had.unread = 0; renderList(); }
    try { await deps.api(`/api/tasks/${thread.taskId}/messages/read`, { method: 'POST' }); } catch (_) { /* retried on the next open */ }
  }

  async function sendMessage(e) {
    e.preventDefault();
    if (!thread) return;
    const input = $('msgInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = ''; grow();
    $('msgSend').disabled = true;
    try {
      const r = await deps.api(`/api/tasks/${thread.taskId}/messages`, { method: 'POST', body: { body: text } });
      addMessage(thread.taskId, r.message);
    } catch (err) {
      input.value = text; grow();
      deps.toast(err.message, true);
    } finally {
      $('msgSend').disabled = false;
      input.focus();
    }
  }

  // A message from the API reply or from the socket (both may arrive: ids keep it once)
  function addMessage(taskId, m) {
    if (thread && thread.taskId === taskId && !thread.messages.some((x) => x.id === m.id)) {
      thread.messages.push(m);
      renderThread(m.senderId === thread.me);
      if (onPage && !document.hidden) markRead();
    }
    const c = convs.find((x) => x.taskId === taskId);
    if (c) {
      c.lastBody = m.body; c.lastKind = m.kind; c.lastMine = !!(thread && m.senderId === thread.me) || (deps.getUser() && m.senderId === deps.getUser().id); c.lastAt = m.createdAt;
      convs.sort((a, b) => (toMs(b.lastAt || b.createdAt) || 0) - (toMs(a.lastAt || a.createdAt) || 0));
    }
  }

  function grow() { const t = $('msgInput'); t.style.height = 'auto'; t.style.height = `${Math.min(t.scrollHeight, 140)}px`; }

  // ---------- socket events ----------
  function bindSocket(s) {
    socket = s;
    s.on('chat-message', (d) => {
      if (!running || !d || !d.message) return;
      const u = deps.getUser();
      const mine = u && d.message.senderId === u.id;
      const viewing = onPage && thread && thread.taskId === d.taskId && !document.hidden;
      addMessage(d.taskId, d.message);
      if (!mine && !viewing) {
        const c = convs.find((x) => x.taskId === d.taskId);
        if (c) { c.unread += 1; setUnread(unread + 1); } else loadList();
        if (d.message.kind === 'text') deps.toast(`${c ? c.otherName : 'New message'}: ${d.message.body.slice(0, 90)}`);
      }
      renderList();
    });
    s.on('chat-read', (d) => {
      if (thread && d && thread.taskId === d.taskId) {
        thread.messages.forEach((m) => { if (m.senderId === thread.me && !m.readAt) m.readAt = d.readAt; });
        renderThread(false);
      }
    });
    s.on('call-incoming', onIncoming);
    s.on('call-accepted', onAccepted);
    s.on('call-signal', onSignal);
    s.on('call-ended', onEnded);
    s.on('call-taken', (d) => { if (incoming && d && d.callId === incoming.callId && !(call && call.callId === d.callId)) hideIncoming(); });
    s.on('connect', () => { if (running) loadList(); });
  }

  // ---------- VOICE CALLS ----------
  let call = null;          // { callId, taskId, role: 'caller'|'callee', otherName, pc, local, pending: [], startedAt, timer, muted }
  let incoming = null;      // { callId, taskId, title, fromName }
  const emit = (ev, payload) => new Promise((resolve) => {
    if (!socket || !socket.connected) return resolve({ ok: false, error: 'Not connected to ScopeDesk. Check your internet connection.' });
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, error: 'ScopeDesk did not answer. Try again.' }); } }, 8000);
    socket.emit(ev, payload, (r) => { if (!done) { done = true; clearTimeout(t); resolve(r || { ok: false }); } });
  });

  // ringtone: two soft tones, made with WebAudio (no sound file needed)
  let ringCtx = null, ringTimer = null;
  function ring(on, outgoing) {
    clearInterval(ringTimer); ringTimer = null;
    if (!on) { if (ringCtx) { try { ringCtx.close(); } catch (_) { /* closed */ } ringCtx = null; } return; }
    try {
      ringCtx = ringCtx || new (window.AudioContext || window.webkitAudioContext)();
      const beep = () => {
        if (!ringCtx) return;
        [0, 0.22].forEach((offset, i) => {
          const o = ringCtx.createOscillator(), g = ringCtx.createGain();
          o.frequency.value = outgoing ? 440 : (i ? 660 : 880);
          g.gain.setValueAtTime(0.0001, ringCtx.currentTime + offset);
          g.gain.exponentialRampToValueAtTime(outgoing ? 0.05 : 0.12, ringCtx.currentTime + offset + 0.03);
          g.gain.exponentialRampToValueAtTime(0.0001, ringCtx.currentTime + offset + 0.2);
          o.connect(g).connect(ringCtx.destination);
          o.start(ringCtx.currentTime + offset); o.stop(ringCtx.currentTime + offset + 0.22);
        });
      };
      beep(); ringTimer = setInterval(beep, outgoing ? 3000 : 1600);
    } catch (_) { /* no audio: the card is still shown */ }
  }

  async function getMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This browser cannot make calls. Use Chrome, Edge or the ScopeDesk app.');
    try { return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }); }
    catch (err) {
      if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) throw new Error('Microphone access was blocked. Allow the microphone for ScopeDesk (the icon in the address bar), then call again.');
      if (err && err.name === 'NotFoundError') throw new Error('No microphone was found on this computer.');
      throw new Error('Could not use the microphone.');
    }
  }

  async function makePeer(c) {
    let cfg = {};
    try { cfg = await deps.api(`/api/calls/config?taskId=${encodeURIComponent(c.taskId)}`); } catch (err) { throw new Error(err.message || 'Could not prepare the call.'); }
    const pc = new RTCPeerConnection({ iceServers: cfg.iceServers || [], iceTransportPolicy: cfg.iceTransportPolicy || 'all' });
    c.pc = pc; c.pending = [];
    c.local.getTracks().forEach((t) => pc.addTrack(t, c.local));
    pc.onicecandidate = (e) => { if (e.candidate && socket) socket.emit('call-signal', { callId: c.callId, type: 'candidate', candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate }); };
    pc.ontrack = (e) => { const a = $('callAudio'); if (a.srcObject !== e.streams[0]) { a.srcObject = e.streams[0]; a.play().catch(() => { /* autoplay after the click is allowed */ }); } };
    pc.onconnectionstatechange = () => {
      if (!call || call.pc !== pc) return;
      if (pc.connectionState === 'connected') { if (!call.startedAt) { call.startedAt = Date.now(); tick(); } setBar(); }
      if (pc.connectionState === 'disconnected') setBar('Reconnecting...');
      if (pc.connectionState === 'failed') { deps.toast('The call could not connect (the two networks cannot reach each other). Try again, or keep chatting.', true); hangUp(); }
    };
    return pc;
  }
  async function flushCandidates(c) {
    const list = c.pending || []; c.pending = [];
    for (const cand of list) { try { await c.pc.addIceCandidate(cand); } catch (_) { /* stale candidate */ } }
  }

  function tick() {
    clearInterval(call && call.timer);
    if (!call) return;
    call.timer = setInterval(setBar, 1000);
    setBar();
  }
  function setBar(override) {
    if (!call) { $('callBar').classList.add('hidden'); return; }
    $('callBar').classList.remove('hidden');
    $('callBar').classList.toggle('connected', !!call.startedAt);
    $('callBarName').textContent = call.otherName || 'Voice call';
    let state;
    if (override) state = override;
    else if (call.startedAt) { const s = Math.floor((Date.now() - call.startedAt) / 1000); state = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}${call.muted ? ' · muted' : ''}`; }
    else state = call.role === 'caller' ? (call.accepted ? 'Connecting...' : 'Calling...') : 'Connecting...';
    $('callBarState').textContent = state;
    const m = $('callMute'); m.setAttribute('aria-pressed', String(!!call.muted)); m.classList.toggle('on', !!call.muted);
    m.setAttribute('aria-label', call.muted ? 'Unmute microphone' : 'Mute microphone');
    if (thread) renderHead();
  }

  async function startCall(taskId) {
    if (call) return deps.toast('You are already on a call.', true);
    const t = Number(taskId);
    let local;
    try { local = await getMic(); } catch (err) { return deps.toast(err.message, true); }
    const r = await emit('call-invite', { taskId: t });
    if (!r.ok) { local.getTracks().forEach((x) => x.stop()); return deps.toast(r.error || 'The call could not start.', true); }
    call = { callId: r.callId, taskId: t, role: 'caller', otherName: r.otherName, local, accepted: false, muted: false };
    ring(true, true);
    setBar();
  }

  async function onAccepted(d) {
    if (!call || !d || d.callId !== call.callId || call.role !== 'caller') return;
    ring(false);
    call.accepted = true; setBar();
    try {
      const pc = await makePeer(call);
      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);
      socket.emit('call-signal', { callId: call.callId, type: 'offer', sdp: pc.localDescription.sdp });
    } catch (err) { deps.toast(err.message || 'The call could not connect.', true); hangUp(); }
  }

  async function onSignal(d) {
    if (!call || !d || d.callId !== call.callId) return;
    try {
      if (d.type === 'offer' && call.pc) {
        await call.pc.setRemoteDescription({ type: 'offer', sdp: d.sdp });
        await flushCandidates(call);
        const answer = await call.pc.createAnswer();
        await call.pc.setLocalDescription(answer);
        socket.emit('call-signal', { callId: call.callId, type: 'answer', sdp: call.pc.localDescription.sdp });
      } else if (d.type === 'answer' && call.pc) {
        await call.pc.setRemoteDescription({ type: 'answer', sdp: d.sdp });
        await flushCandidates(call);
      } else if (d.type === 'candidate' && d.candidate) {
        if (call.pc && call.pc.remoteDescription) { try { await call.pc.addIceCandidate(d.candidate); } catch (_) { /* stale */ } }
        else (call.pending = call.pending || []).push(d.candidate);
      }
    } catch (err) { deps.toast('The call could not connect.', true); hangUp(); }
  }

  function onIncoming(d) {
    if (!running || !d) return;
    if (call) { socket.emit('call-decline', { callId: d.callId }); return; }   // already on a call in this tab
    incoming = d;
    $('callInName').textContent = d.fromName;
    $('callInSub').textContent = `About: ${d.title}`;
    $('callIncoming').classList.remove('hidden');
    ring(true, false);
    $('callAccept').focus();
    try { if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification(`Incoming call: ${d.fromName}`, { body: d.title }); } catch (_) { /* optional */ }
  }
  function hideIncoming() { incoming = null; $('callIncoming').classList.add('hidden'); if (!call) ring(false); }

  async function acceptIncoming() {
    const d = incoming;
    if (!d) return;
    hideIncoming(); ring(false);
    let local;
    try { local = await getMic(); } catch (err) { socket.emit('call-decline', { callId: d.callId }); return deps.toast(err.message, true); }
    call = { callId: d.callId, taskId: d.taskId, role: 'callee', otherName: d.fromName, local, muted: false };
    setBar('Connecting...');
    try {
      await makePeer(call);                       // ready BEFORE accepting, so the caller's offer always finds a connection
      const r = await emit('call-accept', { callId: d.callId });
      if (!r.ok) throw new Error(r.error || 'This call is no longer ringing.');
    } catch (err) { deps.toast(err.message, true); cleanup(); }
  }
  function declineIncoming() { const d = incoming; hideIncoming(); if (d && socket) socket.emit('call-decline', { callId: d.callId }); }

  function hangUp() { const c = call; if (c && socket) socket.emit('call-end', { callId: c.callId }); cleanup(); }

  function cleanup() {
    const c = call; call = null;
    ring(false);
    if (c) {
      clearInterval(c.timer);
      try { if (c.pc) c.pc.close(); } catch (_) { /* closed */ }
      if (c.local) c.local.getTracks().forEach((t) => { try { t.stop(); } catch (_) { /* stopped */ } });
    }
    const a = $('callAudio'); a.srcObject = null;
    setBar();
  }

  const ENDED = {
    declined: (n) => `${n} declined the call.`, missed: (n) => `${n} did not answer.`, cancelled: () => 'The call was cancelled.',
    hangup: () => 'Call ended.', disconnected: (n) => `${n} lost the connection. The call ended.`, offline: (n) => `${n} is not online.`,
    'session-ended': () => 'The call ended because the ticket was closed.'
  };
  function onEnded(d) {
    if (!d) return;
    if (incoming && incoming.callId === d.callId) { hideIncoming(); if (d.reason === 'cancelled' || d.reason === 'missed') deps.toast(`Missed call from ${incoming ? incoming.fromName : 'your contact'}.`); return; }
    if (!call || call.callId !== d.callId) return;
    const name = call.otherName || 'They';
    cleanup();
    deps.toast((ENDED[d.reason] || ENDED.hangup)(name), d.reason === 'session-ended');
  }

  function toggleMute() {
    if (!call || !call.local) return;
    call.muted = !call.muted;
    call.local.getAudioTracks().forEach((t) => { t.enabled = !call.muted; });
    setBar();
  }

  // ---------- wiring ----------
  function bind() {
    $('msgFilter').addEventListener('input', renderList);
    $('msgCompose').addEventListener('submit', sendMessage);
    $('msgInput').addEventListener('input', grow);
    $('msgInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('msgCompose').requestSubmit(); } });
    $('msgCallBtn').addEventListener('click', () => { if (thread && !call) startCall(thread.taskId); else if (call && thread && call.taskId === thread.taskId) hangUp(); });
    $('msgBack').addEventListener('click', () => { $('msgThread').classList.remove('has-thread'); });
    $('callAccept').addEventListener('click', acceptIncoming);
    $('callDecline').addEventListener('click', declineIncoming);
    $('callEnd').addEventListener('click', hangUp);
    $('callMute').addEventListener('click', toggleMute);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) markRead(); });
    window.addEventListener('beforeunload', () => { if (call && socket) socket.emit('call-end', { callId: call.callId }); });
  }

  window.ScopeDeskMessages = {
    init(d) { if (deps) return; deps = d; bind(); },
    bindSocket,
    start() {
      running = true;
      $('msgOtherRole').textContent = isClient() ? 'vendor' : 'client';
      $('msgEmptyOther').textContent = isClient() ? 'vendor' : 'client';
      loadList();
    },
    stop() {
      if (call) hangUp();
      hideIncoming();
      running = false; convs = []; thread = null; activeTask = null; setUnread(0);
      $('msgList').replaceChildren(); renderHead();
    },
    onRoute(panelId) {
      onPage = panelId === 'messagesPanel';
      if (!running) return;
      if (onPage) { loadList(); markRead(); }
    },
    async open(taskId) {
      deps.route('messagesPanel');
      await loadList();
      openThread(taskId);
    },
    call(taskId) { return startCall(taskId); },
    inCall: () => !!call,
    unread: () => unread
  };
})();
