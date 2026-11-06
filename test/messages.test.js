'use strict';
// Client <-> vendor messaging and voice calls: only the two parties of a ticket, only while allowed, kill switch hangs up.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadServer } = require('./helpers/server-harness');

const h = loadServer({ env: {} });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const got = (sock, ev) => h.io.emits.filter((e) => e.to === sock.id && e.ev === ev);

async function ticket(suffix, { status } = {}) {
  const client = await h.addUser(`mc_${suffix}`, 'client');
  const vendor = await h.addUser(`mv_${suffix}`, 'vendor');
  const r = await h.call('POST', '/api/tasks', { user: client, body: { vendor_id: vendor.id, task: 'Fix the billing export', duration_minutes: 30, allowed_apps: ['Notepad'], alerts_enabled: true } });
  const task = r.body.task;
  if (status) await h.db.run('UPDATE tasks SET status = ? WHERE id = ?', [status, task.id]);
  const cs = await h.connect(h.tokenFor(client));
  const vs = await h.connect(h.tokenFor(vendor));
  return { client, vendor, task, cs, vs };
}

test('messages: the two parties talk in real time; nobody else can read or write', async () => {
  const t = await ticket('a');
  const sent = await h.call('POST', `/api/tasks/${t.task.id}/messages`, { user: t.client, body: { body: '  Hi, the export fails at step 3  ' } });
  assert.equal(sent.status, 201);
  assert.equal(sent.body.message.body, 'Hi, the export fails at step 3');
  assert.equal(got(t.vs, 'chat-message').length, 1, 'vendor gets it live');
  assert.equal(got(t.cs, 'chat-message').length, 1, 'client\'s other tabs too');
  const reply = await h.call('POST', `/api/tasks/${t.task.id}/messages`, { user: t.vendor, body: { body: 'On it. Please open Tally.' } });
  assert.equal(reply.status, 201);

  const list = await h.call('GET', '/api/conversations', { user: t.client });
  const conv = list.body.conversations.find((c) => c.taskId === t.task.id);
  assert.equal(conv.unread, 1); assert.equal(conv.lastBody, 'On it. Please open Tally.'); assert.match(conv.otherName, /mv_a/);
  assert.equal(list.body.unread, 1);
  const thread = await h.call('GET', `/api/tasks/${t.task.id}/messages`, { user: t.client });
  assert.deepEqual(thread.body.messages.map((m) => m.body), ['Hi, the export fails at step 3', 'On it. Please open Tally.']);
  assert.equal(thread.body.canSend, true); assert.equal(thread.body.canCall, true);
  await h.call('POST', `/api/tasks/${t.task.id}/messages/read`, { user: t.client });
  assert.equal((await h.call('GET', '/api/conversations', { user: t.client })).body.unread, 0);
  assert.equal(got(t.vs, 'chat-read').length, 1, 'vendor sees it was read');

  const strangerVendor = await h.addUser('mv_stranger', 'vendor');
  const strangerClient = await h.addUser('mc_stranger', 'client');
  for (const u of [strangerVendor, strangerClient]) {
    assert.equal((await h.call('GET', `/api/tasks/${t.task.id}/messages`, { user: u })).status, 404);
    assert.equal((await h.call('POST', `/api/tasks/${t.task.id}/messages`, { user: u, body: { body: 'hi' } })).status, 404);
  }
  assert.equal((await h.call('POST', `/api/tasks/${t.task.id}/messages`, { user: t.client, body: { body: '   ' } })).status, 400);
});

