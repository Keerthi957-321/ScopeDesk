'use strict';
// ICE configuration handed to the browsers / Electron (GET /api/rtc-config).
//
// HYBRID by design: iceTransportPolicy is always "all" unless you opt in to relay-only, so every connection gathers
//   host  candidates (same Wi-Fi / hotspot / LAN: connects in milliseconds, no internet round trip),
//   srflx candidates (public address found through STUN: works across most home/office NATs),
//   relay candidates (TURN: works through strict firewalls and symmetric NAT).
// ICE tries all pairs at once and keeps the best one that works, so the same code and the same settings serve both cases.
//
// Relay providers (first one found wins; all of them are optional):
//   1) Cloudflare Realtime TURN:  CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_API_TOKEN   (credentials expire with the task window)
//   2) Metered:                   METERED_APP + METERED_API_KEY
//   3) Your own coturn:           TURN_URLS + TURN_SECRET            (credentials expire with the task window)
//   4) Fixed credentials:         TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL
//   5) Public Open Relay fallback (shared, no sign-up, best effort). Used ONLY when 1-4 are not configured.
//      Turn it off with PUBLIC_TURN_FALLBACK=false. Do not rely on it for production: shared servers are rate limited and can change
//      without notice. Media is DTLS-SRTP encrypted, so the relay operator cannot read the screen, but it can see traffic metadata.
//
// Optional: STUN_URLS (comma separated, replaces the built-in STUN list)
//           TURN_FORCE_RELAY=true  -> relay-only (strictest: the stream cannot outlive its credentials; slower and costs relay bandwidth)
//           default (false/unset)  -> "all": direct paths first, relay as fallback
const crypto = require('crypto');

const CF_API = 'https://rtc.live.cloudflare.com/v1/turn/keys';

const DEFAULT_STUN = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun2.l.google.com:19302',
  'stun:stun.cloudflare.com:3478'
];

// Shared public relay (Metered "Open Relay"). Published credentials, not secret.
const PUBLIC_TURN = {
  urls: [
    'turn:openrelay.metered.ca:80',
    'turn:openrelay.metered.ca:443',
    'turn:openrelay.metered.ca:443?transport=tcp',
    'turns:openrelay.metered.ca:443?transport=tcp'
  ],
  username: 'openrelayproject',
  credential: 'openrelayproject'
};

const validMeteredApp = (v) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(String(v || '').trim());
const publicFallbackEnabled = (env) => String(env.PUBLIC_TURN_FALLBACK || '').toLowerCase() !== 'false';
const without53 = (list) => list
  .map((s) => ({ ...s, urls: [].concat(s.urls || []).filter((u) => !/:53(\?|$)/.test(u)) }))   // browsers refuse port 53
  .filter((s) => s.urls.length > 0);

// A private relay (options 1-4) is configured. The public fallback is deliberately not counted here.
function relayConfigured(env = process.env) {
  const urls = String(env.TURN_URLS || '').trim();
  return !!((env.CLOUDFLARE_TURN_KEY_ID && env.CLOUDFLARE_TURN_API_TOKEN) || (validMeteredApp(env.METERED_APP) && env.METERED_API_KEY) || (urls && env.TURN_SECRET) || (urls && env.TURN_USERNAME && env.TURN_CREDENTIAL));
}

async function meteredIceServers({ app, apiKey, fetchFn, timeoutMs = 5000 }) {
  const res = await fetchFn(`https://${String(app).trim().toLowerCase()}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Metered TURN answered ${res.status}`);
  const data = await res.json();
  const servers = without53(Array.isArray(data) ? data : []);
  if (!servers.some((s) => s.username && s.credential)) throw new Error('Metered TURN returned no credentials');
  return servers;
}

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
  const servers = without53(raw);
  if (!servers.some((s) => s.username && s.credential)) throw new Error('Cloudflare TURN returned no credentials');
  return servers;
}

// Returns the exact RTCConfiguration both pages pass to `new RTCPeerConnection(...)`, plus two informational fields
// (`relay`, `relayKind`, `hardExpiry`) the UI uses to explain a failure. The browser ignores unknown dictionary members.
async function buildRtcConfig({ userId, expiresAtMs, env = process.env, fetchFn = globalThis.fetch, now = Date.now(), log = console }) {
  const stunList = String(env.STUN_URLS || env.STUN_URL || '').split(',').map((s) => s.trim()).filter(Boolean);
  const iceServers = [{ urls: stunList.length ? stunList : DEFAULT_STUN }];
  const forceRelay = String(env.TURN_FORCE_RELAY || '').toLowerCase() === 'true';
  let relayKind = null, hardExpiry = false;

  if (env.CLOUDFLARE_TURN_KEY_ID && env.CLOUDFLARE_TURN_API_TOKEN) {
    // credentials live exactly as long as the task window (+30 s), never less than 5 minutes, never more than a day
    const ttl = Math.max(300, Math.min(86400, Math.ceil((expiresAtMs - now) / 1000) + 30));
    try {
      iceServers.push(...await cloudflareIceServers({ keyId: env.CLOUDFLARE_TURN_KEY_ID, token: env.CLOUDFLARE_TURN_API_TOKEN, ttl, fetchFn }));
      relayKind = 'cloudflare'; hardExpiry = true;
    } catch (err) {
      log.error('[RTC] Cloudflare TURN failed, trying the next relay option:', err.message);   // never log the token
    }
  }

  if (!relayKind && validMeteredApp(env.METERED_APP) && env.METERED_API_KEY) {
    try {
      iceServers.push(...await meteredIceServers({ app: env.METERED_APP, apiKey: env.METERED_API_KEY, fetchFn }));
      relayKind = 'metered';
    } catch (err) {
      log.error('[RTC] Metered TURN failed, trying the next relay option:', err.message);   // never log the key
    }
  }

  const turnUrls = String(env.TURN_URLS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!relayKind && turnUrls.length && env.TURN_SECRET) {
    const username = `${Math.floor(expiresAtMs / 1000)}:${userId}`;   // coturn REST convention: "<unix expiry>:<user>"
    const credential = crypto.createHmac('sha1', env.TURN_SECRET).update(username).digest('base64');
    iceServers.push({ urls: turnUrls, username, credential });
    relayKind = 'coturn'; hardExpiry = true;
  } else if (!relayKind && turnUrls.length && env.TURN_USERNAME && env.TURN_CREDENTIAL) {
    iceServers.push({ urls: turnUrls, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL });
    relayKind = 'fixed';
  }

  if (!relayKind && publicFallbackEnabled(env)) {
    iceServers.push({ ...PUBLIC_TURN, urls: [...PUBLIC_TURN.urls] });
    relayKind = 'public';
  }

  return {
    iceServers,
    iceTransportPolicy: forceRelay && relayKind && relayKind !== 'public' ? 'relay' : 'all',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceCandidatePoolSize: 2,          // start gathering before the offer exists: the first candidates are ready sooner
    hardExpiry,
    relay: !!relayKind,
    relayKind                          // 'cloudflare' | 'metered' | 'coturn' | 'fixed' | 'public' | null
  };
}

module.exports = { buildRtcConfig, relayConfigured, DEFAULT_STUN, PUBLIC_TURN };
