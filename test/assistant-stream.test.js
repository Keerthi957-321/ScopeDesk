'use strict';
// AI assistant speed + vendor access: streamed answers (SSE), no "thinking" on Gemini Flash, one retry on a dropped
// connection, vendor prompt + ticket context only for the user's own ticket.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createAssistant, VENDOR_PROMPT, SYSTEM_PROMPT } = require('../server/assistant');
const { loadServer } = require('./helpers/server-harness');
const quiet = { warn() {}, error() {}, log() {} };

// a fetch Response whose body arrives in the given raw pieces (split anywhere, even inside a line)
function sseResponse(pieces) {
  const enc = new TextEncoder(); let i = 0;
  return { ok: true, status: 200, headers: { get: () => 'text/event-stream' },
    body: { getReader: () => ({ read: async () => (i < pieces.length ? { value: enc.encode(pieces[i++]), done: false } : { done: true }), cancel() {} }) } };
}
const chunk = (t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`;

test('stream: pieces arrive in order even when split mid-line; [DONE] ends it; the request asks for a stream without thinking', async () => {
  const sent = [];
  const raw = chunk('Open ') + chunk('Tally, ') + chunk('then press F12.') + 'data: [DONE]\n\n';
  const pieces = [raw.slice(0, 7), raw.slice(7, 40), raw.slice(40, 41), raw.slice(41)];
  const a = createAssistant({ env: { GEMINI_API_KEY: 'AIzaT' }, log: quiet, fetchImpl: async (url, o) => { sent.push(JSON.parse(o.body)); return sseResponse(pieces); } });
  const got = [];
  const full = await a.stream([{ role: 'user', content: 'how?' }], { role: 'vendor' }, (t) => got.push(t));
  assert.deepEqual(got, ['Open ', 'Tally, ', 'then press F12.']);
  assert.equal(full, 'Open Tally, then press F12.');
  assert.equal(sent[0].stream, true); assert.equal(sent[0].reasoning_effort, 'none');
  assert.equal(sent[0].messages[0].content.startsWith(VENDOR_PROMPT), true, 'vendors get the vendor prompt');
});

test('speed fallbacks: a dropped connection is retried once; a model that refuses "no thinking" is asked again without it', async () => {
  let n = 0;
  const flaky = createAssistant({ env: { GEMINI_API_KEY: 'AIzaT' }, log: quiet, fetchImpl: async () => {
    n += 1; if (n === 1) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
  } });
  assert.equal(await flaky.reply([{ role: 'user', content: 'hi' }]), 'ok'); assert.equal(n, 2);

  const logs = [];
  const down = createAssistant({ env: { GEMINI_API_KEY: 'AIzaT' }, log: { ...quiet, error: (m) => logs.push(m) }, fetchImpl: async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); } });
  await assert.rejects(down.reply([{ role: 'user', content: 'hi' }]), (e) => e.code === 'AI_UNREACHABLE');
  assert.ok(logs.some((m) => /ENOTFOUND/.test(m)), 'the real network cause is in the server log');

  const bodies = [];
  const picky = createAssistant({ env: { GEMINI_API_KEY: 'AIzaT' }, log: quiet, fetchImpl: async (u, o) => {
    const b = JSON.parse(o.body); bodies.push(b);
    if (b.reasoning_effort) return { ok: false, status: 400, json: async () => ({ error: { message: 'Unknown field reasoning_effort' } }) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'fine' } }] }) };
  } });
  assert.equal(await picky.reply([{ role: 'user', content: 'hi' }]), 'fine');
  assert.equal(bodies.length, 2); assert.equal(bodies[1].reasoning_effort, undefined);
  const pro = []; const p2 = createAssistant({ env: { GEMINI_API_KEY: 'AIzaT', GEMINI_MODEL: 'gemini-2.5-pro' }, log: quiet, fetchImpl: async (u, o) => { pro.push(JSON.parse(o.body)); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'x' } }] }) }; } });
  await p2.reply([{ role: 'user', content: 'hi' }]);
  assert.equal(pro[0].reasoning_effort, undefined, 'only Flash gets the switch');
  assert.equal(SYSTEM_PROMPT.includes('CLIENT'), true);
});

// ---- the routes, with a fake Gemini that streams ----
const seen = [];
async function fakeGemini(url, opts) {
  const body = JSON.parse(opts.body); seen.push(body);
  if (body.stream) return sseResponse([chunk('Hello '), chunk('there.'), 'data: [DONE]\n\n']);
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Hello there.' } }] }) };
}
const h = loadServer({ env: { GEMINI_API_KEY: 'AIzaROUTE' }, fetch: fakeGemini });
const events = (text) => text.split('\n\n').filter(Boolean).map((b) => { const ev = /event: (\w+)/.exec(b)[1]; const d = JSON.parse(/data: (.*)/.exec(b)[1]); return { ev, d }; });

test('routes: vendors chat (status + stream), with context of their own ticket only', async () => {
  const client = await h.addUser('as_client', 'client', { daysOld: 2 });
  const vendor = await h.addUser('as_vendor', 'vendor');
  const other = await h.addUser('as_other_vendor', 'vendor');
  const st = await h.call('GET', '/api/chat/status', { user: vendor });
  assert.equal(st.body.chatbot, true); assert.equal(st.body.role, 'vendor'); assert.equal(st.body.chatbotConfigured, true);
  const t = (await h.call('POST', '/api/tasks', { user: client, body: { vendor_id: vendor.id, task: 'Fix the GST invoice export in Tally', duration_minutes: 30, allowed_apps: ['Tally'], alerts_enabled: true } })).body.task;
  await h.call('POST', `/api/tasks/${t.id}/messages`, { user: client, body: { body: 'It fails at step 3' } });

  const r = await h.call('POST', '/api/chat/stream', { user: vendor, body: { taskId: t.id, messages: [{ role: 'user', content: 'Draft a reply to my client' }] } });
  assert.equal(r.status, 200); assert.match(r.headers['Content-Type'], /text\/event-stream/);
  const ev = events(r.text);
  assert.deepEqual(ev.filter((e) => e.ev === 'delta').map((e) => e.d.t), ['Hello ', 'there.']);
  assert.equal(ev.at(-1).ev, 'done'); assert.equal(ev.at(-1).d.reply, 'Hello there.');
  const sys = seen.at(-1).messages[0].content;
  assert.match(sys, /helping a VENDOR/); assert.match(sys, /GST invoice export/); assert.match(sys, /Client: It fails at step 3/);
  assert.doesNotMatch(sys, new RegExp(t.token || 'no-token-in-response'), 'the session token never goes to the AI');

  // another vendor asking about this ticket gets no context
  await h.call('POST', '/api/chat/stream', { user: other, body: { taskId: t.id, messages: [{ role: 'user', content: 'Summarise' }] } });
  assert.doesNotMatch(seen.at(-1).messages[0].content, /GST invoice export/);
  // clients still go through their plan; the non-streamed route still works
  const plain = await h.call('POST', '/api/chat', { user: client, body: { messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(plain.body.reply, 'Hello there.'); assert.match(seen.at(-1).messages[0].content, /talking to the client/);
  const bad = await h.call('POST', '/api/chat/stream', { user: vendor, body: { messages: [] } });
  assert.equal(bad.status, 400, 'checks run before the stream opens');
});
