// Friendly check: this app needs Node.js 22.13+ (built-in SQLite). Older Node crashes right away and the page shows "server not running".
{
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 13)) {
    console.error(`\n[START] You have Node.js ${process.versions.node}. ScopeDesk needs 22.13 or newer. Install the LTS version from https://nodejs.org and run this again.\n`);
    process.exit(1);
  }
}
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Load settings (SMTP email etc.) from a .env file next to server.js, if you created one
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch (_) { /* no .env file: that is fine */ }

const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const db = require('./db');
const createSessionTimers = require('./server/session-timers');
const createRemoteControl = require('./server/remote-control');
const policyCatalog = require('./server/policy-catalog');
const taskScope = require('./server/task-scope');
const { createMailer, isPermanentRecipientFailure, testSmtpLogin } = require('./server/mailer');
const { createOtpService } = require('./server/otp');
const { effectiveMailEnv, saveMailSettings, isLocalRequest, settingsFile } = require('./server/mail-settings');
const { validateEmailAddress } = require('./server/email-check');
const appCatalog = require('./agent/app-catalog');
const { buildRtcConfig, relayConfigured, describeIceSetup } = require('./server/rtc-config');
const { loadJwtSecret, buildOriginChecker } = require('./server/net-config');
const { createBilling } = require('./server/billing');
const { createAssistant } = require('./server/assistant');
const { createConversations } = require('./server/conversations');
const { createAccessRequests } = require('./server/access-requests');
const { createWorkspace } = require('./server/workspace');

const app = express();
const server = http.createServer(app);
// Railway sets RAILWAY_PROJECT_ID on every deployment, so a Railway deploy is always treated as production
const IS_PRODUCTION = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_PROJECT_ID;

// CORS: the front-end may live on Vercel, GitHub Pages or Railway itself while the API/Socket.IO lives on Railway.
// See server/net-config.js for the exact rules (and CORS_ORIGIN for adding your own domain).
const isAllowedOrigin = buildOriginChecker({ env: process.env, isProduction: IS_PRODUCTION });
function corsOrigin(origin, cb) {
  if (!isAllowedOrigin(origin) && origin) console.warn(`[CORS] Blocked origin ${origin}. Add it to CORS_ORIGIN in Railway > Variables if it is yours.`);
  cb(null, isAllowedOrigin(origin));
}
const io = new Server(server, {
  cors: { origin: corsOrigin, methods: ['GET', 'POST'], credentials: false },   // auth is a bearer token in the handshake, not a cookie
  transports: ['websocket', 'polling'],                                          // polling first-hop works through strict proxies; upgrade follows
  pingInterval: 20000,
  pingTimeout: 25000                                                             // survive Railway's proxy idle timeouts and mobile networks
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const BUILD = '2026-11-06-v19'; // shown on the page so you can tell which version you are looking at
const APP_URL = (process.env.APP_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `http://localhost:${PORT}`)).replace(/\/+$/, '');
if (IS_PRODUCTION) app.set('trust proxy', 1); // behind Railway's proxy: real client IPs for rate limits

// ================= EMAIL (SMTP) =================
// Real emails through nodemailer (server/mailer.js). Settings come from SMTP_HOST (default smtp.gmail.com), SMTP_PORT (default 587),
// SMTP_USER and SMTP_PASS in the environment / .env, OR from the one-time "Connect email" screen in the app (server/mail-settings.js).
// Environment variables always win. Codes are only ever sent by email: they are never printed to the console or written to a log.
function buildMailer() { return createMailer({ env: effectiveMailEnv(process.env), log: console }); }
let activeMailer = buildMailer();
const mailer = {
  get configured() { return activeMailer.configured; },
  sendResetCode: (...args) => activeMailer.sendResetCode(...args),
  sendVerificationCode: (...args) => activeMailer.sendVerificationCode(...args),
  verify: () => activeMailer.verify(),
  reload() { activeMailer = buildMailer(); return activeMailer.verify(); }   // picks up settings saved from the app, no restart needed
};
mailer.verify().catch(() => { /* already reported by verify() */ });

// ================= PAYMENTS (Razorpay) =================
// No RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET -> payments OFF: every task is free and unlimited (legacy behaviour). See server/billing.js.
const billing = createBilling({ env: process.env, log: console });
// AI assistant (Gemini or OpenAI). Off when neither GEMINI_API_KEY nor OPENAI_API_KEY is set. Who may use it is decided per request from the client's plan.
const assistant = createAssistant({ env: process.env, log: console });

// ================= CONSTANTS =================
const DUPLICATE_ACCOUNT_MSG = 'An account with this email/username already exists. Please Sign In instead.';
const SHORT_PASSWORD_MSG = 'Password must be at least 8 characters long.';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const USERNAME_RE = /^[A-Za-z0-9._-]{3,50}$/;

// JWT secret: from env, else a random one saved next to the database. The server never refuses to start over this
// (a missing variable used to crash the Railway container on boot). See server/net-config.js.
const JWT_SECRET = loadJwtSecret({
  env: process.env,
  dataDir: path.dirname(process.env.DB_PATH || path.join(__dirname, 'scopedesk.db')),
  log: console
}).secret;

// ================= MIDDLEWARE =================
app.use(cors({ origin: corsOrigin, exposedHeaders: ['X-New-Token'] }));
app.use(express.json({ limit: '50kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});
app.get('/api/health', (req, res) => res.status(200).json({ app: 'scopedesk', ok: true, status: 'online', build: BUILD , relay: relayConfigured() }));
// IMPORTANT: serve ONLY the /public folder (never the project root, which holds the database and secrets)
// no-cache: the browser must re-check files on every load, so an old cached script.js can never run against a new server
app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache')
}));

// ================= HELPERS =================
const TOKEN_LIFETIME = '7d';
const TOKEN_REFRESH_AFTER_MS = 30 * 60 * 1000; // active users get a fresh token every 30 min (sliding login)
const AUTH_MESSAGES = {
  NO_TOKEN: 'Please sign in to continue.',
  TOKEN_EXPIRED: 'Your login expired. Please sign in again.',
  TOKEN_INVALID: 'Your login is no longer valid on this server (it may have been reset). Please sign in again.'
};

function issueToken(user) {
  return jwt.sign(
    { userId: user.userId, username: user.username, role: user.role, organization: user.organization || null },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: TOKEN_LIFETIME }
  );
}

function readToken(token) {
  if (!token) return { code: 'NO_TOKEN' };
  try {
    return { payload: jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) };
  } catch (err) {
    return { code: err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID' };
  }
}

function verifyToken(token) {
  return readToken(token).payload || null;
}

function authenticateToken(req, res, next) {
  const header = req.headers['authorization'];
  const { payload, code } = readToken(header && header.split(' ')[1]);
  if (!payload) {
    console.warn(`[AUTH] ${req.method} ${req.originalUrl} rejected: ${code}`);
    return res.status(401).json({ error: AUTH_MESSAGES[code], code });
  }
  if (payload.scope === 'agent') return res.status(403).json({ error: 'Host-agent tokens cannot call this API.' });
  req.user = { ...payload, userId: Number(payload.userId) };

  // Sliding login: while you are active, quietly hand the browser a fresh token so you are never logged out mid-work
  if (Date.now() - (payload.iat || 0) * 1000 > TOKEN_REFRESH_AFTER_MS) {
    res.setHeader('X-New-Token', issueToken(req.user));
  }
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.user.role !== role) {
      return res.status(403).json({ error: `Only ${role} accounts can do this.` });
    }
    next();
  };
}

// SQLite's datetime('now') has no timezone; treat those values as UTC.
function parseDbDate(value) {
  if (!value) return new Date(NaN);
  const s = String(value);
  if (s.includes('T') || s.endsWith('Z')) return new Date(s);
  return new Date(s.replace(' ', 'T') + 'Z');
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function logAudit(userId, action, details) {
  return db.run('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)',
    [userId || null, action, JSON.stringify(details || {})]).catch(() => {});
}

// Simple in-memory brute-force limiter (resets on server restart)
const attempts = new Map(); // key -> { count, resetAt }
function isLimited(key, max) {
  const entry = attempts.get(key);
  return !!entry && entry.resetAt > Date.now() && entry.count >= max;
}
function recordAttempt(key, windowMs) {
  const entry = attempts.get(key);
  if (!entry || entry.resetAt <= Date.now()) {
    attempts.set(key, { count: 1, resetAt: Date.now() + windowMs });
  } else {
    entry.count += 1;
  }
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) if (v.resetAt <= now) attempts.delete(k);
}, 60000).unref();

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) return SHORT_PASSWORD_MSG;
  if (Buffer.byteLength(password, 'utf8') > 72) return 'Password must be 72 bytes or fewer.';
  return null;
}

const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10); // keeps login timing equal for unknown users

// ================= SOCKET.IO: CONNECTION REGISTRY =================
// userId -> Set of socket ids. A user may have several tabs/devices connected.
const userSockets = new Map();

function addSocket(userId, socketId) {
  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId).add(socketId);
}
function removeSocket(userId, socketId) {
  const set = userSockets.get(userId);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) userSockets.delete(userId);
}

// Sends an event ONLY to the sockets that belong to this user id. Returns how many sockets got it.
function emitToUser(userId, event, payload) {
  const ids = userSockets.get(Number(userId));
  if (!ids || ids.size === 0) return 0;
  ids.forEach((socketId) => io.to(socketId).emit(event, payload));
  return ids.size;
}

// Socket handshake authentication: identity comes from the signed JWT, never from client-sent fields.
io.use((socket, next) => {
  const payload = verifyToken(socket.handshake.auth && socket.handshake.auth.token);
  if (!payload) return next(new Error('Authentication required'));
  socket.data.user = { userId: Number(payload.userId), username: payload.username, role: payload.role };
  if (payload.scope !== 'agent') return next();
  // Host agent: may only do agent things, and only while its task is open. An agent pairing JWT stays cryptographically valid until
  // the window ends, so a terminated task must be refused HERE, or a restarted / reconnecting agent could open a fresh socket.
  const taskId = Number(payload.taskId);
  socket.data.agent = { taskId };
  db.get('SELECT client_id, status, token_revoked FROM tasks WHERE id = ?', [taskId])
    .then((task) => {
      if (!task || task.client_id !== Number(payload.userId) || task.token_revoked || !['pending', 'active'].includes(task.status)) {
        return next(new Error('Authentication required'));   // the agent treats this as "token revoked" and exits
      }
      next();
    })
    .catch(() => next(new Error('Authentication required')));
});

// ================= SESSION LIFECYCLE (shared by REST + sockets) =================
async function getVendorUserIds(taskId) {
  const rows = await db.all('SELECT DISTINCT vendor_id FROM remote_sessions WHERE task_id = ? AND vendor_id IS NOT NULL', [taskId]);
  return rows.map((r) => r.vendor_id);
}

