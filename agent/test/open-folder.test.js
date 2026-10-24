const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { InputInjector } = require('../input-injector');
const { loadPolicy } = require('../policy');
const { parseInput } = require('../validate');

const quiet = () => {};
function setup(allowedPaths) {
  const policy = loadPolicy({ taskType: '', targetProcess: 'notepad.exe', taskId: 1, extra: { allowedPaths, allowedApps: [] }, log: quiet, file: '/nonexistent.json' });
  const flagged = [], opened = [];
  const monitor = { state: 'waiting', flag: (r) => { monitor.state = 'locked'; flagged.push(r); } };
  const injector = new InputInjector({ monitor, log: quiet, viewOnly: false, policy, launcher: (p) => opened.push(p) });
  return { injector, flagged, opened, monitor };
}
const tick = () => new Promise((r) => setTimeout(r, 20));

test('schema: open needs a short plain string', () => {
  assert.deepStrictEqual(parseInput({ t: 'open', p: 'C:\\BillingData' }), { t: 'open', p: 'C:\\BillingData' });
  assert.strictEqual(parseInput({ t: 'open', p: '' }), null);
  assert.strictEqual(parseInput({ t: 'open', p: 'x'.repeat(261) }), null);
  assert.strictEqual(parseInput({ t: 'open', p: 'C:\\a\u0000b' }), null);
  assert.strictEqual(parseInput({ t: 'open', p: 5 }), null);
});

test('an approved folder opens (also when written with a "." segment)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'Billing-'));
  const { injector, flagged, opened } = setup([dir]);
  injector.handle({ t: 'open', p: dir });
  injector.handle({ t: 'open', p: path.join(dir, '.') });
  await tick();
  assert.strictEqual(flagged.length, 0);
  assert.strictEqual(opened.length, 2);
});

test('a folder outside the approved paths is a violation: nothing opens, input locks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ok-'));
  const { injector, flagged, opened } = setup([dir]);
  injector.handle({ t: 'open', p: os.homedir() });
  await tick();
  assert.deepStrictEqual(opened, []);
  assert.strictEqual(flagged.length, 1);
  assert.strictEqual(flagged[0].kind, 'path');
  assert.strictEqual(flagged[0].detail, os.homedir());
});

test('look-alike and parent-escape paths are refused', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-'));
  const allowed = path.join(base, 'BillingData'); fs.mkdirSync(allowed);
  fs.mkdirSync(path.join(base, 'BillingDataEvil'));
  const { injector, flagged, opened } = setup([allowed]);
  injector.handle({ t: 'open', p: path.join(base, 'BillingDataEvil') });
  await tick();
  assert.strictEqual(opened.length, 0);
  assert.strictEqual(flagged.length, 1);
  const s2 = setup([allowed]);
  s2.injector.handle({ t: 'open', p: path.join(allowed, '..') });
  await tick();
  assert.strictEqual(s2.opened.length, 0);
  assert.strictEqual(s2.flagged.length, 1);
});

test('a task with no approved folders refuses every open request', async () => {
  const { injector, flagged, opened } = setup([]);
  injector.handle({ t: 'open', p: os.tmpdir() });
  await tick();
  assert.strictEqual(opened.length, 0);
  assert.strictEqual(flagged.length, 1);
});

test('once locked, further requests are ignored', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ok-'));
  const { injector, flagged, opened } = setup([dir]);
  injector.handle({ t: 'open', p: os.homedir() });
  await tick();
  injector.handle({ t: 'open', p: dir });
  await tick();
  assert.strictEqual(opened.length, 0);
  assert.strictEqual(flagged.length, 1);
});
