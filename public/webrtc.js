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
  // stopped: the Client pressed "Stop remote control" (server 'control-state'). Input is refused on every path until the Client starts it again.
  const view = { conn: 'idle', agent: 'unknown', input: 'none', halted: null, stopped: false, shareSurface: null, relay: null, relayKind: null, connectSlow: false, retrying: 0, everLive: false, path: null };
  let agentEvents = 0;                       // bumped by every live agent event, so an older join() reply cannot overwrite a newer state
  let agentSeq = -1;                         // desktop app status sequence: a late/duplicate status is ignored
  let slowTimer = null, stallTimer = null;   // 15 s of "connecting" = informational flag; 25 s = start repairing

  const desktop = window.scopedeskDesktop && window.scopedeskDesktop.isDesktop ? window.scopedeskDesktop : null;
  let agentLink = false;                     // Client: is the background agent up and able to take input right now?

  const set = (patch) => {
    // Only a REAL change is announced: an update that changes nothing must not make the page redraw (and re-toggle) its controls.
    let changed = false;
    for (const k of Object.keys(patch)) { if (view[k] !== patch[k]) { view[k] = patch[k]; changed = true; } }
    if (changed) onChange({ ...view, role, taskId });
  };

  // Privacy-safe diagnostics: stages, states and ids only. Never the content of an input event (no typed characters, no coordinates).
  const diagState = {};
  function diag(stage, value) {
    const v = String(value);
    if (diagState[stage] === v) return;                  // log transitions, not repeats
    diagState[stage] = v;
    console.log(`[ScopeDesk] remote-control ${stage}: ${v}` + (taskId ? ` (task ${taskId})` : ''));
  }

  // VENDOR: which way will the next mouse or key event travel?
  //   'channel' = WebRTC data channel to the Client's window (open, and the Client's agent is ready)
  //   'relay'   = through the server to the Client's agent (used whenever the channel is not usable)
  //   'none'    = nothing can receive it right now (agent offline / view-only / halted / not connected)
  function inputPath() {
    if (role !== 'viewer' || view.halted || view.stopped) return 'none';
    if (['offline', 'unknown', 'view-only', 'locked'].includes(view.agent)) return 'none';
    if (hostBridgeReady && dc.ctl && dc.ctl.readyState === 'open') return 'channel';
    if (socket && socket.connected) return 'relay';
    return 'none';
  }
  function refreshInput() {
    const path = inputPath();
    diag('input path', path);
    set({ input: path });
  }

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

  // Friendly in-window notice for the Client (public/screen-share.js). Never throws, ignores duplicate signals for one ending.
  function showClosedNotice(info) {
    try { if (isClientFn() && window.ScopeDeskScreenShare && window.ScopeDeskScreenShare.showSessionClosed) window.ScopeDeskScreenShare.showSessionClosed(info); } catch (_) { /* the notice is a nicety */ }
  }

  // ---------- desktop app wiring (Client side) ----------
  if (desktop) {
    const track = (s) => {
      if (s && typeof s.seq === 'number') { if (s.seq <= agentSeq) return; agentSeq = s.seq; }   // stale reply / duplicate event
      // Ready only when the agent finished starting (phase 'running') AND reported that it can really apply input.
      const up = !!s && s.phase === 'running' && s.inputReady === true;
      diag('host agent', s ? `${s.phase}${up ? ' (input ready)' : ''}` : 'unknown');
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
  const boundSockets = new WeakSet();
  function bindSocket(s) {
    socket = s;
    if (boundSockets.has(s)) return;                              // this socket already has the handlers: never register them twice
    boundSockets.add(s);
    if (isClientFn()) requestNotificationPermission();            // Client dashboard is up: ask to allow notifications now
    s.on('webrtc-peer-joined', (d) => { if (role === 'host' && d.role === 'vendor') makeOffer(); });
    s.on('webrtc-peer-left', () => { if (role === 'host') closePeer(); set({ conn: 'waiting' }); });
    s.on('webrtc-signal', onSignal);
    s.on('screen-frame', onFrame);                                      // server relay fallback pictures (vendor only)
    s.on('file-result', (d) => { if (d && d.taskId === taskId) fileListeners.forEach((fn) => { try { fn(d); } catch (_) { /* listener */ } }); });
    s.on('webrtc-close', (d) => {
      if (taskId && d.taskId === taskId) {
        const wasHost = role === 'host';
        stop(d.reason === 'security_violation' ? 'violation' : 'closed');
        if (wasHost) {
          notifyTerminated({ reason: d.reason, taskId: d.taskId });
          showClosedNotice({ reason: d.reason, taskId: d.taskId });
        }
      }
    });
    s.on('agent-status', (d) => { if (d.taskId === taskId) { agentEvents++; diag('host agent (server)', d.online ? 'online' : 'offline'); set({ agent: d.online ? (['offline', 'unknown'].includes(view.agent) ? 'waiting' : view.agent) : 'offline' }); refreshInput(); } });
    s.on('agent-diag', (d) => { if (d && d.taskId === taskId) { diag('client PC', `${d.os} input=${d.inputReady ? 'yes' : 'no'}`); set({ hostDiag: d }); } });
    s.on('agent-state', (d) => { if (d.taskId === taskId) { agentEvents++; diag('agent state', d.state); set({ agent: d.state, policy: d.policy || view.policy }); refreshInput(); } });
    // The server had nobody to hand an input event to (the Client's agent is not connected): show it instead of failing silently
    s.on('input-undeliverable', (d) => { if (d.taskId === taskId && role === 'viewer') { diag('input', 'not delivered: host agent offline'); set({ agent: 'offline', input: 'none' }); } });
    s.on('control-halt', (d) => {
      if (d.taskId !== taskId) return;
      if (d.reason === 'violation') { frozen = true; closeChannels(); notifyTerminated({ reason: 'security_violation', taskId: d.taskId }); }
      if (d.reason === 'ended' && role === 'host') { closeChannels(); showClosedNotice({ reason: d.endReason || 'closed', taskId: d.taskId }); }
      set({ halted: d.reason, locked: !!d.permanent });
      refreshInput();
    });
    // The Client started / stopped remote control (server/remote-control.js). One authoritative flag on both screens.
    s.on('control-state', (d) => {
      if (!d || d.taskId !== taskId) return;
      diag('remote control', d.active ? 'started by the client' : 'stopped by the client');
      set({ stopped: !d.active });
      if (role === 'host') announceAgentLink();      // the vendor's page stops using the data channel at once
      refreshInput();
    });
    s.on('control-resume', (d) => { if (d.taskId === taskId) { frozen = false; set({ halted: null, locked: false }); refreshInput(); } });
    // After a dropped connection the server forgot our room membership: join again
    s.on('connect', () => { if (role && taskId) join().catch(() => {}); refreshInput(); });
    s.on('disconnect', () => refreshInput());
  }

  const emitAck = (ev, payload) => new Promise((resolve) => socket.emit(ev, payload, resolve));

  async function join() {
    const res = await emitAck('webrtc-join', { taskId, role: role === 'host' ? 'client' : 'vendor' });
    if (!res || !res.ok) throw new Error((res && res.error) || 'Could not join the session.');
    const before = agentEvents;
    const a = await emitAck('agent-status', { taskId });
    // A live 'agent-state' / 'agent-status' event that arrived while this request was in flight is newer: keep it
    if (a && a.ok && agentEvents === before) set({ agent: a.online ? (a.state || 'waiting') : 'offline', halted: a.halted || null, stopped: !!a.stopped });
    else if (a && a.ok) set({ halted: a.halted || null, stopped: !!a.stopped });
    refreshInput();
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
      const relayed = role === 'viewer' && frames.active;           // the screen is already shown through the server relay
      if (st === 'connected') {
        clearTimeout(slowTimer); clearTimeout(stallTimer); clearTimeout(recover.timer); recover.timer = null; recover.n = 0;
        if (role === 'viewer') endFrames('direct link up');            // the faster WebRTC link replaces the relay
        set({ conn: 'live', connectSlow: false, retrying: 0, everLive: true });
        detectPath(p); setTimeout(() => detectPath(p), 4000);      // a better path can be nominated a moment later
      } else if (st === 'connecting') {
        if (!relayed) set({ conn: 'connecting' });
        clearTimeout(slowTimer); clearTimeout(stallTimer);
        slowTimer = setTimeout(() => { if (pc === p && p.connectionState === 'connecting') set({ connectSlow: true }); }, 15000);
        stallTimer = setTimeout(() => { if (pc === p && p.connectionState === 'connecting') scheduleRecovery(0, true); }, 25000);
      } else if (st === 'disconnected') {
        clearTimeout(slowTimer); clearTimeout(stallTimer);
        if (!relayed) set({ conn: 'lost' });
        scheduleRecovery(3000);                                    // short grace period: many drops heal by themselves
      } else if (st === 'failed') {
        clearTimeout(slowTimer); clearTimeout(stallTimer);
        if (!relayed) set({ conn: 'lost', connectSlow: true });
        scheduleRecovery(0, true);
        if (role === 'viewer') watchFrames();                         // ICE failed: ask for the server relay right away
      }
    };
    // VENDOR side: the Client's offer carries two channels. 'ctl' = reliable + ordered (clicks, keys, wheel, open-folder).
    // 'mv' = unordered, no retransmits (mouse moves: a late move is worthless, so never wait for it).
    p.ondatachannel = (e) => {
      const ch = e.channel;
      if (ch.label !== 'ctl' && ch.label !== 'mv') return;
      dc[ch.label] = ch;
      ch.onopen = () => { diag('data channel ' + ch.label, 'open'); refreshInput(); };
      ch.onmessage = (m) => { try { const d = JSON.parse(m.data); if (d.t === 'bridge') { hostBridgeReady = !!d.ready; diag('host bridge', hostBridgeReady ? 'ready' : 'not ready'); refreshInput(); } } catch (_) { /* ignore */ } };
      ch.onclose = () => { if (dc[ch.label] === ch) { dc[ch.label] = null; if (ch.label === 'ctl') hostBridgeReady = false; diag('data channel ' + ch.label, 'closed'); refreshInput(); } };
    };
    p.ontrack = (e) => {
      remoteStream = e.streams[0];
      if (video && !frames.active) { video.srcObject = remoteStream; video.play().catch(() => {}); }
    };
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

  // ---------- video tuning for a remote desktop: sharp text, low delay ----------
  // Codec order: VP8 (every browser, fast to encode, low latency), then H.264 (hardware encoders on most PCs/Macs), then VP9 / AV1
  // (better compression, more CPU). The vendor's browser picks the first one it also supports. RTX / RED / FEC entries are kept.
  function preferLowLatencyCodecs(p) {
    try {
      if (typeof RTCRtpSender === 'undefined' || typeof RTCRtpSender.getCapabilities !== 'function' || typeof p.getTransceivers !== 'function') return;
      const caps = RTCRtpSender.getCapabilities('video');
      if (!caps || !Array.isArray(caps.codecs)) return;
      const rank = (c) => {
        const m = String(c.mimeType || '').toLowerCase();
        if (m === 'video/vp8') return 0;
        if (m === 'video/h264') return /packetization-mode=1/.test(c.sdpFmtpLine || '') ? 1 : 2;
        if (m === 'video/vp9') return 3;
        if (m === 'video/av1') return 4;
        return 5;                                                   // rtx, red, ulpfec ... (kept, after the real codecs)
      };
      const ordered = caps.codecs.slice().sort((a, b) => rank(a) - rank(b));
      p.getTransceivers().forEach((t) => {
        if (t.sender && t.sender.track && t.sender.track.kind === 'video' && typeof t.setCodecPreferences === 'function') t.setCodecPreferences(ordered);
      });
      diag('video codec preference', 'vp8, h264, vp9');
    } catch (err) { console.log('[ScopeDesk] codec preference not applied:', err && err.message); }
  }
  // 30 fps at most, up to 3 Mbit/s, keep the resolution (text stays readable) and drop frames first when the network is tight
  function tuneSender(sn) {
    try {
      const prm = sn.getParameters();
      if (!prm.encodings || !prm.encodings.length) prm.encodings = [{}];
      Object.assign(prm.encodings[0], { maxBitrate: 3000000, maxFramerate: 30, scaleResolutionDownBy: 1, priority: 'high', networkPriority: 'high' });
      prm.degradationPreference = 'maintain-resolution';
      sn.setParameters(prm).catch(() => {});
    } catch (_) { /* older browsers: defaults are fine */ }
  }

  async function makeOffer() {
    if (role !== 'host' || !stream || frozen) return;
    const p = newPeer();
    const senders = stream.getTracks().map((t) => p.addTrack(t, stream)); // add tracks first, then create the offer
    preferLowLatencyCodecs(p);
    // Data channels must exist before createOffer so they are part of the SDP. The Client only RECEIVES on them.
    hostCtl = p.createDataChannel('ctl', { ordered: true });
    const mv = p.createDataChannel('mv', { ordered: false, maxRetransmits: 0 });
    [hostCtl, mv].forEach((ch) => { ch.onmessage = (m) => forwardToAgent(m.data); });
    hostCtl.onopen = () => { diag('data channel ctl', 'open'); announceAgentLink(); };
    hostCtl.onclose = () => diag('data channel ctl', 'closed');
    set({ conn: 'connecting' });
    const offer = await p.createOffer();
    await p.setLocalDescription(offer);
    if (pc !== p) return;
    sendSignal({ type: 'offer', offer: wire(p.localDescription || offer) });
    sdpWentOut();                                                    // candidates already gathered go out now, the rest as they appear
    senders.filter((sn) => sn.track && sn.track.kind === 'video').forEach(tuneSender);
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
    } else if (msg.type === 'frames' && role === 'host') {
      hostFrames(msg.on === true);                                     // vendor: "the direct link does not work, use the server relay"
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
  let sharer = null;   // guarded capture helper (public/screen-share.js), kept so a double click cannot open two pickers
  async function startHost(id) {
    stop();
    role = 'host'; taskId = id; frozen = false; set({ conn: 'starting', halted: null, lockout: null });
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      stop();
      throw new Error('This device cannot share its screen: phone and tablet browsers do not allow it. Open ScopeDesk on a Windows, Mac or Linux computer (Chrome, Edge or the ScopeDesk desktop app) and press Share my screen there. A phone can still be used as the Vendor to view and control a computer.');
    }
    // Guarded capture (public/screen-share.js). getDisplayMedia is still the FIRST await after the click, so the browser's
    // user-activation window is fresh. A cancelled picker / missed preview / wrong surface is a normal, retryable outcome:
    // the signaling socket and the task stay exactly as they are, only the dialog shows a tip, and the Client can press Share again.
    const Guard = window.ScopeDeskScreenShare;
    if (Guard) {
      // The picker offers Entire screen, a Window or a browser Tab. Only an entire screen allows remote control: with a window or tab the
      // vendor can watch (the host agent turns input off and both screens say why). The desktop app shows its own screen/window picker.
      // The Client's choice in Remote Connection (share-mode.js) steers the picker and is verified on the result.
      if (!sharer) sharer = Guard.create({ requireEntireScreen: false, log: () => {}, getMode: () => (window.ScopeDeskShareMode ? window.ScopeDeskShareMode.get() : null) });
      const r = await sharer.start();
      if (!r.ok) {
        let tip = r.tip || r.message || 'Screen sharing did not start.';
        if (desktop && typeof desktop.getDisplayMediaDenial === 'function' && r.code !== 'insecure' && r.code !== 'unsupported') {
          try { const why = await desktop.getDisplayMediaDenial(); if (why) tip += ` (ScopeDesk app detail: ${why})`; } catch (_) { /* optional detail */ }
        }
        if (r.retryable) {
          // NOT stop(): that would leave the signaling room and end the session. Just return to the state before the click.
          role = null; taskId = null;
          set({ conn: 'idle' });
        } else {
          stop();
        }
        const failure = new Error(tip);
        failure.retryable = !!r.retryable;
        failure.code = r.code;
        throw failure;
      }
      stream = r.stream;
      try { await loadIceConfig(id); } catch (err) { stop(); throw new Error(err.message || 'Could not start screen sharing.'); }
    } else try {
      // Fallback when screen-share.js is not loaded (older page): the original capture
      const hint = window.ScopeDeskShareMode ? window.ScopeDeskShareMode.captureHints() : { displaySurface: 'monitor', monitorTypeSurfaces: 'include' };
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { displaySurface: hint.displaySurface, frameRate: { ideal: 30, max: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false, monitorTypeSurfaces: hint.monitorTypeSurfaces, selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude'
      });
      await loadIceConfig(id);
    } catch (err) {
      stop();
      const cancelled = err && (err.name === 'NotAllowedError' || err.name === 'AbortError');
      throw new Error(cancelled ? 'Screen sharing was cancelled. Click the picture of your screen first, then press Share.' : (err.message || 'Could not start screen sharing.'));
    }
    const track = stream.getVideoTracks()[0];
    track.contentHint = 'detail';               // favour sharp text over smooth motion
    set({ shareSurface: (track.getSettings() || {}).displaySurface || null, shareMode: window.ScopeDeskShareMode ? window.ScopeDeskShareMode.get() : null });
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
    viewerSince = Date.now();
    clearInterval(frames.watch);
    frames.watch = setInterval(watchFrames, 2000);
    await join();
  }

  // Vendor -> Client. Data channel when the Client's agent link is up, otherwise the server relay.
  function sendInput(e, volatile) {
    if (role !== 'viewer' || view.halted || view.stopped) return false;  // stopped/halted: nothing leaves this page
    if (['view-only', 'locked'].includes(view.agent)) return false;       // the Client's PC will not apply it: do not pretend
    const ch = e.t === 'move' ? dc.mv : dc.ctl;
    if (hostBridgeReady && ch && ch.readyState === 'open') {
      try { ch.send(JSON.stringify(e)); return true; } catch (_) { /* the channel just broke: use the relay below */ }
    }
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
    const ready = agentLink && !frozen && !view.stopped;
    diag('host bridge (sent)', ready ? 'ready' : 'not ready');
    if (hostCtl && hostCtl.readyState === 'open') { try { hostCtl.send(JSON.stringify({ t: 'bridge', ready })); } catch (_) { /* closing */ } }
  }
  // Raw JSON from the vendor goes to Electron untouched; the agent validates every frame itself
  function forwardToAgent(raw) {
    if (!desktop || frozen || view.halted || view.stopped || !agentLink) return;
    if (typeof raw !== 'string' || raw.length > 20000) return;           // a pasted text can be up to 4000 characters
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
    stopRelay(); endFrames('stopped'); clearInterval(frames.watch); frames.watch = null;
    closePeer();
    if (stream) { try { stream.getTracks().forEach((t) => t.stop()); } catch (_) { /* already stopped */ } stream = null; }
    try { if (window.ScopeDeskScreenShare && window.ScopeDeskScreenShare.stopAll) window.ScopeDeskScreenShare.stopAll(); } catch (_) { /* nothing else to stop */ }
    if (video) video.srcObject = null;
    if (detachInput) { detachInput(); detachInput = null; }
    if (socket && taskId && role) socket.emit('webrtc-leave', { taskId });
    const was = taskId;
    Object.keys(diagState).forEach((k) => delete diagState[k]);
    earlyIce = [];
    role = null; taskId = null; video = null; stage = null;
    clearTimeout(slowTimer); clearTimeout(stallTimer);
    set({ conn: reason || 'idle', agent: 'unknown', input: 'none', halted: null, stopped: false, shareSurface: null, shareMode: null, connectSlow: false, retrying: 0, everLive: false, path: null });
    return was;
  }

  // The OS reports the network is back (Wi-Fi switch, hotspot, cable): repair at once instead of waiting for the next back-off tick.
  window.addEventListener('online', () => { if (role && pc && pc.connectionState !== 'connected') { recover.n = 0; scheduleRecovery(0, true); } });
  if (navigator.connection && navigator.connection.addEventListener) navigator.connection.addEventListener('change', () => { if (role && pc && pc.connectionState !== 'connected') scheduleRecovery(500, true); });

  // Kept so older pages that still call them do not break. The local WebSocket bridge (ws://127.0.0.1:47600) is gone:
  // the desktop app passes input over Electron IPC, so no port is opened on the Client's PC.
  const noop = () => {};
  // ---------- SCREEN RELAY FALLBACK (different networks without a TURN relay, strict firewalls) ----------
  // VENDOR: if the direct WebRTC link is not up ~12 s after joining (or drops), ask the Client's page to send the screen through the
  // ScopeDesk server as JPEG pictures. They are drawn on a canvas whose stream feeds the SAME <video>, so pointer mapping, input and
  // the UI work unchanged. Input travels through the server relay meanwhile. WebRTC keeps retrying; once it connects the relay stops.
  let remoteStream = null, viewerSince = 0;
  const frames = { active: false, canvas: null, ctx: null, out: null, lastAt: 0, watch: null, decoding: false };
  function watchFrames() {
    if (role !== 'viewer' || view.halted) return;                      // a stopped session is still viewable (view-only)
    const direct = pc && pc.connectionState === 'connected';
    if (direct) { if (frames.active) endFrames('direct link up'); return; }
    if (Date.now() - viewerSince < 5000) return;                        // 5 s without a direct link: show the screen through the server
    sendSignal({ type: 'frames', on: true });                          // repeated every few seconds: the Client stops when we go quiet
    if (frames.active && Date.now() - frames.lastAt > 10000) { frames.active = false; diag('screen path', 'server relay silent'); set({ conn: 'lost' }); }
  }
  function onFrame(d) {
    if (role !== 'viewer' || !d || d.taskId !== taskId || !video || frames.decoding) return;
    if (pc && pc.connectionState === 'connected') return;                // the direct link is up: ignore late relay pictures
    if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') return;
    frames.decoding = true;
    createImageBitmap(new Blob([d.data], { type: 'image/jpeg' })).then((img) => {
      if (!frames.canvas) {
        frames.canvas = document.createElement('canvas');
        frames.ctx = frames.canvas.getContext('2d');
      }
      if (frames.canvas.width !== d.w || frames.canvas.height !== d.h) { frames.canvas.width = d.w; frames.canvas.height = d.h; }
      frames.ctx.drawImage(img, 0, 0, d.w, d.h);
      if (img.close) img.close();
      if (!frames.active) {
        frames.active = true;
        if (!frames.out) frames.out = frames.canvas.captureStream(15);
        video.srcObject = frames.out; video.play().catch(() => {});
        diag('screen path', 'server relay');
        set({ conn: 'live', path: 'server', everLive: true, connectSlow: false });
      }
      frames.lastAt = Date.now();
    }).catch(() => { /* a damaged picture is skipped */ }).finally(() => { frames.decoding = false; });
  }
  function endFrames(why) {
    if (!frames.active) return;
    frames.active = false;
    diag('screen path', why);
    if (role === 'viewer') sendSignal({ type: 'frames', on: false });
    if (video && remoteStream) { video.srcObject = remoteStream; video.play().catch(() => {}); }
  }

  // CLIENT: sends ~5 pictures per second (max 1280 px wide, JPEG) while the vendor keeps asking. Stops 20 s after the last request.
  const relay = { on: false, until: 0, timer: null, video: null, canvas: null, inflight: false, sentAt: 0 };
  function hostFrames(on) {
    if (!on) return stopRelay();
    if (role !== 'host' || !stream || frozen || view.halted || typeof document === 'undefined') return;
    relay.until = Date.now() + 20000;
    if (relay.on) return;
    relay.on = true;
    diag('screen relay (sending)', 'on');
    relay.video = document.createElement('video');
    relay.video.muted = true; relay.video.playsInline = true; relay.video.srcObject = stream;
    relay.video.play().catch(() => {});
    relay.canvas = document.createElement('canvas');
    relay.timer = setInterval(sendFrame, 200);
  }
  function sendFrame() {
    if (!relay.on) return;
    if (Date.now() > relay.until || role !== 'host' || frozen || view.halted) return stopRelay();
    if (!socket || !socket.connected || (relay.inflight && Date.now() - relay.sentAt < 3000)) return;
    const v = relay.video, vw = v.videoWidth, vh = v.videoHeight;
    if (!vw || !vh) return;
    const scale = Math.min(1, 1280 / vw);
    const w = Math.max(16, Math.round(vw * scale)), h = Math.max(16, Math.round(vh * scale));
    if (relay.canvas.width !== w || relay.canvas.height !== h) { relay.canvas.width = w; relay.canvas.height = h; }
    relay.canvas.getContext('2d').drawImage(v, 0, 0, w, h);
    relay.inflight = true; relay.sentAt = Date.now();
    relay.canvas.toBlob((b) => {
      if (!b || !relay.on) { relay.inflight = false; return; }
      b.arrayBuffer().then((data) => socket.emit('screen-frame', { taskId, w, h, data }, () => { relay.inflight = false; }))
        .catch(() => { relay.inflight = false; });
    }, 'image/jpeg', 0.6);
  }
  function stopRelay() {
    if (!relay.on) return;
    relay.on = false;
    clearInterval(relay.timer); relay.timer = null;
    if (relay.video) { relay.video.srcObject = null; relay.video = null; }
    relay.canvas = null; relay.inflight = false;
    diag('screen relay (sending)', 'off');
  }

  // ---------- CLIENT: switch which monitor is shared (multi-monitor). Call from a click: it asks for the screen again ----------
  // The desktop app has already been told which display to offer (scopedeskDesktop.selectDisplay). The video track is swapped on the
  // live connection (no reconnect), and the host agent maps the vendor's pointer onto the new display.
  async function switchScreen() {
    if (role !== 'host' || !stream) throw new Error('Share your screen first.');
    const SM = window.ScopeDeskShareMode;
    const hint = SM ? SM.captureHints() : { displaySurface: 'monitor', monitorTypeSurfaces: 'include' };
    const ns = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: hint.displaySurface, frameRate: { ideal: 30, max: 30 } }, audio: false, monitorTypeSurfaces: hint.monitorTypeSurfaces, selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude' });
    const nt = ns.getVideoTracks()[0];
    const newSurface = (nt.getSettings() || {}).displaySurface;
    if (SM && !SM.surfaceMatches(SM.get(), newSurface)) {
      ns.getTracks().forEach((t) => { try { t.stop(); } catch (_) { /* stopped */ } });   // privacy: keep the current share, drop the wrong one
      throw new Error(SM.get() === 'window' ? 'A whole screen was picked, but "Specific Window Only" is on. Pick one window instead.' : 'A window was picked, but "Entire Screen" is on. Pick your whole screen instead.');
    }
    nt.contentHint = 'detail';
    const sender = pc && pc.getSenders().find((sn) => sn.track && sn.track.kind === 'video');
    if (sender) { await sender.replaceTrack(nt); tuneSender(sender); }
    const old = stream;
    stream = ns;
    old.getTracks().forEach((t) => { t.onended = null; try { t.stop(); } catch (_) { /* stopped */ } });
    nt.onended = () => stop('stopped');
    if (relay.video) relay.video.srcObject = ns;
    set({ shareSurface: newSurface || null, shareMode: SM ? SM.get() : null });
    diag('shared screen', 'switched');
  }

  // ---------- VENDOR: send a file to the Client's PC (only into the task's approved folders; see agent/file-receiver.js) ----------
  // Chunks go through the server; each one waits for the Client's PC to confirm it was written. The final result arrives as
  // 'file-result' (ScopeDeskRTC.onFileResult). Nothing can be downloaded FROM the Client's PC.
  const fileListeners = new Set();
  async function sendFile(file, folder, onProgress) {
    if (role !== 'viewer' || !socket || !socket.connected) throw new Error('Not connected to the session.');
    if (view.halted || view.stopped) throw new Error('Remote control is not active.');
    if (!file || file.size > 25 * 1024 * 1024) throw new Error('Files up to 25 MB only.');
    const id = 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    const CHUNK = 192 * 1024;
    for (let off = 0, seq = 0; ; off += CHUNK, seq++) {
      const data = await file.slice(off, off + CHUNK).arrayBuffer();
      const last = off + CHUNK >= file.size;
      const res = await new Promise((resolve) => socket.emit('file-chunk', { taskId, id, seq, last, size: file.size, name: file.name, folder: folder || '', data }, resolve));
      if (!res || !res.ok) throw new Error((res && res.error) || 'The file was refused.');
      if (onProgress) { try { onProgress(Math.min(1, (off + CHUNK) / Math.max(1, file.size))); } catch (_) { /* progress is optional */ } }
      if (last) return id;
    }
  }

  window.ScopeDeskRTC = {
    switchScreen, sendFile, onFileResult: (fn) => { fileListeners.add(fn); return () => fileListeners.delete(fn); }, init, bindSocket, requestNotificationPermission, notifyTerminated, startHost, startViewer, stop, openFolder, fetchRtcConfig: (id) => loadIceConfig(id), peerConfig, setAgentToken: noop, startBridge: noop, stopBridge: noop, isActive: () => !!role, current: () => ({ role, taskId }) };
})();
