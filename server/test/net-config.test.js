const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadJwtSecret, buildOriginChecker } = require('../net-config');

const quiet = { warn() {}, log() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sd-'));

test('JWT_SECRET from the environment wins', () => {
  const r = loadJwtSecret({ env: { JWT_SECRET: '  abc  ' }, dataDir: tmp(), log: quiet });
  assert.deepStrictEqual(r, { secret: 'abc', source: 'env' });
});

test('missing JWT_SECRET never throws: a random secret is generated, saved, and reused on the next boot', () => {
  const dir = tmp();
  const a = loadJwtSecret({ env: {}, dataDir: dir, log: quiet });
  assert.strictEqual(a.source, 'generated-file');
  assert.ok(a.secret.length >= 64);
  const b = loadJwtSecret({ env: {}, dataDir: dir, log: quiet });
  assert.deepStrictEqual({ secret: b.secret, source: b.source }, { secret: a.secret, source: 'file' });
});

test('an unwritable disk still boots, with a temporary in-memory secret', () => {
  const file = path.join(tmp(), 'blocker'); fs.writeFileSync(file, 'x');
  const r = loadJwtSecret({ env: {}, dataDir: path.join(file, 'sub'), log: quiet }); // parent is a file: mkdir fails
  assert.strictEqual(r.source, 'generated-memory');
  assert.ok(r.secret.length >= 64);
});

test('two fresh deployments never share a secret', () => {
  const a = loadJwtSecret({ env: {}, dataDir: tmp(), log: quiet }).secret;
  const b = loadJwtSecret({ env: {}, dataDir: tmp(), log: quiet }).secret;
  assert.notStrictEqual(a, b);
});

test('CORS: production front-ends are allowed, lookalikes and plain http are not', () => {
  const ok = buildOriginChecker({ env: { RAILWAY_PUBLIC_DOMAIN: 'scopedesk-api-production.up.railway.app' }, isProduction: true });
  for (const o of ['https://scope-desk.vercel.app', 'https://keerthi957-321.github.io', 'https://scopedesk-api-production.up.railway.app', undefined]) assert.ok(ok(o), String(o));
  for (const o of ['https://evil-vercel.app', 'https://vercel.app.evil.com', 'http://scope-desk.vercel.app', 'https://evil.com', 'null', 'http://localhost:3000']) assert.ok(!ok(o), o);
});

test('CORS: CORS_ORIGIN adds exact origins and *.wildcards; localhost only outside production', () => {
  const ok = buildOriginChecker({ env: { CORS_ORIGIN: 'https://app.example.com/, *.corp.test' }, isProduction: false });
  assert.ok(ok('https://app.example.com'));
  assert.ok(ok('https://x.corp.test'));
  assert.ok(!ok('https://corp.test.evil.com'));
  assert.ok(ok('http://localhost:5173'));
  assert.ok(ok('null'));
});