// Ends a task. Pushes `force-terminate` to the vendor's sockets and `session-ended` to the client's sockets.
// HARD TERMINATION. In this order, and safe to call again:
//   1. the task row flips to its final status AND its token is revoked, in ONE conditional UPDATE (two callers cannot both "win"),
//   2. input is halted and the host agent's WebSocket is dropped (remoteControl.teardown), the WebRTC room is emptied (cutStream),
//   3. the vendor gets `force-terminate`, the client gets `session-ended`.
// When the task had already ended (e.g. a breach auto-terminated it a moment before the Client pressed "Terminate Session Now"),
// step 2 runs again anyway and the result is { ok: true, alreadyEnded: true }: the kill switch never reports a failure for a
// session that is in fact dead.
async function terminateTask(taskId, { reason, message, actorId, finalStatus = 'terminated', sessionStatus = 'terminated' }) {
  const task = await db.get('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!task) return { ok: false, error: 'Task not found.' };

  const flip = await db.run("UPDATE tasks SET status = ?, token_revoked = 1 WHERE id = ? AND status IN ('pending', 'active')", [finalStatus, taskId]);
  if (!flip.changes) {
    await db.run('UPDATE tasks SET token_revoked = 1 WHERE id = ?', [taskId]);
    conversations.endCallsForTask(taskId, 'session-ended');
    accessRequests.expireTask(taskId).catch(() => {});
    timers.cancel(taskId);
    remoteControl.teardown(taskId, reason);
    cutStream(taskId, reason, message);
    return { ok: true, alreadyEnded: true, status: task.status, task };
  }

  const now = new Date().toISOString();
  await db.run("UPDATE remote_sessions SET status = ?, ended_at = ?, end_reason = ? WHERE task_id = ? AND status = 'active'",
    [sessionStatus, now, reason, taskId]);
  // Teardown FIRST: nothing the vendor sends after this line reaches the Client's PC
  conversations.endCallsForTask(taskId, 'session-ended');
  accessRequests.expireTask(taskId).catch(() => {});
  timers.cancel(taskId);
  remoteControl.teardown(taskId, reason);   // input stops, host agent sockets drop, per-task memory is released
  cutStream(taskId, reason, message);        // both browsers close their WebRTC connection; the stream room is emptied
  await logAudit(actorId, 'SESSION_' + finalStatus.toUpperCase(), { taskId, reason, tokenRevoked: true });

  const payload = { taskId, title: task.title, reason, message, status: finalStatus, tokenRevoked: true };
  for (const vendorId of await getVendorUserIds(taskId)) emitToUser(vendorId, 'force-terminate', payload);
  emitToUser(task.client_id, 'session-ended', payload);
  return { ok: true, task: { ...task, status: finalStatus, token_revoked: 1 } };
}

async function expireOverdueTasks() {
  const rows = await db.all("SELECT id, window_end FROM tasks WHERE status IN ('pending', 'active')");
  const now = Date.now();
  for (const row of rows) {
    if (parseDbDate(row.window_end).getTime() <= now) {
      await terminateTask(row.id, {
        reason: 'time_expired',
        message: 'The approved time window has ended. Session closed.',
        actorId: null,
        finalStatus: 'expired',
        sessionStatus: 'expired'
      });
    }
  }
}
setInterval(() => expireOverdueTasks().catch((e) => console.error('[EXPIRY]', e.message)), 15000).unref();

// ================= WEBRTC SIGNALING HELPERS =================
// One Socket.IO room per task: "task:<id>". Only that task's Client and its active Vendor may join.
const rtcRoom = (taskId) => `task:${taskId}`;

// Instantly tells both peers to close their RTCPeerConnection, then removes everyone from the room.
function cutStream(taskId, reason, message) {
  const room = rtcRoom(taskId);
  io.to(room).emit('webrtc-close', { taskId, reason, message: message || 'The remote connection was closed.' });
  // Revoke each member's stream permission too, not only the room membership: otherwise the socket's own
  // "joined" mark would still let it push signals / screen frames for this task.
  const members = (io.sockets.adapter.rooms && io.sockets.adapter.rooms.get(room)) || new Set();
  for (const id of members) {
    const s = io.sockets.sockets.get(id);
    if (s && s.data && s.data.rtc) s.data.rtc.delete(taskId);
  }
  io.in(room).socketsLeave(room);
}

// Returns 'client' | 'vendor' if this user may use the task's stream, otherwise null.
async function authorizeRtc(user, taskId) {
  if (!Number.isInteger(taskId)) return null;
  const task = await db.get('SELECT client_id, status FROM tasks WHERE id = ?', [taskId]);
  if (!task || task.status !== 'active') return null;
  if (user.role === 'client') return task.client_id === user.userId ? 'client' : null;
  const session = await db.get("SELECT id FROM remote_sessions WHERE task_id = ? AND vendor_id = ? AND status = 'active'", [taskId, user.userId]);
  return session ? 'vendor' : null;
}

// Sends an event to the task's Client and to every Vendor who has a session on it
async function emitToTask(taskId, event, payload) {
  const task = await db.get('SELECT client_id FROM tasks WHERE id = ?', [taskId]);
  if (!task) return;
  emitToUser(task.client_id, event, payload);
  for (const vendorId of await getVendorUserIds(taskId)) emitToUser(vendorId, event, payload);
}

// Per-task countdown: when the approved window ends the task is terminated, both peers are told to hang up, input stops.
const timers = createSessionTimers({
  db, parseDbDate,
  onExpire: (taskId) => terminateTask(taskId, {
    reason: 'time_expired', message: 'The approved time window has ended. Session closed.',
    actorId: null, finalStatus: 'expired', sessionStatus: 'expired'
  })
});
const remoteControl = createRemoteControl({
  io, db, authorizeRtc, emitToTask, verifyToken, timers, onBreach: (b) => handleVendorBreach(b),
  // The Client pressed Start / Stop remote control: recorded with the real reason (audit log), never with input content
  onControlChange: ({ taskId, userId, active, reason }) => logAudit(userId, active ? 'REMOTE_CONTROL_STARTED' : 'REMOTE_CONTROL_STOPPED', { taskId, reason }),
  onAudit: (userId, action, details) => logAudit(userId, action, details)
});

// "Request Additional Access": the vendor asks for more apps/folders, only the client can approve (server/access-requests.js)
const accessRequests = createAccessRequests({
  db, emitToUser, logAudit,
  sendToAgents: (taskId, ev, payload) => remoteControl.sendToAgents(taskId, ev, payload),
  onScopeChanged: (taskId) => remoteControl.invalidateScope(taskId)
});

// Shared Workspace: projects/groups of tickets (server/workspace.js)
const workspace = createWorkspace({ db, emitToUser, parseDbDate, logAudit });

// Client <-> vendor messages and voice calls, per ticket (server/conversations.js)
const conversations = createConversations({ db, io, emitToUser, isVendorBlocked, parseDbDate, logAudit });

// Set AUTO_CUT_STREAM=false in .env to keep the stream alive until the Client presses "Terminate Session Now".
// Default: a violation locks the vendor out for good and the Client can only terminate. Set ALLOW_RESUME_AFTER_VIOLATION=true to let the Client resume.
const ALLOW_RESUME = process.env.ALLOW_RESUME_AFTER_VIOLATION === 'true';
const AUTO_CUT_STREAM = process.env.AUTO_CUT_STREAM !== 'false';

// The Client's PC is where the vendor's actions really happen, so the trusted monitor (agent/client-agent.js)
// runs there and reports with this event. The task and client come from the database, never from the payload.
async function handleHostViolation(user, payload, socket) {
  if (user.role !== 'client') return { ok: false, error: 'Only the host agent (client account) can report this.' };
  const taskId = Number(payload && payload.taskId);
  if (!Number.isInteger(taskId)) return { ok: false, error: 'taskId is required.' };
  if (socket.data.agent && socket.data.agent.taskId !== taskId) return { ok: false, error: 'This agent is paired with a different task.' };

  const session = await db.get(`
    SELECT rs.id, rs.client_id, rs.vendor_name, t.title, t.alerts_enabled
    FROM remote_sessions rs JOIN tasks t ON t.id = rs.task_id
    WHERE rs.task_id = ? AND rs.client_id = ? AND rs.status = 'active' AND t.status = 'active'
    ORDER BY rs.id DESC LIMIT 1
  `, [taskId, user.userId]);
  if (!session) return { ok: false, error: 'No active session for this task.' };
  return enforceBreach(session, taskId, {
    processName: payload && payload.processName,
    kind: payload && payload.kind,
    detail: payload && payload.detail,
    actorId: user.userId
  });
}

// Shared by every breach source (host agent report, server-side scope check): record it, halt input, end the task, alert the Client.
async function enforceBreach(session, taskId, info) {
  const alertsOn = session.alerts_enabled !== 0;
  const processName = String(info.processName || 'unknown').replace(/[^\w .\-\\/()+]/g, '').slice(0, 255) || 'unknown';
  const kind = info.kind === 'path' ? 'path' : 'app';
  const detail = String(info.detail || '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 300); // shown as text only, never as HTML
  const what = kind === 'path'
    ? `${processName} opened a folder outside the approved paths${detail ? ': ' + detail : ''}`
    : `${processName} was brought to the front but is not approved for this task`;
  const occurredAt = new Date().toISOString();
  // 'pending_client' until an alert has really reached the Client's screen (they may be offline, or the PC may be locked)
  const insert = await db.run(`
    INSERT INTO intrusion_events (session_id, task_id, event_type, process_name, details, severity, action_taken, occurred_at)
    VALUES (?, ?, ?, ?, ?, 'critical', ?, ?)
  `, [session.id, taskId, kind === 'path' ? 'out_of_scope_path' : 'unapproved_process', processName, what, alertsOn ? 'pending_client' : 'alert_suppressed', occurredAt]);
  const eventId = insert.lastInsertRowid;

  // Enforcement never depends on the alert switch: the vendor's input stops at once and the stream is cut.
  remoteControl.halt(taskId, 'violation', { permanent: !ALLOW_RESUME });
  let terminated = false;
  if (!ALLOW_RESUME) {
    // Breach protocol: the task ends NOW (vendor gets force-terminate, both peers get webrtc-close, timers are cancelled).
    const ended = await terminateTask(taskId, { reason: 'security_violation', message: `Security violation: ${what}.`, actorId: info.actorId });
    terminated = !!ended.ok;
  } else if (AUTO_CUT_STREAM) {
    cutStream(taskId, 'security_violation', `Security violation: ${what}.`);
  }

  let delivered = 0;
  if (alertsOn) {
    const common = { taskId, taskTitle: session.title, processName, kind, detail, what, vendor: session.vendor_name, eventId, occurredAt };
    delivered = terminated
      // High-priority termination alert: the Client's page renders the blocking defensive overlay.
      ? emitToUser(session.client_id, 'termination-alert', { ...common, severity: 'critical', priority: 'high', locked: true, message: 'Session terminated: the vendor tried to go outside the approved scope.' })
      : emitToUser(session.client_id, 'violation-alert', { ...common, message: 'Vendor accessed unauthorized data!', canResume: ALLOW_RESUME });
    if (delivered > 0) await db.run("UPDATE intrusion_events SET action_taken = 'client_notified' WHERE id = ?", [eventId]);
  }
  await logAudit(info.actorId, 'HOST_VIOLATION_REPORTED', { taskId, processName, kind, detail, terminated, alertsOn, alertDelivered: delivered > 0 });
  return { ok: true, terminated, streamCut: terminated || AUTO_CUT_STREAM, alertDelivered: delivered > 0 };
}

// The server itself caught the Vendor asking for a folder outside the approved paths (see remote-control.js).
async function handleVendorBreach({ taskId, user, kind, processName, detail }) {
  const session = await db.get(`
    SELECT rs.id, rs.client_id, rs.vendor_name, t.title, t.alerts_enabled
    FROM remote_sessions rs JOIN tasks t ON t.id = rs.task_id
    WHERE rs.task_id = ? AND rs.vendor_id = ? AND rs.status = 'active' AND t.status = 'active'
    ORDER BY rs.id DESC LIMIT 1
  `, [taskId, user.userId]);
  if (!session) return { ok: false, error: 'No active session for this task.' };
  return enforceBreach(session, taskId, { processName, kind, detail, actorId: user.userId });
}

// Violations are reported ONLY by the host agent on the Client's PC (handleHostViolation above).
// The old vendor-side report path was removed: a vendor's own browser must not be what polices the vendor.

// If the client was offline when a violation happened, show it as soon as they reconnect
async function deliverPendingAlerts(user, socket) {
  const pending = await db.all(`
    SELECT e.id, e.task_id, e.process_name, e.details, e.occurred_at, t.title, t.status, t.vendor_name
    FROM intrusion_events e
    JOIN tasks t ON t.id = e.task_id
    WHERE t.client_id = ? AND t.status IN ('active', 'terminated') AND t.alerts_enabled = 1 AND e.action_taken = 'pending_client'
    ORDER BY e.id ASC
  `, [user.userId]);
  for (const e of pending) {
    const common = { taskId: e.task_id, taskTitle: e.title, processName: e.process_name, what: e.details, vendor: e.vendor_name, eventId: e.id, occurredAt: e.occurred_at };
    if (e.status === 'terminated') socket.emit('termination-alert', { ...common, severity: 'critical', priority: 'high', locked: true, message: 'Session terminated: the vendor tried to go outside the approved scope.' });
    else socket.emit('violation-alert', { ...common, message: 'Vendor accessed unauthorized data!', canResume: ALLOW_RESUME });
    await db.run("UPDATE intrusion_events SET action_taken = 'client_notified' WHERE id = ?", [e.id]);
  }
}

// A support request sent while the vendor was offline (or whose socket dropped) would otherwise be lost: replay open ones on connect
async function deliverPendingRequests(user, socket) {
  const rows = await db.all(`
    SELECT t.id, t.title, t.duration_minutes, t.window_end, u.organization AS client_org, u.username AS client_name
    FROM tasks t LEFT JOIN users u ON u.id = t.client_id
    WHERE t.assigned_vendor_user_id = ? AND t.status = 'pending'
    ORDER BY t.id ASC
  `, [user.userId]);
  const now = Date.now();
  for (const r of rows) {
    if (parseDbDate(r.window_end).getTime() <= now) continue;
    socket.emit('task-request', { taskId: r.id, title: r.title, client: r.client_org || r.client_name, clientName: r.client_org || r.client_name, duration: r.duration_minutes, durationMinutes: r.duration_minutes, replay: true });
  }
}

io.on('connection', (socket) => {
  const user = socket.data.user;

  // HOST AGENT sockets get a tiny, fixed set of abilities and nothing else.
  // They are deliberately NOT registered under the client's user id: emitToUser(client, ...) is meant for the Client's browser
  // tabs and carries events for EVERY task of that client ('session-ended', 'control-halt', 'control-resume'). Registering the
  // agent there made a ticket that expired or was terminated elsewhere shut down the agent of the running task (the
  // Start/Stop remote control button then flipped back by itself). The agent receives only its own task's events, via
  // remoteControl.sendToAgents().
  if (socket.data.agent) {
    remoteControl.registerAgent(socket);
    const lastHost = new Map();
    socket.on('host-violation', async (payload, ack) => {
      const reply = (b) => { if (typeof ack === 'function') ack(b); };
      try {
        const key = `${payload && payload.taskId}|${payload && payload.processName}`;
        if (Date.now() - (lastHost.get(key) || 0) < 3000) return reply({ ok: true, throttled: true });
        lastHost.set(key, Date.now());
        reply(await handleHostViolation(user, payload, socket));
      } catch (err) { console.error('[WS] host-violation error:', err.message); reply({ ok: false, error: 'Server error.' }); }
    });
    return;
  }
  addSocket(user.userId, socket.id);
  remoteControl.registerBrowser(socket, user);
  conversations.registerBrowser(socket, user);

  const respond = (ack, body) => { if (typeof ack === 'function') ack(body); };

  // ---- WebRTC signaling (the server only relays; video never passes through it) ----
  socket.data.rtc = new Set();
  socket.on('webrtc-join', async (payload, ack) => {
    try {
      const taskId = Number(payload && payload.taskId);
      const wantedRole = payload && payload.role;
      const role = await authorizeRtc(user, taskId);
      if (!role || (wantedRole && wantedRole !== role)) return respond(ack, { ok: false, error: 'You are not allowed to use the stream for this task (it must be active and yours).' });
      if (role === 'vendor' && !ALLOW_RESUME && remoteControl.isHalted(taskId)) return respond(ack, { ok: false, error: 'Your access to this session was revoked after a security violation.' });
      const room = rtcRoom(taskId);
      const peers = [...(await io.in(room).fetchSockets())].filter((s) => s.id !== socket.id).map((s) => s.data.user.role);
      await timers.ensure(taskId).catch((e) => console.error('[TIMER] ensure failed:', e.message));   // a connection is forming: the countdown must be running
      socket.join(room);
      socket.data.rtc.add(taskId);
      socket.to(room).emit('webrtc-peer-joined', { role });
      respond(ack, { ok: true, role, peers });
    } catch (err) {
      console.error('[WS] webrtc-join error:', err.message);
      respond(ack, { ok: false, error: 'Server error.' });
    }
  });

  socket.on('webrtc-signal', (msg) => {
    const taskId = Number(msg && msg.taskId);
    if (!socket.data.rtc.has(taskId)) return; // must have joined this task's room first
    if (!['offer', 'answer', 'candidate', 'restart', 'frames'].includes(msg.type)) return;
    if (JSON.stringify(msg).length > 20000) return;
    const { type, offer, answer, candidate } = msg;
    const on = type === 'frames' ? msg.on === true : undefined;          // vendor: "send the screen through the server" on/off
    socket.to(rtcRoom(taskId)).emit('webrtc-signal', { taskId, type, offer, answer, candidate, on });
  });

  // SCREEN RELAY FALLBACK. When the two computers cannot reach each other (different networks, strict firewalls, no TURN relay set up)
  // the Client's page sends compressed screen pictures here and they are passed to the task's room. Slower than WebRTC (a few frames
  // per second) but it always works where the ScopeDesk server is reachable. Only the task's own Client may send; nothing after a halt.
  let frameWindow = 0, frameCount = 0;
  socket.on('screen-frame', (f, ack) => {
    const reply = (b) => { if (typeof ack === 'function') ack(b); };
    const taskId = Number(f && f.taskId);
    if (user.role !== 'client' || !socket.data.rtc.has(taskId) || remoteControl.isHalted(taskId)) return reply({ ok: false });
    const data = f.data;
    const len = data && (data.byteLength !== undefined ? data.byteLength : data.length);
    const w = Number(f.w), h = Number(f.h);
    if (!(len > 0) || len > 700 * 1024 || !Number.isInteger(w) || !Number.isInteger(h) || w < 16 || h < 16 || w > 4096 || h > 4096) return reply({ ok: false });
    const now = Date.now();
    if (now - frameWindow > 1000) { frameWindow = now; frameCount = 0; }
    if (++frameCount > 15) return reply({ ok: false, error: 'rate' });
    socket.to(rtcRoom(taskId)).volatile.emit('screen-frame', { taskId, w, h, data });
    reply({ ok: true });
  });

  socket.on('webrtc-leave', (payload) => {
    const taskId = Number(payload && payload.taskId);
    socket.leave(rtcRoom(taskId));
    socket.data.rtc.delete(taskId);
    socket.to(rtcRoom(taskId)).emit('webrtc-peer-left', { role: user.role });
  });

  // CLIENT -> SERVER (the "Terminate Session Now" button). Server then sends `force-terminate` to the vendor.
  socket.on('terminate-session', async (payload, ack) => {
    try {
      if (user.role !== 'client') return respond(ack, { ok: false, error: 'Only clients can terminate sessions.' });
      const taskId = Number(payload && payload.taskId);
      const task = Number.isInteger(taskId) ? await db.get('SELECT client_id FROM tasks WHERE id = ?', [taskId]) : null;
      // Ownership check: you can only terminate tasks YOU created
      if (!task || task.client_id !== user.userId) return respond(ack, { ok: false, error: 'Task not found.' });

      const result = await terminateTask(taskId, {
        reason: 'client_terminated',
        message: 'The client ended this session.',
        actorId: user.userId
      });
      respond(ack, { ok: result.ok, alreadyEnded: !!result.alreadyEnded, status: result.task && result.task.status, tokenRevoked: result.ok, error: result.error });
    } catch (err) {
      console.error('[WS] terminate-session error:', err.message);
      respond(ack, { ok: false, error: 'Server error.' });
    }
  });

  // CLIENT -> SERVER ("Resume session" in the alert dialog): lifts a violation halt. Ownership checked.
  socket.on('resume-after-violation', async (payload, ack) => {
    const taskId = Number(payload && payload.taskId);
    const task = Number.isInteger(taskId) ? await db.get('SELECT client_id, status FROM tasks WHERE id = ?', [taskId]) : null;
    const ok = ALLOW_RESUME && !!task && user.role === 'client' && task.client_id === user.userId && task.status === 'active' && remoteControl.resume(taskId);
    if (typeof ack === 'function') ack({ ok });
  });

  socket.on('disconnect', () => removeSocket(user.userId, socket.id));

  if (user.role === 'client') deliverPendingAlerts(user, socket).catch((e) => console.error('[WS] pending alerts:', e.message));
  if (user.role === 'vendor') deliverPendingRequests(user, socket).catch((e) => console.error('[WS] pending requests:', e.message));
});

// ================= AUTHENTICATION ROUTES =================
// Sign-up flow: the address is checked (syntax + DNS) -> the account is created DISABLED for login (status PENDING_VERIFICATION) ->
// a 6-digit code is emailed -> POST /api/auth/verify-email activates it. Login refuses unverified accounts.
// Local development without SMTP: set EMAIL_VERIFICATION=off in .env (never on a real server).
const EMAIL_VERIFICATION_ON = String(process.env.EMAIL_VERIFICATION || 'on').toLowerCase() !== 'off';
const OTP_BAD_MSG = 'Incorrect or expired code. Please try again.';
const OTP_LOCKED_MSG = 'Too many incorrect attempts. Press "Resend Code" to get a new one.';
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAIL_NOT_SET_UP_MSG = 'We cannot send verification emails yet because email is not connected on this server.';
const otp = createOtpService({ db, secret: JWT_SECRET, ttlMs: 15 * 60 * 1000, maxWrong: 5 });

// "Email not connected" answer. canSetup tells the page whether it may offer the in-app setup screen (only on the server's own computer).
const mailNotSetUp = (req) => ({ error: MAIL_NOT_SET_UP_MSG, code: 'MAIL_NOT_CONFIGURED', canSetup: !IS_PRODUCTION && isLocalRequest(req) });

// Creates a fresh 15-minute code (older ones stop working) and emails it. Throws when the email cannot be sent.
async function issueVerificationCode(user) {
  const issued = await otp.issue(user.id);
  try {
    await mailer.sendVerificationCode(user.email, user.username, issued.code);
  } catch (err) {
    await otp.cancel(issued.id).catch(() => {});   // an undelivered code must not stay usable
    throw err;
  }
}

// An account that never confirmed its address holds the username/email hostage; anyone may claim it again, and it is removed after 24 hours
async function deleteUnverifiedAccount(userId) {
  await db.run('DELETE FROM email_verifications WHERE user_id = ?', [userId]);
  await db.run('DELETE FROM vendors WHERE vendor_user_id = ?', [userId]);
  await db.run("DELETE FROM users WHERE id = ? AND status = 'PENDING_VERIFICATION'", [userId]);
}
async function purgeStaleUnverifiedAccounts() {
  const stale = await db.all("SELECT id FROM users WHERE status = 'PENDING_VERIFICATION' AND created_at < datetime('now', '-1 day')");
  for (const u of stale) await deleteUnverifiedAccount(u.id);
}
setInterval(() => purgeStaleUnverifiedAccounts().catch((e) => console.error('[VERIFY] cleanup:', e.message)), 60 * 60 * 1000).unref();

async function registerHandler(req, res) {
  let createdUserId = null;
  try {
    const body = req.body || {};
    const cleanUsername = String(body.username || '').trim();
    const password = body.password;
    const role = body.role;
    const organization = body.organization ? String(body.organization).trim().slice(0, 150) : null;

    if (!cleanUsername || !body.email || !password || !role) {
      return res.status(400).json({ error: 'Username, email, password, and role are required.' });
    }
    if (!USERNAME_RE.test(cleanUsername)) {
      return res.status(400).json({ error: 'Username must be 3-50 characters using only letters, numbers, dot, dash or underscore (no @ or spaces). Put your email in the Email field.' });
    }
    if (!['client', 'vendor'].includes(role)) {
      return res.status(400).json({ error: 'Role must be either client or vendor.' });
    }
    const passwordError = validatePassword(password);
    if (passwordError) return res.status(400).json({ error: passwordError });

    const ipKey = `register|${req.ip}`;
    if (isLimited(ipKey, 10)) return res.status(429).json({ error: 'Too many sign-up attempts. Please try again in a few minutes.' });
    recordAttempt(ipKey, 15 * 60 * 1000);

    // Syntax, disposable-domain and DNS (can this domain receive mail?) checks
    const checked = await validateEmailAddress(String(body.email), { env: process.env });
    if (!checked.ok) return res.status(400).json({ error: checked.error });
    const cleanEmail = checked.email;
    if (!EMAIL_RE.test(cleanEmail)) return res.status(400).json({ error: 'Please enter a valid email address.' });

    if (EMAIL_VERIFICATION_ON && !mailer.configured) return res.status(503).json(mailNotSetUp(req));

    // De-duplication: username OR email (both columns are case-insensitive). Unverified leftovers are replaced, verified accounts are never touched.
    const clashes = await db.all('SELECT id, status FROM users WHERE username = ? OR email = ?', [cleanUsername, cleanEmail]);
    if (clashes.some((c) => c.status !== 'PENDING_VERIFICATION')) return res.status(409).json({ error: DUPLICATE_ACCOUNT_MSG });
    for (const c of clashes) await deleteUnverifiedAccount(c.id);

    const passwordHash = await bcrypt.hash(password, 12);
    let result;
    try {
      result = await db.run(
        'INSERT INTO users (username, email, password_hash, role, organization, email_verified, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [cleanUsername, cleanEmail, passwordHash, role, organization, EMAIL_VERIFICATION_ON ? 0 : 1, EMAIL_VERIFICATION_ON ? 'PENDING_VERIFICATION' : 'ACTIVE']
      );
    } catch (err) {
      // Two people registering at the same instant: the UNIQUE constraint is the final safety net
      if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: DUPLICATE_ACCOUNT_MSG });
      throw err;
    }
    createdUserId = result.lastInsertRowid;

    if (role === 'vendor') {
      await db.run(
        'INSERT INTO vendors (vendor_user_id, name, email, organization, specialization) VALUES (?, ?, ?, ?, ?)',
        [createdUserId, cleanUsername, cleanEmail, organization || 'Independent Support Vendor', 'General Remote Diagnostics']
      );
    }
    await logAudit(createdUserId, 'REGISTER', { username: cleanUsername, role, verificationRequired: EMAIL_VERIFICATION_ON });

    if (!EMAIL_VERIFICATION_ON) {
      return res.status(201).json({ success: true, requiresVerification: false, message: 'Account created successfully. Please sign in.', userId: createdUserId });
    }

    try {
      await issueVerificationCode({ id: createdUserId, username: cleanUsername, email: cleanEmail });
    } catch (err) {
      console.error(`[MAIL] Could not send the verification code to ${cleanEmail}: ${err.message}`);
      if (isPermanentRecipientFailure(err)) {
        // The mail server says this mailbox does not exist: do not keep an account nobody can verify
        await deleteUnverifiedAccount(createdUserId);
        return res.status(422).json({ error: 'The mail server rejected that address. Check it for typing mistakes, or use a different email.' });
      }
      // Temporary problem (network, timeout, server busy): the account exists, the person can ask for a new code in a moment
      return res.status(202).json({
        success: true, requiresVerification: true, emailSent: false, email: cleanEmail, userId: createdUserId,
        message: 'Account created, but we could not send the verification email just now. Press "Resend Code" in a minute.'
      });
    }
    res.status(201).json({
      success: true, requiresVerification: true, emailSent: true, email: cleanEmail, userId: createdUserId,
      message: `We have sent a 6-digit verification code to ${cleanEmail}. Please enter it below to activate your account.`
    });
  } catch (err) {
    if (createdUserId) await deleteUnverifiedAccount(createdUserId).catch(() => {});
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Internal server error during registration.' });
  }
}
app.post('/api/auth/register', registerHandler);
app.post('/api/register', registerHandler);
app.post('/api/auth/signup', registerHandler); // alias (the old alias used a removed Express 4 API and crashed)

