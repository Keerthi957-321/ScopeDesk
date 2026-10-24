// ScopeDesk WebRTC remote desktop.
//   Client (host):   captures the screen (getDisplayMedia), sends it, and RECEIVES the vendor's input on RTCDataChannels.
//   Vendor (viewer): receives the screen and sends mouse/keyboard back as small JSON frames.
//
// Signaling (offer/answer/ICE) goes through the authenticated Socket.IO connection the app already has.
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
  let api = null, socket = null, onChange = () => {};
  let role = null, taskId = null, iceCfg = null;
  let pc = null, stream = null, pendingIce = [], retries = 0;
  let video = null, stage = null, detachInput = null;
  // Vendor: the two channels the Client's offer created.  Client: hostCtl is our end of 'ctl'.
  let dc = { ctl: null, mv: null }, hostBridgeReady = false, hostCtl = null;
  let frozen = false;                        // Client: true after a lockout; no frame reaches the agent until the session is resumed
  const view = { conn: 'idle', agent: 'unknown', halted: null, shareSurface: null, relay: null, connectSlow: false };
  let slowTimer = null;                       // fires when the link has been "connecting" for 15 s (usually: no relay between two networks)

  const desktop = window.scopedeskDesktop && window.scopedeskDesktop.isDesktop ? window.scopedeskDesktop : null;
  let agentLink = false;                     // Client: is the background agent up and able to take input right now?

  const set = (patch) => { Object.assign(view, patch); onChange({ ...view, role, taskId }); };

  function init(opts) {
    api = opts.api; onChange = opts.onChange || onChange;
    console.log('[ScopeDesk] WebRTC Engine Initialized'); // developer console only, never a popup
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
    return was;
  }

  // Called by script.js every time it (re)creates the app socket
  function bindSocket(s) {
    socket = s;
    s.on('webrtc-peer-joined', (d) => { if (role === 'host' && d.role === 'vendor') makeOffer(); });
    s.on('webrtc-peer-left', () => { if (role === 'host') { closePeer(); set({ conn: 'waiting' }); } else set({ conn: 'waiting' }); });
    s.on('webrtc-signal', onSignal);
    s.on('webrtc-close', (d) => { if (taskId && d.taskId === taskId) stop(d.reason === 'security_violation' ? 'violation' : 'closed'); });
    s.on('agent-status', (d) => { if (d.taskId === taskId) set({ agent: d.online ? 'waiting' : 'offline' }); });
    s.on('agent-state', (d) => { if (d.taskId === taskId) set({ agent: d.state, policy: d.policy || view.policy }); });
    s.on('control-halt', (d) => { if (d.taskId === taskId) { if (d.reason === 'violation') { frozen = true; closeChannels(); } set({ halted: d.reason, locked: !!d.permanent }); } });
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
    if (role === 'host' && res.peers.includes('vendor')) makeOffer();
    else set({ conn: 'waiting' });
  }

  function newPeer() {
    closePeer();
    pc = new RTCPeerConnection({ iceServers: iceCfg.iceServers, iceTransportPolicy: iceCfg.iceTransportPolicy });
    pendingIce = [];
    pc.onicecandidate = (e) => {
      if (e.candidate) console.log('[ScopeDesk] ICE candidate:', e.candidate.type || 'unknown');   // developer console only: host / srflx / relay
      if (e.candidate && socket) socket.emit('webrtc-signal', { taskId, type: 'candidate', candidate: e.candidate });
    };
    pc.oniceconnectionstatechange = () => { if (pc) console.log('[ScopeDesk] ICE state:', pc.iceConnectionState); };
    pc.onconnectionstatechange = () => {
      const st = pc && pc.connectionState;
      if (st === 'connected') { clearTimeout(slowTimer); set({ conn: 'live', connectSlow: false }); }
      else if (st === 'connecting') {
        set({ conn: 'connecting' });
        clearTimeout(slowTimer);
        const mine = pc;
        slowTimer = setTimeout(() => { if (pc === mine && mine.connectionState === 'connecting') set({ connectSlow: true }); }, 15000);
      }
      else if (st === 'failed' || st === 'disconnected') {
        clearTimeout(slowTimer);
        set({ conn: 'lost', connectSlow: true });
        if (st === 'failed' && role === 'host' && !frozen && retries < 3) { retries++; const mine = pc; setTimeout(() => { if (pc === mine && role === 'host' && !frozen) makeOffer(); }, 1000); }
      }
      if (st === 'connected') retries = 0;
    };
    // VENDOR side: the Client's offer carries two channels. 'ctl' = reliable + ordered (clicks, keys, wheel, open-folder).
    // 'mv' = unordered, no retransmits (mouse moves: a late move is worthless, so never wait for it).
    pc.ondatachannel = (e) => {
      const ch = e.channel;
      if (ch.label !== 'ctl' && ch.label !== 'mv') return;
      dc[ch.label] = ch;
      ch.onmessage = (m) => { try { const d = JSON.parse(m.data); if (d.t === 'bridge') hostBridgeReady = !!d.ready; } catch (_) { /* ignore */ } };
      ch.onclose = () => { if (dc[ch.label] === ch) dc[ch.label] = null; };
    };
    pc.ontrack = (e) => { if (video) { video.srcObject = e.streams[0]; video.play().catch(() => {}); } };
    return pc;
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
    socket.emit('webrtc-signal', { taskId, type: 'offer', offer });
    senders.filter((sn) => sn.track && sn.track.kind === 'video').forEach((sn) => {
      const prm = sn.getParameters();
      if (!prm.encodings || !prm.encodings.length) prm.encodings = [{}];
      prm.encodings[0].maxBitrate = 4000000;
      prm.degradationPreference = 'maintain-resolution'; // keep text readable; drop frames instead
      sn.setParameters(prm).catch(() => {});
    });
  }

  async function onSignal(msg) {
    if (!msg || msg.taskId !== taskId) return;
    try {
      if (msg.type === 'offer' && role === 'viewer') {
        const p = newPeer();
        set({ conn: 'connecting' });
        await p.setRemoteDescription(msg.offer);
        await flushIce();
        const answer = await p.createAnswer();
        await p.setLocalDescription(answer);
        socket.emit('webrtc-signal', { taskId, type: 'answer', answer });
      } else if (msg.type === 'answer' && role === 'host' && pc) {
        await pc.setRemoteDescription(msg.answer);
        await flushIce();
      } else if (msg.type === 'candidate' && pc) {
        if (pc.remoteDescription) await pc.addIceCandidate(msg.candidate); else pendingIce.push(msg.candidate);
      }
    } catch (err) { set({ conn: 'lost' }); }
  }

  async function flushIce() { for (const c of pendingIce) await pc.addIceCandidate(c); pendingIce = []; }

  // ---------- CLIENT: share the screen. Must be called from a click (browsers require a user gesture) ----------
  async function startHost(id) {
    stop();
    role = 'host'; taskId = id; frozen = false; set({ conn: 'starting', halted: null, lockout: null });
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
      iceCfg = await api(`/api/rtc-config?taskId=${id}`);
      set({ relay: !!iceCfg.relay });
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
  async function startViewer(id, els) {
    stop();
    role = 'viewer'; taskId = id; video = els.video; stage = els.stage; set({ conn: 'starting', halted: null });
    iceCfg = await api(`/api/rtc-config?taskId=${id}`);
    set({ relay: !!iceCfg.relay });
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
    pendingIce = [];
  }

  function stop(reason) {
    closePeer();
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    if (video) video.srcObject = null;
    if (detachInput) { detachInput(); detachInput = null; }
    if (socket && taskId && role) socket.emit('webrtc-leave', { taskId });
    const was = taskId;
    role = null; taskId = null; video = null; stage = null;
    clearTimeout(slowTimer);
    set({ conn: reason || 'idle', agent: 'unknown', halted: null, shareSurface: null, connectSlow: false });
    return was;
  }

  // Kept so older pages that still call them do not break. The local WebSocket bridge (ws://127.0.0.1:47600) is gone:
  // the desktop app passes input over Electron IPC, so no port is opened on the Client's PC.
  const noop = () => {};
  window.ScopeDeskRTC = { init, bindSocket, startHost, startViewer, stop, openFolder, setAgentToken: noop, startBridge: noop, stopBridge: noop, isActive: () => !!role, current: () => ({ role, taskId }) };
})();
