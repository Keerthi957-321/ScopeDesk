'use strict';
// Windows Store apps (Calculator...) are recognised inside ApplicationFrameHost; a widened scope applies in place.
const test = require('node:test');
const assert = require('node:assert/strict');
const { ForegroundMonitor } = require('../monitor');
const { loadPolicy } = require('../policy');
const quiet = () => {};
const pol = (apps, paths = []) => loadPolicy({ taskType: '', targetProcess: '', taskId: 1, extra: { allowedApps: apps, allowedPaths: paths }, log: quiet });
const mon = (p) => new ForegroundMonitor({ policy: p, probe: { foldersFor: async () => [] }, pollMs: 1, strikes: 2, attributionMs: 1, onViolation() {}, onState() {}, log: quiet });

test('Calculator inside ApplicationFrameHost is in scope; another app with a "Calculator" title is not', async () => {
  const m = mon(pol(['Calculator']));
  assert.equal((await m.evaluate({ owner: { name: 'Application Frame Host', path: 'C:\\Windows\\System32\\ApplicationFrameHost.exe' }, title: 'Calculator' })).ok, true);
  assert.equal((await m.evaluate({ owner: { name: 'ApplicationFrameHost.exe', path: '' }, title: 'Settings' })).ok, false);
  assert.equal((await m.evaluate({ owner: { name: 'Google Chrome', path: '/Applications/Google Chrome.app' }, title: 'Calculator' })).ok, false, 'only the Store host may use its title');
  assert.equal((await m.evaluate({ owner: { name: 'Calculator', path: '/System/Applications/Calculator.app/Contents/MacOS/Calculator' }, title: 'Calculator' })).ok, true, 'macOS');
  assert.equal((await m.evaluate({ owner: { name: 'gnome-calculator', path: '/usr/bin/gnome-calculator' }, title: 'Calculator' })).ok, true, 'Linux (GNOME)');
});

test('a scope approved during the session applies to the running monitor at once (same policy object)', async () => {
  const live = pol(['Notepad']);
  const m = mon(live);
  const excel = { owner: { name: 'EXCEL.EXE', path: 'C:\\Program Files\\Microsoft Office\\EXCEL.EXE' }, title: 'Book1' };
  assert.equal((await m.evaluate(excel)).ok, false);
  Object.assign(live, pol(['Notepad', 'Excel']));       // what client-agent.js does on 'scope-updated'
  assert.equal((await m.evaluate(excel)).ok, true);
  assert.equal((await m.evaluate({ owner: { name: 'notepad.exe', path: '' }, title: '' })).ok, true, 'the old apps stay allowed');
});