// Step 2 of sign-up: the 6-digit code from the email activates the account AND signs the person in.
async function verifyOtpHandler(req, res) {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const code = String((req.body && (req.body.otp || req.body.code)) || '').replace(/\s+/g, '');
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter all 6 digits of the code.', code: 'OTP_INCOMPLETE' });

    const ipKey = `verify|${req.ip}`;
    if (isLimited(ipKey, 20)) return res.status(429).json({ error: 'Too many attempts. Please try again in a few minutes.' });
    recordAttempt(ipKey, 15 * 60 * 1000);

    const user = await db.get('SELECT id, username, email, role, organization, status, is_active FROM users WHERE email = ?', [email]);
    if (!user || !user.is_active) return res.status(400).json({ error: OTP_BAD_MSG, code: 'OTP_INVALID' });
    if (user.status !== 'PENDING_VERIFICATION') return res.status(409).json({ error: 'This account is already active. Please sign in.', code: 'ALREADY_ACTIVE' });

    const result = await otp.verify(user.id, code);
    if (!result.ok) {
      return res.status(400).json({ error: result.reason === 'locked' ? OTP_LOCKED_MSG : OTP_BAD_MSG, code: result.reason === 'locked' ? 'OTP_LOCKED' : 'OTP_INVALID' });
    }

    await db.run("UPDATE users SET status = 'ACTIVE', email_verified = 1 WHERE id = ?", [user.id]);
    attempts.delete(`resend-verify|${email}`);
    attempts.delete(`resend-cooldown|${email}`);
    await logAudit(user.id, 'EMAIL_VERIFIED', {});
    await logAudit(user.id, 'LOGIN', { username: user.username, role: user.role, via: 'email-verification' });

    // Activated: sign the person in straight away, same shape as /api/auth/login
    const token = issueToken({ userId: user.id, username: user.username, role: user.role, organization: user.organization });
    res.json({
      success: true,
      message: 'Email verified. Your account is active.',
      token,
      user: { id: user.id, username: user.username, email: user.email, role: user.role, organization: user.organization }
    });
  } catch (err) {
    console.error('Verify-otp error:', err);
    res.status(500).json({ error: 'Could not verify the code. Please try again.' });
  }
}
app.post('/api/verify-otp', verifyOtpHandler);
app.post('/api/auth/verify-email', verifyOtpHandler);   // older name
app.post('/api/verify-signup-otp', verifyOtpHandler);     // name used in the spec

