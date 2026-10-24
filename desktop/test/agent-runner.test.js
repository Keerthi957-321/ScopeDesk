const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createAgentRunner } = require('../agent-runner');

function fakeFork() {
  const calls = [];
  const fn = (file, args, opts) => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
    c.sent = []; c.send = (m) => { c.sent.push(m); }; c.kill = () => { c.killed = true; c.emit('exit', null); };
    calls.push({ file, args, opts, child: c });
    return c;
  };
  fn.calls = calls;
  return fn;
}
const make = (extra = {}) => { const forkFn = fakeFork(); return { forkFn, r: createAgentRunner({ agentDir: '/a', serverUrl: 'http://x', forkFn, rewarmMs: 5, ...extra }) }; };

test('warm() forks a hidden standby agent at launch: no token in argv or env', () => {
  const { forkFn, r } = make();
  assert.ok(r.warm().ok);
  const { opts, args } = forkFn.calls[0];
  assert.strictEqual(opts.windowsHide, true);
  assert.deepStrictEqual(args, []);
  assert.strictEqual(opts.env.SCOPEDESK_AGENT_TOKEN, undefined);
  assert.strictEqual(opts.env.ELECTRON_RUN_AS_NODE, '1');
  assert.strictEqual(r.status().phase, 'standby');
  r.shutdown();
});

test('init() sends the token over IPC to the already-running standby agent (no second fork)', () => {
  const { forkFn, r } = make(); const seen = [];
  r.warm();
  const r2 = r; // same runner
  assert.ok(r2.init({ taskId: 7, token: 'a.b.c' }).ok);
  assert.strictEqual(forkFn.calls.length, 1);
  assert.deepStrictEqual(forkFn.calls[0].child.sent[0], { type: 'init', token: 'a.b.c', viewOnly: false });
  assert.strictEqual(r.status().taskId, 7);
  assert.strictEqual(r.status().phase, 'starting');
  r.shutdown();
});

test('init() without a warm agent forks one first; agent messages map to UI states', () => {
  const { forkFn, r } = make({ onStatus: (s) => seen.push(s.uiState) }); const seen = [];
  r.init({ taskId: 7, token: 'a.b.c' });
  const { child, opts } = forkFn.calls[0];
  assert.strictEqual(opts.env.SCOPEDESK_AGENT_TOKEN, undefined);
  child.emit('message', { type: 'connected' });
  child.emit('message', { type: 'state', state: 'armed', policy: 'billing' });
  assert.strictEqual(r.status().policy, 'billing');
  assert.strictEqual(r.status().uiState, 'armed');
  r.shutdown();
});

test('input() reaches the agent only during a session and only as a short string', () => {
  const { forkFn, r } = make();
  r.warm();
  assert.strictEqual(r.input('{"t":"move","x":0.5,"y":0.5}'), false);   // standby: nothing to control yet
  r.init({ taskId: 1, token: 'a.b.c' });
  assert.strictEqual(r.input('{"t":"move","x":0.5,"y":0.5}'), true);
  assert.strictEqual(r.input('x'.repeat(601)), false);
  assert.strictEqual(r.input({ t: 'move' }), false);
  assert.deepStrictEqual(forkFn.calls[0].child.sent.at(-1), { type: 'input', data: '{"t":"move","x":0.5,"y":0.5}' });
  r.freeze();
  assert.deepStrictEqual(forkFn.calls[0].child.sent.at(-1), { type: 'freeze' });
  r.shutdown();
});

test('a violation message fires onViolation with kind, app and detail', () => {
  const got = []; const { forkFn, r } = make({ onViolation: (v) => got.push(v) });
  r.init({ taskId: 1, token: 'a.b.c' });
  forkFn.calls[0].child.emit('message', { type: 'violation', kind: 'path', processName: 'File Manager', detail: 'C:\\Secret' });
  assert.deepStrictEqual(got, [{ kind: 'path', processName: 'File Manager', detail: 'C:\\Secret' }]);
  assert.match(r.status().detail, /File Manager/);
  r.shutdown();
});

test('stop asks the agent to quit, marks it stopped, then a fresh standby agent comes up', async () => {
  const { forkFn, r } = make();
  r.init({ taskId: 1, token: 'a.b.c' });
  const child = forkFn.calls[0].child;
  r.stop();
  assert.deepStrictEqual(child.sent.at(-1), { type: 'stop' });
  assert.strictEqual(r.status().phase, 'stopped');
  await new Promise((res) => setTimeout(res, 30));
  assert.strictEqual(forkFn.calls.length, 2);       // re-warmed for the next ticket
  r.shutdown();
});

test('a crash is reported as an error with the last log line', () => {
  const { forkFn, r } = make();
  r.init({ taskId: 1, token: 'a.b.c' });
  const child = forkFn.calls[0].child;
  child.stderr.emit('data', 'Cannot load nut.js\n');
  child.emit('exit', 1);
  assert.strictEqual(r.status().phase, 'error');
  assert.match(r.status().detail, /nut\.js/);
  r.shutdown();
});

test('a second ticket replaces the old agent and ignores its late events', () => {
  const { forkFn, r } = make();
  r.init({ taskId: 1, token: 'a.b.c' }); r.init({ taskId: 2, token: 'd.e.f' });
  forkFn.calls[0].child.emit('message', { type: 'state', state: 'armed' });
  assert.strictEqual(r.status().taskId, 2);
  assert.strictEqual(r.status().phase, 'starting');
  r.shutdown();
});