test('messages: only during the ticket window; an "Anytime contact" vendor can text and call any time; blocking wins', async () => {
  const t = await ticket('b', { status: 'completed' });
  const closed = await h.call('POST', `/api/tasks/${t.task.id}/messages`, { user: t.vendor, body: { body: 'Did the fix hold?' } });
  assert.equal(closed.status, 403); assert.match(closed.body.error, /client can approve you for Always-On Access/);
  assert.equal((await t.vs.call('call-invite', { taskId: t.task.id })).ok, false);
  const view = await h.call('GET', `/api/tasks/${t.task.id}/messages`, { user: t.client });
  assert.equal(view.status, 200, 'history stays readable');
  assert.equal(view.body.canSend, false); assert.match(view.body.why, /Always-On Access/);

  // only the client can approve, only a vendor they work with
  assert.equal((await h.call('PUT', `/api/vendors/${t.vendor.id}/contact`, { user: t.vendor })).status, 403);
  const stranger = await h.addUser('mv_unrelated', 'vendor');
  assert.equal((await h.call('PUT', `/api/vendors/${stranger.id}/contact`, { user: t.client })).status, 404);
  assert.equal((await h.call('PUT', `/api/vendors/${t.vendor.id}/contact`, { user: t.client })).status, 200);
  assert.equal(got(t.vs, 'contact-changed').at(-1).p.trusted, true, 'the vendor is told at once');

  assert.equal((await h.call('POST', `/api/tasks/${t.task.id}/messages`, { user: t.vendor, body: { body: 'Did the fix hold?' } })).status, 201);
  const conv = (await h.call('GET', '/api/conversations', { user: t.vendor })).body.conversations.find((c) => c.taskId === t.task.id);
  assert.equal(conv.trusted, true); assert.equal(conv.canCall, true);
  const inv = await t.vs.call('call-invite', { taskId: t.task.id });
  assert.equal(inv.ok, true, 'approved contact can call after the ticket ended');
  await t.cs.call('call-accept', { callId: inv.callId });

  // taking it back closes the conversation again and hangs up a call on the ended ticket
  assert.equal((await h.call('DELETE', `/api/vendors/${t.vendor.id}/contact`, { user: t.client })).status, 200);
  assert.equal(got(t.vs, 'call-ended').at(-1).p.reason, 'contact-removed');
  assert.equal((await h.call('POST', `/api/tasks/${t.task.id}/messages`, { user: t.vendor, body: { body: 'hello?' } })).status, 403);

  // blocking always wins over approval
  const b = await ticket('c');
  await h.call('PUT', `/api/vendors/${b.vendor.id}/contact`, { user: b.client });
  await h.call('POST', `/api/vendors/${b.vendor.id}/terminate`, { user: b.client, body: { reason: 'done' } });
  assert.equal((await h.call('POST', `/api/tasks/${b.task.id}/messages`, { user: b.vendor, body: { body: 'hello?' } })).status, 403);
  assert.equal((await b.vs.call('call-invite', { taskId: b.task.id })).ok, false);
});

test('calls: ring, accept, relay only between the two sockets, hang up, recorded in the chat', async () => {
  const t = await ticket('d');
  const inv = await t.vs.call('call-invite', { taskId: t.task.id });
  assert.equal(inv.ok, true, JSON.stringify(inv));
  const incoming = got(t.cs, 'call-incoming');
  assert.equal(incoming.length, 1); assert.equal(incoming[0].p.callId, inv.callId); assert.match(incoming[0].p.fromName, /mv_d/);
  const cs2 = await h.connect(h.tokenFor(t.client));                    // a second client tab
  assert.equal((await t.vs.call('call-invite', { taskId: t.task.id })).ok, false, 'one call at a time');

  assert.equal((await t.cs.call('call-accept', { callId: inv.callId })).ok, true);
  assert.equal(got(t.vs, 'call-accepted').length, 1);
  assert.equal((await cs2.call('call-accept', { callId: inv.callId })).ok, false, 'already answered');

  t.vs.fire('call-signal', { callId: inv.callId, type: 'offer', sdp: 'v=0 offer' });
  t.cs.fire('call-signal', { callId: inv.callId, type: 'answer', sdp: 'v=0 answer' });
  cs2.fire('call-signal', { callId: inv.callId, type: 'candidate', candidate: { c: 'x' } });   // not part of the call: dropped
  t.vs.fire('call-signal', { callId: inv.callId, type: 'shell', sdp: 'rm -rf' });            // unknown type: dropped
  assert.deepEqual(got(t.cs, 'call-signal').map((e) => e.p.type), ['offer']);
  assert.deepEqual(got(t.vs, 'call-signal').map((e) => e.p.type), ['answer']);
  assert.equal(got(cs2, 'call-signal').length, 0);

  assert.equal((await t.cs.call('call-end', { callId: inv.callId })).ok, true);
  assert.equal(got(t.vs, 'call-ended').at(-1).p.reason, 'hangup');
  await wait(20);
  const thread = await h.call('GET', `/api/tasks/${t.task.id}/messages`, { user: t.client });
  assert.match(thread.body.messages.at(-1).body, /^Voice call · \d+:\d\d$/);
  assert.equal(thread.body.messages.at(-1).kind, 'call');
});