// "Resend Code": 60-second cooldown per address (enforced here, not only in the page), same answer whether or not an account exists
async function resendOtpHandler(req, res) {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (!mailer.configured) return res.status(503).json(mailNotSetUp(req));

    const coolKey = `resend-cooldown|${email}`;
    if (isLimited(coolKey, 1)) {
      const wait = Math.max(1, Math.ceil(((attempts.get(coolKey) || {}).resetAt - Date.now()) / 1000));
      return res.status(429).json({ error: `Please wait ${wait} seconds before asking for another code.`, code: 'OTP_COOLDOWN', retryAfter: wait });
    }
    const ipKey = `resend-verify-ip|${req.ip}`, mailKey = `resend-verify|${email}`;
    if (isLimited(ipKey, 10) || isLimited(mailKey, 5)) return res.status(429).json({ error: 'Too many requests. Please try again in a few minutes.' });
    recordAttempt(coolKey, RESEND_COOLDOWN_MS);
    recordAttempt(ipKey, 15 * 60 * 1000);
    recordAttempt(mailKey, 15 * 60 * 1000);

    const response = { success: true, cooldownSeconds: RESEND_COOLDOWN_MS / 1000, message: 'If this address has an account waiting for verification, a new 6-digit code has been sent. Check your inbox and spam folder.' };
    const user = await db.get("SELECT id, username, email FROM users WHERE email = ? AND status = 'PENDING_VERIFICATION' AND is_active = 1", [email]);
    if (user) {
      // Not awaited: the reply takes the same time whether or not the account exists
      issueVerificationCode(user).catch((err) => console.error(`[MAIL] Could not send the verification code to ${email}: ${err.message}`));
    }
    res.json(response);
  } catch (err) {
    console.error('Resend-otp error:', err);
    res.status(500).json({ error: 'Could not process the request.' });
  }
}
app.post('/api/auth/resend-verification', resendOtpHandler);
app.post('/api/resend-otp', resendOtpHandler);

// ---- One-time "Connect email" screen (no terminal, no file editing) ----
// GET tells the page whether email works and whether THIS computer may be configured from the app.
// POST saves the Gmail / SMTP login after a real test login. Allowed only from the server's own computer, never in production,
// and only while email is not configured yet. A hosted server must set SMTP_USER / SMTP_PASS in its environment instead.
app.get('/api/setup/mail', (req, res) => {
  res.json({ configured: mailer.configured, canSetup: !mailer.configured && !IS_PRODUCTION && isLocalRequest(req) });
});

app.post('/api/setup/mail', async (req, res) => {
  try {
    if (mailer.configured) return res.status(409).json({ error: 'Email is already connected.' });
    if (IS_PRODUCTION || !isLocalRequest(req)) {
      return res.status(403).json({ error: 'Email can only be connected from the computer the server runs on. On a hosted server, set SMTP_USER and SMTP_PASS in its environment variables.' });
    }
    const ipKey = `mail-setup|${req.ip}`;
    if (isLimited(ipKey, 10)) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes.' });
    recordAttempt(ipKey, 15 * 60 * 1000);

    const body = req.body || {};
    const user = String(body.user || '').trim();
    const pass = String(body.pass || '');
    const host = String(body.host || '').trim() || 'smtp.gmail.com';
    const port = String(body.port || '').trim() || '587';
    if (!EMAIL_RE.test(user) || user.length > 254) return res.status(400).json({ error: 'Enter the email address that will send the codes (for example yourname@gmail.com).' });
    if (pass.length < 8 || pass.length > 200) return res.status(400).json({ error: 'Enter the app password.' });
    if (!/^[A-Za-z0-9.-]{3,253}$/.test(host) || !/^\d{2,5}$/.test(port)) return res.status(400).json({ error: 'The mail server name or port is not valid.' });

    const candidate = { SMTP_HOST: host, SMTP_PORT: port, SMTP_USER: user, SMTP_PASS: pass };
    const tested = await testSmtpLogin(candidate);
    if (!tested.ok) return res.status(400).json({ error: tested.error });

    saveMailSettings(candidate, settingsFile());
    await mailer.reload();
    await logAudit(null, 'MAIL_CONFIGURED', { host, user });
    res.json({ success: true, message: 'Email is connected. Verification codes will now be sent from ' + user + '.' });
  } catch (err) {
    console.error('Mail setup error:', err);
    res.status(500).json({ error: 'Could not save the email settings.' });
  }
});

// Live check used by the sign-up form: is this username / email already taken? (Unverified leftovers can be replaced, so they count as free.)
app.get('/api/auth/availability', async (req, res) => {
  const limitKey = `avail|${req.ip}`;
  if (isLimited(limitKey, 60)) return res.status(429).json({ error: 'Too many checks. Please slow down.' });
  recordAttempt(limitKey, 60 * 1000);

  const username = String(req.query.username || '').trim();
  const email = String(req.query.email || '').trim().toLowerCase();
  const out = {};
  if (username) out.usernameTaken = !!(await db.get("SELECT id FROM users WHERE username = ? AND status <> 'PENDING_VERIFICATION'", [username]));
  if (email) out.emailTaken = !!(await db.get("SELECT id FROM users WHERE email = ? AND status <> 'PENDING_VERIFICATION'", [email]));
  res.json(out);
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const body = req.body || {};
    const identifier = String(body.username || body.email || '').trim();
    const password = typeof body.password === 'string' ? body.password : '';

    if (!identifier || !password) {
      return res.status(400).json({ error: 'Username (or email) and password are required.' });
    }

    const limitKey = `login|${req.ip}|${identifier.toLowerCase()}`;
    if (isLimited(limitKey, 5)) {
      return res.status(429).json({ error: 'Too many failed attempts. Please try again in 15 minutes.' });
    }

    const user = await db.get(
      'SELECT id, username, email, password_hash, role, organization, is_active, email_verified, status FROM users WHERE username = ? OR email = ?',
      [identifier, identifier.toLowerCase()]
    );

    const matches = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !matches) {
      recordAttempt(limitKey, 15 * 60 * 1000);
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    if (!user.is_active) {
      return res.status(403).json({ error: 'This account has been deactivated. Contact administration.' });
    }
    // Only reached with the right password, so this reveals nothing to a stranger
    if (user.status === 'PENDING_VERIFICATION') {
      return res.status(403).json({ error: 'Please verify your email address first. Enter the 6-digit code we emailed you, or press "Resend Code".', code: 'EMAIL_NOT_VERIFIED', email: user.email });
    }

    attempts.delete(limitKey);
    const token = issueToken({ userId: user.id, username: user.username, role: user.role, organization: user.organization });
    await logAudit(user.id, 'LOGIN', { username: user.username, role: user.role });

    res.json({
      success: true,
      message: 'Login successful.',
      token,
      user: { id: user.id, username: user.username, email: user.email, role: user.role, organization: user.organization }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error during login.' });
  }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  const user = await db.get(
    'SELECT id, username, email, role, organization, is_active, created_at FROM users WHERE id = ?',
    [req.user.userId]
  );
  if (!user || !user.is_active) return res.status(401).json({ error: 'Account not available.' });
  res.json({ user });
});

// ---- Forgot password: a 6-digit code (no links, no terminal, no scripts) ----
// Flow: forgot-password creates a code and emails it to the account's address -> the sign-in page shows the code + new-password fields ->
// reset-password checks email + code and sets the new password. The code is never logged: it only exists in the email.
// Only a keyed hash of the code is stored (never the code), it expires after 15 minutes, works once, and dies after 5 wrong guesses.
const RESET_CODE_TTL_MS = 15 * 60 * 1000;
const RESET_MAX_WRONG_GUESSES = 5;
const RESET_BAD_CODE_MSG = 'That code is incorrect or has expired. Check the code, or request a new one.';
const hashResetCode = (userId, code, nonce) => crypto.createHmac('sha256', JWT_SECRET).update(`${userId}:${code}:${nonce}`).digest('hex');

const forgotPasswordHandler = async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });

    // Without a working mail setup no code is created at all (there is nowhere safe to deliver it)
    if (!mailer.configured) {
      return res.status(503).json({ error: 'Password reset email is not set up on this server. Ask the administrator to set SMTP_USER and SMTP_PASS.' });
    }

    // Limits apply to every request, whether or not the account exists, so they reveal nothing
    const ipKey = `forgot|${req.ip}`, mailKey = `forgot-mail|${email}`;
    if (isLimited(ipKey, 8) || isLimited(mailKey, 3)) return res.status(429).json({ error: 'Too many requests. Please try again in a few minutes.' });
    recordAttempt(ipKey, 15 * 60 * 1000);
    recordAttempt(mailKey, 15 * 60 * 1000);

    // Same response whether or not the email exists, so attackers cannot probe for accounts
    const response = {
      success: true,
      emailConfigured: true,
      message: 'If an account exists for that email, a 6-digit reset code has been sent. Check your inbox (and spam folder). It is valid for 15 minutes.'
    };

    const user = await db.get('SELECT id, username, email FROM users WHERE email = ? AND is_active = 1 AND email_verified = 1', [email]);
    if (user) {
      const resetCode = String(crypto.randomInt(100000, 1000000)); // cryptographically secure, always 6 digits
      const nonce = crypto.randomBytes(8).toString('hex');
      await db.run('UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0', [user.id]); // only the newest code works
      const inserted = await db.run('INSERT INTO password_resets (user_id, token_hash, expires_at, attempts) VALUES (?, ?, ?, 0)',
        [user.id, `${nonce}:${hashResetCode(user.id, resetCode, nonce)}`, new Date(Date.now() + RESET_CODE_TTL_MS).toISOString()]);
      await logAudit(user.id, 'PASSWORD_RESET_REQUESTED', {});

      // Not awaited on purpose: the reply takes the same time whether or not the account exists.
      // If delivery fails the code is cancelled, and the failure (never the code) is logged for the administrator.
      mailer.sendResetCode(user.email || email, user.username, resetCode)
        .then(() => console.log(`[MAIL] Password reset code emailed to ${email}`))
        .catch(async (err) => {
          console.error(`[MAIL] Could not send the reset code to ${email}: ${err.message}`);
          try {
            if (inserted && inserted.lastInsertRowid) await db.run('UPDATE password_resets SET used = 1 WHERE id = ?', [inserted.lastInsertRowid]);
            else await db.run('UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0', [user.id]);
          } catch (_) { /* nothing more to do */ }
        });
    }
    res.json(response);
  } catch (err) {
    console.error('Forgot-password error:', err);
    res.status(500).json({ error: 'Could not process the request.' });
  }
};
app.post('/api/auth/forgot-password', forgotPasswordHandler);
app.post('/api/forgot-password', forgotPasswordHandler);   // short name

const resetPasswordHandler = async (req, res) => {
  try {
    const body = req.body || {};
    const rawEmail = body.email;
    const rawCode = body.code !== undefined ? body.code : body.otpCode;          // `otpCode` is accepted as well as `code`
    const password = body.password !== undefined ? body.password : body.newPassword;   // `newPassword` is accepted as well as `password`
    const email = String(rawEmail || '').trim().toLowerCase();
    const code = String(rawCode || '').trim();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Enter the 6-digit code from your email.' });
    const passwordError = validatePassword(password);
    if (passwordError) return res.status(400).json({ error: passwordError });

    const ipKey = `reset|${req.ip}`;
    if (isLimited(ipKey, 20)) return res.status(429).json({ error: 'Too many attempts. Please try again in a few minutes.' });
    recordAttempt(ipKey, 15 * 60 * 1000);

    // Every failure below returns the same message, so nothing tells an attacker whether the email has an account
    const user = await db.get('SELECT id FROM users WHERE email = ? AND is_active = 1 AND email_verified = 1', [email]);
    if (!user) return res.status(400).json({ error: RESET_BAD_CODE_MSG });
    const reset = await db.get('SELECT id, token_hash, expires_at FROM password_resets WHERE user_id = ? AND used = 0 ORDER BY id DESC LIMIT 1', [user.id]);
    if (!reset || new Date(reset.expires_at).getTime() < Date.now()) return res.status(400).json({ error: RESET_BAD_CODE_MSG });

    // Count this guess BEFORE checking it (parallel guesses cannot beat the limit), then burn the code after too many misses
    await db.run('UPDATE password_resets SET attempts = attempts + 1 WHERE id = ? AND used = 0', [reset.id]);
    const { attempts: tries, used } = await db.get('SELECT attempts, used FROM password_resets WHERE id = ?', [reset.id]);
    if (used || tries > RESET_MAX_WRONG_GUESSES) return res.status(400).json({ error: RESET_BAD_CODE_MSG });

    const [nonce, stored] = String(reset.token_hash).split(':');
    const given = hashResetCode(user.id, code, nonce);
    const ok = !!stored && stored.length === given.length && crypto.timingSafeEqual(Buffer.from(stored), Buffer.from(given));
    if (!ok) {
      if (tries >= RESET_MAX_WRONG_GUESSES) await db.run('UPDATE password_resets SET used = 1 WHERE id = ?', [reset.id]);
      return res.status(400).json({ error: RESET_BAD_CODE_MSG });
    }

    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(password, 12), user.id]);
    await db.run('UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0', [user.id]);
    attempts.delete(`forgot-mail|${email}`);
    await logAudit(user.id, 'PASSWORD_RESET_COMPLETED', {});
    res.json({ success: true, message: 'Password updated. Please sign in with your new password.' });
  } catch (err) {
    console.error('Reset-password error:', err);
    res.status(500).json({ error: 'Could not reset password.' });
  }
};
app.post('/api/auth/reset-password', resetPasswordHandler);
app.post('/api/reset-password', resetPasswordHandler);   // short name

