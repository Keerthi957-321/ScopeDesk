'use strict';
// Payments OFF (no Razorpay keys): every task is free and unlimited, the gateway is never contacted (legacy behaviour).
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadServer } = require('./helpers/server-harness');

let fetchCalls = 0;
const h = loadServer({ env: { RAZORPAY_KEY_ID: '', RAZORPAY_KEY_SECRET: '' }, fetch: async () => { fetchCalls += 1; throw new Error('must not be called'); } });

test('payments off: quote says FREE and unlimited for every duration', async () => {
  const client = await h.addUser('c_off', 'client');
  for (const d of [15, 30, 60, 120]) {
    const q = await h.call('GET', `/api/billing/quote?duration_minutes=${d}`, { user: client });
    assert.equal(q.body.paymentsEnabled, false);
    assert.equal(q.body.free, true);
    assert.equal(q.body.unlimited, true);
  }
});

test('payments off: any number of tasks of any length are created at once, no payment window', async () => {
  const vendor = await h.addUser('v_off', 'vendor');
  const client = await h.addUser('c_off2', 'client');
  for (const d of [15, 15, 15, 15, 15, 30, 60, 120]) {
    const r = await h.call('POST', '/api/tasks', { user: client, body: { vendor_id: vendor.id, task: 'Legacy free task', duration_minutes: d, allowed_apps: ['Notepad'], alerts_enabled: true } });
    assert.equal(r.status, 201);
    assert.equal(r.body.paymentRequired, undefined);
    assert.equal(r.body.task.billing, 'legacy');
  }
  assert.equal(fetchCalls, 0);
  // legacy tasks never count against a future allowance
  assert.equal((await h.db.get("SELECT COUNT(*) AS n FROM tasks WHERE client_id = ? AND billing = 'free'", [client.id])).n, 0);
});

test('payments off: the verify endpoint is closed', async () => {
  const client = await h.addUser('c_off3', 'client');
  assert.equal((await h.call('POST', '/api/payments/verify', { user: client, body: { razorpay_order_id: 'order_1' } })).status, 400);
});
