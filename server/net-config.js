'use strict';
// Deployment-safety helpers for server.js (pure functions, unit-tested in server/test/net-config.test.js).
//   loadJwtSecret()      the server must NEVER fail to boot because JWT_SECRET is missing
//   buildOriginChecker() which websites may call the API and open the Socket.IO connection (CORS)
const path = require('path');

// ---------------------------------------------------------------- JWT secret
// Order of preference:
//   1. JWT_SECRET environment variable            (best: set it in Railway > Variables)
//   2. a secret previously generated and saved next to the database (survives redeploys when DB_PATH is on a Railway Volume)
//   3. a new random 384-bit secret, saved for next time
//   4. a new random secret kept in memory only     (if the disk is read-only: everyone signs in again after a restart, but the server runs)
//
// Why NOT a hardcoded string: ScopeDesk's source is public on GitHub. A secret written in the code is a secret everyone
// knows, and anyone could then forge a login token for any account. A random per-deployment secret has the same
// "never crashes" property without that hole.
function loadJwtSecret({ env = process.env, fs = require('fs'), crypto = require('crypto'), dataDir, log = console }) {
  const fromEnv = String(env.JWT_SECRET || '').trim();
  if (fromEnv) return { secret: fromEnv, source: 'env' };

  const file = path.join(dataDir, '.jwt_secret');
  try {
    const saved = fs.readFileSync(file, 'utf8').trim();
    if (saved.length >= 32) return { secret: saved, source: 'file' };
  } catch (_) { /* no saved secret yet */ }

  const secret = crypto.randomBytes(48).toString('hex');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, secret, { mode: 0o600 });
    log.warn(`[AUTH] JWT_SECRET is not set. Generated a random one and saved it to ${file}. Set JWT_SECRET in Railway > Variables to make this permanent.`);
    return { secret, source: 'generated-file' };
  } catch (e) {
    log.warn(`[AUTH] JWT_SECRET is not set and ${file} is not writable (${e.code || e.message}). Using a temporary secret: everyone must sign in again after each restart. Set JWT_SECRET in Railway > Variables.`);
    return { secret, source: 'generated-memory' };
  }
}

// ---------------------------------------------------------------- CORS
// Logins use an Authorization header (not cookies), so CORS is not what protects the API. It only decides which
// front-ends the browser lets talk to it. Allowed:
//   * the server's own address (APP_URL, Railway's domain)
//   * anything in CORS_ORIGIN (comma list). Entries like "*.example.com" allow every https subdomain.
//   * the common free hosts for the front-end: *.vercel.app, *.github.io, *.netlify.app, *.up.railway.app
//   * localhost, only outside production
//   * no Origin header at all (the Electron app's own requests, curl, health checks)
const DEFAULT_SUFFIXES = ['.vercel.app', '.github.io', '.netlify.app', '.up.railway.app'];
const clean = (v) => String(v || '').trim().replace(/\/+$/, '');

function buildOriginChecker({ env = process.env, isProduction }) {
  const exact = new Set();
  const suffixes = [...DEFAULT_SUFFIXES];
  const add = (entry) => {
    const e = clean(entry);
    if (!e) return;
    if (e.startsWith('*.')) suffixes.push(e.slice(1).toLowerCase());          // "*.example.com" -> ".example.com"
    else exact.add(e.toLowerCase());
  };
  [env.CORS_ORIGIN, env.APP_URL].filter(Boolean).flatMap((v) => String(v).split(',')).forEach(add);
  if (env.RAILWAY_PUBLIC_DOMAIN) add(`https://${env.RAILWAY_PUBLIC_DOMAIN}`);

  return function isAllowedOrigin(origin) {
    if (!origin) return true;
    const o = clean(origin).toLowerCase();
    if (exact.has(o)) return true;
    if (!isProduction && o === 'null') return true;                      // a page opened from a file on disk (development only)
    let u; try { u = new URL(o); } catch (_) { return false; }          // junk fails here
    if (!isProduction && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]')) return true;
    // Whole-label match ("evil-vercel.app" does not end with ".vercel.app"), and https only
    return u.protocol === 'https:' && suffixes.some((s) => u.hostname.endsWith(s));
  };
}

module.exports = { loadJwtSecret, buildOriginChecker };