// ================= VENDOR ACCOUNTS (clients only) =================
const REPORT_REASONS = ['Accessed unauthorized data', 'Unprofessional conduct', 'Did not do the agreed work', 'Suspicious activity', 'Other'];

async function isVendorBlocked(clientId, vendorUserId) {
  return !!(await db.get('SELECT id FROM client_vendor_blocks WHERE client_id = ? AND vendor_user_id = ?', [clientId, vendorUserId]));
}

async function findVendorUser(id) {
  const vendorId = Number(id);
  if (!Number.isInteger(vendorId)) return null;
  return db.get("SELECT id, username, organization FROM users WHERE id = ? AND role = 'vendor' AND is_active = 1", [vendorId]);
}

// Every active vendor ACCOUNT, with this client's own block/report status
app.get('/api/vendors', authenticateToken, requireRole('client'), async (req, res) => {
  const vendors = await db.all(`
    SELECT u.id AS user_id, u.username, u.organization,
           COALESCE(v.specialization,
                    (SELECT g.specialization FROM vendors g WHERE g.vendor_user_id = u.id AND g.client_id IS NULL LIMIT 1),
                    'General Remote Diagnostics') AS specialization,
           COALESCE(v.rating, 0) AS rating,
           COALESCE(v.tasks_completed, 0) AS tasks_completed,
           CASE WHEN b.id IS NULL THEN 0 ELSE 1 END AS blocked,
           b.reason AS blocked_reason,
           (SELECT COUNT(*) FROM vendor_reports r WHERE r.vendor_user_id = u.id AND r.client_id = ?) AS my_reports
    FROM users u
    LEFT JOIN vendors v ON v.vendor_user_id = u.id AND v.client_id = ?          -- THIS client's directory row only
    LEFT JOIN client_vendor_blocks b ON b.vendor_user_id = u.id AND b.client_id = ?
    WHERE u.role = 'vendor' AND u.is_active = 1
    ORDER BY blocked ASC, rating DESC, u.username COLLATE NOCASE
  `, [req.user.userId, req.user.userId, req.user.userId]);
  res.json({ vendors });
});

// Report a vendor (saved for administrator review; does not block them)
app.post('/api/vendors/:id/report', authenticateToken, requireRole('client'), async (req, res) => {
  const vendor = await findVendorUser(req.params.id);
  if (!vendor) return res.status(404).json({ error: 'Vendor account not found.' });

  const reason = String((req.body && req.body.reason) || '');
  if (!REPORT_REASONS.includes(reason)) return res.status(400).json({ error: 'Please choose a reason for the report.' });
  const details = String((req.body && req.body.details) || '').trim().slice(0, 1000);

  const limitKey = `report|${req.user.userId}`;
  if (isLimited(limitKey, 10)) return res.status(429).json({ error: 'Too many reports. Please try again later.' });
  recordAttempt(limitKey, 60 * 60 * 1000);

  await db.run('INSERT INTO vendor_reports (client_id, vendor_user_id, reason, details) VALUES (?, ?, ?, ?)',
    [req.user.userId, vendor.id, reason, details]);
  await logAudit(req.user.userId, 'VENDOR_REPORTED', { vendorUserId: vendor.id, reason });
  res.status(201).json({ success: true, message: `Report about ${vendor.username} submitted.` });
});

// "Terminate" a vendor for THIS client: ends their live sessions, revokes their pending requests,
// and stops them from connecting to or being assigned this client's tasks. Other clients are unaffected.
app.post('/api/vendors/:id/terminate', authenticateToken, requireRole('client'), async (req, res) => {
  const vendor = await findVendorUser(req.params.id);
  if (!vendor) return res.status(404).json({ error: 'Vendor account not found.' });

  const reason = String((req.body && req.body.reason) || 'Access ended by client').trim().slice(0, 300);
  await db.run('INSERT OR IGNORE INTO client_vendor_blocks (client_id, vendor_user_id, reason) VALUES (?, ?, ?)',
    [req.user.userId, vendor.id, reason]);

  const tasks = await db.all(`
    SELECT id FROM tasks
    WHERE client_id = ? AND status IN ('pending', 'active')
      AND (assigned_vendor_user_id = ?
           OR id IN (SELECT task_id FROM remote_sessions WHERE vendor_id = ? AND status = 'active'))
  `, [req.user.userId, vendor.id, vendor.id]);

  for (const t of tasks) {
    await terminateTask(t.id, {
      reason: 'vendor_removed',
      message: 'The client has ended your access.',
      actorId: req.user.userId
    });
  }
  await logAudit(req.user.userId, 'VENDOR_TERMINATED', { vendorUserId: vendor.id, tasksEnded: tasks.length });
  res.json({ success: true, tasksEnded: tasks.length, message: `${vendor.username}'s access has been terminated.` });
});

app.post('/api/vendors/:id/restore', authenticateToken, requireRole('client'), async (req, res) => {
  const vendorId = Number(req.params.id);
  if (!Number.isInteger(vendorId)) return res.status(400).json({ error: 'Invalid vendor.' });
  await db.run('DELETE FROM client_vendor_blocks WHERE client_id = ? AND vendor_user_id = ?', [req.user.userId, vendorId]);
  await logAudit(req.user.userId, 'VENDOR_RESTORED', { vendorUserId: vendorId });
  res.json({ success: true });
});

// ================= SUPPORT TASKS =================
// DATA ISOLATION RULES (enforced in SQL, never in the browser):
//   * a Client sees only tasks WHERE client_id = their own id
//   * a Vendor sees only tasks explicitly assigned to them (assigned_vendor_user_id = their own id)
//   * a Vendor never receives the token, other vendors' names, or any intrusion/violation log
//   * a task can only be sent to the one vendor the Client selected, and it can only be claimed by that vendor
app.get('/api/tasks', authenticateToken, async (req, res) => {
  let tasks;
  if (req.user.role === 'client') {
    tasks = await db.all(`
      SELECT t.*,
             (SELECT COUNT(*) FROM intrusion_events e WHERE e.task_id = t.id) AS intrusion_count,
             (SELECT r.vendor_id FROM remote_sessions r WHERE r.task_id = t.id ORDER BY r.id DESC LIMIT 1) AS session_vendor_id,
             (SELECT COALESCE(NULLIF(vu.organization, ''), 'Independent Vendor') || ' (' || vu.username || ')'
                FROM remote_sessions r JOIN users vu ON vu.id = r.vendor_id
               WHERE r.task_id = t.id ORDER BY r.id DESC LIMIT 1) AS session_vendor_name
      FROM tasks t WHERE t.client_id = ? ORDER BY t.id DESC LIMIT 500
    `, [req.user.userId]);
  } else {
    tasks = await db.all(`
      SELECT t.id, t.title, t.description, t.target_process, t.allowed_apps, t.allowed_paths, t.duration_minutes, t.status,
             t.window_start, t.window_end, t.created_at, t.assigned_vendor_user_id, t.client_id,
             u.organization AS client_org, u.username AS client_username,
             (SELECT r.id FROM remote_sessions r WHERE r.task_id = t.id AND r.vendor_id = ? ORDER BY r.id DESC LIMIT 1) AS session_id,
             (SELECT r.status FROM remote_sessions r WHERE r.task_id = t.id AND r.vendor_id = ? ORDER BY r.id DESC LIMIT 1) AS session_status
      FROM tasks t
      LEFT JOIN users u ON u.id = t.client_id
      WHERE t.assigned_vendor_user_id = ?
      ORDER BY t.id DESC LIMIT 500
    `, [req.user.userId, req.user.userId, req.user.userId]);
  }
  res.json({ tasks, serverTime: Date.now() });
});

// Applications for the ticket form's multi-select (clean names only: no file names, no extensions).
// The list is the built-in matrix (File Manager, Calculator, Notepad, Paint, Chrome ...) plus every program the Client's own PC
// reported through POST /api/apps/report (the desktop app / agent runs agent/app-discovery.js on that PC).
const reportedApps = new Map(); // userId -> { at, apps: string[] }
const REPORTED_APPS_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_REPORTED_APPS = 600;

app.get('/api/apps', authenticateToken, (req, res) => {   // clients (task form) and vendors (Request Additional Access)
  const mine = reportedApps.get(req.user.userId);
  const fresh = mine && Date.now() - mine.at < REPORTED_APPS_TTL_MS ? mine.apps : [];
  res.json({
    apps: appCatalog.mergeAppLists(appCatalog.listAppNames(), fresh),
    aliases: appCatalog.listAliases(),
    fromDevice: fresh.length
  });
});

app.post('/api/apps/report', authenticateToken, requireRole('client'), (req, res) => {
  const raw = req.body && Array.isArray(req.body.apps) ? req.body.apps : null;
  if (!raw) return res.status(400).json({ error: 'apps must be a list of application names.' });
  const apps = appCatalog.mergeAppLists(raw.slice(0, MAX_REPORTED_APPS * 2)).slice(0, MAX_REPORTED_APPS);
  reportedApps.set(req.user.userId, { at: Date.now(), apps });
  res.json({ success: true, count: apps.length });
});

// Task types the host policy knows. Kept for older clients; the ticket form no longer uses it.
app.get('/api/policy-types', authenticateToken, requireRole('client'), (req, res) => {
  const types = policyCatalog.listTypes();
  res.json({ types: types || [], validated: !!types });
});

// ================= TASK CREATION + BILLING =================
// The SERVER decides whether a task is free. The browser only shows the quote; it never sends "free: true" and nothing it sends
// about price or allowance is read. The free-allowance check and the insert are ONE SQL statement, so two tabs pressing
// "Issue Token" at the same moment cannot both get the 3rd free task.

// How many FREE tasks this client already created in this calendar month (billing time zone). Read from the database.
async function freeTasksUsed(clientId, month) {
  const row = await db.get("SELECT COUNT(*) AS n FROM tasks WHERE client_id = ? AND billing = 'free' AND billing_month = ?", [clientId, month]);
  return Number(row && row.n) || 0;
}

// Validates the request body and the chosen vendor. Returns { status, error } or { t, assignedVendor, vendorLabel, body }.
async function prepareTask(user, rawBody) {
  const parsed = taskScope.validateTaskRequest(rawBody);
  if (parsed.error) return { status: 400, error: parsed.error };
  const t = parsed.value;
  // The task goes to exactly the vendor the Client selected: an active vendor account the Client has not blocked
  const assignedVendor = await findVendorUser(t.vendorUserId);
  if (!assignedVendor) return { status: 400, error: 'The selected vendor account was not found.' };
  if (await isVendorBlocked(user.userId, assignedVendor.id)) {
    return { status: 403, error: 'You terminated this vendor\'s access. Restore them in the vendor list first.' };
  }
  // Only the validated fields are kept (stored with a paid order, re-validated when the payment comes back)
  const body = { vendor_id: t.vendorUserId, task: t.task, duration_minutes: t.durationMinutes, allowed_apps: t.allowedApps, alerts_enabled: t.alertsEnabled };
  return { t, assignedVendor, vendorLabel: vendorDisplayName(assignedVendor), body };
}

/**
 * Inserts the task and announces it to the vendor. For billing 'free' the insert only happens while the client is still under the
 * monthly allowance (checked inside the same statement); returns null when that race was lost.
 */
