'use strict';
/**
 * Loads the REAL server.js (real routes, real socket handlers, real SQLite database) with tiny stand-ins for the npm packages
 * (express, socket.io, cors, bcryptjs, jsonwebtoken, nodemailer), so the billing and termination logic can be tested
 * without installing anything or opening a network port to the outside. Call ONCE per test process (node --test runs each file
 * in its own process).
 *
 *   const h = loadServer({ env: { RAZORPAY_KEY_ID: ..., ... }, fetch: fakeFetch });
 *   const res = await h.call('POST', '/api/tasks', { user, body });
 */
const Module = require('module');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

function makeStubs() {
  const routes = [];
  const express = () => {
    const app = (req, res) => { res.statusCode = 404; res.end(); };
    for (const m of ['get', 'post', 'put', 'delete', 'patch']) app[m] = (p, ...h) => { routes.push({ method: m.toUpperCase(), path: p, handlers: h }); };
    app.use = () => {}; app.set = () => {};
    return app;
  };
  express.json = () => (req, res, next) => next();
  express.static = () => (req, res, next) => next();

  // jsonwebtoken: signed JSON, enough for the server's own sign/verify round trip
  const jwt = {
    sign(payload, secret, opts = {}) {
      const body = { ...payload, iat: Math.floor(Date.now() / 1000) };
      const data = Buffer.from(JSON.stringify(body)).toString('base64url');
      return `${data}.${crypto.createHmac('sha256', secret).update(data).digest('base64url')}`;
    },
    verify(token, secret) {
      const [data, sig] = String(token || '').split('.');
      if (!data || sig !== crypto.createHmac('sha256', secret).update(data).digest('base64url')) throw Object.assign(new Error('invalid'), { name: 'JsonWebTokenError' });
      return JSON.parse(Buffer.from(data, 'base64url').toString());
    }
  };

  // socket.io: records the connection middleware + handler and every emit, per socket id
  const ioState = { emits: [], middleware: [], onConnection: null, server: null };
  class FakeSocket {
    constructor(id, token) { this.id = id; this.handshake = { auth: { token } }; this.data = {}; this.handlers = {}; this.rooms = new Set(); this.disconnected = false; }
    on(ev, fn) { this.handlers[ev] = fn; }
    emit(ev, p) { ioState.emits.push({ to: this.id, ev, p }); }
    join(r) { this.rooms.add(r); const s = ioState.server; if (!s.sockets.adapter.rooms.has(r)) s.sockets.adapter.rooms.set(r, new Set()); s.sockets.adapter.rooms.get(r).add(this.id); }
    leave(r) { this.rooms.delete(r); const set = ioState.server.sockets.adapter.rooms.get(r); if (set) set.delete(this.id); }
    to(r) { return { emit: (ev, p) => ioState.emits.push({ to: r, ev, p, from: this.id }), volatile: { emit() {} } }; }
    disconnect() { this.disconnected = true; }
    call(ev, payload) { return new Promise((resolve) => this.handlers[ev](payload, resolve)); }
  }
  class Server {
    constructor() { ioState.server = this; this.sockets = { adapter: { rooms: new Map() }, sockets: new Map() }; }
    use(fn) { ioState.middleware.push(fn); }
    on(ev, fn) { if (ev === 'connection') ioState.onConnection = fn; }
    to(target) { return { emit: (ev, p) => ioState.emits.push({ to: target, ev, p }) }; }
    in(room) {
      return {
        socketsLeave: () => { const set = this.sockets.adapter.rooms.get(room); if (set) { for (const id of set) { const s = this.sockets.sockets.get(id); if (s) s.rooms.delete(room); } this.sockets.adapter.rooms.delete(room); } },
        fetchSockets: async () => [...(this.sockets.adapter.rooms.get(room) || [])].map((id) => this.sockets.sockets.get(id)).filter(Boolean)
      };
    }
  }
  // Connects a fake socket through the real middleware + connection handler. Resolves with the socket, or rejects with the auth error.
  ioState.connect = (token) => new Promise((resolve, reject) => {
    const sock = new FakeSocket(`s${ioState.server.sockets.sockets.size + 1}_${Math.random().toString(36).slice(2, 7)}`, token);
    const run = (i) => {
      if (i >= ioState.middleware.length) {
        ioState.server.sockets.sockets.set(sock.id, sock);
        ioState.onConnection(sock);
        return resolve(sock);
      }
      ioState.middleware[i](sock, (err) => (err ? reject(err) : run(i + 1)));
    };
    run(0);
  });

  // http: the real module, but the listening server never keeps the test process alive
  const realHttp = require('http');
  const http = { ...realHttp, createServer: (...a) => { const srv = realHttp.createServer(...a); const listen = srv.listen.bind(srv); srv.listen = (...args) => { const r = listen(...args); srv.unref(); return r; }; return srv; } };

  return {
    routes, ioState,
    modules: {
      http,
      express,
      cors: () => (req, res, next) => next(),
      bcryptjs: { hashSync: (p) => `h:${p}`, compareSync: (p, h) => h === `h:${p}`, hash: async (p) => `h:${p}`, compare: async (p, h) => h === `h:${p}` },
      jsonwebtoken: jwt,
      'socket.io': { Server },
      nodemailer: { createTransport: () => ({ verify: async () => true, sendMail: async () => ({ messageId: 'x' }) }) }
    }
  };
}

