'use strict';
// "Request Additional Access": the vendor asks, nothing changes until the client approves; approval widens the ticket and is pushed
// to the client's PC live; deny / cancel / ticket end; validation and anti-spam; nobody else can decide.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadServer } = require('./helpers/server-harness');
const h = loadServer();

async function live(tag) {
  const client = await h.addUser(`ar_c_${tag}`, 'client', { daysOld: 2 });
  const vendor = await h.addUser(`ar_v_${tag}`, 'vendor');
  const task = (await h.call('POST', '/api/tasks', { user: client, body: { vendor_id: vendor.id, task: 'Fix the invoice export', duration_minutes: 30, allowed_apps: ['Notepad'], alerts_enabled: true } })).body.task;
  await h.call('POST', '/api/sessions/connect', { user: vendor, body: { token: task.token } });
  const agentSock = await h.connect(h.agentTokenFor(client, task.id));
  assert.equal((await agentSock.call('agent-hello', { protocol: 99 })).ok, true);
  const clientSock = await h.connect(h.tokenFor(client));
  return { client, vendor, task, agentSock, clientSock };
}
const ask = (s, body) => h.call('POST', `/api/tasks/${s.task.id}/access-requests`, { user: s.vendor, body });
const toAgent = (s, ev) => h.io.emits.filter((e) => e.to === s.agentSock.id && e.ev === ev);

test('access: vendor asks -> client sees it -> approve widens the ticket and updates the client PC live', async () => {
  const s = await live('a');
  const r = await ask(s, { apps: ['Excel', 'Notepad'], paths: ['C:\\Billing\\2026'], reason: 'The export opens in Excel' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(r.body.request.apps, ['Excel'], 'already-allowed Notepad is dropped');
  assert.ok(h.io.emits.some((e) => e.ev === 'access-request' && e.p.id === r.body.request.id && e.p.vendorName), 'the client is told');
  // nothing changed yet
  let t = await h.db.get('SELECT allowed_apps FROM tasks WHERE id = ?', [s.task.id]);
  assert.doesNotMatch(t.allowed_apps, /Excel/);
  assert.equal(toAgent(s, 'scope-updated').length, 0);
  // only the ticket's client can decide; the vendor cannot approve their own request
  assert.equal((await h.call('POST', `/api/access-requests/${r.body.request.id}/approve`, { user: s.vendor })).status, 403);
  const other = await h.addUser('ar_other_client', 'client', { daysOld: 2 });
  assert.equal((await h.call('POST', `/api/access-requests/${r.body.request.id}/approve`, { user: other })).status, 404);
  // a second request while one waits is refused
  assert.equal((await ask(s, { apps: ['Word'], reason: 'also Word' })).status, 409);

  const ok = await h.call('POST', `/api/access-requests/${r.body.request.id}/approve`, { user: s.client, body: { apps: ['Excel'], paths: [] } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.request.grantedApps, ['Excel']); assert.deepEqual(ok.body.request.grantedPaths, [], 'partial approval: the folder was unticked');
  t = await h.db.get('SELECT allowed_apps, allowed_paths FROM tasks WHERE id = ?', [s.task.id]);
  assert.deepEqual(JSON.parse(t.allowed_apps), ['Notepad', 'Excel']);
  const pushed = toAgent(s, 'scope-updated');
  assert.equal(pushed.length, 1); assert.deepEqual(pushed[0].p.allowedApps, ['Notepad', 'Excel']);
  assert.equal(ok.body.appliedLive, true);
  assert.equal((await h.call('POST', `/api/access-requests/${r.body.request.id}/approve`, { user: s.client })).status, 409, 'answered once only');

  // a folder: also allows the file manager
  const r2 = await ask(s, { paths: ['C:\\Billing\\2026'], reason: 'The invoices are saved there' });
  assert.equal(r2.status, 201);
  const ok2 = await h.call('POST', `/api/access-requests/${r2.body.request.id}/approve`, { user: s.client });
  assert.deepEqual(ok2.body.allowedPaths, ['C:\\Billing\\2026']); assert.ok(ok2.body.allowedApps.includes('File Manager'));
  const list = await h.call('GET', `/api/tasks/${s.task.id}/access-requests`, { user: s.vendor });
  assert.equal(list.body.requests.length, 2);
});

test('access: deny, cancel, validation, and the ticket ending expires a waiting request', async () => {
  const s = await live('b');
  assert.equal((await ask(s, { apps: ['PowerShell'], reason: 'need a shell' })).status, 400, 'shells are never allowed');
  assert.equal((await ask(s, { paths: ['C:\\'], reason: 'whole drive' })).status, 400, 'no whole drives');
  assert.equal((await ask(s, { paths: ['C:\\Billing\\..\\Windows'], reason: 'sneaky' })).status, 400);
  assert.equal((await ask(s, { apps: ['Excel'] })).status, 400, 'a reason is required');
  assert.equal((await ask(s, { apps: [], paths: [], reason: 'nothing' })).status, 400);

  const r = await ask(s, { apps: ['Excel'], reason: 'Excel please' });
  const no = await h.call('POST', `/api/access-requests/${r.body.request.id}/deny`, { user: s.client });
  assert.equal(no.body.request.status, 'denied');
  assert.doesNotMatch((await h.db.get('SELECT allowed_apps FROM tasks WHERE id = ?', [s.task.id])).allowed_apps, /Excel/);

  const r2 = await ask(s, { apps: ['Excel'], reason: 'asking again' });
  assert.equal((await h.call('POST', `/api/access-requests/${r2.body.request.id}/cancel`, { user: s.vendor })).body.request.status, 'cancelled');

  const r3 = await ask(s, { apps: ['Word'], reason: 'Word for the letter' });
  assert.equal((await s.clientSock.call('terminate-session', { taskId: s.task.id })).ok, true);
  await new Promise((r) => setTimeout(r, 20));
  const row = await h.db.get('SELECT status FROM access_requests WHERE id = ?', [r3.body.request.id]);
  assert.equal(row.status, 'expired');
  assert.equal((await h.call('POST', `/api/access-requests/${r3.body.request.id}/approve`, { user: s.client })).status, 409);
  assert.equal((await ask(s, { apps: ['Excel'], reason: 'after the end' })).status, 409, 'no requests on an ended ticket');
});

test('control check: the client PC\'s reason reaches the vendor (cleaned, no extra fields)', async () => {
  const s = await live('diag');
  const before = h.io.emits.length;
  await s.agentSock.fire('agent-diag', { taskId: s.task.id, detail: 'waiting: "Google Chrome" is in front\u0000', inputReady: false, inputReason: 'macOS has not allowed ScopeDesk to control this Mac.', os: 'darwin', share: 'screen', apps: ['Notepad'], secret: 'x' });
  const e = h.io.emits.slice(before).find((x) => x.ev === 'agent-diag');
  assert.ok(e, 'relayed to the ticket');
  assert.equal(e.p.os, 'darwin'); assert.equal(e.p.inputReady, false); assert.match(e.p.inputReason, /macOS/);
  assert.equal(e.p.detail.includes('\u0000'), false); assert.equal(e.p.secret, undefined);
  const before2 = h.io.emits.length;
  await s.agentSock.fire('agent-diag', { taskId: s.task.id + 999, detail: 'other ticket' });
  assert.equal(h.io.emits.slice(before2).filter((x) => x.ev === 'agent-diag').length, 0, 'an agent only reports for its own ticket');
});