test('calls: declined, callee offline (missed), caller disconnects', async () => {
  const t = await ticket('e');
  const inv = await t.cs.call('call-invite', { taskId: t.task.id });
  assert.equal((await t.vs.call('call-decline', { callId: inv.callId })).ok, true);
  assert.equal(got(t.cs, 'call-ended').at(-1).p.reason, 'declined');

  const off = await ticket('f');
  off.vs.fire('disconnect');                                         // vendor closes ScopeDesk
  const miss = await off.cs.call('call-invite', { taskId: off.task.id });
  assert.equal(miss.ok, false); assert.match(miss.error, /not online/);
  await wait(20);
  assert.equal((await h.call('GET', `/api/tasks/${off.task.id}/messages`, { user: off.client })).body.messages.at(-1).body, 'Missed voice call');

  const g = await ticket('g');
  const c = await g.cs.call('call-invite', { taskId: g.task.id });
  await g.vs.call('call-accept', { callId: c.callId });
  g.cs.fire('disconnect');
  assert.equal(got(g.vs, 'call-ended').at(-1).p.reason, 'disconnected');
});

test('kill switch: terminating the ticket hangs up its call at once; call config only for parties', async () => {
  const t = await ticket('h');
  assert.equal((await h.call('GET', `/api/calls/config?taskId=${t.task.id}`, { user: t.vendor })).status, 200);
  const other = await h.addUser('mc_other', 'client');
  assert.equal((await h.call('GET', `/api/calls/config?taskId=${t.task.id}`, { user: other })).status, 403);
  const inv = await t.vs.call('call-invite', { taskId: t.task.id });
  await t.cs.call('call-accept', { callId: inv.callId });
  const res = await t.cs.call('terminate-session', { taskId: t.task.id });
  assert.equal(res.ok, true);
  assert.equal(got(t.vs, 'call-ended').at(-1).p.reason, 'session-ended');
  assert.equal(got(t.cs, 'call-ended').at(-1).p.reason, 'session-ended');
  assert.equal((await t.vs.call('call-invite', { taskId: t.task.id })).ok, false, 'no new call on a terminated ticket');
});

test('messages: a ticket whose time window has run out is locked even before its status changes; Always-On Access still works', async () => {
  const t = await ticket('w', { status: 'active' });
  const open = await h.call('GET', `/api/tasks/${t.task.id}/messages`, { user: t.vendor });
  assert.equal(open.body.canSend, true); assert.ok(open.body.windowEnd, 'the page gets the end time so it can lock itself');
  await h.db.run("UPDATE tasks SET window_end = datetime('now', '-1 minute') WHERE id = ?", [t.task.id]);
  const late = await h.call('POST', `/api/tasks/${t.task.id}/messages`, { user: t.vendor, body: { body: 'still there?' } });
  assert.equal(late.status, 403); assert.match(late.body.error, /only during an active task/);
  assert.equal((await t.cs.call('call-invite', { taskId: t.task.id })).ok, false);
  const conv = (await h.call('GET', '/api/conversations', { user: t.client })).body.conversations.find((c) => c.taskId === t.task.id);
  assert.equal(conv.canSend, false); assert.equal(conv.open, false);
  assert.equal((await h.call('PUT', `/api/vendors/${t.vendor.id}/contact`, { user: t.client })).status, 200);
  assert.equal((await h.call('POST', `/api/tasks/${t.task.id}/messages`, { user: t.vendor, body: { body: 'still there?' } })).status, 201);
});
