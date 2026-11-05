'use strict';
// Boards: each user's private kanban. Owner-only reads and writes; validated columns, priorities and sizes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadServer } = require('./helpers/server-harness');

const h = loadServer({ env: {} });

test('board: create, move between columns, edit, delete - owner only', async () => {
  const a = await h.addUser('board_a', 'client');
  const b = await h.addUser('board_b', 'vendor');
  assert.deepEqual((await h.call('GET', '/api/board', { user: a })).body.items, []);

  const c1 = await h.call('POST', '/api/board', { user: a, body: { title: '  Call vendor about invoices  ', priority: 'high' } });
  assert.equal(c1.status, 201);
  assert.equal(c1.body.item.title, 'Call vendor about invoices');
  assert.equal(c1.body.item.status, 'todo');
  assert.equal(c1.body.item.priority, 'high');
  const c2 = await h.call('POST', '/api/board', { user: a, body: { title: 'Second', status: 'todo' } });
  assert.ok(c2.body.item.position < c1.body.item.position, 'new cards go on top');

  const moved = await h.call('PATCH', `/api/board/${c1.body.item.id}`, { user: a, body: { status: 'doing', position: 5 } });
  assert.equal(moved.body.item.status, 'doing');
  assert.equal(moved.body.item.position, 5);
  const done = await h.call('PATCH', `/api/board/${c1.body.item.id}`, { user: a, body: { status: 'done', title: 'Called vendor' } });
  assert.equal(done.body.item.status, 'done'); assert.equal(done.body.item.title, 'Called vendor');

  // another user can neither see nor touch these cards
  assert.deepEqual((await h.call('GET', '/api/board', { user: b })).body.items, []);
  assert.equal((await h.call('PATCH', `/api/board/${c1.body.item.id}`, { user: b, body: { status: 'todo' } })).status, 404);
  assert.equal((await h.call('DELETE', `/api/board/${c1.body.item.id}`, { user: b })).status, 404);

  assert.equal((await h.call('DELETE', `/api/board/${c2.body.item.id}`, { user: a })).status, 200);
  assert.equal((await h.call('GET', '/api/board', { user: a })).body.items.length, 1);
});

test('board: bad input is refused', async () => {
  const a = await h.addUser('board_c', 'client');
  assert.equal((await h.call('POST', '/api/board', { user: a, body: { title: '   ' } })).status, 400);
  const c = await h.call('POST', '/api/board', { user: a, body: { title: 'x'.repeat(500), status: 'nonsense', priority: 'urgent!!' } });
  assert.equal(c.body.item.title.length, 140);
  assert.equal(c.body.item.status, 'todo'); assert.equal(c.body.item.priority, 'normal');
  assert.equal((await h.call('PATCH', `/api/board/${c.body.item.id}`, { user: a, body: { status: 'archived' } })).status, 400);
  assert.equal((await h.call('PATCH', `/api/board/${c.body.item.id}`, { user: a, body: { position: 'abc' } })).status, 400);
  assert.equal((await h.call('PATCH', `/api/board/${c.body.item.id}`, { user: a, body: { title: '' } })).status, 400);
  assert.equal((await h.call('GET', '/api/board', {})).status, 401);
});

test('board: a card can link only to the user\'s own ticket', async () => {
  const client = await h.addUser('board_owner', 'client');
  const vendor = await h.addUser('board_vendor', 'vendor');
  const other = await h.addUser('board_other', 'client');
  const t = await h.call('POST', '/api/tasks', { user: client, body: { vendor_id: vendor.id, task: 'Fix the billing export', duration_minutes: 15, allowed_apps: ['Notepad'], alerts_enabled: true } });
  const mine = await h.call('POST', '/api/board', { user: client, body: { title: 'Follow up', taskId: t.body.task.id } });
  assert.equal(mine.body.item.taskId, t.body.task.id);
  const theirs = await h.call('POST', '/api/board', { user: other, body: { title: 'Snoop', taskId: t.body.task.id } });
  assert.equal(theirs.body.item.taskId, null);
});
