'use strict';
// ICE server list handed to the browsers (GET /api/rtc-config).
//
// STUN alone only works when both computers can reach each other directly. Two computers on DIFFERENT networks (home vs office,
// mobile data, strict NAT) usually cannot, and the video then hangs on "Connecting..." / "connection lost, retrying".
// A TURN relay fixes that. Pick ONE of these (first one found wins):
//
//   1) Cloudflare Realtime TURN (recommended, first 1,000 GB a month free):
//        CLOUDFLARE_TURN_KEY_ID=<Turn Token ID>   CLOUDFLARE_TURN_API_TOKEN=<API Token>
//      Credentials are created per request and expire exactly when the task window ends.
//   2) Metered (free account, sign-up gives an app name and an API key; the "Open Relay" free TURN):
//        METERED_APP=<your app name, e.g. myapp for myapp.metered.live>   METERED_API_KEY=<API key>
//      Metered's credentials are not tied to the task window, so direct connections are tried first and the relay is the fallback.
//   3) Your own coturn (use-auth-secret):   TURN_URLS=turn:turn.example.com:3478,turns:turn.example.com:5349   TURN_SECRET=<secret>
//   4) A provider with fixed credentials:   TURN_URLS=...   TURN_USERNAME=...   TURN_CREDENTIAL=...
//
// Why no built-in public username/password: shared "open" credentials stop working without notice and cannot expire with a task.
//
// Optional: STUN_URL, TURN_FORCE_RELAY=true|false (default: relay-only for 1 and 2, so the stream cannot outlive its credentials).
const crypto = require('crypto');

const CF_API = 'https://rtc.live.cloudflare.com/v1/turn/keys';

function relayConfigured(env = process.env) {
  const urls = String(env.TURN_URLS || '').trim();
  return !!((env.CLOUDFLARE_TURN_KEY_ID && env.CLOUDFLARE_TURN_API_TOKEN) || (validMeteredApp(env.METERED_APP) && env.METERED_API_KEY) || (urls && env.TURN_SECRET) || (urls && env.TURN_USERNAME && env.TURN_CREDENTIAL));
}

// Metered: GET https://<app>.metered.live/api/v1/turn/credentials?apiKey=<key> answers with an array of ICE servers.
// The app name is only ever used as a sub-domain of metered.live (letters, digits, dashes), so it cannot point the server anywhere else.
const validMeteredApp = (v) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(String(v || '').trim());
async function meteredIceServers({ app, apiKey, fetchFn, timeoutMs = 5000 }) {
  const res = await fetchFn(`https://${String(app).trim().toLowerCase()}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Metered TURN answered ${res.status}`);
  const data = await res.json();
  const servers = (Array.isArray(data) ? data : [])
    .map((s) => ({ ...s, urls: [].concat(s.urls || []).filter((u) => !/:53(\?|$)/.test(u)) }))
    .filter((s) => s.urls.length > 0);
  if (!servers.some((s) => s.username && s.credential)) throw new Error('Metered TURN returned no credentials');
  return servers;
}

// Cloudflare answers with { iceServers: [...] } (or a single object). Port 53 entries are dropped: browsers refuse that port.
async function cloudflareIceServers({ keyId, token, ttl, fetchFn, timeoutMs = 5000 }) {
  const res = await fetchFn(`${CF_API}/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`Cloudflare TURN answered ${res.status}`);
  const data = await res.json();
  const raw = Array.isArray(data.iceServers) ? data.iceServers : (data.iceServers ? [data.iceServers] : []);
  const servers = raw
    .map((s) => ({ ...s, urls: [].concat(s.urls || []).filter((u) => !/:53(\?|$)/.test(u)) }))
    .filter((s) => s.urls.length > 0);
  if (!servers.some((s) => s.username && s.credential)) throw new Error('Cloudflare TURN returned no credentials');
  return servers;
}

async function buildRtcConfig({ userId, expiresAtMs, env = process.env, fetchFn = globalThis.fetch, now = Date.now(), log = console }) {
  const iceServers = [{ urls: env.STUN_URL || 'stun:stun.l.google.com:19302' }];
  const forceRelay = env.TURN_FORCE_RELAY;
  let relay = false, hardExpiry = false, policyRelay = false;

  if (env.CLOUDFLARE_TURN_KEY_ID && env.CLOUDFLARE_TURN_API_TOKEN) {
    // credentials live exactly as long as the task window (+30 s), never less than 5 minutes, never more than a day
    const ttl = Math.max(300, Math.min(86400, Math.ceil((expiresAtMs - now) / 1000) + 30));
    try {
      iceServers.push(...await cloudflareIceServers({ keyId: env.CLOUDFLARE_TURN_KEY_ID, token: env.CLOUDFLARE_TURN_API_TOKEN, ttl, fetchFn }));
      relay = true; hardExpiry = true; policyRelay = forceRelay !== 'false';
    } catch (err) {
      log.error('[RTC] Cloudflare TURN failed, falling back to STUN only:', err.message);   // never log the token
    }
  }

  if (!relay && validMeteredApp(env.METERED_APP) && env.METERED_API_KEY) {
    try {
      iceServers.push(...await meteredIceServers({ app: env.METERED_APP, apiKey: env.METERED_API_KEY, fetchFn }));
      relay = true; policyRelay = forceRelay === 'true';   // fixed-lifetime credentials: direct first, relay as the fallback
    } catch (err) {
      log.error('[RTC] Metered TURN failed, falling back to STUN only:', err.message);   // never log the key
    }
  }

  const turnUrls = String(env.TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!relay && turnUrls.length && env.TURN_SECRET) {
    const username = `${Math.floor(expiresAtMs / 1000)}:${userId}`;   // coturn REST convention: "<unix expiry>:<user>"
    const credential = crypto.createHmac('sha1', env.TURN_SECRET).update(username).digest('base64');
    iceServers.push({ urls: turnUrls, username, credential });
    relay = true; hardExpiry = true; policyRelay = forceRelay !== 'false';
  } else if (!relay && turnUrls.length && env.TURN_USERNAME && env.TURN_CREDENTIAL) {
    iceServers.push({ urls: turnUrls, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL });
    relay = true; policyRelay = forceRelay === 'true';   // fixed credentials cannot expire with the task: direct first, relay as fallback
  }

  return { iceServers, iceTransportPolicy: policyRelay ? 'relay' : 'all', hardExpiry, relay };
}

module.exports = { buildRtcConfig, relayConfigured };