function loadServer({ env = {}, fetch } = {}) {
  const stubs = makeStubs();
  const origResolve = Module._resolveFilename;
  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs.modules, request)) return stubs.modules[request];
    return origLoad.call(this, request, parent, isMain);
  };
  Module._resolveFilename = function (request, ...rest) {
    if (Object.prototype.hasOwnProperty.call(stubs.modules, request)) return request;
    return origResolve.call(this, request, ...rest);
  };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scopedesk-test-'));
  Object.assign(process.env, {
    DB_PATH: path.join(dir, 'test.db'), JWT_SECRET: 'test-secret-'.padEnd(40, 'x'), NODE_ENV: 'production', PORT: '0', HOST: '127.0.0.1',
    EMAIL_VERIFICATION: 'off', RAZORPAY_KEY_ID: '', RAZORPAY_KEY_SECRET: '', ...env
  });
  if (fetch) globalThis.fetch = fetch;
  const quiet = { log: console.log, warn: console.warn };
  console.log = () => {}; console.warn = () => {};
  const root = path.join(__dirname, '..', '..');
  require(path.join(root, 'server.js'));
  const db = require(path.join(root, 'db.js'));
  console.log = quiet.log; console.warn = quiet.warn;

  const jwtSecret = process.env.JWT_SECRET;
  const tokenFor = (u) => stubs.modules.jsonwebtoken.sign({ userId: u.id, username: u.username, role: u.role, organization: u.organization || null }, jwtSecret);
  const agentTokenFor = (u, taskId) => stubs.modules.jsonwebtoken.sign({ userId: u.id, username: u.username, role: 'client', scope: 'agent', taskId }, jwtSecret);

  // daysOld: how long ago the account was created (> 30 = the free trial is over)
  async function addUser(username, role, { daysOld = 0 } = {}) {
    const created = new Date(Date.now() - daysOld * 86400000).toISOString();
    const r = await db.run("INSERT INTO users (username, email, password_hash, role, organization, email_verified, status, created_at) VALUES (?, ?, 'h:x', ?, ?, 1, 'ACTIVE', ?)",
      [username, `${username}@example.com`, role, `${username} Org`, created]);
    return { id: r.lastInsertRowid, username, role, organization: `${username} Org` };
  }

  function match(routePath, actual) {
    const a = routePath.split('/'); const b = actual.split('?')[0].split('/');
    if (a.length !== b.length) return null;
    const params = {};
    for (let i = 0; i < a.length; i += 1) {
      if (a[i].startsWith(':')) params[a[i].slice(1)] = decodeURIComponent(b[i]);
      else if (a[i] !== b[i]) return null;
    }
    return params;
  }

  // Runs one request through the real route handlers (auth middleware included)
  function call(method, url, { user, body, token } = {}) {
    const route = stubs.routes.find((r) => r.method === method && match(r.path, url));
    if (!route) throw new Error(`no route ${method} ${url}`);
    const query = Object.fromEntries(new URLSearchParams(url.split('?')[1] || ''));
    const auth = token || (user ? tokenFor(user) : '');
    return new Promise((resolve, reject) => {
      const req = { method, originalUrl: url, headers: auth ? { authorization: `Bearer ${auth}` } : {}, body: body || {}, query, params: match(route.path, url), ip: '127.0.0.1' };
      const res = { statusCode: 200, headers: {}, status(c) { this.statusCode = c; return this; }, setHeader(k, v) { this.headers[k] = v; }, json(b) { resolve({ status: this.statusCode, body: b }); } };
      const run = (i) => { try { const out = route.handlers[i](req, res, () => run(i + 1)); if (out && out.catch) out.catch(reject); } catch (e) { reject(e); } };
      run(0);
    });
  }

  // Open task countdowns (setTimeout) would keep the process running after the last test
  require('node:test').after(() => setTimeout(() => process.exit(process.exitCode || 0), 50));

  return { db, call, addUser, tokenFor, agentTokenFor, io: stubs.ioState, connect: (token) => stubs.ioState.connect(token) };
}

module.exports = { loadServer };
