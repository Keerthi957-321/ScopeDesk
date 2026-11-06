'use strict';
/**
 * "Request Additional Access": during a ticket the VENDOR asks for more apps or folders; nothing changes unless the CLIENT approves.
 *
 *   pending ──(client Approve)──> approved   scope widened in the database, then pushed to the client's PC (agent 'scope-updated')
 *      │    ──(client Deny)─────> denied
 *      │    ──(vendor Cancel)───> cancelled
 *      └────(ticket ends)───────> expired    (ended, terminated, timed out, access revoked)
 *
 * Zero trust:
 *   - The vendor only ever sends a WISH. The server re-validates every app and folder with the same rules as a new ticket
 *     (no shells / system tools, no whole drives, no ".."), and the agent on the client's PC checks again with its own policy.
 *   - Only the ticket's own client can decide, only while the ticket is open, only on a pending request. Approve may be partial:
 *     the client can untick items before approving.
 *   - One pending request per ticket (no prompt spam); at most MAX_PER_TICKET requests per ticket.
 *   - The approved scope only ever ADDS to the ticket. Nothing is removed by a request.
 *   - Every step is in the audit log.
 */
const { parseAllowedApps, checkPath, readList } = require('./task-scope');

const MAX_PER_TICKET = 10;
const MAX_ITEMS = 10;

