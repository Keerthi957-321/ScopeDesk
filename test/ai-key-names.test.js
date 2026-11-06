'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAssistant, findKeys } = require('../server/assistant');
const quiet = { warn() {}, error() {}, log() {} };
test('the AI key is found under near-miss names and explains when missing', () => {
  for (const env of [{ GEMINI_API_KEY: 'AIzaX' }, { 'GEMINI_API_KEY ': 'AIzaX' }, { gemini_api_key: ' "AIzaX" ' }, { GOOGLE_API_KEY: 'AIzaX' }, { OPENAI_API_KEY: 'AIzaX' }, { OPENAI_API_KEY: 'AQ.Ab12' }]) {
    const a = createAssistant({ env, log: quiet });
    assert.equal(a.configured, true, JSON.stringify(env)); assert.equal(a.provider, 'gemini', JSON.stringify(env));
  }
  assert.equal(createAssistant({ env: { OPENAI_API_KEY: 'sk-abc' }, log: quiet }).provider, 'openai');
  assert.equal(createAssistant({ env: { GEMINI_API_KEY: '   ' }, log: quiet }).configured, false);
  assert.match(findKeys({ GEMINI_API_KEY: '' }).note, /"GEMINI_API_KEY" \(empty\)/);
  assert.match(findKeys({}).note, /not set on this server/);
});

test('bad key characters are cleaned or reported; the reason for "could not reach" reaches the page', async () => {
  assert.equal(findKeys({ GEMINI_API_KEY: ' AIza Sy​Abc\n' }).geminiKey, 'AIzaSyAbc');
  assert.match(findKeys({ GEMINI_API_KEY: 'AIzaSy…' }).note, /not allowed/);
  const a = createAssistant({ env: { GEMINI_API_KEY: 'AIzaSy…' }, log: quiet, fetchImpl: async () => { throw new TypeError('Cannot convert argument to a ByteString because the character at index 13 has a value of 8230'); } });
  await assert.rejects(a.reply([{ role: 'user', content: 'hi' }]), (e) => e.code === 'AI_KEY_FORMAT');
  const { loadServer } = require('./helpers/server-harness');
  const h = loadServer({ env: { GEMINI_API_KEY: 'AIzaX' }, fetch: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); } });
  const v = await h.addUser('why_vendor', 'vendor');
  const r = await h.call('POST', '/api/chat', { user: v, body: { messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(r.status, 502); assert.match(r.body.error, /Reason: ENOTFOUND/); assert.doesNotMatch(r.body.error, /AIzaX/);
});
