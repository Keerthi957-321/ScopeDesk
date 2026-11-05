'use strict';
// "Specific Window Only" vs "Entire Screen": the choice steers the picker AND is verified, so a whole screen never leaves the PC
// in window mode.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const SS = require('../public/screen-share');

function fakeStream(surface) {
  const track = { stopped: false, stop() { this.stopped = true; }, getSettings: () => (surface ? { displaySurface: surface } : {}), addEventListener() {} };
  return { track, getTracks: () => [track], getVideoTracks: () => [track] };
}
const devices = (...results) => { const calls = []; return { calls, getDisplayMedia: async (c) => { calls.push(c); return results.shift(); } }; };

function loadStore(saved) {
  const store = new Map(saved ? [['scopedesk_share_mode', saved]] : []);
  const win = { localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) } };
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'share-mode.js'), 'utf8'), vm.createContext({ window: win, globalThis: win }));
  return { SM: win.ScopeDeskShareMode, store };
}

test('share mode store: private default, saved per device, listeners told, labels', () => {
  const { SM, store } = loadStore();
  assert.equal(SM.get(), 'window');
  assert.equal(SM.label(), 'Specific Window Only');
  const seen = [];
  SM.onChange((m) => seen.push(m));
  SM.set('screen'); SM.set('screen'); SM.set('nonsense');
  assert.deepEqual(seen, ['screen']);
  assert.equal(store.get('scopedesk_share_mode'), 'screen');
  assert.equal(SM.label(), 'Entire Screen');
  assert.equal(loadStore('screen').SM.get(), 'screen');
  assert.deepEqual({ ...SM.captureHints('window') }, { displaySurface: 'window', monitorTypeSurfaces: 'exclude' });
  assert.equal(SM.surfaceMatches('window', 'monitor'), false);
  assert.equal(SM.surfaceMatches('window', 'window'), true);
  assert.equal(SM.surfaceMatches('screen', 'window'), false);
  assert.equal(SM.surfaceMatches('window', undefined), true, 'engines that do not report it are decided by the desktop picker');
});

test('window mode: the picker hides whole screens, and a whole screen that is picked anyway is released, never used', async () => {
  const monitor = fakeStream('monitor');
  const dev = devices(monitor);
  const share = SS.create({ mediaDevices: dev, requireEntireScreen: false, getMode: () => 'window' });
  const r = await share.start();
  assert.equal(r.ok, false);
  assert.equal(r.code, 'wrong-surface');
  assert.match(r.tip, /Specific Window Only/);
  assert.equal(monitor.track.stopped, true, 'the captured screen is stopped at once');
  assert.equal(share.getStream(), null);
  assert.equal(dev.calls[0].video.displaySurface, 'window');
  assert.equal(dev.calls[0].monitorTypeSurfaces, 'exclude');
});

test('window mode accepts one window (or a tab); screen mode asks for the entire screen', async () => {
  const w = await SS.create({ mediaDevices: devices(fakeStream('window')), requireEntireScreen: false, getMode: () => 'window' }).start();
  assert.equal(w.ok, true); assert.equal(w.surface, 'window');
  const t = await SS.create({ mediaDevices: devices(fakeStream('browser')), requireEntireScreen: false, getMode: () => 'window' }).start();
  assert.equal(t.ok, true);
  const dev = devices(fakeStream('monitor'));
  const sc = await SS.create({ mediaDevices: dev, requireEntireScreen: false, getMode: () => 'screen' }).start();
  assert.equal(sc.ok, true);
  assert.equal(dev.calls[0].video.displaySurface, 'monitor');
  assert.equal(dev.calls[0].monitorTypeSurfaces, 'include');
});
