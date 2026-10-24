const test = require('node:test');
const assert = require('node:assert');
const { buildRtcConfig, relayConfigured } = require('../rtc-config');
const quiet = { error() {} };
const NOW = 1_000_000_000_000;
const cfResponse = { ok: true, json: async () => ({ iceServers: [
  { urls: ['stun:stun.cloudflare.com:3478'] },
  { urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:5349?transport=tcp'], username: 'u1', credential: 'c1' }
] }) };

test('no TURN configured: STUN only, relay=false (and the page can say so)', async () => {
  const c = await buildRtcConfig({ userId: 1, expiresAtMs: NOW + 600000, env: {}, now: NOW, log: quiet });
  assert.strictEqual(c.relay, false); assert.strictEqual(c.iceTransportPolicy, 'all'); assert.strictEqual(c.iceServers.length, 1);
  assert.strictEqual(relayConfigured({}), false);
});

test('Cloudflare: credentials requested for exactly the task window, port 53 removed, relay forced', async () => {
  let seen;
  const fetchFn = async (url, opts) => { seen = { url, opts }; return cfResponse; };
  const env = { CLOUDFLARE_TURN_KEY_ID: 'KEY123', CLOUDFLARE_TURN_API_TOKEN: 'TOKEN' };
  const c = await buildRtcConfig({ userId: 7, expiresAtMs: NOW + 1800000, env, fetchFn, now: NOW, log: quiet });
  assert.match(seen.url, /\/turn\/keys\/KEY123\/credentials\/generate-ice-servers$/);
  assert.strictEqual(seen.opts.headers.Authorization, 'Bearer TOKEN');
  assert.strictEqual(JSON.parse(seen.opts.body).ttl, 1830);                       // 30 minutes + 30 s
  const turn = c.iceServers.find((s) => s.username);
  assert.ok(!turn.urls.some((u) => /:53(\?|$)/.test(u)));  // port 53 gone, 5349 kept
  assert.ok(turn.urls.some((u) => u.includes(':5349')));
  assert.strictEqual(c.relay, true); assert.strictEqual(c.hardExpiry, true); assert.strictEqual(c.iceTransportPolicy, 'relay');
  assert.strictEqual(relayConfigured(env), true);
});

test('Cloudflare outage or bad key: falls back to STUN only without throwing or leaking the token', async () => {
  const logged = [];
  const env = { CLOUDFLARE_TURN_KEY_ID: 'K', CLOUDFLARE_TURN_API_TOKEN: 'SECRET-TOKEN' };
  const c = await buildRtcConfig({ userId: 1, expiresAtMs: NOW + 600000, env, now: NOW, fetchFn: async () => ({ ok: false, status: 401 }), log: { error: (...a) => logged.push(a.join(' ')) } });
  assert.strictEqual(c.relay, false); assert.strictEqual(c.iceTransportPolicy, 'all');
  assert.ok(logged.length === 1 && !logged[0].includes('SECRET-TOKEN'));
});

test('ttl is clamped between 5 minutes and one day', async () => {
  const ttls = [];
  const fetchFn = async (u, o) => { ttls.push(JSON.parse(o.body).ttl); return cfResponse; };
  const env = { CLOUDFLARE_TURN_KEY_ID: 'K', CLOUDFLARE_TURN_API_TOKEN: 'T' };
  await buildRtcConfig({ userId: 1, expiresAtMs: NOW + 1000, env, fetchFn, now: NOW, log: quiet });
  await buildRtcConfig({ userId: 1, expiresAtMs: NOW + 10 * 86400000, env, fetchFn, now: NOW, log: quiet });
  assert.deepStrictEqual(ttls, [300, 86400]);
});

test('coturn secret and fixed-credential providers still work', async () => {
  const a = await buildRtcConfig({ userId: 3, expiresAtMs: NOW + 60000, now: NOW, env: { TURN_URLS: 'turn:t.example.com:3478', TURN_SECRET: 's' }, log: quiet });
  assert.strictEqual(a.relay, true); assert.strictEqual(a.iceTransportPolicy, 'relay'); assert.match(a.iceServers[1].username, /^\d+:3$/);
  const b = await buildRtcConfig({ userId: 3, expiresAtMs: NOW + 60000, now: NOW, env: { TURN_URLS: 'turn:t.example.com:3478', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p' }, log: quiet });
  assert.strictEqual(b.relay, true); assert.strictEqual(b.iceTransportPolicy, 'all'); assert.strictEqual(b.hardExpiry, false);
});

test('Metered: credentials fetched from the app sub-domain, array answer used, key never logged on failure', async () => {
  let seenUrl;
  const answer = { ok: true, json: async () => ([{ urls: 'stun:stun.relay.metered.ca:80' }, { urls: ['turn:global.relay.metered.ca:80', 'turn:global.relay.metered.ca:443?transport=tcp'], username: 'mu', credential: 'mc' }]) };
  const env = { METERED_APP: 'MyApp', METERED_API_KEY: 'key&1' };
  const c = await buildRtcConfig({ userId: 1, expiresAtMs: NOW + 600000, env, now: NOW, log: quiet, fetchFn: async (u) => { seenUrl = u; return answer; } });
  assert.strictEqual(seenUrl, 'https://myapp.metered.live/api/v1/turn/credentials?apiKey=key%261');
  assert.strictEqual(c.relay, true); assert.strictEqual(c.iceTransportPolicy, 'all'); assert.strictEqual(c.hardExpiry, false);
  assert.ok(c.iceServers.some((s) => s.username === 'mu'));
  assert.strictEqual(relayConfigured(env), true);

  const logged = [];
  const bad = await buildRtcConfig({ userId: 1, expiresAtMs: NOW + 600000, env: { METERED_APP: 'myapp', METERED_API_KEY: 'TOP-SECRET-KEY' }, now: NOW,
    fetchFn: async () => ({ ok: false, status: 403 }), log: { error: (...a) => logged.push(a.join(' ')) } });
  assert.strictEqual(bad.relay, false);
  assert.ok(logged.length === 1 && !logged[0].includes('TOP-SECRET-KEY'));
});

test('Metered app name cannot redirect the request to another host', async () => {
  let called = false;
  for (const app of ['evil.com/x', 'a b', '../x', 'x@evil.com', '']) {
    const c = await buildRtcConfig({ userId: 1, expiresAtMs: NOW + 600000, env: { METERED_APP: app, METERED_API_KEY: 'k' }, now: NOW, log: quiet, fetchFn: async () => { called = true; return { ok: true, json: async () => [] }; } });
    assert.strictEqual(c.relay, false);
  }
  assert.strictEqual(called, false);
});

test('Cloudflare wins over Metered when both are set', async () => {
  const urls = [];
  const fetchFn = async (u) => { urls.push(u); return cfResponse; };
  const c = await buildRtcConfig({ userId: 1, expiresAtMs: NOW + 600000, now: NOW, log: quiet, fetchFn, env: { CLOUDFLARE_TURN_KEY_ID: 'K', CLOUDFLARE_TURN_API_TOKEN: 'T', METERED_APP: 'myapp', METERED_API_KEY: 'k' } });
  assert.strictEqual(urls.length, 1); assert.ok(urls[0].includes('cloudflare.com')); assert.strictEqual(c.iceTransportPolicy, 'relay');
});
