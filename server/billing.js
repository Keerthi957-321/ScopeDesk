'use strict';
/**
 * ScopeDesk billing rules + Razorpay (Orders API, no SDK needed).
 *
 * PLANS (the SERVER decides; the browser only displays what the server tells it):
 *   - TRIAL  : the first TRIAL_DAYS (30) days after sign-up. Every task is free (any length) and the AI assistant is included,
 *              so a new client experiences everything.
 *   - FREE   : after the trial. FREE_TASKS_PER_MONTH (3) free tasks per calendar month, each up to FREE_TASK_MAX_MINUTES (15).
 *              Longer tasks, and every task after the 3 free ones, are paid per task through Razorpay. No AI assistant.
 *   - MEMBER : paid membership (monthly or yearly, Razorpay). Unlimited free tasks + the AI assistant.
 *   - Payments OFF mode: when RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET is missing, there are no plans: every task is free and
 *     unlimited (legacy behaviour) and the AI assistant is open to every client (if OPENAI_API_KEY is set).
 *
 * Environment:
 *   RAZORPAY_KEY_ID=rzp_test_xxxxxxxx      (public; sent to the browser for the checkout window)
 *   RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxx   (secret; never leaves the server)
 *   TASK_PRICES_INR=15:99,30:199,60:349,120:599   (optional; price per duration in rupees)
 *   BILLING_TIMEZONE=Asia/Kolkata          (optional; which calendar decides "this month")
 *   MEMBERSHIP_MONTHLY_INR=299             (optional; membership price for 30 days)
 *   MEMBERSHIP_YEARLY_INR=2999             (optional; membership price for 365 days)
 *   TRIAL_DAYS=30                          (optional; length of the free trial after sign-up)
 *
 * Pure functions + one injectable fetch, so it is easy to test without the network.
 */
const crypto = require('crypto');

const FREE_TASKS_PER_MONTH = 3;
const FREE_TASK_MAX_MINUTES = 15;
const DEFAULT_PRICES_INR = { 15: 99, 30: 199, 60: 349, 120: 599 };
const DAY_MS = 24 * 60 * 60 * 1000;
const MEMBERSHIP_PLANS = { monthly: { days: 30, label: 'Monthly membership' }, yearly: { days: 365, label: 'Yearly membership' } };
const RAZORPAY_API = 'https://api.razorpay.com/v1';
const KEY_ID_RE = /^rzp_(test|live)_[A-Za-z0-9]{6,}$/;

function parsePriceTable(raw, log) {
  if (!raw) return { ...DEFAULT_PRICES_INR };
  const table = {};
  for (const part of String(raw).split(',')) {
    const [m, p] = part.split(':').map((s) => Number(String(s || '').trim()));
    if (Number.isInteger(m) && m > 0 && Number.isFinite(p) && p >= 1) table[m] = Math.round(p * 100) / 100;
  }
  if (!Object.keys(table).length) {
    if (log) log.warn('[BILLING] TASK_PRICES_INR could not be read; using the default prices.');
    return { ...DEFAULT_PRICES_INR };
  }
  return table;
}

/** "YYYY-MM" of `date` in the billing time zone. Stored on each task, so "this month" never depends on server clock zone. */
function billingMonth(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(date);
  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value;
  return `${y}-${m}`;
}

function readKeys(env, log) {
  const keyId = String(env.RAZORPAY_KEY_ID || '').trim();
  const keySecret = String(env.RAZORPAY_KEY_SECRET || '').trim();
  if (!keyId && !keySecret) return { enabled: false, why: 'no Razorpay keys set' };
  if (!keyId || !keySecret) {
    log.warn(`[BILLING] Only ${keyId ? 'RAZORPAY_KEY_ID' : 'RAZORPAY_KEY_SECRET'} is set. Both are needed; payments are OFF.`);
    return { enabled: false, why: 'Razorpay keys incomplete' };
  }
  if (!KEY_ID_RE.test(keyId)) log.warn('[BILLING] RAZORPAY_KEY_ID does not look like rzp_test_... or rzp_live_... Razorpay will probably refuse it.');
  if (keySecret.length < 8) log.warn('[BILLING] RAZORPAY_KEY_SECRET looks too short. Razorpay will probably refuse it.');
  return { enabled: true, keyId, keySecret, mode: keyId.startsWith('rzp_live_') ? 'live' : 'test' };
}

