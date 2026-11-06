'use strict';
// Shared Workspace (replaces Boards): the client groups tickets; the vendor sees only their own tickets inside those groups; live
// notifications; deleting a group keeps the tickets; the old Boards API and table are gone.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadServer } = require('./helpers/server-harness');
const h = loadServer();

test('workspace: groups, moving tickets, what each side sees, live updates', async () => {
  const client = await h.addUser('ws_client', 'client', { daysOld: 2 });
  const v1 = await h.addUser('ws_v1', 'vendor'), v2 = await h.addUser('ws_v2', 'vendor');
  const mk = async (v, task) => (await h.call('POST', '/api/tasks', { user: client, body: { vendor_id: v.id, task, duration_minutes: 30, allowed_apps: ['Excel'], alerts_enabled: true } })).body.task;
  const t1 = await mk(v1, 'GST return'), t2 = await mk(v2, 'Printer setup'), t3 = await mk(v1, 'Payroll check');
  const g = await h.call('POST', '/api/projects', { user: client, body: { name: 'Accounts', color: 'teal' } });
  assert.equal(g.status, 201); assert.equal(g.body.project.color, 'teal');
  assert.equal((await h.call('POST', '/api/projects', { user: v1, body: { name: 'Mine' } })).status, 403, 'vendors cannot create groups');
  assert.equal((await h.call('POST', '/api/projects', { user: client, body: { name: 'x' } })).status, 400);

  await h.connect(h.tokenFor(client));
  const before = h.io.emits.length;
  assert.equal((await h.call('PUT', `/api/tasks/${t1.id}/project`, { user: client, body: { projectId: g.body.project.id } })).status, 200);
  await h.call('PUT', `/api/tasks/${t2.id}/project`, { user: client, body: { projectId: g.body.project.id } });
  assert.ok(h.io.emits.slice(before).some((e) => e.ev === 'workspace-changed'), 'open screens are told');
  assert.equal((await h.call('PUT', `/api/tasks/${t1.id}/project`, { user: v1, body: { projectId: null } })).status, 403);

  const cw = (await h.call('GET', '/api/workspace', { user: client })).body;
  assert.equal(cw.canEdit, true);
  assert.deepEqual(cw.projects[0].tasks.map((t) => t.id).sort(), [t1.id, t2.id].sort());
  assert.deepEqual(cw.ungrouped.map((t) => t.id), [t3.id]);
  assert.equal(cw.projects[0].tasks.find((t) => t.id === t1.id).owner, 'ws_v1', 'client sees who owns each ticket');
  assert.equal(cw.projects[0].tasks[0].stage, 'waiting');

  const vw = (await h.call('GET', '/api/workspace', { user: v1 })).body;
  assert.equal(vw.canEdit, false);
  assert.equal(vw.projects.length, 1); assert.equal(vw.projects[0].name, 'Accounts');
  assert.deepEqual(vw.projects[0].tasks.map((t) => t.id), [t1.id], "a vendor never sees another vendor's ticket");
  assert.deepEqual(vw.ungrouped.map((t) => t.id), [t3.id]);
  const v2w = (await h.call('GET', '/api/workspace', { user: v2 })).body;
  assert.deepEqual(v2w.projects[0].tasks.map((t) => t.id), [t2.id]);

  // another client cannot touch this group
  const other = await h.addUser('ws_other', 'client', { daysOld: 2 });
  assert.equal((await h.call('PATCH', `/api/projects/${g.body.project.id}`, { user: other, body: { name: 'Hacked' } })).status, 404);
  assert.equal((await h.call('PUT', `/api/tasks/${t1.id}/project`, { user: other, body: { projectId: null } })).status, 404);

  assert.equal((await h.call('PATCH', `/api/projects/${g.body.project.id}`, { user: client, body: { name: 'Accounts 2026', color: 'rose' } })).body.project.name, 'Accounts 2026');
  assert.equal((await h.call('DELETE', `/api/projects/${g.body.project.id}`, { user: client })).status, 200);
  const after = (await h.call('GET', '/api/workspace', { user: client })).body;
  assert.equal(after.projects.length, 0); assert.equal(after.ungrouped.length, 3, 'tickets are kept');
});

test('boards are gone: no routes, no table', async () => {
  const u = await h.addUser('ws_nob', 'client', { daysOld: 2 });
  let err = null; try { await h.call('GET', '/api/board', { user: u }); } catch (e) { err = e; }
  assert.match(String(err && err.message), /no route/);
  assert.equal(await h.db.get("SELECT name FROM sqlite_master WHERE name = 'board_items'"), undefined);
});
