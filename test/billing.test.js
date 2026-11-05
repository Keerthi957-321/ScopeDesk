'use strict';
// Payments ON: free allowance decided by the server from the database, Razorpay order in paise, signature-verified fulfilment.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createBilling, billingMonth } = require('../server/billing');
const { loadServer } = require('./helpers/server-harness');

const KEY_ID = 'rzp_test_ABCdef123456';
const KEY_SECRET = 'secret_for_tests_only';
const quiet = { warn() {}, error() {}, log() {} };

// ---------- fake Razorpay ----------
const gateway = { calls: [], down: false, n: 0 };
async function fakeFetch(url, opts) {
  gateway.calls.push({ url, opts, body: opts.body ? JSON.parse(opts.body) : null });
  if (gateway.down) throw new Error('ECONNREFUSED');
  if (opts.headers.Authorization !== `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`) {
    return { ok: false, status: 401, json: async () => ({ error: { description: 'Authentication failed' } }) };
  }
  const b = JSON.parse(opts.body);
  gateway.n += 1;
  const id = `order_T${gateway.n}`;
  return { ok: true, status: 200, json: async () => ({ id, amount: b.amount, currency: b.currency, status: 'created', receipt: b.receipt }) };
}
const sign = (orderId, paymentId, secret = KEY_SECRET) => crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');

// ---------- pure rules ----------
test('billing rules: 3 free tasks of up to 15 min per month, then paid; prices in paise', () => {
  const b = createBilling({ env: { RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: KEY_SECRET }, log: quiet });
  assert.equal(b.enabled, true);
  assert.equal(b.mode, 'test');
  assert.deepEqual([0, 1, 2].map((used) => b.decide({ durationMinutes: 15, freeUsed: used }).billing), ['free', 'free', 'free']);
  const fourth = b.decide({ durationMinutes: 15, freeUsed: 3 });
  assert.equal(fourth.billing, 'paid'); assert.equal(fourth.reason, 'allowance'); assert.equal(fourth.amountPaise, 9900);
  const long = b.decide({ durationMinutes: 30, freeUsed: 0 });
  assert.equal(long.billing, 'paid'); assert.equal(long.reason, 'duration'); assert.equal(long.amountPaise, 19900); assert.equal(long.freeLeft, 3);
  assert.equal(b.decide({ durationMinutes: 120, freeUsed: 0 }).amountPaise, 59900);
});

test('billing rules: custom prices and the calendar month of the billing time zone', () => {
  const b = createBilling({ env: { RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: KEY_SECRET, TASK_PRICES_INR: '15:49.5,30:100' }, log: quiet });
  assert.equal(b.decide({ durationMinutes: 15, freeUsed: 9 }).amountPaise, 4950);
  assert.equal(b.decide({ durationMinutes: 60, freeUsed: 0 }).amountPaise, 4 * 4950);       // no own price: 4 blocks of 15 min
  // 31 Oct 19:00 UTC is already 1 Nov 00:30 in India: the new month's allowance applies
  assert.equal(billingMonth(new Date('2026-10-31T19:00:00Z'), 'Asia/Kolkata'), '2026-11');
  assert.equal(billingMonth(new Date('2026-10-31T19:00:00Z'), 'UTC'), '2026-10');
});

test('payments OFF when either key is missing: everything free and unlimited', () => {
  for (const env of [{}, { RAZORPAY_KEY_ID: KEY_ID }, { RAZORPAY_KEY_SECRET: KEY_SECRET }, { RAZORPAY_KEY_ID: '  ', RAZORPAY_KEY_SECRET: '' }]) {
    const b = createBilling({ env, log: quiet });
    assert.equal(b.enabled, false);
    assert.equal(b.keyId, null);
    const d = b.decide({ durationMinutes: 120, freeUsed: 99 });
    assert.equal(d.free, true); assert.equal(d.unlimited, true); assert.equal(d.billing, 'legacy');
  }
});

