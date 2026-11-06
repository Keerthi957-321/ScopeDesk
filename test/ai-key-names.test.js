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
