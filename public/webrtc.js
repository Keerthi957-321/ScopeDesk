// ScopeDesk WebRTC remote desktop.
//   Client (host):   captures the screen (getDisplayMedia), sends it, and RECEIVES the vendor's input on RTCDataChannels.
//   Vendor (viewer): receives the screen and sends mouse/keyboard back as small JSON frames.
//
// Signaling (offer/answer/ICE) goes through the authenticated Socket.IO connection the app already has.
//
// NETWORK TRAVERSAL (same Wi-Fi AND different networks, no settings to change)
//   * The server's rtcConfig (GET /api/rtc-config) is passed WHOLE to new RTCPeerConnection(): iceTransportPolicy "all", STUN + TURN.
//     host candidates win on a shared network, srflx across ordinary NATs, relay through strict firewalls.
//   * ICE candidates are TRICKLED: every candidate is emitted over Socket.IO the moment the browser produces it, and applied the
//     moment it arrives. Nothing waits for gathering to finish, so the first working path (usually the local one) opens the stream.
//   * A dropped link is repaired by an automatic loop (ICE restart, then a full rebuild) with back-off. It never raises an alert.
//
// INPUT PATHS (vendor -> Client's PC)
//   1. FAST PATH, peer to peer: vendor -> RTCDataChannel -> Client's window -> Electron IPC (ipcRenderer.send) -> background host
//      agent -> OS input. Used whenever the desktop app's agent is running. No local network port is involved.
//   2. FALLBACK: vendor -> Socket.IO -> server -> host agent. The server checks every event (task active, vendor owns it, rate limit).
// Either way the agent schema-checks each frame again and refuses it unless the foreground app/folder is inside the task's scope.
//
// SECURITY LOCKOUT: when the agent reports an out-of-scope app or folder, the desktop app raises a native OS notification and
// sends 'lockout' here. We immediately freeze the data channels, close the peer connection and show the locked state.
(function () {
  let api = null, socket = null, onChange = () => {}, isClientFn = () => false, onPermission = () => {};
  let role = null, taskId = null, iceCfg = null;
  let pc = null, stream = null, pendingIce = [], earlyIce = [];
  let sdpSent = false, outIce = [];          // outgoing candidates wait only until our own SDP has been sent, then flow instantly
  let sigChain = Promise.resolve();          // signaling messages are handled strictly in order
  const recover = { timer: null, n: 0, lastReq: 0 };
  let video = null, stage = null, detachInput = null;
  // Vendor: the two channels the Client's offer created.  Client: hostCtl is our end of 'ctl'.
  let dc = { ctl: null, mv: null }, hostBridgeReady = false, hostCtl = null;
  let frozen = false;                        // Client: true after a lockout; no frame reaches the agent until the session is resumed
  const view = { conn: 'idle', agent: 'unknown', halted: null, shareSurface: null, relay: null, relayKind: null, connectSlow: false, retrying: 0, everLive: false, path: null };
  let slowTimer = null, stallTimer = null;   // 15 s of "connecting" = informational flag; 25 s = start repairing

  const desktop = window.scopedeskDesktop && window.scopedeskDesktop.isDesktop ? window.scopedeskDesktop : null;
  let agentLink = false;                     // Client: is the background agent up and able to take input right now?

  const set = (patch) => { Object.assign(view, patch); onChange({ ...view, role, taskId }); };

  // ---------- ICE configuration (the server's rtcConfig, used as is) ----------
  // Only the members RTCPeerConnection understands are forwarded; hardExpiry / relay / relayKind stay informational.
  function peerConfig(cfg) {
    const c = cfg || {};
    return {
      iceServers: c.iceServers || [],
      iceTransportPolicy: c.iceTransportPolicy || 'all',
      bundlePolicy: c.bundlePolicy || 'max-bundle',
      rtcpMuxPolicy: c.rtcpMuxPolicy || 'require',
      iceCandidatePoolSize: Number.isInteger(c.iceCandidatePoolSize) ? c.iceCandidatePoolSize : 0
    };
  }
  async function loadIceConfig(id) {
    const cfg = await api(`/api/rtc-config?taskId=${id}`);
    iceCfg = cfg;
    set({ relay: !!cfg.relay, relayKind: cfg.relayKind || null });
    return cfg;
  }
  // Fresh credentials for a recovery attempt. A failure here is harmless: the previous configuration keeps working.
  async function refreshIceConfig() {
    try { await loadIceConfig(taskId); if (pc) pc.setConfiguration(peerConfig(iceCfg)); } catch (_) { /* keep the old servers */ }
  }

  function init(opts) {
    api = opts.api; onChange = opts.onChange || onChange;
    if (typeof opts.isClient === 'function') isClientFn = opts.isClient;      // the Client dashboard asks for alert permission; the Vendor never does
    if (typeof opts.onPermission === 'function') onPermission = opts.onPermission;
    console.log('[ScopeDesk] WebRTC Engine Initialized'); // developer console only, never a popup
  }

  // ---------- native notifications (Client only) ----------
  // 1. Permission: asked as soon as the Client dashboard connects. Browsers that insist on a click (Safari) get it on the first click.
  // 2. Alert: when the session is terminated or a breach is signalled, a persistent system notification is raised.
  let notifyAsked = false, lastNotifyAt = 0;
  function requestNotificationPermission() {
    try {
      if (!('Notification' in window)) return Promise.resolve('unsupported');
      if (Notification.permission !== 'granted' && Notification.permission !== 'denied') {
        const done = () => { try { onPermission(Notification.permission); } catch (_) { /* optional */ } return Notification.permission; };
        const res = Notification.requestPermission(done);                 // older browsers use the callback, newer ones the promise
        if (res && typeof res.then === 'function') res.then(done).catch(() => {});
        if (!notifyAsked) {                                                // still undecided (no gesture yet): ask again on the first click
          notifyAsked = true;
          document.addEventListener('pointerdown', () => { if (Notification.permission === 'default') requestNotificationPermission(); }, { once: true });
        }
      }
      return Promise.resolve(Notification.permission);
    } catch (_) { return Promise.resolve('unsupported'); }
  }

  function notifyTerminated(info) {
    try {
      if (!isClientFn() || !('Notification' in window) || Notification.permission !== 'granted') return false;
      const reason = (info && info.reason) || 'terminated';
      if (reason === 'client_terminated' || reason === 'completed') return false;   // the Client (or the vendor, normally) ended it: no alarm needed
      const now = Date.now();
      if (now - lastNotifyAt < 3000) return false;                                   // several signals for one event show one alert
      lastNotifyAt = now;
      const expired = reason === 'time_expired';
      const n = new Notification(expired ? 'ScopeDesk: Session Ended' : 'ScopeDesk: Session Terminated!', {
        body: expired
          ? 'The approved time window has ended. Remote access has been closed.'
          : 'Security breach or manual termination detected. Remote access has been permanently revoked.' + (info && info.detail ? ` (${info.detail})` : ''),
        icon: '/assets/warning-icon.png',
        tag: 'scopedesk-session-terminated',   // same tag = replaces an older alert instead of stacking
        renotify: true,
        requireInteraction: true               // stays on screen until clicked
      });
      n.onclick = () => { try { window.focus(); } catch (_) { /* optional */ } n.close(); };
      return true;
    } catch (_) { return false; }               // the on-page alert and lock screen still show
  }

  // ---------- desktop app wiring (Client side) ----------
  if (desktop) {
    const track = (s) => {
      const up = !!s && ['connected', 'running'].includes(s.phase);
      if (up !== agentLink) { agentLink = up; announceAgentLink(); }
    };
    desktop.onAgentStatus(track);
    desktop.getAgentStatus().then(track).catch(() => { /* status arrives by event anyway */ });
    desktop.onLockout((d) => lockout(d));
  }

  // The vendor went outside the approved scope. Order matters: stop frames first, then cut the link.
  function lockout(detail) {
    frozen = true;
    closeChannels();                         // 1. freeze the RTCDataChannel loop: nothing more can arrive or be forwarded
    const was = role === 'host' ? taskId : null;
    if (role) stop('violation');             // 2. sever the WebRTC link (also stops screen capture)
    frozen = true;                           // stop() cleared state; keep the freeze until the session is resumed or ended
    set({ halted: 'violation', locked: true, lockout: detail || null });
    if (!desktop) notifyTerminated({ reason: 'security_violation', taskId: was });   // the desktop app already raised its own OS notification
    return was;
  }

  // Called by script.js every time it (re)creates the app socket
  function bindSocket(s) {
    socket = s;
    if (isClientFn()) requestNotificationPermission();            // Client dashboard is up: ask to allow notifications now
    s.on('webrtc-peer-joined', (d) => { if (role === 'host' && d.role === 'vendor') makeOffer(); });
    s.on('webrtc-peer-left', () => { if (role === 'host') closePeer(); set({ conn: 'waiting' }); });
    s.on('webrtc-signal', onSignal);
    s.on('webrtc-close', (d) => {
      if (taskId && d.taskId === taskId) {
        const wasHost = role === 'host';
        stop(d.reason === 'security_violation' ? 'violation' : 'closed');
        if (wasHost) notifyTerminated({ reason: d.reason, taskId: d.taskId });
      }
    });
    s.on('agent-status', (d) => { if (d.taskId === taskId) set({ agent: d.online ? 'waiting' : 'offline' }); });
    s.on('agent-state', (d) => { if (d.taskId === taskId) set({ agent: d.state, policy: d.policy || view.policy }); });
    s.on('control-halt', (d) => { if (d.taskId === taskId) { if (d.reason === 'violation') { frozen = true; closeChannels(); notifyTerminated({ reason: 'security_violation', taskId: d.taskId }); } set({ halted: d.reason, locked: !!d.permanent }); } });
    s.on('control-resume', (d) => { if (d.taskId === taskId) { frozen = false; set({ halted: null, locked: false }); } });
    // After a dropped connection the server forgot our room membership: join again
    s.on('connect', () => { if (role && taskId) join().catch(() => {}); });
  }

  const emitAck = (ev, payload) => new Promise((resolve) => socket.emit(ev, payload, resolve));

  async function join() {
    const res = await emitAck('webrtc-join', { taskId, role: role === 'host' ? 'client' : 'vendor' });
    if (!res || !res.ok) throw new Error((res && res.error) || 'Could not join the session.');
    const a = await emitAck('agent-status', { taskId });
    if (a && a.ok) set({ agent: a.online ? (a.state || 'waiting') : 'offline', halted: a.halted || null });
    if (role === 'host' && res.peers.includes('vendor')) {
      if (pc && pc.connectionState === 'connected') restartIce().catch(() => {});   // our own socket blinked: refresh paths, keep the stream
      else makeOffer();
    } else set({ conn: 'waiting' });
  }

  // ---------- signaling helpers ----------
  const wire = (d) => ({ type: d.type, sdp: d.sdp });
  const fingerprint = (sdp) => { const m = /a=fingerprint:\S+ (\S+)/.exec(sdp || ''); return m ? m[1] : null; };   // identifies one RTCPeerConnection's DTLS identity
  function sendSignal(msg) { if (socket && socket.connected && taskId) { socket.emit('webrtc-signal', { taskId, ...msg }); return true; } return false; }
  // Our SDP goes out first, then every candidate that was produced meanwhile, then each new candidate immediately.
  function sdpWentOut() { sdpSent = true; const q = outIce; outIce = []; q.forEach((c) => sendSignal({ type: 'candidate', candidate: c })); }

  function newPeer() {
    closePeer();
    const p = new RTCPeerConnection(peerConfig(iceCfg));     // the full hybrid configuration from the server
    pc = p; pendingIce = []; outIce = []; sdpSent = false;
    p.onicecandidate = (e) => {
      if (pc !== p || !e.candidate) return;
      const c = typeof e.candidate.toJSON === 'function' ? e.candidate.toJSON() : e.candidate;
      console.log('[ScopeDesk] ICE candidate:', e.candidate.type || 'unknown');   // developer console only: host / srflx / relay
      if (sdpSent) sendSignal({ type: 'candidate', candidate: c }); else outIce.push(c);
    };
    p.onicecandidateerror = (e) => { console.log('[ScopeDesk] ICE server problem:', e && e.url, e && e.errorCode); };   // never shown to the user
    p.oniceconnectionstatechange = () => { if (pc === p) console.log('[ScopeDesk] ICE state:', p.iceConnectionState); };
    p.onconnectionstatechange = () => {
      if (pc !== p) return;
      const st = p.connectionState;
      if (st === 'connected') {
        clearTimeout(slowTimer); clearTimeout(stallTimer); clearTimeout(recover.timer); recover.timer = null; recover.n = 0;
        set({ conn: 'live', connectSlow: false, retrying: 0, everLive: true });
        detectPath(p); setTimeout(() => detectPath(p), 4000);      // a better path can be nominated a moment later
      } else if (st === 'connecting') {
        set({ conn: 'connecting' });
        clearTimeout(slowTimer); clearTimeout(stallTimer);
        slowTimer = setTimeout(() => { if (pc === p && p.connectionState === 'connecting') set({ connectSlow: true }); }, 15000);
        stallTimer = setTimeout(() => { if (pc === p && p.connectionState === 'connecting') scheduleRecovery(0, true); }, 25000);
      } else if (st === 'disconnected') {
        clearTimeout(slowTimer); clearTimeout(stallTimer);
        set({ conn: 'lost' });
        scheduleRecovery(3000);                                    // short grace period: many drops heal by themselves
      } else if (st === 'failed') {
        clearTimeout(slowTimer); clearTimeout(stallTimer);
        set({ conn: 'lost', connectSlow: true });
        scheduleRecovery(0, true);
      }
    };
    // VENDOR side: the Client's offer carries two channels. 'ctl' = reliable + ordered (clicks, keys, wheel, open-folder).
    // 'mv' = unordered, no retransmits (mouse moves: a late move is worthless, so never wait for it).
    p.ondatachannel = (e) => {
      const ch = e.channel;
      if (ch.label !== 'ctl' && ch.label !== 'mv') return;
      dc[ch.label] = ch;
      ch.onmessage = (m) => { try { const d = JSON.parse(m.data); if (d.t === 'bridge') hostBridgeReady = !!d.ready; } catch (_) { /* ignore */ } };
      ch.onclose = () => { if (dc[ch.label] === ch) dc[ch.label] = null; };
    };
    p.ontrack = (e) => { if (video) { video.srcObject = e.streams[0]; video.play().catch(() => {}); } };
    return p;
  }

  // Reports whether the stream runs over the local network ('local'), a direct internet path ('direct') or the relay ('relay').
  async function detectPath(p) {
    try {
      const stats = await p.getStats();
      const byId = {}; let pairId = null, pair = null;
      stats.forEach((r) => { byId[r.id] = r; if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId; });
      pair = pairId ? byId[pairId] : null;
      if (!pair) stats.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
      if (!pair) return;
      const l = byId[pair.localCandidateId], r = byId[pair.remoteCandidateId];
      const types = [l && l.candidateType, r && r.candidateType];
      const path = types.includes('relay') ? 'relay' : (types.every((t) => t === 'host') ? 'local' : 'direct');
      if (pc === p) set({ path });
    } catch (_) { /* stats are optional */ }
  }

  // ---------- automatic recovery: no alerts, no UI error, just keeps trying until the session ends ----------
  // Delays: 1 s, 2 s, 4 s, 8 s, then every 15 s. HOST repairs with an ICE restart (new candidates, same screen capture and channels);
  // every 5th attempt it rebuilds the whole peer. VENDOR asks the host to do it, because the host owns the offer.
  const backoff = (n) => Math.min(15000, 1000 * 2 ** Math.min(n, 4));
  function scheduleRecovery(delay, replace) {
    if (!role || frozen || view.halted) return;
    if (recover.timer) { if (!replace) return; clearTimeout(recover.timer); }
    const mine = pc;
    recover.timer = setTimeout(() => { recover.timer = null; recoverNow(mine); }, delay == null ? backoff(recover.n) : delay);
  }
  async function recoverNow(expected) {
    if (!role || frozen || view.halted) return;
    if (pc !== expected) return;                                    // the peer was replaced meanwhile; the new one has its own watchers
    if (pc && pc.connectionState === 'connected') { recover.n = 0; return; }
    recover.n++;
    set({ retrying: recover.n });
    await refreshIceConfig();                                       // fresh TURN credentials, then re-gather
    if (pc !== expected || !role) return;
    try {
      if (role === 'host') {
        if (!pc || pc.connectionState === 'closed' || recover.n % 5 === 0) await makeOffer(); else await restartIce();
      } else {
        sendSignal({ type: 'restart' });
      }
    } catch (err) { console.log('[ScopeDesk] recovery attempt failed:', err && err.message); }
    scheduleRecovery(null);                                         // keep going until connected or the session ends
  }

  // HOST: new ICE credentials on the SAME peer. Screen capture, data channels and the remote page stay as they are.
  async function restartIce() {
    const p = pc;
    if (role !== 'host' || !p || !stream || frozen || p.connectionState === 'closed') return false;
    sdpSent = false; outIce = [];
    const offer = await p.createOffer({ iceRestart: true });
    await p.setLocalDescription(offer);
    if (pc !== p) return false;
    sendSignal({ type: 'offer', offer: wire(p.localDescription || offer) });
    sdpWentOut();
    return true;
  }

  async function makeOffer() {
    if (role !== 'host' || !stream || frozen) return;
    const p = newPeer();
    const senders = stream.getTracks().map((t) => p.addTrack(t, stream)); // add tracks first, then create the offer
    // Data channels must exist before createOffer so they are part of the SDP. The Client only RECEIVES on them.
    hostCtl = p.createDataChannel('ctl', { ordered: true });
    const mv = p.createDataChannel('mv', { ordered: false, maxRetransmits: 0 });
    [hostCtl, mv].forEach((ch) => { ch.onmessage = (m) => forwardToAgent(m.data); });
    hostCtl.onopen = announceAgentLink;
    set({ conn: 'connecting' });
    const offer = await p.createOffer();
    await p.setLocalDescription(offer);
    if (pc !== p) return;
    sendSignal({ type: 'offer', offer: wire(p.localDescription || offer) });
    sdpWentOut();                                                    // candidates already gathered go out now, the rest as they appear
    senders.filter((sn) => sn.track && sn.track.kind === 'video').forEach((sn) => {
      const prm = sn.getParameters();
      if (!prm.encodings || !prm.encodings.length) prm.encodings = [{}];
      prm.encodings[0].maxBitrate = 4000000;
      prm.degradationPreference = 'maintain-resolution'; // keep text readable; drop frames instead
      sn.setParameters(prm).catch(() => {});
    });
  }

  // Signaling messages are processed one at a time, in arrival order (an offer is always finished before its candidates are applied).
  function onSignal(msg) {
    if (!msg || msg.taskId !== taskId) return;
    sigChain = sigChain.then(() => handleSignal(msg)).catch(() => { scheduleRecovery(1000); });
  }

  async function addRemoteCandidate(c) {
    if (!c) return;                                                  // end-of-candidates marker
    if (!pc) { if (earlyIce.length < 64) earlyIce.push(c); return; }
    if (!pc.remoteDescription) { pendingIce.push(c); return; }
    try { await pc.addIceCandidate(c); } catch (_) { /* a candidate from a replaced generation: harmless, never an error */ }
  }

  async function handleSignal(msg) {
    if (msg.taskId !== taskId || !role) return;
    if (msg.type === 'offer' && role === 'viewer') {
      // Same DTLS identity = the host restarted ICE on the live peer: answer on the same peer so the stream never blinks.
      const same = pc && pc.remoteDescription && pc.connectionState !== 'closed' && fingerprint(pc.remoteDescription.sdp) === fingerprint(msg.offer && msg.offer.sdp);
      const p = same ? pc : newPeer();
      if (!same) set({ conn: 'connecting' });
      sdpSent = false; outIce = [];
      await p.setRemoteDescription(msg.offer);
      await flushIce();
      const answer = await p.createAnswer();
      await p.setLocalDescription(answer);
      sendSignal({ type: 'answer', answer: wire(p.localDescription || answer) });
      sdpWentOut();
    } else if (msg.type === 'answer' && role === 'host' && pc) {
      if (pc.signalingState !== 'have-local-offer') return;          // stale answer from an earlier attempt
      await pc.setRemoteDescription(msg.answer);
      await flushIce();
    } else if (msg.type === 'candidate') {
      await addRemoteCandidate(msg.candidate);
    } else if (msg.type === 'restart' && role === 'host') {
      if (Date.now() - recover.lastReq < 1500) return;               // the viewer asks repeatedly while it waits
      recover.lastReq = Date.now();
      await refreshIceConfig();
      await restartIce();
    }
  }

  async function flushIce() {
    const list = earlyIce.concat(pendingIce); earlyIce = []; pendingIce = [];
    for (const c of list) { try { await pc.addIceCandidate(c); } catch (_) { /* stale candidate */ } }
  }

  // ---------- CLIENT: share the screen. Must be called from a click (browsers require a user gesture) ----------
  async function startHost(id) {
    stop();
    role = 'host'; taskId = id; frozen = false; set({ conn: 'starting', halted: null, lockout: null });
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      stop();
      throw new Error('This device cannot share its screen: phone and tablet browsers do not allow it. Open ScopeDesk on a Windows, Mac or Linux computer (Chrome, Edge or the ScopeDesk desktop app) and press Share my screen there. A phone can still be used as the Vendor to view and control a computer.');
    }
    try {
      // getDisplayMedia must be the FIRST await after the click: Chrome/Edge only allow it while the click's
      // "transient user activation" is fresh (~5 s). Fetching the ICE config before it can make the call fail.
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: 'monitor',            // hint: open the picker on "Entire screen" (needed for remote control)
          frameRate: { ideal: 30, max: 30 },
          width: { ideal: 1920 }, height: { ideal: 1080 }   // ideal only: hard limits can make capture fail
        },
        audio: false,
        monitorTypeSurfaces: 'include',         // Chromium extras; browsers that do not know them ignore them
        selfBrowserSurface: 'exclude',          // do not offer the ScopeDesk tab itself (avoids a mirror-in-mirror)
        surfaceSwitching: 'exclude'
      });
      await loadIceConfig(id);
    } catch (err) {
      stop();
      const cancelled = err && (err.name === 'NotAllowedError' || err.name === 'AbortError');
      throw new Error(cancelled ? 'Screen sharing was cancelled. In the window, click the screen preview first, then press Share.' : (err.message || 'Could not start screen sharing.'));
    }
    const track = stream.getVideoTracks()[0];
    track.contentHint = 'detail';               // favour sharp text over smooth motion
    set({ shareSurface: (track.getSettings() || {}).displaySurface || null });
    track.onended = () => stop('stopped');      // the Client pressed "Stop sharing"
    await join();
  }

  // ---------- VENDOR: receive the screen and mirror input ----------
  // `els.rtcConfig` (optional): the config object the page already fetched from the server. It is used as is.
  async function startViewer(id, els) {
    stop();
    role = 'viewer'; taskId = id; video = els.video; stage = els.stage; set({ conn: 'starting', halted: null });
    if (els.rtcConfig && els.rtcConfig.iceServers) { iceCfg = els.rtcConfig; set({ relay: !!iceCfg.relay, relayKind: iceCfg.relayKind || null }); }
    else await loadIceConfig(id);
    attachInput();
    await join();
  }

  // Vendor -> Client. Data channel when the Client's agent link is up, otherwise the server relay.
  function sendInput(e, volatile) {
    if (role !== 'viewer' || view.halted) return false;
    const ch = e.t === 'move' ? dc.mv : dc.ctl;
    if (hostBridgeReady && ch && ch.readyState === 'open') { ch.send(JSON.stringify(e)); return true; }
    if (socket && socket.connected) { (volatile ? socket.volatile : socket).emit('remote-input', { taskId, e }); return true; }
    return false;
  }

  // The capture logic lives in remote-input.js; this only decides how each event travels
  function attachInput() { detachInput = window.ScopeDeskInput.attach({ stage, video, send: sendInput }); }

  // Vendor asks the host to open a folder in the file manager. The HOST decides: a path outside the task's allowed folders
  // is a scope violation (input locked, Client notified, link cut). Returns false if there is no live channel.
  function openFolder(folderPath) {
    const p = String(folderPath || '').trim().slice(0, 260);
    return !!p && sendInput({ t: 'open', p });
  }

  // ---------- CLIENT: hand data-channel frames to the background agent ----------
  function announceAgentLink() {
    if (hostCtl && hostCtl.readyState === 'open') { try { hostCtl.send(JSON.stringify({ t: 'bridge', ready: agentLink && !frozen })); } catch (_) { /* closing */ } }
  }
  // Raw JSON from the vendor goes to Electron untouched; the agent validates every frame itself
  function forwardToAgent(raw) {
    if (!desktop || frozen || view.halted || !agentLink) return;
    if (typeof raw !== 'string' || raw.length > 600) return;
    desktop.sendInput(raw);
  }

  // ---------- teardown ----------
  function closeChannels() {
    [hostCtl, dc.ctl, dc.mv].forEach((ch) => { if (ch) { ch.onmessage = null; try { ch.close(); } catch (_) { /* already closed */ } } });
    hostCtl = null; dc = { ctl: null, mv: null }; hostBridgeReady = false;
  }

  function closePeer() {
    closeChannels();
    if (pc) { try { pc.close(); } catch (_) { /* already closed */ } pc = null; }
    window.scopedeskPeer = null;
    pendingIce = []; outIce = []; sdpSent = false;      // earlyIce survives here: on the viewer it is filled BEFORE the peer for the offer exists
    clearTimeout(recover.timer); recover.timer = null; recover.n = 0;
    clearTimeout(slowTimer); clearTimeout(stallTimer);
  }

  function stop(reason) {
    closePeer();
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    if (video) video.srcObject = null;
    if (detachInput) { detachInput(); detachInput = null; }
    if (socket && taskId && role) socket.emit('webrtc-leave', { taskId });
    const was = taskId;
    earlyIce = [];
    role = null; taskId = null; video = null; stage = null;
    clearTimeout(slowTimer); clearTimeout(stallTimer);
    set({ conn: reason || 'idle', agent: 'unknown', halted: null, shareSurface: null, connectSlow: false, retrying: 0, everLive: false, path: null });
    return was;
  }

  // The OS reports the network is back (Wi-Fi switch, hotspot, cable): repair at once instead of waiting for the next back-off tick.
  window.addEventListener('online', () => { if (role && pc && pc.connectionState !== 'connected') { recover.n = 0; scheduleRecovery(0, true); } });
  if (navigator.connection && navigator.connection.addEventListener) navigator.connection.addEventListener('change', () => { if (role && pc && pc.connectionState !== 'connected') scheduleRecovery(500, true); });

  // Kept so older pages that still call them do not break. The local WebSocket bridge (ws://127.0.0.1:47600) is gone:
  // the desktop app passes input over Electron IPC, so no port is opened on the Client's PC.
  const noop = () => {};
  window.ScopeDeskRTC = { init, bindSocket, requestNotificationPermission, notifyTerminated, startHost, startViewer, stop, openFolder, fetchRtcConfig: (id) => loadIceConfig(id), peerConfig, setAgentToken: noop, startBridge: noop, stopBridge: noop, isActive: () => !!role, current: () => ({ role, taskId }) };
})();
