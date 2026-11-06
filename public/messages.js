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
      top.append(el('strong', 'msg-conv-name', c.otherName));
      if (c.trusted) { const star = el('span', 'msg-conv-vip', '\u2605 Always-On'); star.title = 'Always-On Access Approved: can text and call any time'; top.append(star); }
      else if (!c.canSend) { const lock = el('span', 'msg-conv-lock', '\uD83D\uDD12'); lock.title = 'Locked: texting and calling are available only during an active task'; top.append(lock); }
      top.append(el('time', 'msg-conv-time', c.lastAt ? shortAgo(toMs(c.lastAt)) : ''));
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
    if (activeTask !== Number(taskId)) { $('msgInput').value = ''; grow(); }   // a half-written message never jumps to another conversation
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

  // Lock the open conversation by itself the moment the task's time window ends (no reload needed)
  let lockTimer = null;
  function scheduleLock() {
    clearTimeout(lockTimer); lockTimer = null;
    if (!thread || !thread.canSend || thread.trusted || !thread.windowEnd) return;
    const ms = toMs(thread.windowEnd) - Date.now();
    if (Number.isFinite(ms) && ms > 0 && ms < 2 ** 31 - 1) lockTimer = setTimeout(() => { reloadThread(); loadList(); }, ms + 1500);
  }
  // Called by script.js whenever the task list changes: a task that became active unlocks its chat, one that ended locks it
  let taskSig = '';
  function tasksChanged(tasks) {
    if (!running) return;
    const sig = (tasks || []).map((t) => `${t.id}:${t.status}`).join(',');
    if (sig === taskSig) return;
    const first = !taskSig; taskSig = sig;
    if (first) return;
    loadList();
    if (thread) reloadThread();
  }
  async function draftReply() {
    if (!thread || !window.ScopeDeskPlans || !ScopeDeskPlans.draft) return;
    const btn = $('msgAiDraft'); btn.disabled = true; const label = btn.textContent; btn.textContent = 'Drafting...';
    const input = $('msgInput');
    try {
      const recent = thread.messages.filter((m) => m.kind === 'text').slice(-10)
        .map((m) => `${m.senderId === thread.me ? 'Me' : thread.otherName}: ${m.body}`).join('\n');
      input.value = '';
      await ScopeDeskPlans.draft({
        taskId: thread.taskId,
        prompt: `Draft my next chat message to ${thread.otherName} about the ticket "${thread.title}". Reply with ONLY the message text, friendly and short (1-3 sentences), no quotes.\n\nConversation so far:\n${recent || '(no messages yet)'}`
      }, (text) => { input.value = text; grow(); });
      input.focus();
    } catch (err) { deps.toast(err.message, true); }
    finally { btn.disabled = false; btn.textContent = label; }
  }

  async function reloadThread() {
    if (!thread) return;
    try { const r = await deps.api(`/api/tasks/${thread.taskId}/messages`); if (thread && r.taskId === thread.taskId) { thread = { ...r }; renderThread(false); } } catch (_) { /* keep the last state */ }
  }
  async function setTrust(on) {
    if (!thread || thread.role !== 'client') return;
    const btn = $('msgTrustBtn'); btn.disabled = true;
    try {
      await deps.api(`/api/vendors/${thread.vendorId}/contact`, { method: on ? 'PUT' : 'DELETE' });
      deps.toast(on ? `Always-On Access approved: ${thread.otherName} can text and call you any time. Turn it off whenever you like.` : `${thread.otherName} can reach you only during an active task again.`);
      await reloadThread(); loadList();
    } catch (err) { deps.toast(err.message, true); }
    finally { btn.disabled = false; }
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
    const lockTip = t.why || 'Locked: texting and calling are available only during an active task.';
    const vBtn = $('msgVideoBtn');
    vBtn.disabled = !t.canCall || !!call;
    vBtn.classList.toggle('locked', !t.canCall);
    vBtn.title = !t.canCall ? (t.why || 'Locked: available only during an active task.') : call ? 'You are on a call' : `Video call ${t.otherName}`;
    const callBtn = $('msgCallBtn');
    callBtn.disabled = !t.canCall || (!!call && !inCall);
    callBtn.classList.toggle('locked', !t.canCall);
    callBtn.title = !t.canCall ? lockTip : call ? (inCall ? 'On a call' : 'You are on another call') : `Call ${t.otherName}`;
    callBtn.classList.toggle('in-call', !!inCall);
    callBtn.querySelector('span').textContent = inCall ? 'On call' : !t.canCall ? 'Locked' : 'Call';
    // Locked state: the composer stays on screen, greyed out, with the reason as its tooltip
    const compose = $('msgCompose'), input = $('msgInput');
    compose.classList.remove('hidden');
    compose.classList.toggle('locked', !t.canSend);
    compose.title = t.canSend ? '' : lockTip;
    input.disabled = !t.canSend;
    input.placeholder = t.canSend ? (t.trusted && !t.open ? 'Always-On Access: write any time...' : 'Write a message...') : 'Locked: available only during an active task';
    $('msgSend').disabled = !t.canSend;
    $('msgSend').title = t.canSend ? 'Send' : lockTip;
    $('msgAiDraft').classList.toggle('hidden', !(t.canSend && window.ScopeDeskPlans && ScopeDeskPlans.canChat && ScopeDeskPlans.canChat()));
    $('msgClosed').classList.toggle('hidden', t.canSend);
    $('msgClosedText').textContent = t.canSend ? '' : lockTip;
    // Always-On Access (VIP): the client's switch; both sides see the badge
    const client = t.role === 'client';
    $('msgTrustChip').classList.toggle('hidden', !t.trusted);
    $('msgTrustBtn').classList.toggle('hidden', !client);
    $('msgTrustBtn').setAttribute('aria-checked', String(!!t.trusted));
    $('msgTrustBtn').classList.toggle('on', !!t.trusted);
    $('msgClosedTrust').classList.toggle('hidden', !(client && !t.canSend && !t.trusted && /Always-On Access/.test(t.why || '')));
    scheduleLock();
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
    // the client turned "Anytime contact" on or off: refresh what is allowed
    s.on('contact-changed', () => { if (!running) return; loadList(); if (thread) reloadThread(); });
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

  // ----- camera (video calls) -----
  async function openCam(c) {
    if (c.cam) return c.cam;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('This browser cannot use a camera.');
    try { c.cam = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24 } }, audio: false }); }
    catch (err) {
      if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) throw new Error('Camera access was blocked. Allow the camera for ScopeDesk, then try again. The call continues with audio.');
      if (err && err.name === 'NotFoundError') throw new Error('No camera was found. The call continues with audio.');
      throw new Error('Could not use the camera. The call continues with audio.');
    }
    $('callSelf').srcObject = c.cam;
    c.wantCam = true;
    setBar(); renderVideo();
    return c.cam;
  }
  // send (or stop sending) the camera on the negotiated video slot
  async function applyCam(c) {
    if (!c.videoTx) return;
    const track = c.cam ? c.cam.getVideoTracks()[0] : null;
    try { await c.videoTx.sender.replaceTrack(track || null); } catch (_) { /* the call is closing */ }
    if (socket && c.callId) socket.emit('call-signal', { callId: c.callId, type: 'cam', on: !!track });
  }
  async function toggleCam() {
    const c = call; if (!c) return;
    if (c.cam) {
      c.cam.getTracks().forEach((t) => { try { t.stop(); } catch (_) { /* stopped */ } });   // the camera light goes off
      c.cam = null; c.wantCam = false; $('callSelf').srcObject = null;
      await applyCam(c);
    } else {
      try { await openCam(c); await applyCam(c); } catch (err) { deps.toast(err.message, true); }
    }
    setBar(); renderVideo();
  }
  function renderVideo() {
    const c = call;
    const remoteOn = !!(c && c.remoteVideo && c.remoteVideo.readyState === 'live' && !c.remoteVideo.muted && c.otherCam !== false);
    const show = !!(c && (c.cam || remoteOn || c.otherCam));
    $('callVideoWrap').classList.toggle('hidden', !show);
    $('callSelf').classList.toggle('hidden', !(c && c.cam));
    $('callVideoOff').classList.toggle('hidden', remoteOn);
    $('callVideoOff').textContent = c ? `${c.otherName || 'The other person'}'s camera is off` : '';
    if (remoteOn) $('callVideo').play().catch(() => {});
  }

  async function makePeer(c) {
    let cfg = {};
    try { cfg = await deps.api(`/api/calls/config?taskId=${encodeURIComponent(c.taskId)}`); } catch (err) { throw new Error(err.message || 'Could not prepare the call.'); }
    const pc = new RTCPeerConnection({ iceServers: cfg.iceServers || [], iceTransportPolicy: cfg.iceTransportPolicy || 'all' });
    c.pc = pc; c.pending = [];
    c.local.getTracks().forEach((t) => pc.addTrack(t, c.local));
    // Video is always negotiated (a two-way video slot), but nothing is sent until that person turns their camera on:
    // replaceTrack() switches it on/off at once, with no new negotiation. The caller creates the slot; the callee finds it in the offer.
    if (c.role === 'caller') c.videoTx = pc.addTransceiver('video', { direction: 'sendrecv' });
    pc.onicecandidate = (e) => { if (e.candidate && socket) socket.emit('call-signal', { callId: c.callId, type: 'candidate', candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate }); };
    pc.ontrack = (e) => {
      if (e.track.kind === 'video') {
        c.remoteVideo = e.track;
        $('callVideo').srcObject = new MediaStream([e.track]);
        e.track.onunmute = renderVideo; e.track.onmute = renderVideo; e.track.onended = renderVideo;
        renderVideo();
        return;
      }
      const a = $('callAudio');
      const stream = e.streams[0] || new MediaStream([e.track]);
      if (a.srcObject !== stream) { a.srcObject = stream; a.play().catch(() => { /* autoplay after the click is allowed */ }); }
    };
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
    const cam = $('callCam'); cam.setAttribute('aria-pressed', String(!!call.cam)); cam.classList.toggle('cam-on', !!call.cam);
    cam.setAttribute('aria-label', call.cam ? 'Turn camera off' : 'Turn camera on'); cam.title = call.cam ? 'Camera off' : 'Camera on';
    const m = $('callMute'); m.setAttribute('aria-pressed', String(!!call.muted)); m.classList.toggle('on', !!call.muted);
    m.setAttribute('aria-label', call.muted ? 'Unmute microphone' : 'Mute microphone');
    if (thread) renderHead();
  }

  async function startCall(taskId, { video = false } = {}) {
    if (call) return deps.toast('You are already on a call.', true);
    const t = Number(taskId);
    let local;
    try { local = await getMic(); } catch (err) { return deps.toast(err.message, true); }
    const r = await emit('call-invite', { taskId: t, video });
    if (!r.ok) { local.getTracks().forEach((x) => x.stop()); return deps.toast(r.error || 'The call could not start.', true); }
    call = { callId: r.callId, taskId: t, role: 'caller', otherName: r.otherName, local, accepted: false, muted: false, wantCam: video };
    if (video) { try { await openCam(call); } catch (err) { deps.toast(err.message, true); call.wantCam = false; } }
    if (!isClient() && thread && !thread.trusted) deps.toast(`Call request sent. It connects only when ${r.otherName} approves.`);
    ring(true, true);
    setBar();
  }

  async function onAccepted(d) {
    if (!call || !d || d.callId !== call.callId || call.role !== 'caller') return;
    ring(false);
    call.accepted = true; setBar();
    try {
      const pc = await makePeer(call);
      if (call.wantCam) await applyCam(call);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('call-signal', { callId: call.callId, type: 'offer', sdp: pc.localDescription.sdp });
    } catch (err) { deps.toast(err.message || 'The call could not connect.', true); hangUp(); }
  }

  async function onSignal(d) {
    if (!call || !d || d.callId !== call.callId) return;
    try {
      if (d.type === 'offer' && call.pc) {
        await call.pc.setRemoteDescription({ type: 'offer', sdp: d.sdp });
        const vt = call.pc.getTransceivers().find((t) => t.receiver && t.receiver.track && t.receiver.track.kind === 'video');
        if (vt) { vt.direction = 'sendrecv'; call.videoTx = vt; if (call.wantCam) await applyCam(call); }
        await flushCandidates(call);
        const answer = await call.pc.createAnswer();
        await call.pc.setLocalDescription(answer);
        socket.emit('call-signal', { callId: call.callId, type: 'answer', sdp: call.pc.localDescription.sdp });
      } else if (d.type === 'answer' && call.pc) {
        await call.pc.setRemoteDescription({ type: 'answer', sdp: d.sdp });
        await flushCandidates(call);
      } else if (d.type === 'cam') {
        call.otherCam = d.on === true; renderVideo();
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
    // Always-On vendor + "answer automatically": connect at once, audio only (the camera is never switched on for the client)
    if (d.autoAnswer && isClient()) {
      deps.toast(`Answered automatically: ${d.fromName} (Always-On Access). Hang up any time.`);
      acceptIncoming(false);
      return;
    }
    const kind = d.video ? 'video' : 'voice';
    $('callInKicker').textContent = d.request ? `Call request from your vendor (${kind}). It connects only if you approve.`
      : d.trusted ? `Incoming ${kind} call \u00B7 Always-On vendor` : `Incoming ${kind} call`;
    $('callInName').textContent = d.fromName;
    $('callInSub').textContent = `About: ${d.title}`;
    $('callAccept').setAttribute('aria-label', d.request ? 'Approve (audio)' : 'Accept call');
    $('callAccept').title = d.request ? 'Approve and connect (audio)' : 'Accept';
    $('callAcceptVideo').classList.toggle('hidden', !d.video);
    $('callInAutoRow').classList.toggle('hidden', !(d.trusted && isClient()));
    $('callInAuto').checked = !!d.autoAnswer;
    $('callIncoming').classList.remove('hidden');
    ring(true, false);
    $('callAccept').focus();
    try { if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification(`Incoming call: ${d.fromName}`, { body: d.title }); } catch (_) { /* optional */ }
  }
  function hideIncoming() { incoming = null; $('callIncoming').classList.add('hidden'); if (!call) ring(false); }

  async function acceptIncoming(withVideo = false) {
    const d = incoming;
    if (!d) return;
    hideIncoming(); ring(false);
    let local;
    try { local = await getMic(); } catch (err) { socket.emit('call-decline', { callId: d.callId }); return deps.toast(err.message, true); }
    call = { callId: d.callId, taskId: d.taskId, role: 'callee', otherName: d.fromName, local, muted: false, wantCam: !!withVideo };
    if (withVideo) { try { await openCam(call); } catch (err) { deps.toast(err.message, true); call.wantCam = false; } }
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
      if (c.cam) c.cam.getTracks().forEach((t) => { try { t.stop(); } catch (_) { /* stopped */ } });
    }
    const a = $('callAudio'); a.srcObject = null;
    $('callVideo').srcObject = null; $('callSelf').srcObject = null;
    renderVideo();
    setBar();
  }

  const ENDED = {
    declined: (n) => `${n} declined the call.`, missed: (n) => `${n} did not answer.`, cancelled: () => 'The call was cancelled.',
    hangup: () => 'Call ended.', disconnected: (n) => `${n} lost the connection. The call ended.`, offline: (n) => `${n} is not online.`,
    'contact-removed': () => 'The call ended: Always-On Access was turned off and this task has ended.',
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
    $('msgVideoBtn').addEventListener('click', () => { if (thread && !call) startCall(thread.taskId, { video: true }); });
    $('callCam').addEventListener('click', () => toggleCam());
    $('callAcceptVideo').addEventListener('click', () => acceptIncoming(true));
    $('callInAuto').addEventListener('change', async (e) => {
      const d = incoming; if (!d) return;
      try { await deps.api(`/api/vendors/${d.fromId}/contact`, { method: 'PUT', body: { autoAnswer: e.target.checked } }); deps.toast(e.target.checked ? `Calls from ${d.fromName} will be answered automatically (audio only). Change it in Messages.` : 'Automatic answering is off.'); }
      catch (err) { e.target.checked = !e.target.checked; deps.toast(err.message, true); }
    });
    $('msgBack').addEventListener('click', () => { $('msgThread').classList.remove('has-thread'); });
    $('msgTrustBtn').addEventListener('click', () => setTrust(!(thread && thread.trusted)));
    $('msgAiDraft').addEventListener('click', draftReply);
    $('msgClosedTrust').addEventListener('click', () => setTrust(true));
    $('callAccept').addEventListener('click', () => acceptIncoming(false));
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
      $('msgPageSub').textContent = isClient()
        ? 'One conversation per ticket. Texting and calling unlock during an active task. Vendors you approve for Always-On Access can reach you any time.'
        : 'One conversation per ticket. Texting and calling unlock during an active task, or any time with clients who approved you for Always-On Access.';
      loadList();
    },
    stop() {
      if (call) hangUp();
      hideIncoming();
      running = false; convs = []; thread = null; activeTask = null; taskSig = ''; clearTimeout(lockTimer); setUnread(0);
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
    tasksChanged,
    // "Use in Messages" from the assistant: open that ticket's chat with the draft in the box (never sent automatically)
    async prefill(taskId, text) {
      deps.route('messagesPanel');
      await loadList();
      await openThread(taskId);
      if (thread && thread.taskId === Number(taskId) && thread.canSend) { $('msgInput').value = text; grow(); $('msgInput').focus(); }
      else if (thread) deps.toast(thread.why || 'This conversation is locked.', true);
    },
    refresh() { if (running) { loadList(); if (thread) renderHead(); } },
    inCall: () => !!call,
    unread: () => unread
  };
})();
