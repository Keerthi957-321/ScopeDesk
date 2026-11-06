'use strict';
/**
 * Shared WORKSPACE (replaces the old private Boards): the client groups tickets into projects ("groups"), and both sides see,
 * live, what is being worked on in each group.
 *
 *   projects(id, client_id, name, color, description, created_at, updated_at)     owned by ONE client
 *   tasks.project_id -> projects.id (NULL = "Not grouped")
 *
 * Who sees what:
 *   client  every one of their projects and tickets; may create / rename / recolour / delete groups and move tickets between them
 *   vendor  only tickets assigned to them, inside the client's group name/colour (read-only). A vendor never sees a group they
 *           have no ticket in, nor other vendors' tickets.
 * Every change is pushed as 'workspace-changed' to the client and to the vendors of the tickets involved, so open screens refresh.
 */
const { readList } = require('./task-scope');

const COLORS = ['indigo', 'teal', 'amber', 'rose', 'violet', 'sky', 'lime', 'slate'];
const MAX_PROJECTS = 60;

function createWorkspace({ db, emitToUser, parseDbDate, logAudit = () => {}, now = () => Date.now() }) {
  const ready = (async () => {
    await db.run(`CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT 'indigo',
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    await db.run('CREATE INDEX IF NOT EXISTS idx_projects_client ON projects(client_id)');
    const cols = (await db.all('PRAGMA table_info(tasks)')).map((c) => c.name);
    if (!cols.includes('project_id')) await db.run('ALTER TABLE tasks ADD COLUMN project_id INTEGER');
  })();

  const cleanName = (v) => String(v || '').replace(/[\u0000-\u001f]+/g, ' ').trim().slice(0, 60);
  const cleanText = (v) => String(v || '').replace(/[\u0000-\u0009\u000b-\u001f]+/g, ' ').trim().slice(0, 240);
  const projectView = (p) => ({ id: p.id, name: p.name, color: p.color, description: p.description, createdAt: p.created_at, updatedAt: p.updated_at });

  // The state of one ticket, in words both sides understand
  function stage(t) {
    const end = t.window_end ? parseDbDate(t.window_end) : null;
    const endMs = end instanceof Date && !Number.isNaN(end.getTime()) ? end.getTime() : null;
    const left = endMs != null ? Math.max(0, Math.round((endMs - now()) / 60000)) : null;
    if (t.status === 'active') return { key: 'live', label: 'Live now', minutesLeft: left };
    if (t.status === 'pending') return endMs != null && endMs <= now() ? { key: 'ended', label: 'Expired' } : { key: 'waiting', label: 'Waiting to start', minutesLeft: left };
    if (t.status === 'completed') return { key: 'done', label: 'Done' };
    if (t.status === 'terminated' || t.status === 'violation') return { key: 'stopped', label: 'Stopped' };
    return { key: 'ended', label: t.status === 'expired' ? 'Expired' : 'Ended' };
  }
  function taskView(t, role) {
    const s = stage(t);
    return {
      id: t.id, title: t.title, projectId: t.project_id || null, status: t.status, stage: s.key, stageLabel: s.label, minutesLeft: s.minutesLeft ?? null,
      apps: readList(t.allowed_apps), folders: readList(t.allowed_paths).length,
      owner: role === 'client' ? (t.vendor_username || t.vendor_name || 'Vendor') : (t.client_name || 'Client'),
      ownerRole: role === 'client' ? 'vendor' : 'client',
      durationMinutes: t.duration_minutes, createdAt: t.created_at, windowEnd: t.window_end || null
    };
  }

  async function get(user) {
    await ready;
    const role = user.role;
    if (role !== 'client' && role !== 'vendor') return { status: 403, error: 'Not available.' };
    const where = role === 'client' ? 't.client_id = ?' : 't.assigned_vendor_user_id = ?';
    const tasks = await db.all(`SELECT t.id, t.title, t.status, t.project_id, t.allowed_apps, t.allowed_paths, t.window_end, t.duration_minutes, t.created_at,
        t.vendor_name, vu.username AS vendor_username, COALESCE(NULLIF(cu.organization, ''), cu.username) AS client_name, t.client_id
      FROM tasks t LEFT JOIN users vu ON vu.id = t.assigned_vendor_user_id LEFT JOIN users cu ON cu.id = t.client_id
      WHERE ${where} ORDER BY t.id DESC LIMIT 400`, [user.userId]);
    let projects;
    if (role === 'client') projects = await db.all('SELECT * FROM projects WHERE client_id = ? ORDER BY id', [user.userId]);
    else {
      const ids = [...new Set(tasks.map((t) => t.project_id).filter(Boolean))];
      projects = ids.length ? await db.all(`SELECT * FROM projects WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id`, ids) : [];
    }
    const known = new Set(projects.map((p) => p.id));
    const views = tasks.map((t) => taskView({ ...t, project_id: known.has(t.project_id) ? t.project_id : null }, role));
    return {
      status: 200, role, colors: COLORS, canEdit: role === 'client',
      projects: projects.map((p) => ({ ...projectView(p), tasks: views.filter((v) => v.projectId === p.id) })),
      ungrouped: views.filter((v) => !v.projectId)
    };
  }

  // tell the client and every vendor with a ticket in the touched groups
  async function notify(clientId, projectIds = []) {
    emitToUser(clientId, 'workspace-changed', {});
    const ids = projectIds.filter(Boolean);
    if (!ids.length) return;
    const rows = await db.all(`SELECT DISTINCT assigned_vendor_user_id AS v FROM tasks WHERE client_id = ? AND project_id IN (${ids.map(() => '?').join(',')})`, [clientId, ...ids]);
    rows.forEach((r) => { if (r.v) emitToUser(r.v, 'workspace-changed', {}); });
  }

  async function create(user, body) {
    await ready;
    if (user.role !== 'client') return { status: 403, error: 'Only the client creates groups.' };
    const name = cleanName(body && body.name);
    if (name.length < 2) return { status: 400, error: 'Give the group a name (at least 2 letters).' };
    const n = await db.get('SELECT COUNT(*) AS n FROM projects WHERE client_id = ?', [user.userId]);
    if (Number(n && n.n) >= MAX_PROJECTS) return { status: 400, error: `At most ${MAX_PROJECTS} groups.` };
    const color = COLORS.includes(body && body.color) ? body.color : COLORS[Number(n && n.n) % COLORS.length];
    const r = await db.run('INSERT INTO projects (client_id, name, color, description) VALUES (?, ?, ?, ?)', [user.userId, name, color, cleanText(body && body.description)]);
    const p = await db.get('SELECT * FROM projects WHERE id = ?', [r.lastInsertRowid]);
    logAudit(user.userId, 'PROJECT_CREATED', { projectId: p.id });
    await notify(user.userId);
    return { status: 201, project: projectView(p) };
  }

  async function mine(user, id) {
    const p = await db.get('SELECT * FROM projects WHERE id = ?', [Number(id)]);
    return p && user.role === 'client' && p.client_id === user.userId ? p : null;
  }

  async function update(user, id, body) {
    await ready;
    const p = await mine(user, id);
    if (!p) return { status: 404, error: 'Group not found.' };
    const name = body && body.name !== undefined ? cleanName(body.name) : p.name;
    if (name.length < 2) return { status: 400, error: 'Give the group a name (at least 2 letters).' };
    const color = body && body.color !== undefined ? (COLORS.includes(body.color) ? body.color : null) : p.color;
    if (!color) return { status: 400, error: 'Unknown colour.' };
    const description = body && body.description !== undefined ? cleanText(body.description) : p.description;
    await db.run("UPDATE projects SET name = ?, color = ?, description = ?, updated_at = datetime('now') WHERE id = ?", [name, color, description, p.id]);
    await notify(user.userId, [p.id]);
    return { status: 200, project: projectView(await db.get('SELECT * FROM projects WHERE id = ?', [p.id])) };
  }

  // Deleting a group never deletes tickets: they move to "Not grouped"
  async function remove(user, id) {
    await ready;
    const p = await mine(user, id);
    if (!p) return { status: 404, error: 'Group not found.' };
    await notify(user.userId, [p.id]);                     // vendors who could see it must refresh too (before the link is cut)
    await db.run('UPDATE tasks SET project_id = NULL WHERE project_id = ? AND client_id = ?', [p.id, user.userId]);
    await db.run('DELETE FROM projects WHERE id = ?', [p.id]);
    logAudit(user.userId, 'PROJECT_DELETED', { projectId: p.id });
    return { status: 200, success: true };
  }

  async function moveTask(user, taskId, projectId) {
    await ready;
    if (user.role !== 'client') return { status: 403, error: 'Only the client groups tickets.' };
    const t = await db.get('SELECT id, client_id, project_id FROM tasks WHERE id = ?', [Number(taskId)]);
    if (!t || t.client_id !== user.userId) return { status: 404, error: 'Ticket not found.' };
    let target = null;
    if (projectId !== null && projectId !== undefined && projectId !== '') {
      const p = await mine(user, projectId);
      if (!p) return { status: 404, error: 'Group not found.' };
      target = p.id;
    }
    await db.run('UPDATE tasks SET project_id = ? WHERE id = ?', [target, t.id]);
    await notify(user.userId, [t.project_id, target]);
    const v = await db.get('SELECT assigned_vendor_user_id AS v FROM tasks WHERE id = ?', [t.id]);
    if (v && v.v) emitToUser(v.v, 'workspace-changed', {});
    return { status: 200, taskId: t.id, projectId: target };
  }

  return { get, create, update, remove, moveTask, ready, COLORS };
}

module.exports = { createWorkspace, COLORS };