function createAccessRequests({ db, emitToUser, sendToAgents, onScopeChanged = () => {}, logAudit = () => {}, now = () => Date.now() }) {
  const ready = (async () => {
    await db.run(`CREATE TABLE IF NOT EXISTS access_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      vendor_user_id INTEGER NOT NULL,
      client_id INTEGER NOT NULL,
      apps TEXT NOT NULL DEFAULT '[]',
      paths TEXT NOT NULL DEFAULT '[]',
      reason TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending',
      granted_apps TEXT NOT NULL DEFAULT '[]',
      granted_paths TEXT NOT NULL DEFAULT '[]',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      decided_at DATETIME
    )`);
    await db.run('CREATE INDEX IF NOT EXISTS idx_access_requests_task ON access_requests(task_id, status)');
  })();

  const view = (r) => r && ({
    id: r.id, taskId: r.task_id, status: r.status, reason: r.reason,
    apps: readList(r.apps), paths: readList(r.paths),
    grantedApps: readList(r.granted_apps), grantedPaths: readList(r.granted_paths),
    createdAt: r.created_at, decidedAt: r.decided_at || null
  });
  const open = (t) => t && (t.status === 'pending' || t.status === 'active') && !t.token_revoked;

  async function task(taskId) {
    return db.get('SELECT id, title, client_id, assigned_vendor_user_id, status, token_revoked, allowed_apps, allowed_paths FROM tasks WHERE id = ?', [Number(taskId)]);
  }
  const keyOf = (s) => String(s).trim().toLowerCase().replace(/[\\/]+$/, '').replace(/\\/g, '/');

  // Clean the vendor's wish with the same rules as a new ticket, and drop what the ticket already allows
  function cleanWish(body, t) {
    const appsIn = Array.isArray(body && body.apps) ? body.apps.slice(0, MAX_ITEMS + 1) : [];
    const pathsIn = Array.isArray(body && body.paths) ? body.paths.slice(0, MAX_ITEMS + 1) : [];
    if (appsIn.length > MAX_ITEMS || pathsIn.length > MAX_ITEMS) return { error: `Ask for at most ${MAX_ITEMS} apps and ${MAX_ITEMS} folders at a time.` };
    let apps = [];
    if (appsIn.length) {
      const r = parseAllowedApps(appsIn);
      if (r.error) return { error: r.error };
      apps = r.apps;
    }
    const paths = [];
    for (const raw of pathsIn) {
      const p = String(raw || '').trim().replace(/^["']|["']$/g, '');
      if (!p) continue;
      const bad = checkPath(p);
      if (bad) return { error: bad };
      if (!/^([A-Za-z]:[\\/]|\\\\[^\\/?.]|\/|~[\\/]|%[A-Za-z_][A-Za-z0-9_]*%[\\/])/.test(p)) return { error: `"${p.slice(0, 60)}" is not a full folder path (for example C:\\Billing or /Users/me/Billing).` };
      if (!paths.some((x) => keyOf(x) === keyOf(p))) paths.push(p);
    }
    const haveApps = new Set(readList(t.allowed_apps).map(keyOf));
    const havePaths = new Set(readList(t.allowed_paths).map(keyOf));
    apps = apps.filter((a) => !haveApps.has(keyOf(a)));
    const newPaths = paths.filter((p) => !havePaths.has(keyOf(p)));
    if (!apps.length && !newPaths.length) return { error: (appsIn.length || pathsIn.length) ? 'This ticket already allows everything you asked for.' : 'Choose at least one app or folder to ask for.' };
    const reason = String((body && body.reason) || '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 300);
    if (reason.length < 3) return { error: 'Say in a few words why you need it (the client sees this).' };
    return { apps, paths: newPaths, reason };
  }

  async function create(user, taskId, body) {
    await ready;
    if (user.role !== 'vendor') return { status: 403, error: 'Only the vendor can ask for more access.' };
    const t = await task(taskId);
    if (!t || t.assigned_vendor_user_id !== user.userId) return { status: 404, error: 'Ticket not found.' };
    if (!open(t)) return { status: 409, error: 'This ticket has ended, so no more access can be given.' };
    const pending = await db.get("SELECT id FROM access_requests WHERE task_id = ? AND status = 'pending'", [t.id]);
    if (pending) return { status: 409, error: 'You already have a request waiting for the client. Wait for an answer or cancel it first.' };
    const count = await db.get('SELECT COUNT(*) AS n FROM access_requests WHERE task_id = ?', [t.id]);
    if (Number(count && count.n) >= MAX_PER_TICKET) return { status: 429, error: 'Too many access requests on this ticket.' };
    const w = cleanWish(body, t);
    if (w.error) return { status: 400, error: w.error };
    const r = await db.run('INSERT INTO access_requests (task_id, vendor_user_id, client_id, apps, paths, reason) VALUES (?, ?, ?, ?, ?, ?)',
      [t.id, user.userId, t.client_id, JSON.stringify(w.apps), JSON.stringify(w.paths), w.reason]);
    const row = view(await db.get('SELECT * FROM access_requests WHERE id = ?', [r.lastInsertRowid]));
    logAudit(user.userId, 'ACCESS_REQUESTED', { taskId: t.id, requestId: row.id, apps: w.apps, paths: w.paths });
    const who = await db.get('SELECT username FROM users WHERE id = ?', [user.userId]);
    emitToUser(t.client_id, 'access-request', { ...row, taskTitle: t.title, vendorName: (who && who.username) || 'Your vendor' });
    emitToUser(user.userId, 'access-request', { ...row, taskTitle: t.title });
    return { status: 201, request: row };
  }

  async function list(user, taskId) {
    await ready;
    const t = await task(taskId);
    if (!t || !((user.role === 'client' && t.client_id === user.userId) || (user.role === 'vendor' && t.assigned_vendor_user_id === user.userId))) return { status: 404, error: 'Ticket not found.' };
    const rows = await db.all('SELECT * FROM access_requests WHERE task_id = ? ORDER BY id DESC LIMIT 20', [t.id]);
    return { status: 200, requests: rows.map(view), allowedApps: readList(t.allowed_apps), allowedPaths: readList(t.allowed_paths), open: open(t) };
  }

  // body (approve): { apps?: [...], paths?: [...] } to approve only some of the asked items (default: all)
  async function decide(user, requestId, approve, body = {}) {
    await ready;
    if (user.role !== 'client') return { status: 403, error: 'Only the client can approve or deny.' };
    const req = await db.get('SELECT * FROM access_requests WHERE id = ?', [Number(requestId)]);
    if (!req || req.client_id !== user.userId) return { status: 404, error: 'Request not found.' };
    if (req.status !== 'pending') return { status: 409, error: `This request was already ${req.status}.` };
    const t = await task(req.task_id);
    if (!open(t)) { await expireTask(req.task_id); return { status: 409, error: 'This ticket has ended, so the request has expired.' }; }

    if (!approve) {
      const r = await db.run("UPDATE access_requests SET status = 'denied', decided_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'", [req.id]);
      if (!r.changes) return { status: 409, error: 'This request was already answered.' };
      const row = view(await db.get('SELECT * FROM access_requests WHERE id = ?', [req.id]));
      logAudit(user.userId, 'ACCESS_DENIED', { taskId: t.id, requestId: req.id });
      emitToUser(req.vendor_user_id, 'access-request', { ...row, taskTitle: t.title });
      emitToUser(user.userId, 'access-request', { ...row, taskTitle: t.title });
      return { status: 200, request: row };
    }

    // Partial approval: only items that were really asked for can be granted (the client cannot be tricked into a wider list either)
    const asked = { apps: readList(req.apps), paths: readList(req.paths) };
    const pick = (want, have) => (Array.isArray(want) ? have.filter((h) => want.some((w) => keyOf(w) === keyOf(h))) : have);
    const grantApps = pick(body.apps, asked.apps);
    const grantPaths = pick(body.paths, asked.paths);
    if (!grantApps.length && !grantPaths.length) return { status: 400, error: 'Tick at least one item to approve, or press Deny.' };

    const r = await db.run("UPDATE access_requests SET status = 'approved', decided_at = CURRENT_TIMESTAMP, granted_apps = ?, granted_paths = ? WHERE id = ? AND status = 'pending'",
      [JSON.stringify(grantApps), JSON.stringify(grantPaths), req.id]);
    if (!r.changes) return { status: 409, error: 'This request was already answered.' };
    // Widen the ticket (union; nothing is ever removed here)
    const apps = [...readList(t.allowed_apps)];
    grantApps.forEach((a) => { if (!apps.some((x) => keyOf(x) === keyOf(a))) apps.push(a); });
    const paths = [...readList(t.allowed_paths)];
    grantPaths.forEach((p) => { if (!paths.some((x) => keyOf(x) === keyOf(p))) paths.push(p); });
    if (grantPaths.length && !apps.some((a) => keyOf(a) === 'file manager')) apps.push('File Manager');   // folders open in the file manager
    await db.run('UPDATE tasks SET allowed_apps = ?, allowed_paths = ? WHERE id = ?', [JSON.stringify(apps), JSON.stringify(paths), t.id]);
    onScopeChanged(t.id);
    const delivered = sendToAgents(t.id, 'scope-updated', { taskId: t.id, allowedApps: apps, allowedPaths: paths });
    const row = view(await db.get('SELECT * FROM access_requests WHERE id = ?', [req.id]));
    logAudit(user.userId, 'ACCESS_APPROVED', { taskId: t.id, requestId: req.id, apps: grantApps, paths: grantPaths });
    const payload = { ...row, taskTitle: t.title, allowedApps: apps, allowedPaths: paths, appliedLive: delivered > 0 };
    emitToUser(req.vendor_user_id, 'access-request', payload);
    emitToUser(user.userId, 'access-request', payload);
    return { status: 200, request: row, allowedApps: apps, allowedPaths: paths, appliedLive: delivered > 0 };
  }

  async function cancel(user, requestId) {
    await ready;
    const req = await db.get('SELECT * FROM access_requests WHERE id = ?', [Number(requestId)]);
    if (!req || req.vendor_user_id !== user.userId) return { status: 404, error: 'Request not found.' };
    const r = await db.run("UPDATE access_requests SET status = 'cancelled', decided_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'", [req.id]);
    if (!r.changes) return { status: 409, error: 'This request was already answered.' };
    const row = view(await db.get('SELECT * FROM access_requests WHERE id = ?', [req.id]));
    emitToUser(req.client_id, 'access-request', row);
    emitToUser(user.userId, 'access-request', row);
    return { status: 200, request: row };
  }

  // The ticket ended (any way): a waiting request can never be approved any more
  async function expireTask(taskId) {
    await ready;
    const rows = await db.all("SELECT * FROM access_requests WHERE task_id = ? AND status = 'pending'", [Number(taskId)]);
    if (!rows.length) return 0;
    await db.run("UPDATE access_requests SET status = 'expired', decided_at = CURRENT_TIMESTAMP WHERE task_id = ? AND status = 'pending'", [Number(taskId)]);
    for (const r of rows) {
      const row = view({ ...r, status: 'expired' });
      emitToUser(r.client_id, 'access-request', row);
      emitToUser(r.vendor_user_id, 'access-request', row);
    }
    return rows.length;
  }

  return { create, list, decide, cancel, expireTask, ready };
}

module.exports = { createAccessRequests, MAX_PER_TICKET };
