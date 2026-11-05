'use strict';
// "Terminate Session Now": out-of-bounds alert reaches the Client, and the kill switch destroys the session's sockets,
// revokes the token, and refuses every way back in (vendor token, host-agent reconnect, agent scope).
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadServer } = require('./helpers/server-harness');

const h = loadServer({ env: {} });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const emitsTo = (socket, ev) => h.io.emits.filter((e) => e.to === socket.id && e.ev === ev);

async function liveSession(suffix) {
  const client = await h.addUser(`client_${suffix}`, 'client');
  const vendor = await h.addUser(`vendor_${suffix}`, 'vendor');
  const created = await h.call('POST', '/api/tasks', { user: client, body: { vendor_id: vendor.id, task: 'Fix the billing export', duration_minutes: 30, allowed_apps: ['Notepad'], alerts_enabled: true } });
  const task = created.body.task;
  const clientSock = await h.connect(h.tokenFor(client));
  const vendorSock = await h.connect(h.tokenFor(vendor));
  const joined = await h.call('POST', '/api/sessions/connect', { user: vendor, body: { token: task.token } });
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  const agentToken = h.agentTokenFor(client, task.id);
  const agentSock = await h.connect(agentToken);
  const hello = await agentSock.call('agent-hello', { protocol: 99 });
  assert.equal(hello.ok, true, JSON.stringify(hello));
  return { client, vendor, task, clientSock, vendorSock, agentSock, agentToken };
}

test('kill switch: socket terminate revokes the token, drops the agent socket, force-terminates the vendor', async () => {
  const s = await liveSession('a');
  const res = await s.clientSock.call('terminate-session', { taskId: s.task.id });
  assert.equal(res.ok, true);
  assert.equal(res.tokenRevoked, true);
  assert.equal(res.alreadyEnded, false);
  assert.equal(res.token, undefined, 'the ack never carries the token');

  const row = await h.db.get('SELECT status, token_revoked FROM tasks WHERE id = ?', [s.task.id]);
  assert.equal(row.status, 'terminated');
  assert.equal(row.token_revoked, 1);
  assert.equal((await h.db.get("SELECT status FROM remote_sessions WHERE task_id = ?", [s.task.id])).status, 'terminated');

  assert.equal(emitsTo(s.vendorSock, 'force-terminate').length, 1);
  assert.equal(emitsTo(s.clientSock, 'session-ended').length, 1);
  assert.ok(h.io.emits.some((e) => e.to === s.agentSock.id && e.ev === 'control-halt' && e.p.reason === 'ended'), 'agent told to shut down');
  await wait(400);
  assert.equal(s.agentSock.disconnected, true, 'host agent WebSocket destroyed');

  // every way back in is closed
  const again = await h.call('POST', '/api/sessions/connect', { user: s.vendor, body: { token: s.task.token } });
  assert.equal(again.status, 403);
  await assert.rejects(h.connect(s.agentToken), /Authentication required/);
  assert.equal((await h.call('GET', '/api/agent/scope', { token: s.agentToken })).status, 409);
  assert.equal((await h.call('POST', `/api/tasks/${s.task.id}/agent-token`, { user: s.client })).status, 400);
});

test('kill switch: pressing it again (or over HTTPS) succeeds as "already ended", never as an error', async () => {
  const s = await liveSession('b');
  assert.equal((await s.clientSock.call('terminate-session', { taskId: s.task.id })).ok, true);
  const second = await s.clientSock.call('terminate-session', { taskId: s.task.id });
  assert.equal(second.ok, true); assert.equal(second.alreadyEnded, true);
  const rest = await h.call('POST', `/api/tasks/${s.task.id}/terminate`, { user: s.client });
  assert.equal(rest.status, 200); assert.equal(rest.body.alreadyEnded, true);
});

test('kill switch over HTTPS (socket down) does the full teardown; other clients get 404', async () => {
  const s = await liveSession('c');
  const stranger = await h.addUser('client_stranger', 'client');
  assert.equal((await h.call('POST', `/api/tasks/${s.task.id}/terminate`, { user: stranger })).status, 404);
  assert.equal((await h.call('POST', `/api/tasks/${s.task.id}/terminate`, { user: s.vendor })).status, 403);
  const r = await h.call('POST', `/api/tasks/${s.task.id}/terminate`, { user: s.client });
  assert.equal(r.status, 200); assert.equal(r.body.tokenRevoked, true); assert.equal(r.body.alreadyEnded, false);
  assert.equal(emitsTo(s.vendorSock, 'force-terminate').length, 1);
  await wait(400);
  assert.equal(s.agentSock.disconnected, true);
});

test('out-of-bounds app: the Client gets the alert at once; Terminate Session Now afterwards is clean', async () => {
  const s = await liveSession('d');
  const report = await s.agentSock.call('host-violation', { taskId: s.task.id, processName: 'cmd.exe', kind: 'app' });
  assert.equal(report.ok, true);
  const alerts = emitsTo(s.clientSock, 'termination-alert').concat(emitsTo(s.clientSock, 'violation-alert'));
  assert.equal(alerts.length, 1, 'client alerted');
  assert.equal(alerts[0].p.taskId, s.task.id);
  assert.equal(alerts[0].p.processName, 'cmd.exe');
  assert.equal(emitsTo(s.vendorSock, 'violation-alert').length, 0, 'the vendor never sees the alert');
  // default policy already ended it; the Client's button must still succeed and leave the token revoked
  const res = await s.clientSock.call('terminate-session', { taskId: s.task.id });
  assert.equal(res.ok, true);
  assert.equal((await h.db.get('SELECT token_revoked FROM tasks WHERE id = ?', [s.task.id])).token_revoked, 1);
  await assert.rejects(h.connect(s.agentToken), /Authentication required/);
});

test('stream permission is revoked with the room: a terminated client socket cannot push screen frames', async () => {
  const s = await liveSession('e');
  const j = await s.clientSock.call('webrtc-join', { taskId: s.task.id, role: 'client' });
  assert.equal(j.ok, true);
  assert.equal(s.clientSock.data.rtc.has(s.task.id), true);
  await s.clientSock.call('terminate-session', { taskId: s.task.id });
  assert.equal(s.clientSock.data.rtc.has(s.task.id), false);
});

test('a completed session also closes the host agent and revokes the token', async () => {
  const s = await liveSession('f');
  const sess = await h.db.get('SELECT id FROM remote_sessions WHERE task_id = ?', [s.task.id]);
  const r = await h.call('POST', `/api/sessions/${sess.id}/complete`, { user: s.vendor });
  assert.equal(r.status, 200);
  assert.equal((await h.db.get('SELECT token_revoked FROM tasks WHERE id = ?', [s.task.id])).token_revoked, 1);
  await wait(400);
  assert.equal(s.agentSock.disconnected, true);
});

test('only the owning client can terminate over the socket', async () => {
  const s = await liveSession('g');
  const res = await s.vendorSock.call('terminate-session', { taskId: s.task.id });
  assert.equal(res.ok, false);
  assert.equal((await h.db.get('SELECT status FROM tasks WHERE id = ?', [s.task.id])).status, 'active');
});