function createBilling({ env = process.env, fetchImpl = globalThis.fetch, log = console } = {}) {
  const keys = readKeys(env, log);
  const prices = parsePriceTable(env.TASK_PRICES_INR, log);
  let timeZone = String(env.BILLING_TIMEZONE || 'Asia/Kolkata');
  try { billingMonth(new Date(), timeZone); } catch (_) { log.warn(`[BILLING] Unknown BILLING_TIMEZONE "${timeZone}"; using Asia/Kolkata.`); timeZone = 'Asia/Kolkata'; }

  const priceInrFor = (minutes) => {
    if (prices[minutes] != null) return prices[minutes];
    // A duration without its own price: charge per started 15-minute block at the 15-minute rate
    return Math.ceil(minutes / 15) * (prices[15] || DEFAULT_PRICES_INR[15]);
  };
  const toPaise = (inr) => Math.round(inr * 100);   // Razorpay amounts are integers in paise (₹1 = 100 paise)
  const positive = (v, d) => { const n = Number(v); return Number.isFinite(n) && n >= 1 ? Math.round(n * 100) / 100 : d; };
  const trialDays = Math.max(0, Math.floor(Number(env.TRIAL_DAYS != null && env.TRIAL_DAYS !== '' ? env.TRIAL_DAYS : 30)) || 0);
  const membershipPrices = { monthly: positive(env.MEMBERSHIP_MONTHLY_INR, 299), yearly: positive(env.MEMBERSHIP_YEARLY_INR, 2999) };

  const toDate = (v) => {
    if (v instanceof Date) return v;
    const s = String(v || '');
    if (!s) return new Date(NaN);
    return new Date(s.includes('T') || s.endsWith('Z') ? s : s.replace(' ', 'T') + 'Z');   // SQLite datetime('now') is UTC without a zone
  };

  /**
   * Which plan this client is on RIGHT NOW, from the database row (users.created_at, users.membership_until).
   * Returns { plan: 'legacy'|'member'|'trial'|'free', chatbot, unlimitedTasks, trialEndsAt, memberUntil } (times in ms or null).
   */
  function entitlements({ createdAt, memberUntil, now = Date.now() } = {}) {
    const until = toDate(memberUntil).getTime();
    const memberUntilMs = Number.isFinite(until) && until > now ? until : null;
    const created = toDate(createdAt).getTime();
    const trialEnd = Number.isFinite(created) ? created + trialDays * DAY_MS : NaN;
    const trialEndsAt = Number.isFinite(trialEnd) && trialEnd > now ? trialEnd : null;
    if (!keys.enabled) return { plan: 'legacy', chatbot: true, unlimitedTasks: true, trialEndsAt: null, memberUntil: null };
    if (memberUntilMs) return { plan: 'member', chatbot: true, unlimitedTasks: true, trialEndsAt, memberUntil: memberUntilMs };
    if (trialEndsAt) return { plan: 'trial', chatbot: true, unlimitedTasks: true, trialEndsAt, memberUntil: null };
    return { plan: 'free', chatbot: false, unlimitedTasks: false, trialEndsAt: null, memberUntil: null };
  }

  /** New membership end time: a renewal before expiry adds the days on top of what is left. */
  function extendMembership(currentUntil, planKey, now = Date.now()) {
    const plan = MEMBERSHIP_PLANS[planKey];
    if (!plan) throw new Error('Unknown membership plan.');
    const cur = toDate(currentUntil).getTime();
    const from = Number.isFinite(cur) && cur > now ? cur : now;
    return new Date(from + plan.days * DAY_MS);
  }

  function membershipQuote(planKey) {
    const plan = MEMBERSHIP_PLANS[planKey];
    if (!plan) return null;
    const priceInr = membershipPrices[planKey];
    return { plan: planKey, label: plan.label, days: plan.days, priceInr, amountPaise: toPaise(priceInr), currency: 'INR' };
  }

  /**
   * The one decision. `freeUsed` = free tasks this client already created this calendar month (from the database).
   * Returns { billing: 'legacy'|'free'|'paid', free, ... }.
   */
  function decide({ durationMinutes, freeUsed, plan = 'free' }) {
    if (!keys.enabled) {
      return { paymentsEnabled: false, plan: 'legacy', billing: 'legacy', free: true, unlimited: true, freeLimit: null, freeLeft: null, amountPaise: 0, priceInr: 0 };
    }
    // Trial and members: every task free, any length. Stored as their own billing kind, so they never use up the monthly free allowance.
    if (plan === 'member' || plan === 'trial') {
      return { paymentsEnabled: true, plan, billing: plan, free: true, unlimited: true, freeLimit: FREE_TASKS_PER_MONTH, freeMaxMinutes: FREE_TASK_MAX_MINUTES, freeLeft: null, amountPaise: 0, priceInr: 0 };
    }
    const used = Math.max(0, Number(freeUsed) || 0);
    const freeLeft = Math.max(0, FREE_TASKS_PER_MONTH - used);
    const base = { paymentsEnabled: true, plan: 'free', freeLimit: FREE_TASKS_PER_MONTH, freeMaxMinutes: FREE_TASK_MAX_MINUTES, freeLeft, unlimited: false };
    if (durationMinutes <= FREE_TASK_MAX_MINUTES && freeLeft > 0) {
      return { ...base, billing: 'free', free: true, freeLeftAfter: freeLeft - 1, amountPaise: 0, priceInr: 0 };
    }
    const priceInr = priceInrFor(durationMinutes);
    return {
      ...base, billing: 'paid', free: false, priceInr, amountPaise: toPaise(priceInr), currency: 'INR',
      reason: durationMinutes > FREE_TASK_MAX_MINUTES ? 'duration' : 'allowance'
    };
  }

  async function razorpay(method, pathName, body) {
    if (!keys.enabled) throw Object.assign(new Error('Payments are not configured.'), { code: 'PAYMENTS_OFF' });
    if (typeof fetchImpl !== 'function') throw Object.assign(new Error('fetch is not available in this Node.js version.'), { code: 'NO_FETCH' });
    const auth = Buffer.from(`${keys.keyId}:${keys.keySecret}`).toString('base64');
    let res;
    try {
      res = await fetchImpl(RAZORPAY_API + pathName, {
        method,
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(10000)
      });
    } catch (err) {
      throw Object.assign(new Error('Could not reach Razorpay.'), { code: 'GATEWAY_UNREACHABLE', cause: err });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const desc = (data && data.error && data.error.description) || `HTTP ${res.status}`;
      // 401 = wrong keys. Logged for the operator; the browser only gets a generic message.
      log.error(`[BILLING] Razorpay ${method} ${pathName} failed: ${desc}`);
      throw Object.assign(new Error('The payment gateway refused the request.'), { code: res.status === 401 ? 'GATEWAY_AUTH' : 'GATEWAY_ERROR' });
    }
    return data;
  }

  /** Creates a Razorpay order. amountPaise must be an integer >= 100 (Razorpay minimum is ₹1). */
  async function createOrder({ amountPaise, receipt, notes }) {
    if (!Number.isInteger(amountPaise) || amountPaise < 100) throw new Error('Invalid amount.');
    const order = await razorpay('POST', '/orders', {
      amount: amountPaise, currency: 'INR', receipt: String(receipt).slice(0, 40), notes: notes || {}
    });
    if (!order || typeof order.id !== 'string' || order.amount !== amountPaise) throw Object.assign(new Error('Unexpected order from Razorpay.'), { code: 'GATEWAY_ERROR' });
    return order;
  }

  /** Razorpay's documented check: HMAC-SHA256(order_id + "|" + payment_id, key_secret) == razorpay_signature. Constant time. */
  function verifySignature({ orderId, paymentId, signature }) {
    if (!keys.enabled) return false;
    if (![orderId, paymentId, signature].every((v) => typeof v === 'string' && v.length > 0 && v.length < 200)) return false;
    const expected = crypto.createHmac('sha256', keys.keySecret).update(`${orderId}|${paymentId}`).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  return {
    enabled: keys.enabled,
    mode: keys.enabled ? keys.mode : 'off',
    keyId: keys.enabled ? keys.keyId : null,          // public key only
    timeZone,
    prices,
    FREE_TASKS_PER_MONTH,
    FREE_TASK_MAX_MINUTES,
    month: (date = new Date()) => billingMonth(date, timeZone),
    priceInrFor,
    decide,
    entitlements,
    extendMembership,
    membershipQuote,
    membershipPrices,
    trialDays,
    MEMBERSHIP_PLANS,
    createOrder,
    verifySignature,
    describe: () => (keys.enabled
      ? `Payments:  Razorpay ${keys.mode} mode (trial ${trialDays} days; free plan ${FREE_TASKS_PER_MONTH} tasks of up to ${FREE_TASK_MAX_MINUTES} min/month; membership \u20b9${membershipPrices.monthly}/month or \u20b9${membershipPrices.yearly}/year)`
      : `Payments:  OFF (${keys.why}). Every task is free and unlimited.`)
  };
}

module.exports = { createBilling, billingMonth, parsePriceTable, FREE_TASKS_PER_MONTH, FREE_TASK_MAX_MINUTES, MEMBERSHIP_PLANS };
