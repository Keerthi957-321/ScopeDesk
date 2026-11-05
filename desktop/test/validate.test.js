const test = require('node:test');
const assert = require('node:assert');
const { validateAgentConfig, isTrustedSender } = require('../validate');
const jwt = 'aaa.bbb.ccc';

test('accepts a task id and a JWT-shaped token only', () => {
  const r = validateAgentConfig({ taskId: '12', token: jwt });
  assert.deepStrictEqual(r, { ok: true, value: { taskId: 12, token: jwt, viewOnly: false, manual: false } });
});
test('rejects bad ids, tokens and shapes', () => {
  for (const bad of [null, 'x', {}, { taskId: 0, token: jwt }, { taskId: 1.5, token: jwt }, { taskId: 1, token: 'nope' }, { taskId: 1, token: jwt + ' && calc' }, { taskId: 1, token: 'a.b.c'.repeat(2000) }]) {
    assert.strictEqual(validateAgentConfig(bad).ok, false);
  }
});
test('extra fields (urls, commands) are dropped', () => {
  const r = validateAgentConfig({ taskId: 3, token: jwt, serverUrl: 'http://evil', cmd: 'calc' });
  assert.deepStrictEqual(Object.keys(r.value).sort(), ['manual', 'taskId', 'token', 'viewOnly']);
});
test('only the ScopeDesk origin is trusted', () => {
  assert.ok(isTrustedSender('http://localhost:3000/index.html', 'http://localhost:3000'));
  assert.ok(!isTrustedSender('http://localhost:5500/', 'http://localhost:3000'));
  assert.ok(!isTrustedSender('https://evil.example/', 'http://localhost:3000'));
  assert.ok(!isTrustedSender('', 'http://localhost:3000'));
});

test('validateAgentConfig keeps the manual flag (the Client clicked Start), so main.js does not ignore the start', () => {
  const { validateAgentConfig } = require('../validate');
  const token = 'aaa.bbb.ccc';
  assert.equal(validateAgentConfig({ taskId: 3, token, manual: true }).value.manual, true);
  assert.equal(validateAgentConfig({ taskId: 3, token }).value.manual, false);
  assert.equal(validateAgentConfig({ taskId: 3, token, manual: 'yes' }).value.manual, false);   // only a real boolean true counts
});