async function insertTask(user, prep, { billingKind, month, amountPaise = 0, paymentOrderId = null }) {
  const { t, assignedVendor, vendorLabel } = prep;
  const token = `SCD-${crypto.randomInt(1000, 10000)}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const now = new Date();
  const windowEnd = new Date(now.getTime() + t.durationMinutes * 60000);
  const values = [
    user.userId,
    assignedVendor.id,
    vendorLabel,
    t.task,                                  // "what": the task text is the title everybody sees
    'Task-bounded remote support session with strict process isolation',
    t.allowedApps[0],                        // primary approved app (older agents read this column)
    t.allowedPaths.length ? JSON.stringify(t.allowedPaths) : '',
    JSON.stringify(t.allowedApps),
    t.alertsEnabled ? 1 : 0,
    t.durationMinutes,
    token,
    now.toISOString(),
    windowEnd.toISOString(),
    billingKind, month, amountPaise, paymentOrderId
  ];
  const columns = `client_id, vendor_id, assigned_vendor_user_id, vendor_name, title, description, target_process, task_type, allowed_paths, allowed_apps,
    alerts_enabled, duration_minutes, token, status, window_start, window_end, billing, billing_month, amount_paise, payment_order_id`;
  const select = "?, NULL, ?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?";
  const result = billingKind === 'free'
    ? await db.run(`INSERT INTO tasks (${columns}) SELECT ${select}
        WHERE (SELECT COUNT(*) FROM tasks WHERE client_id = ? AND billing = 'free' AND billing_month = ?) < ?`,
      [...values, user.userId, month, billing.FREE_TASKS_PER_MONTH])
    : await db.run(`INSERT INTO tasks (${columns}) VALUES (${select})`, values);
  if (!result.changes) return null;

  const task = await db.get('SELECT * FROM tasks WHERE id = ?', [result.lastInsertRowid]);
  timers.schedule(task.id, windowEnd.getTime());
  await logAudit(user.userId, 'TASK_CREATED', { taskId: task.id, duration: t.durationMinutes, assignedTo: assignedVendor.id, apps: t.allowedApps, folders: t.allowedPaths.length, alerts: t.alertsEnabled, billing: billingKind, amountPaise });
  const clientLabel = user.organization || user.username;
  emitToUser(assignedVendor.id, 'task-request', {
    taskId: task.id, title: task.title, client: clientLabel, clientName: clientLabel,
    duration: t.durationMinutes, durationMinutes: t.durationMinutes, allowedApps: t.allowedApps
  });
  return task;
}

// The client's plan right now (trial / free / member / legacy), worked out from the database every time
async function planFor(userId) {
  const u = await db.get('SELECT created_at, membership_until, membership_plan FROM users WHERE id = ?', [userId]);
  return { ...billing.entitlements({ createdAt: u && u.created_at, memberUntil: u && u.membership_until }), membershipPlan: (u && u.membership_plan) || '' };
}
async function decideFor(userId, durationMinutes, month) {
  const ent = await planFor(userId);
  const freeUsed = billing.enabled && ent.plan === 'free' ? await freeTasksUsed(userId, month) : 0;
  return { decision: billing.decide({ durationMinutes, freeUsed, plan: ent.plan }), ent };
}

// What the browser may show about a decision (never the secret, never anything it could send back to change the price)
function publicBilling(decision, month, ent) {
  return {
    plan: decision.plan,
    trialEndsAt: ent ? ent.trialEndsAt : null,
    memberUntil: ent ? ent.memberUntil : null,
    paymentsEnabled: decision.paymentsEnabled,
    free: decision.free,
    unlimited: !!decision.unlimited,
    billing: decision.billing,
    reason: decision.reason || null,
    freeLimit: decision.freeLimit,
    freeMaxMinutes: decision.freeMaxMinutes || billing.FREE_TASK_MAX_MINUTES,
    freeLeft: decision.freeLeft,
    freeLeftAfter: decision.freeLeftAfter != null ? decision.freeLeftAfter : decision.freeLeft,
    priceInr: decision.priceInr,
    amountPaise: decision.amountPaise,
    currency: 'INR',
    month
  };
}

// Quote for the ticket form: "This task is FREE (2 of 3 left)" or "Pay ₹199 & Issue Token". Display only: POST /api/tasks decides again.
app.get('/api/billing/quote', authenticateToken, requireRole('client'), async (req, res) => {
  const duration = Number(req.query.duration_minutes);
  if (!taskScope.DURATION_OPTIONS.includes(duration)) return res.status(400).json({ error: `Duration must be one of: ${taskScope.DURATION_OPTIONS.join(', ')} minutes.` });
  const month = billing.month();
  const { decision, ent } = await decideFor(req.user.userId, duration, month);
  res.json(publicBilling(decision, month, ent));
});

// One Razorpay order for either a paid task or a membership. Returns { status, body } to send.
async function createGatewayOrder(user, { kind, plan = '', amountPaise, durationMinutes = 0, requestJson = '{}', description, notes }) {
  const insert = await db.run(
    "INSERT INTO payment_orders (client_id, amount_paise, currency, duration_minutes, request_json, status, kind, plan) VALUES (?, ?, 'INR', ?, ?, 'created', ?, ?)",
    [user.userId, amountPaise, durationMinutes, requestJson, kind, plan]
  );
  const localId = insert.lastInsertRowid;
  let order;
  try {
    order = await billing.createOrder({
      amountPaise,
      receipt: `scopedesk_${localId}`,
      notes: { scopedesk_order: String(localId), client_id: String(user.userId), kind, plan, ...(notes || {}) }
    });
  } catch (err) {
    await db.run("UPDATE payment_orders SET status = 'unfulfilled', error = ? WHERE id = ?", [String(err.code || err.message).slice(0, 200), localId]);
    console.error('[BILLING] order creation failed:', err.code || err.message);
    return { status: 502, body: { error: 'The payment gateway is not available right now. No money was taken. Please try again in a minute.', code: 'GATEWAY_UNAVAILABLE' } };
  }
  await db.run('UPDATE payment_orders SET razorpay_order_id = ? WHERE id = ?', [order.id, localId]);
  const me = await db.get('SELECT username, email, organization FROM users WHERE id = ?', [user.userId]);
  await logAudit(user.userId, 'PAYMENT_ORDER_CREATED', { orderId: order.id, kind, plan, amountPaise, duration: durationMinutes });
  return {
    status: 200,
    payment: {
      keyId: billing.keyId,                  // public key only; the secret never leaves the server
      orderId: order.id,
      amount: order.amount,                  // paise, exactly what Razorpay will charge
      currency: order.currency || 'INR',
      name: 'ScopeDesk',
      description,
      prefill: { name: (me && (me.organization || me.username)) || '', email: (me && me.email) || '' }
    }
  };
}

// Plan card + upgrade dialog: current plan, trial / membership end, free tasks left, membership prices, AI assistant availability
app.get('/api/billing/status', authenticateToken, requireRole('client'), async (req, res) => {
  const month = billing.month();
  const ent = await planFor(req.user.userId);
  const used = billing.enabled && ent.plan === 'free' ? await freeTasksUsed(req.user.userId, month) : 0;
  res.json({
    paymentsEnabled: billing.enabled,
    plan: ent.plan,
    chatbot: ent.chatbot,
    chatbotConfigured: assistant.configured,
    trialEndsAt: ent.trialEndsAt,
    trialDays: billing.trialDays,
    memberUntil: ent.memberUntil,
    membershipPlan: ent.membershipPlan,
    freeLimit: billing.FREE_TASKS_PER_MONTH,
    freeMaxMinutes: billing.FREE_TASK_MAX_MINUTES,
    freeLeft: ent.plan === 'free' ? Math.max(0, billing.FREE_TASKS_PER_MONTH - used) : null,
    memberships: billing.enabled ? ['monthly', 'yearly'].map((k) => billing.membershipQuote(k)) : []
  });
});

// ================= REQUEST ADDITIONAL ACCESS =================
// Vendor: POST /api/tasks/:id/access-requests { apps: [...], paths: [...], reason }    Client & vendor: GET the ticket's requests
// Client: POST /api/access-requests/:id/approve { apps?, paths? } (partial approval) | /deny.   Vendor: POST /api/access-requests/:id/cancel
const sendResult = (res, r) => res.status(r.status).json(r.error ? { error: r.error } : r);
app.get('/api/tasks/:id/access-requests', authenticateToken, async (req, res) => sendResult(res, await accessRequests.list(req.user, req.params.id)));
app.post('/api/tasks/:id/access-requests', authenticateToken, async (req, res) => {
  const key = `access-req|${req.user.userId}`;
  if (isLimited(key, 20)) return res.status(429).json({ error: 'Too many requests. Please wait a few minutes.' });
  recordAttempt(key, 60 * 60 * 1000);
  sendResult(res, await accessRequests.create(req.user, req.params.id, req.body));
});
app.post('/api/access-requests/:id/approve', authenticateToken, async (req, res) => sendResult(res, await accessRequests.decide(req.user, req.params.id, true, req.body || {})));
app.post('/api/access-requests/:id/deny', authenticateToken, async (req, res) => sendResult(res, await accessRequests.decide(req.user, req.params.id, false)));
app.post('/api/access-requests/:id/cancel', authenticateToken, async (req, res) => sendResult(res, await accessRequests.cancel(req.user, req.params.id)));

// ================= AI ASSISTANT (clients by plan, vendors always) =================
const AI_ERRORS = () => {
  const keyName = assistant.provider === 'gemini' ? 'GEMINI_API_KEY' : 'OPENAI_API_KEY';
  return {
    AI_AUTH: `The AI service rejected the API key. The administrator should check ${keyName} in the server settings (Railway > Variables).`,
    AI_QUOTA: 'The AI service account has run out of free usage or credit. The administrator should check the AI account.',
    AI_BUSY: 'The AI assistant is busy right now. Please try again in a minute.',
    AI_MODEL: `The AI model "${assistant.model}" is not available for this key. The administrator can set ${assistant.provider === 'gemini' ? 'GEMINI_MODEL' : 'OPENAI_MODEL'} to another model.`,
    AI_UNREACHABLE: 'Could not reach the AI service. Please try again in a moment.',
    AI_KEY_FORMAT: `The AI key saved on the server has characters that are not allowed (often a shortened copy with "..." or curly quotes). Copy the key again from Google AI Studio and paste it into ${keyName} in Railway > Variables.`
  };
};
// the short technical reason (e.g. ENOTFOUND, timed out after 25s) is shown in brackets so it can be reported; never the key
const aiErrorText = (code, cause) => {
  const text = AI_ERRORS()[code] || 'The AI assistant could not answer right now. Please try again.';
  const why = String(cause || '').replace(/[^\w .:/-]/g, '').slice(0, 80);
  return code === 'AI_UNREACHABLE' && why ? `${text} (Reason: ${why})` : text;
};

// Facts about one ticket the user is a party of, so the assistant can draft a reply or a summary. Nothing secret (no tokens).
async function chatContext(user, taskId) {
  const id = Number(taskId);
  if (!Number.isInteger(id) || id <= 0) return '';
  const t = await db.get(`SELECT t.*, COALESCE(NULLIF(cu.organization, ''), cu.username) AS client_name, vu.username AS vendor_username
    FROM tasks t LEFT JOIN users cu ON cu.id = t.client_id LEFT JOIN users vu ON vu.id = t.assigned_vendor_user_id WHERE t.id = ?`, [id]);
  if (!t || !((user.role === 'client' && t.client_id === user.userId) || (user.role === 'vendor' && t.assigned_vendor_user_id === user.userId))) return '';
  let apps = []; try { apps = JSON.parse(t.allowed_apps || '[]'); } catch (_) { /* none */ }
  let folders = []; try { folders = JSON.parse(t.allowed_paths || '[]'); } catch (_) { /* none */ }
  const end = t.window_end ? parseDbDate(t.window_end) : null;
  const minsLeft = end ? Math.round((end.getTime() - Date.now()) / 60000) : null;
  const lines = [
    `Title: ${String(t.title || '').slice(0, 200)}`,
    `Task description: ${String(t.description || t.task || '').slice(0, 1200)}`,
    `Status: ${t.status}${minsLeft != null && ['pending', 'active'].includes(t.status) ? ` (${Math.max(0, minsLeft)} minutes left in the time window)` : ''}`,
    `Duration: ${t.duration_minutes || '?'} minutes. Allowed apps: ${apps.join(', ') || 'none listed'}.${folders.length ? ` Allowed folders: ${folders.join(', ')}.` : ''}`,
    `Client: ${t.client_name || 'client'}. Vendor: ${t.vendor_username || 'vendor'}.`
  ];
  const msgs = await db.all("SELECT sender_id, kind, body FROM task_messages WHERE task_id = ? ORDER BY id DESC LIMIT 12", [id]);
  if (msgs.length) {
    lines.push('Recent chat (oldest first):');
    msgs.reverse().forEach((m) => lines.push(`${m.sender_id === t.client_id ? 'Client' : 'Vendor'}${m.kind === 'call' ? ' (call)' : ''}: ${String(m.body).slice(0, 300)}`));
  }
  return lines.join('\n');
}

// Shared checks for /api/chat and /api/chat/stream. Returns { error: [status, body] } or what the assistant needs.
async function prepareChat(req) {
  const role = req.user.role;
  if (role !== 'client' && role !== 'vendor') return { error: [403, { error: 'The AI assistant is for clients and vendors.' }] };
  if (role === 'client') {
    const ent = await planFor(req.user.userId);
    if (!ent.chatbot) return { error: [402, { error: 'The AI assistant is included in the free trial and in Membership. Upgrade to keep using it.', code: 'MEMBERSHIP_REQUIRED' }] };
  }
  if (!assistant.configured) return { error: [503, { error: 'The AI assistant is not set up on this server yet (add GEMINI_API_KEY or OPENAI_API_KEY in the server settings).', code: 'AI_NOT_CONFIGURED' }] };
  const limitKey = `chat|${req.user.userId}`;
  if (isLimited(limitKey, 60)) return { error: [429, { error: 'You have sent a lot of questions. Please wait a few minutes.' }] };
  recordAttempt(limitKey, 60 * 60 * 1000);
  const clean = assistant.cleanMessages(req.body && req.body.messages);
  if (clean.error) return { error: [400, { error: clean.error }] };
  const context = req.body && req.body.taskId != null ? await chatContext(req.user, req.body.taskId) : '';
  return { messages: clean.messages, opts: { role, name: req.user.organization || req.user.username, context } };
}

// Who may chat (any signed-in client or vendor): the chat window uses this to show itself or the reason it is locked
app.get('/api/chat/status', authenticateToken, async (req, res) => {
  const role = req.user.role;
  let chatbot = role === 'vendor';
  let plan = role === 'vendor' ? 'vendor' : null;
  if (role === 'client') { const ent = await planFor(req.user.userId); chatbot = ent.chatbot; plan = ent.plan; }
  const hl = assistant.health();
  res.json({ role, plan, chatbot, chatbotConfigured: assistant.configured, paymentsEnabled: billing.enabled, streaming: true,
    ai: { provider: hl.provider, model: hl.model, lastError: hl.lastError, lastOkAt: hl.lastOkAt } });
});

// One answer at once. body: { messages: [{ role: 'user'|'assistant', content }], taskId? }. Checked HERE on every message.
app.post('/api/chat', authenticateToken, async (req, res) => {
  const prep = await prepareChat(req);
  if (prep.error) return res.status(prep.error[0]).json(prep.error[1]);
  try {
    res.json({ reply: await assistant.reply(prep.messages, prep.opts) });
  } catch (err) {
    console.error('[AI] chat failed:', err.code || err.message, err.cause || '');
    res.status(502).json({ error: aiErrorText(err.code, err.cause), code: err.code || 'AI_ERROR' });
  }
});

// The same, streamed as Server-Sent Events so the first words show within a moment:
//   event: delta  data: {"t":"..."}      (many)
//   event: done   data: {"reply":"..."}  or   event: error  data: {"error":"...","code":"..."}
app.post('/api/chat/stream', authenticateToken, async (req, res) => {
  const prep = await prepareChat(req);
  if (prep.error) return res.status(prep.error[0]).json(prep.error[1]);
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');                 // proxies (Railway, nginx) must not hold the stream back
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  let closed = false;
  req.on('close', () => { closed = true; });
  const send = (event, data) => { if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  send('open', {});
  try {
    const reply = await assistant.stream(prep.messages, prep.opts, (t) => send('delta', { t }));
    send('done', { reply });
  } catch (err) {
    console.error('[AI] chat stream failed:', err.code || err.message, err.cause || '');
    send('error', { error: aiErrorText(err.code, err.cause), code: err.code || 'AI_ERROR' });
  }
  res.end();
});

// Buy (or renew) a membership. body: { plan: 'monthly' | 'yearly' }. The price comes from the server, never from the browser.
app.post('/api/membership/checkout', authenticateToken, requireRole('client'), async (req, res) => {
  if (!billing.enabled) return res.status(400).json({ error: 'Payments are not switched on for this server, so every feature is already free.' });
  const quote = billing.membershipQuote(String((req.body && req.body.plan) || ''));
  if (!quote) return res.status(400).json({ error: 'Choose the monthly or the yearly membership.' });
  const limitKey = `member-checkout|${req.user.userId}`;
  if (isLimited(limitKey, 20)) return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
  recordAttempt(limitKey, 60 * 60 * 1000);
  const out = await createGatewayOrder(req.user, { kind: 'membership', plan: quote.plan, amountPaise: quote.amountPaise, description: `ScopeDesk ${quote.label} (${quote.days} days)` });
  if (out.status !== 200) return res.status(out.status).json(out.body);
  res.json({ success: true, paymentRequired: true, membership: quote, payment: out.payment });
});

// body: { vendor_id, task, duration_minutes, allowed_apps: ["Excel", ...], alerts_enabled: true|false }
// Free (or payments off): 201 { success, task, billing }.   Paid: 200 { success, paymentRequired: true, payment: {...}, billing } and NO task yet.
app.post('/api/tasks', authenticateToken, requireRole('client'), async (req, res) => {
  const prep = await prepareTask(req.user, req.body);
  if (prep.error) return res.status(prep.status).json({ error: prep.error });

  const limitKey = `task-create|${req.user.userId}`;
  if (isLimited(limitKey, 30)) return res.status(429).json({ error: 'Too many tasks created. Please try again later.' });
  recordAttempt(limitKey, 60 * 60 * 1000);

  const month = billing.month();
  let { decision, ent } = await decideFor(req.user.userId, prep.t.durationMinutes, month);

  if (decision.billing !== 'paid') {
    const task = await insertTask(req.user, prep, { billingKind: decision.billing, month });
    if (task) return res.status(201).json({ success: true, task, billing: publicBilling(decision, month, ent) });
    // Another request used the last free task a moment ago: this one has to be paid
    decision = billing.decide({ durationMinutes: prep.t.durationMinutes, freeUsed: billing.FREE_TASKS_PER_MONTH, plan: 'free' });
  }

  // ---- PAID: create a Razorpay order. The validated request is stored with it; the task is only created after a verified payment.
  const out = await createGatewayOrder(req.user, {
    kind: 'task', amountPaise: decision.amountPaise, durationMinutes: prep.t.durationMinutes, requestJson: JSON.stringify(prep.body),
    description: `Remote support task: ${prep.t.durationMinutes} minutes`, notes: { duration_minutes: String(prep.t.durationMinutes) }
  });
  if (out.status !== 200) return res.status(out.status).json(out.body);
  res.json({ success: true, paymentRequired: true, billing: publicBilling(decision, month, ent), payment: out.payment });
});

// Razorpay Checkout's success handler posts here. The signature proves Razorpay saw the payment for THIS order; only then is
// the task created, from the request stored with the order (never from anything the browser sends now).
app.post('/api/payments/verify', authenticateToken, requireRole('client'), async (req, res) => {
  const b = req.body || {};
  const orderId = String(b.razorpay_order_id || '');
  const paymentId = String(b.razorpay_payment_id || '');
  const signature = String(b.razorpay_signature || '');
  if (!billing.enabled) return res.status(400).json({ error: 'Payments are not switched on for this server.' });

  const limitKey = `pay-verify|${req.user.userId}`;
  if (isLimited(limitKey, 20)) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes.' });

  const order = orderId ? await db.get('SELECT * FROM payment_orders WHERE razorpay_order_id = ? AND client_id = ?', [orderId, req.user.userId]) : null;
  if (!order) { recordAttempt(limitKey, 10 * 60 * 1000); return res.status(404).json({ error: 'Payment order not found.' }); }

  // The handler can fire twice (double click, retry after a dropped connection): hand back the same result
  if (order.status === 'fulfilled' && order.kind === 'membership') {
    return res.status(200).json({ success: true, alreadyProcessed: true, membership: await planFor(req.user.userId) });
  }
  if (order.status === 'fulfilled' && order.task_id) {
    const task = await db.get('SELECT * FROM tasks WHERE id = ? AND client_id = ?', [order.task_id, req.user.userId]);
    return res.status(200).json({ success: true, task, alreadyProcessed: true });
  }
  if (order.status !== 'created') {
    return res.status(409).json({ error: order.status === 'unfulfilled' && order.razorpay_payment_id
      ? `Your payment (${order.razorpay_payment_id}) was received but the task could not be created. Please contact support for a refund.`
      : 'This payment is already being processed.' });
  }

  if (!billing.verifySignature({ orderId, paymentId, signature })) {
    recordAttempt(limitKey, 10 * 60 * 1000);
    await logAudit(req.user.userId, 'PAYMENT_SIGNATURE_INVALID', { orderId });
    return res.status(400).json({ error: 'The payment could not be verified. If money was taken, it will be refunded automatically by Razorpay.' });
  }

  // Claim the order exactly once
  const claim = await db.run("UPDATE payment_orders SET status = 'paid', razorpay_payment_id = ?, paid_at = ? WHERE id = ? AND status = 'created'",
    [paymentId, new Date().toISOString(), order.id]);
  if (!claim.changes) return res.status(409).json({ error: 'This payment is already being processed.' });
  await logAudit(req.user.userId, 'PAYMENT_VERIFIED', { orderId, paymentId, amountPaise: order.amount_paise, kind: order.kind });

  if (order.kind === 'membership') {
    // Renewing before expiry adds the days on top of what is left
    const me = await db.get('SELECT membership_until FROM users WHERE id = ?', [req.user.userId]);
    let until;
    try { until = billing.extendMembership(me && me.membership_until, order.plan); } catch (e) {
      await db.run("UPDATE payment_orders SET status = 'unfulfilled', error = ? WHERE id = ?", ['unknown plan', order.id]);
      return res.status(409).json({ error: `Payment received (${paymentId}), but the plan is unknown. Please contact support.` });
    }
    await db.run('UPDATE users SET membership_until = ?, membership_plan = ? WHERE id = ?', [until.toISOString(), order.plan, req.user.userId]);
    await db.run("UPDATE payment_orders SET status = 'fulfilled' WHERE id = ?", [order.id]);
    await logAudit(req.user.userId, 'MEMBERSHIP_ACTIVATED', { plan: order.plan, until: until.toISOString(), paymentId });
    return res.status(200).json({ success: true, membership: await planFor(req.user.userId), payment: { paymentId, amountPaise: order.amount_paise } });
  }

  let stored = null;
  try { stored = JSON.parse(order.request_json); } catch (_) { /* handled below */ }
  const prep = stored ? await prepareTask(req.user, stored) : { error: 'The stored task request is unreadable.' };
  const task = prep.error ? null : await insertTask(req.user, prep, { billingKind: 'paid', month: billing.month(), amountPaise: order.amount_paise, paymentOrderId: order.id });
  if (!task) {
    const why = prep.error || 'The task could not be saved.';
    await db.run("UPDATE payment_orders SET status = 'unfulfilled', error = ? WHERE id = ?", [why.slice(0, 200), order.id]);
    await logAudit(req.user.userId, 'PAYMENT_UNFULFILLED', { orderId, paymentId, why });
    return res.status(409).json({ error: `Payment received (${paymentId}), but the task could not be created: ${why} Please contact support for a refund.` });
  }
  await db.run("UPDATE payment_orders SET status = 'fulfilled', task_id = ? WHERE id = ?", [task.id, order.id]);
  res.status(201).json({ success: true, task, payment: { paymentId, amountPaise: order.amount_paise } });
});

// ================= REMOTE SESSIONS =================
// Display names used in tickets and in the live events. Same format as the label written when a ticket is addressed to a vendor.
const vendorDisplayName = (u) => `${(u && u.organization) || 'Independent Vendor'} (${(u && u.username) || 'vendor'})`;
const clientDisplayName = (u) => (u && (u.organization || u.username)) || 'Client';
app.post('/api/sessions/connect', authenticateToken, requireRole('vendor'), async (req, res) => {
  const body = req.body || {};
  let task;
  let cleanToken;

  if (body.task_id !== undefined && body.task_id !== null) {
    // Accepting a request that was sent directly to this vendor account (no token typing needed)
    task = Number.isInteger(Number(body.task_id)) ? await db.get('SELECT * FROM tasks WHERE id = ?', [Number(body.task_id)]) : null;
    if (!task || task.assigned_vendor_user_id !== req.user.userId) {
      return res.status(404).json({ error: 'Request not found.' });
    }
    cleanToken = task.token;
  } else {
    cleanToken = String(body.token || '').trim().toUpperCase();
    if (!cleanToken) return res.status(400).json({ error: 'Session token is required.' });

    const limitKey = `connect|${req.user.userId}`;
    if (isLimited(limitKey, 10)) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes.' });

    task = await db.get('SELECT * FROM tasks WHERE token = ?', [cleanToken]);
    // A token only works for the vendor the Client selected. Anyone else gets the same answer as for a wrong token,
    // so a vendor cannot even learn that somebody else's token exists.
    if (!task || task.assigned_vendor_user_id !== req.user.userId) {
      recordAttempt(limitKey, 10 * 60 * 1000);
      return res.status(404).json({ error: 'Access token not found in ScopeDesk registries.' });
    }
  }

  if (await isVendorBlocked(task.client_id, req.user.userId)) {
    return res.status(403).json({ error: 'This client has ended your access.' });
  }
  if (task.status === 'completed') return res.status(400).json({ error: 'This task session has already completed.' });
  if (task.status === 'terminated') return res.status(403).json({ error: 'This session was terminated due to a boundary violation or client revocation.' });
  if (task.status === 'expired') return res.status(403).json({ error: 'This token has expired past its allocated time interval.' });
  if (task.token_revoked) return res.status(403).json({ error: 'This token was revoked by the client.' });

  const windowEnd = parseDbDate(task.window_end);
  const now = new Date();
  if (now > windowEnd) {
    await terminateTask(task.id, { reason: 'time_expired', message: 'Time window ended.', actorId: null, finalStatus: 'expired', sessionStatus: 'expired' });
    return res.status(403).json({ error: 'This token has expired past its allocated time interval.' });
  }

  let session = null;
  if (task.status === 'active') {
    session = await db.get("SELECT * FROM remote_sessions WHERE task_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1", [task.id]);
    if (session && session.vendor_id !== req.user.userId) {
      return res.status(409).json({ error: 'This task is already being worked on by another vendor.' });
    }
  }

  const isReconnect = !!session;
  // Who is who, read from the database (never from anything the browser sent)
  const vendorRow = await db.get('SELECT id, username, organization FROM users WHERE id = ?', [req.user.userId]);
  const clientRow = await db.get('SELECT id, username, organization FROM users WHERE id = ?', [task.client_id]);
  const vendorName = vendorDisplayName(vendorRow || { username: req.user.username });
  const clientName = clientDisplayName(clientRow);
  const windowStart = parseDbDate(task.window_start);
  // One payload for both sides. startTime/endTime are the approved window (the countdown runs to endTime).
  const meta = {
    taskId: task.id, title: task.title, targetProcess: task.target_process,
    vendorId: req.user.userId, vendorName, vendorUsername: req.user.username,
    clientId: task.client_id, clientName,
    allowedApps: taskScope.readList(task.allowed_apps), alertsEnabled: task.alerts_enabled !== 0,
    startTime: windowStart.getTime(), endTime: windowEnd.getTime(), windowEnd: windowEnd.getTime(),
    durationMinutes: task.duration_minutes, acceptedAt: now.getTime(), serverTime: Date.now()
  };

  if (!session) {
    // The ticket now names the vendor who really accepted it (it used to keep the label written at creation, e.g. "Any vendor with the token")
    await db.run(
      "UPDATE tasks SET status = 'active', vendor_id = ?, vendor_name = ?, assigned_vendor_user_id = COALESCE(assigned_vendor_user_id, ?) WHERE id = ?",
      [req.user.userId, vendorName, req.user.userId, task.id]
    );
    const sessionRes = await db.run(`
      INSERT INTO remote_sessions (task_id, client_id, vendor_id, vendor_name, token, status, started_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?)
    `, [task.id, task.client_id, req.user.userId, req.user.username, cleanToken, now.toISOString()]);
    session = await db.get('SELECT * FROM remote_sessions WHERE id = ?', [sessionRes.lastInsertRowid]);
    await logAudit(req.user.userId, 'SESSION_STARTED', { taskId: task.id });
    timers.schedule(task.id, windowEnd.getTime());
    // Client: who accepted + the time window. `session-connected` is kept for the share-screen prompt (it now carries the same facts).
    emitToUser(task.client_id, 'task-started', meta);
    emitToUser(task.client_id, 'session-connected', { ...meta, vendor: vendorName });
    // Vendor: who sent the request + the time window (every tab/window of this vendor account)
    emitToUser(req.user.userId, 'task-accepted', meta);
  }

  const { token: _hidden, ...safeTask } = task; // never echo the token back
  res.json({
    success: true,
    reconnect: isReconnect,
    session,
    meta,
    task: { ...safeTask, status: 'active', vendor_id: req.user.userId, vendor_name: vendorName },
    windowEnd: windowEnd.getTime(),
    serverTime: Date.now(),
    remainingMinutes: Math.max(1, Math.round((windowEnd - now) / 60000))
  });
});

// REST version of terminate (the UI uses the socket event, this is a fallback). Owning client only.
app.post('/api/sessions/:id/terminate', authenticateToken, requireRole('client'), async (req, res) => {
  const session = await db.get('SELECT * FROM remote_sessions WHERE id = ?', [req.params.id]);
  if (!session || session.client_id !== req.user.userId) return res.status(404).json({ error: 'Session not found' });

  const result = await terminateTask(session.task_id, {
    reason: 'client_terminated', message: 'The client ended this session.', actorId: req.user.userId
  });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ success: true, alreadyEnded: !!result.alreadyEnded, message: 'Session terminated and remote pipe severed.' });
});

// Kill switch over plain HTTPS, by task id. The page uses this when its WebSocket is down or does not answer in time,
// so "Terminate Session Now" still works on a flaky connection. Owning client only.
app.post('/api/tasks/:id/terminate', authenticateToken, requireRole('client'), async (req, res) => {
  const taskId = Number(req.params.id);
  const task = Number.isInteger(taskId) ? await db.get('SELECT client_id FROM tasks WHERE id = ?', [taskId]) : null;
  if (!task || task.client_id !== req.user.userId) return res.status(404).json({ error: 'Task not found.' });
  const result = await terminateTask(taskId, { reason: 'client_terminated', message: 'The client ended this session.', actorId: req.user.userId });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ success: true, ok: true, alreadyEnded: !!result.alreadyEnded, tokenRevoked: true });
});

// Vendor (or owning client) ends the session normally
app.post('/api/sessions/:id/complete', authenticateToken, async (req, res) => {
  const session = await db.get('SELECT * FROM remote_sessions WHERE id = ?', [req.params.id]);
  const isParticipant = session && (session.vendor_id === req.user.userId || session.client_id === req.user.userId);
  if (!isParticipant) return res.status(404).json({ error: 'Session not found' });
  if (session.status !== 'active') return res.status(400).json({ error: `Session is already ${session.status}.` });

  const now = new Date().toISOString();
  await db.run("UPDATE remote_sessions SET status = 'completed', ended_at = ?, end_reason = 'completed' WHERE id = ?", [now, session.id]);
  // Changing the status to 'completed' fires the trust-engine trigger in db.js: rating = rating + 1 (and tasks_completed + 1)
  // for this vendor inside THIS client's directory, exactly once, in the same transaction.
  await db.run("UPDATE tasks SET status = 'completed', token_revoked = 1 WHERE id = ? AND status = 'active'", [session.task_id]);
  await logAudit(req.user.userId, 'SESSION_COMPLETED', { sessionId: session.id });
  // A completed session must close exactly like a terminated one: the host agent used to keep running (and accepting input)
  // until the original time window ran out, because nothing told it the task was over.
  timers.cancel(session.task_id);
  conversations.endCallsForTask(session.task_id, 'session-ended');
  accessRequests.expireTask(session.task_id).catch(() => {});
  remoteControl.teardown(session.task_id, 'completed');
  cutStream(session.task_id, 'completed', 'Session completed.');

  const payload = { taskId: session.task_id, reason: 'completed', message: 'Session completed.', status: 'completed' };
  emitToUser(session.client_id, 'session-ended', payload);
  if (session.vendor_id) emitToUser(session.vendor_id, 'session-ended', payload);
  res.json({ success: true, message: 'Session marked as completed successfully.' });
});

// ================= MESSAGES + CALLS (client <-> vendor, per ticket) =================
app.get('/api/conversations', authenticateToken, async (req, res) => {
  res.json({ conversations: await conversations.list(req.user), unread: await conversations.unreadTotal(req.user) });
});
app.get('/api/tasks/:id/messages', authenticateToken, async (req, res) => {
  const r = await conversations.messages(req.user, req.params.id);
  if (!r) return res.status(404).json({ error: 'Conversation not found.' });
  const a = r.access;
  const autoAnswer = a.role === 'client' && a.trusted ? (await conversations.contact(a.task.client_id, a.vendorId)).autoAnswer : false;
  res.json({ autoAnswer, messages: r.messages, me: req.user.userId, taskId: a.task.id, title: a.task.title, status: a.task.status, otherName: a.otherName, canSend: a.canSend, canCall: a.canCall, why: a.why, trusted: a.trusted, open: a.open, vendorId: a.vendorId, role: a.role, windowEnd: a.task.window_end || null });
});
app.post('/api/tasks/:id/messages', authenticateToken, async (req, res) => {
  const limitKey = `chat-send|${req.user.userId}`;
  if (isLimited(limitKey, 40)) return res.status(429).json({ error: 'You are sending messages very quickly. Wait a moment.' });
  recordAttempt(limitKey, 60 * 1000);
  const r = await conversations.send(req.user, req.params.id, req.body && req.body.body);
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.status(201).json({ message: r.message });
});
app.post('/api/tasks/:id/messages/read', authenticateToken, async (req, res) => {
  const r = await conversations.markRead(req.user, req.params.id);
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json({ success: true, updated: r.updated });
});
// "Always-On Access" (VIP): the client approves a vendor to text / call at any time (PUT) or takes it back (DELETE). Clients only.
app.put('/api/vendors/:id/contact', authenticateToken, requireRole('client'), async (req, res) => {
  // body (optional): { autoAnswer: true|false } answer this vendor's calls automatically (audio only)
  const r = await conversations.setTrusted(req.user, req.params.id, true, { autoAnswer: req.body && typeof req.body.autoAnswer === 'boolean' ? req.body.autoAnswer : undefined });
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json({ success: true, trusted: true, autoAnswer: r.autoAnswer });
});
app.delete('/api/vendors/:id/contact', authenticateToken, requireRole('client'), async (req, res) => {
  const r = await conversations.setTrusted(req.user, req.params.id, false);
  if (r.error) return res.status(r.status).json({ error: r.error });
  res.json({ success: true, trusted: false });
});
// ICE servers for a voice call (TURN credentials for 2 hours). Only for a party of a ticket that may call right now.
app.get('/api/calls/config', authenticateToken, async (req, res) => {
  const a = await conversations.access(req.user, req.query.taskId);
  if (!a || !a.canCall) return res.status(403).json({ error: (a && a.why) || 'Conversation not found.' });
  res.json(await buildRtcConfig({ userId: req.user.userId, expiresAtMs: Date.now() + 2 * 60 * 60 * 1000 }));
});

// ================= WORKSPACE (projects / groups shared by client and vendor; replaces the old Boards) =================
// GET /api/workspace -> { projects: [{ ...group, tasks }], ungrouped, canEdit }   (vendors: only their own tickets, read-only)
// Client: POST /api/projects { name, color?, description? } | PATCH /api/projects/:id | DELETE /api/projects/:id (tickets are kept)
//         PUT /api/tasks/:id/project { projectId | null }
app.get('/api/workspace', authenticateToken, async (req, res) => sendResult(res, await workspace.get(req.user)));
app.post('/api/projects', authenticateToken, async (req, res) => sendResult(res, await workspace.create(req.user, req.body || {})));
app.patch('/api/projects/:id', authenticateToken, async (req, res) => sendResult(res, await workspace.update(req.user, req.params.id, req.body || {})));
app.delete('/api/projects/:id', authenticateToken, async (req, res) => sendResult(res, await workspace.remove(req.user, req.params.id)));
app.put('/api/tasks/:id/project', authenticateToken, async (req, res) => sendResult(res, await workspace.moveTask(req.user, req.params.id, req.body && req.body.projectId)));

// ================= WEBRTC CONFIG + HOST AGENT PAIRING =================
// ICE servers for the task (TURN credentials expire exactly when the task window ends)
app.get('/api/rtc-config', authenticateToken, async (req, res) => {
  const taskId = Number(req.query.taskId);
  if (!(await authorizeRtc(req.user, taskId))) return res.status(403).json({ error: 'No active session for this task.' });
  const task = await db.get('SELECT window_end FROM tasks WHERE id = ?', [taskId]);
  res.json(await buildRtcConfig({ userId: req.user.userId, expiresAtMs: parseDbDate(task.window_end).getTime() }));
});

// The Client asks for a pairing token for the agent on their PC. It is valid for ONE task only, expires when the
// window ends, and is refused by every normal API route, so it cannot be used to log in as the Client.
app.post('/api/tasks/:id/agent-token', authenticateToken, requireRole('client'), async (req, res) => {
  const task = await db.get('SELECT * FROM tasks WHERE id = ?', [Number(req.params.id)]);
  if (!task || task.client_id !== req.user.userId) return res.status(404).json({ error: 'Task not found.' });
  if (!['pending', 'active'].includes(task.status)) return res.status(400).json({ error: `This task is already ${task.status}.` });
  const secondsLeft = Math.floor((parseDbDate(task.window_end).getTime() - Date.now()) / 1000);
  if (secondsLeft < 5) return res.status(400).json({ error: 'The time window has already ended.' });
  const agentToken = jwt.sign(
    { userId: req.user.userId, username: req.user.username, role: 'client', scope: 'agent', taskId: task.id },
    JWT_SECRET, { algorithm: 'HS256', expiresIn: secondsLeft }
  );
  await logAudit(req.user.userId, 'AGENT_TOKEN_ISSUED', { taskId: task.id });
  res.json({ agentToken, taskId: task.id, expiresInSeconds: secondsLeft });
});

// ================= ALERTS & HISTORY (scoped to the owning client) =================
app.get('/api/alerts', authenticateToken, requireRole('client'), async (req, res) => {
  const alerts = await db.all(`
    SELECT e.*, t.title AS task_title
    FROM intrusion_events e JOIN tasks t ON e.task_id = t.id
    WHERE t.client_id = ? ORDER BY e.id DESC LIMIT 50
  `, [req.user.userId]);
  res.json({ alerts });
});

// Task history. Same isolation rules as /api/tasks: a client gets only the tasks they created, a vendor only tasks assigned to them.
app.get('/api/history', authenticateToken, async (req, res) => {
  let history;
  if (req.user.role === 'client') {
    history = await db.all(`
      SELECT t.id AS task_id, t.title AS task_title, t.target_process, t.allowed_apps, t.allowed_paths, t.alerts_enabled,
             t.duration_minutes, t.status AS task_status, t.vendor_name, t.window_start, t.window_end, t.created_at,
             (SELECT COUNT(*) FROM intrusion_events ie WHERE ie.task_id = t.id) AS intrusion_count
      FROM tasks t WHERE t.client_id = ? ORDER BY t.id DESC LIMIT 500
    `, [req.user.userId]);
  } else {
    history = await db.all(`
      SELECT t.id AS task_id, t.title AS task_title, t.allowed_apps, t.allowed_paths,
             t.duration_minutes, t.status AS task_status, t.window_start, t.window_end, t.created_at,
             COALESCE(NULLIF(u.organization, ''), u.username) AS client_name
      FROM tasks t LEFT JOIN users u ON u.id = t.client_id
      WHERE t.assigned_vendor_user_id = ? ORDER BY t.id DESC LIMIT 500
    `, [req.user.userId]);
  }
  res.json({ history });
});

// The host agent on the Client's PC reads its approved scope here. The agent token is bound to ONE task and is refused by every
// other route, and the scope is read from the database, never from anything the vendor sent.
app.get('/api/agent/scope', async (req, res) => {
  const header = req.headers['authorization'];
  const { payload, code } = readToken(header && header.split(' ')[1]);
  if (!payload || payload.scope !== 'agent') return res.status(401).json({ error: AUTH_MESSAGES[code] || AUTH_MESSAGES.TOKEN_INVALID, code: code || 'TOKEN_INVALID' });
  const task = await db.get('SELECT id, client_id, status, token_revoked, allowed_apps, allowed_paths, alerts_enabled, window_end FROM tasks WHERE id = ?', [Number(payload.taskId)]);
  if (!task || task.client_id !== Number(payload.userId)) return res.status(404).json({ error: 'Task not found.' });
  if (!['pending', 'active'].includes(task.status) || task.token_revoked) return res.status(409).json({ error: `This task is already ${task.status}.` });
  res.json({
    taskId: task.id,
    allowedApps: taskScope.readList(task.allowed_apps),
    allowedPaths: taskScope.readList(task.allowed_paths),
    alertsEnabled: task.alerts_enabled !== 0,
    endsAt: parseDbDate(task.window_end).getTime()
  });
});

// ================= ERROR HANDLING =================
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON in request.' });
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`\n[START] Port ${PORT} is already in use. Something else is using it. Stop that program, or set a different PORT.\n`);
  else console.error('[START] Server failed to start:', err.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  timers.restoreAll().then((n) => console.log(`[TIMER] Re-armed ${n} open task(s)`)).catch((e) => console.error('[TIMER]', e.message));
  console.log('====================================================');
  console.log(' ScopeDesk Secure Task-Bounded Remote Support Engine');
  console.log(` Open:      ${APP_URL}`);
  console.log(` Mode:      ${IS_PRODUCTION ? 'production' : 'development'}   Build: ${BUILD}`);
  console.log(` Folder:    ${__dirname}`);
  if (IS_PRODUCTION && !process.env.DB_PATH) console.warn(' WARNING:   DB_PATH is not set. Data is lost on every redeploy. Add a Railway Volume and set DB_PATH=/data/scopedesk.db (see RAILWAY.md).');
  console.log(` Realtime:  Socket.IO on the same port`);
  console.log(` Database:  ${db.driver}`);
  console.log(` ${describeIceSetup()}`);
  console.log(` ${billing.describe()}`);
  console.log(` ${assistant.describe()}`);
  console.log('====================================================');
});
