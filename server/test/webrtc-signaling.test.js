// Drives public/webrtc.js with a fake RTCPeerConnection + fake socket to check the signaling rules (no browser needed).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path'), vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'webrtc.js'), 'utf8');
const CFG = { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }, { urls: ['turn:t.example.com:443?transport=tcp'], username: 'u', credential: 'c' }],
  iceTransportPolicy: 'all', bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require', iceCandidatePoolSize: 2, relay: true, relayKind: 'fixed' };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function harness() {
  const peers = [], sent = [], handlers = {}, listeners = {};
  class FakePC {
    constructor(cfg) { this.cfg = cfg; this.connectionState = 'new'; this.signalingState = 'stable'; this.remoteDescription = null; this.localDescription = null; this.added = []; this.offers = []; this.failAdd = false; peers.push(this); }
    addTrack() { return { track: { kind: 'video' }, getParameters: () => ({}), setParameters: async () => {} }; }
    createDataChannel() { return { readyState: 'connecting', close() {} }; }
    async createOffer(o) { this.offers.push(o || {}); return { type: 'offer', sdp: 'v=0\na=fingerprint:sha-256 HOST' + (o && o.iceRestart ? '' : '') }; }
    async createAnswer() { return { type: 'answer', sdp: 'v=0\na=fingerprint:sha-256 VIEW' }; }
    async setLocalDescription(d) { this.localDescription = d; this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable'; }
    async setRemoteDescription(d) { this.remoteDescription = d; this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable'; }
    async addIceCandidate(c) { if (this.failAdd) throw new Error('bad candidate'); this.added.push(c); }
    setConfiguration(c) { this.cfg = c; }
    getStats() { return Promise.resolve(new Map()); }
    close() { this.connectionState = 'closed'; }
    emitCandidate(cand) { this.onicecandidate && this.onicecandidate({ candidate: { type: 'host', toJSON: () => cand } }); }
    setState(st) { this.connectionState = st; this.onconnectionstatechange && this.onconnectionstatechange(); }
  }
  const socket = { connected: true, on: (ev, fn) => { handlers[ev] = fn; }, emit: (ev, payload, ack) => { sent.push({ ev, payload }); if (ev === 'webrtc-join' && ack) ack({ ok: true, peers: ['vendor'] }); else if (ev === 'agent-status' && ack) ack({ ok: false }); } };
  const stream = { getTracks: () => [{ kind: 'video', stop() {} }], getVideoTracks: () => [{ contentHint: '', getSettings: () => ({}) }] };
  const win = { addEventListener: (ev, fn) => { listeners[ev] = fn; } };
  const ctx = vm.createContext({ window: win, navigator: { mediaDevices: { getDisplayMedia: async () => stream } }, console: { log() {} }, RTCPeerConnection: FakePC, setTimeout, clearTimeout, Promise, JSON, Date, Math });
  vm.runInContext(SRC, ctx);
  const rtc = win.ScopeDeskRTC;
  let apiCalls = 0;
  rtc.init({ api: async () => { apiCalls++; return CFG; }, onChange: () => {} });
  rtc.bindSocket(socket);
  const signals = () => sent.filter((m) => m.ev === 'webrtc-signal').map((m) => m.payload);
  return { rtc, peers, sent, handlers, signals, stream, listeners, apiCalls: () => apiCalls };
}

test('host: the whole server rtcConfig reaches RTCPeerConnection', async () => {
  const h = harness();
  await h.rtc.startHost(7);
  await tick();
  assert.deepStrictEqual(h.peers[0].cfg.iceServers, CFG.iceServers);
  assert.strictEqual(h.peers[0].cfg.iceTransportPolicy, 'all');
  assert.strictEqual(h.peers[0].cfg.bundlePolicy, 'max-bundle');
  assert.strictEqual(h.peers[0].cfg.iceCandidatePoolSize, 2);
});

test('host: candidates are emitted one by one, immediately, and never before the offer', async () => {
  const h = harness();
  await h.rtc.startHost(7);
  await tick();
  const p = h.peers[0];
  const types = () => h.signals().map((s) => s.type);
  assert.strictEqual(types()[0], 'offer');
  p.emitCandidate({ candidate: 'candidate:1 host' });
  assert.deepStrictEqual(types(), ['offer', 'candidate']);          // sent at once, no waiting for gathering to finish
  p.emitCandidate({ candidate: 'candidate:2 srflx' });
  p.emitCandidate({ candidate: 'candidate:3 relay' });
  assert.deepStrictEqual(types(), ['offer', 'candidate', 'candidate', 'candidate']);
});

test('viewer: a candidate that arrives before the offer is kept and applied after it; bad candidates are never fatal', async () => {
  const h = harness();
  await h.rtc.startViewer(7, { video: {}, stage: { addEventListener() {}, removeEventListener() {}, focus() {} }, rtcConfig: CFG }).catch(() => {});
  h.handlers['webrtc-signal']({ taskId: 7, type: 'candidate', candidate: { candidate: 'candidate:early' } });
  h.handlers['webrtc-signal']({ taskId: 7, type: 'offer', offer: { type: 'offer', sdp: 'v=0\na=fingerprint:sha-256 HOST' } });
  await tick(20);
  const p = h.peers[h.peers.length - 1];
  assert.deepStrictEqual(p.added.map((c) => c.candidate), ['candidate:early']);
  assert.ok(h.signals().some((s) => s.type === 'answer'));
  p.failAdd = true;
  h.handlers['webrtc-signal']({ taskId: 7, type: 'candidate', candidate: { candidate: 'candidate:stale' } });
  await tick(10);
  assert.notStrictEqual(h.rtc.current().role, null);                // still in the session, no error state
});

test('host: a failed link is repaired by an ICE restart on the same peer, with no new peer and no error', async () => {
  const h = harness();
  await h.rtc.startHost(7);
  await tick();
  const p = h.peers[0];
  p.setState('connected');
  p.setState('failed');
  await tick(40);
  assert.strictEqual(h.peers.length, 1);                            // same RTCPeerConnection
  assert.ok(p.offers.some((o) => o.iceRestart === true));           // new ICE credentials, candidates are gathered again
  assert.ok(h.signals().filter((s) => s.type === 'offer').length >= 2);
  p.emitCandidate({ candidate: 'candidate:after-restart' });        // trickled right away after the restart offer
  assert.strictEqual(h.signals().filter((s) => s.type === 'candidate').pop().candidate.candidate, 'candidate:after-restart');
  assert.ok(h.apiCalls() >= 2);                                     // credentials were refreshed for the attempt
  p.setState('connected');                                          // recovered: the loop stops
});

test('viewer: a restart offer on the live peer is answered on the same peer; a new peer\'s offer replaces it', async () => {
  const h = harness();
  await h.rtc.startViewer(7, { video: {}, stage: { addEventListener() {}, removeEventListener() {}, focus() {} }, rtcConfig: CFG }).catch(() => {});
  h.handlers['webrtc-signal']({ taskId: 7, type: 'offer', offer: { type: 'offer', sdp: 'v=0\na=fingerprint:sha-256 HOST-A' } });
  await tick(15);
  h.handlers['webrtc-signal']({ taskId: 7, type: 'offer', offer: { type: 'offer', sdp: 'v=0\na=ice-ufrag:new\na=fingerprint:sha-256 HOST-A' } });
  await tick(15);
  const same = h.peers.length;
  h.handlers['webrtc-signal']({ taskId: 7, type: 'offer', offer: { type: 'offer', sdp: 'v=0\na=fingerprint:sha-256 HOST-B' } });
  await tick(15);
  assert.strictEqual(h.peers.length, same + 1);
  assert.strictEqual(h.signals().filter((s) => s.type === 'answer').length, 3);
});

test('the server relays the "restart" signal', () => {
  assert.match(fs.readFileSync(path.join(__dirname, '..', '..', 'server.js'), 'utf8'), /\['offer', 'answer', 'candidate', 'restart'\]\.includes\(msg\.type\)/);
});

test('a device without getDisplayMedia (phone) gets a plain explanation, not a JavaScript error', async () => {
  const h = harness();
  const ctx = vm.createContext({ window: { addEventListener() {} }, navigator: { mediaDevices: {} }, console: { log() {} }, RTCPeerConnection: function () {}, setTimeout, clearTimeout, Promise, JSON, Date, Math });
  vm.runInContext(SRC, ctx);
  ctx.window.ScopeDeskRTC.init({ api: async () => CFG, onChange: () => {} });
  await assert.rejects(() => ctx.window.ScopeDeskRTC.startHost(1), /phone and tablet browsers do not allow it/);
});