test('signature check: Razorpay HMAC, constant time, rejects anything else', () => {
  const b = createBilling({ env: { RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: KEY_SECRET }, log: quiet });
  assert.equal(b.verifySignature({ orderId: 'order_1', paymentId: 'pay_1', signature: sign('order_1', 'pay_1') }), true);
  assert.equal(b.verifySignature({ orderId: 'order_1', paymentId: 'pay_2', signature: sign('order_1', 'pay_1') }), false);
  assert.equal(b.verifySignature({ orderId: 'order_1', paymentId: 'pay_1', signature: sign('order_1', 'pay_1', 'wrong') }), false);
  assert.equal(b.verifySignature({ orderId: 'order_1', paymentId: 'pay_1', signature: 'short' }), false);
  assert.equal(b.verifySignature({ orderId: 'order_1', paymentId: 'pay_1' }), false);
});

// ---------- real server.js routes ----------
const h = loadServer({ env: { RAZORPAY_KEY_ID: KEY_ID, RAZORPAY_KEY_SECRET: KEY_SECRET }, fetch: fakeFetch });
let vendor;
const body = (over = {}) => ({ vendor_id: vendor.id, task: 'Fix the invoice export', duration_minutes: 15, allowed_apps: ['Notepad'], alerts_enabled: true, ...over });

test('server: quote and creation follow the database allowance; the 4th task opens Razorpay', async () => {
  vendor = await h.addUser('vendor_a', 'vendor');
  const client = await h.addUser('client_a', 'client', { daysOld: 60 });

  let q = await h.call('GET', '/api/billing/quote?duration_minutes=15', { user: client });
  assert.equal(q.body.free, true); assert.equal(q.body.freeLeft, 3); assert.equal(q.body.freeLimit, 3);
  q = await h.call('GET', '/api/billing/quote?duration_minutes=30', { user: client });
  assert.equal(q.body.free, false); assert.equal(q.body.priceInr, 199); assert.equal(q.body.reason, 'duration');

  for (let i = 0; i < 3; i += 1) {
    const r = await h.call('POST', '/api/tasks', { user: client, body: body() });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.task.billing, 'free');
    assert.equal(r.body.billing.freeLeftAfter, 2 - i);
  }
  assert.equal(gateway.calls.length, 0, 'free tasks never touch the gateway');

  q = await h.call('GET', '/api/billing/quote?duration_minutes=15', { user: client });
  assert.equal(q.body.free, false); assert.equal(q.body.reason, 'allowance'); assert.equal(q.body.freeLeft, 0);

  // The browser claims the task is free and costs nothing: ignored, the server decides
  const r = await h.call('POST', '/api/tasks', { user: client, body: { ...body(), free: true, amount: 0, billing: 'free' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.paymentRequired, true);
  assert.equal(r.body.task, undefined, 'no task before payment');
  assert.equal(r.body.payment.amount, 9900);
  assert.equal(r.body.payment.keyId, KEY_ID);
  assert.ok(!JSON.stringify(r.body).includes(KEY_SECRET), 'secret never sent');
  assert.equal(gateway.calls.at(-1).body.amount, 9900);
  assert.equal(gateway.calls.at(-1).body.currency, 'INR');
  const n = await h.db.get("SELECT COUNT(*) AS n FROM tasks WHERE client_id = ?", [client.id]);
  assert.equal(n.n, 3);
});

test('server: two tabs racing for the last free task -> exactly one gets it free', async () => {
  const client = await h.addUser('client_race', 'client', { daysOld: 60 });
  await h.call('POST', '/api/tasks', { user: client, body: body() });
  await h.call('POST', '/api/tasks', { user: client, body: body() });
  const results = await Promise.all([1, 2, 3].map(() => h.call('POST', '/api/tasks', { user: client, body: body() })));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.body.paymentRequired).length, 2);
  const free = await h.db.get("SELECT COUNT(*) AS n FROM tasks WHERE client_id = ? AND billing = 'free'", [client.id]);
  assert.equal(free.n, 3);
});

test('server: a long task is paid even with free tasks left, and does not use up the allowance', async () => {
  const client = await h.addUser('client_long', 'client', { daysOld: 60 });
  const r = await h.call('POST', '/api/tasks', { user: client, body: body({ duration_minutes: 60 }) });
  assert.equal(r.body.paymentRequired, true);
  assert.equal(r.body.billing.reason, 'duration');
  assert.equal(r.body.payment.amount, 34900);
  const q = await h.call('GET', '/api/billing/quote?duration_minutes=15', { user: client });
  assert.equal(q.body.freeLeft, 3);
});

test('server: payment verification creates the task once, only with a valid signature, only for the owner', async () => {
  const client = await h.addUser('client_pay', 'client', { daysOld: 60 });
  const other = await h.addUser('client_other', 'client', { daysOld: 60 });
  const start = await h.call('POST', '/api/tasks', { user: client, body: body({ duration_minutes: 30, task: 'Paid task text here' }) });
  const orderId = start.body.payment.orderId;

  let v = await h.call('POST', '/api/payments/verify', { user: client, body: { razorpay_order_id: orderId, razorpay_payment_id: 'pay_X', razorpay_signature: sign(orderId, 'pay_X', 'forged') } });
  assert.equal(v.status, 400);
  v = await h.call('POST', '/api/payments/verify', { user: other, body: { razorpay_order_id: orderId, razorpay_payment_id: 'pay_X', razorpay_signature: sign(orderId, 'pay_X') } });
  assert.equal(v.status, 404, 'another client cannot redeem this order');
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM tasks WHERE client_id = ?', [client.id])).n, 0);

  v = await h.call('POST', '/api/payments/verify', { user: client, body: { razorpay_order_id: orderId, razorpay_payment_id: 'pay_X', razorpay_signature: sign(orderId, 'pay_X') } });
  assert.equal(v.status, 201, JSON.stringify(v.body));
  assert.equal(v.body.task.billing, 'paid');
  assert.equal(v.body.task.amount_paise, 19900);
  assert.equal(v.body.task.duration_minutes, 30);
  assert.equal(v.body.task.title, 'Paid task text here');      // from the stored request, not from the verify call
  assert.match(v.body.task.token, /^SCD-/);

  const again = await h.call('POST', '/api/payments/verify', { user: client, body: { razorpay_order_id: orderId, razorpay_payment_id: 'pay_X', razorpay_signature: sign(orderId, 'pay_X') } });
  assert.equal(again.body.alreadyProcessed, true);
  assert.equal(again.body.task.id, v.body.task.id);
  assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM tasks WHERE client_id = ?', [client.id])).n, 1);
  assert.equal((await h.db.get('SELECT status FROM payment_orders WHERE razorpay_order_id = ?', [orderId])).status, 'fulfilled');
});

test('server: gateway down -> clear error, no task, nothing charged', async () => {
  const client = await h.addUser('client_down', 'client', { daysOld: 60 });
  gateway.down = true;
  try {
    const r = await h.call('POST', '/api/tasks', { user: client, body: body({ duration_minutes: 30 }) });
    assert.equal(r.status, 502);
    assert.match(r.body.error, /No money was taken/);
    assert.equal((await h.db.get('SELECT COUNT(*) AS n FROM tasks WHERE client_id = ?', [client.id])).n, 0);
  } finally { gateway.down = false; }
});

test('server: a new calendar month gives the 3 free tasks back', async () => {
  const client = await h.addUser('client_month', 'client', { daysOld: 60 });
  for (let i = 0; i < 3; i += 1) await h.call('POST', '/api/tasks', { user: client, body: body() });
  assert.equal((await h.call('GET', '/api/billing/quote?duration_minutes=15', { user: client })).body.freeLeft, 0);
  await h.db.run("UPDATE tasks SET billing_month = '2000-01' WHERE client_id = ?", [client.id]);   // they now belong to an old month
  const q = await h.call('GET', '/api/billing/quote?duration_minutes=15', { user: client });
  assert.equal(q.body.freeLeft, 3); assert.equal(q.body.free, true);
});

test('server: vendors cannot quote, create or pay', async () => {
  assert.equal((await h.call('GET', '/api/billing/quote?duration_minutes=15', { user: vendor })).status, 403);
  assert.equal((await h.call('POST', '/api/payments/verify', { user: vendor, body: {} })).status, 403);
});
