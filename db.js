const path = require('path');

// Database: SQLite via Node's built-in `node:sqlite` (Node 22.13+). No external DB needed.
// Demo accounts with a published password must never exist on a public server
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_PROJECT_ID;
const dbPath = process.env.DB_PATH || path.join(__dirname, 'scopedesk.db');

let sqliteDb;
try {
  const { DatabaseSync } = require('node:sqlite');
  sqliteDb = new DatabaseSync(dbPath);
  console.log(`[DB] Connected to SQLite database: ${dbPath}`);
} catch (err) {
  console.error('[DB] Could not open SQLite. You need Node.js 22.13 or newer.', err.message);
  process.exit(1);
}

function initSqliteTables() {
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('client', 'vendor')),
      organization TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      email_verified INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'ACTIVE',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER,
      vendor_user_id INTEGER,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      organization TEXT NOT NULL,
      specialization TEXT DEFAULT 'General IT & System Support',
      status TEXT NOT NULL DEFAULT 'Active',
      rating REAL DEFAULT 4.9,
      tasks_completed INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      vendor_id INTEGER,
      vendor_name TEXT,
      title TEXT NOT NULL,
      description TEXT,
      target_process TEXT NOT NULL,
      target_window TEXT,
      duration_minutes INTEGER NOT NULL DEFAULT 30,
      token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'completed', 'expired', 'terminated')),
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS remote_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      client_id INTEGER NOT NULL,
      vendor_id INTEGER,
      vendor_name TEXT,
      token TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'terminated', 'expired')),
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      end_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS intrusion_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER,
      task_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      process_name TEXT,
      details TEXT,
      severity TEXT NOT NULL DEFAULT 'critical',
      action_taken TEXT NOT NULL DEFAULT 'alert_only',
      occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- NEW: password recovery. Only a SHA-256 hash of the reset token is stored.
    CREATE TABLE IF NOT EXISTS password_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Sign-up email verification: only a keyed hash of the 6-digit code is stored. New accounts start unverified (users.email_verified = 0).
    CREATE TABLE IF NOT EXISTS email_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      code_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_email_verifications_user ON email_verifications (user_id);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- NEW: a client can end a vendor's access (per-client block) and report vendors
    CREATE TABLE IF NOT EXISTS client_vendor_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      vendor_user_id INTEGER NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (client_id, vendor_user_id)
    );

    CREATE TABLE IF NOT EXISTS vendor_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      vendor_user_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_client ON tasks (client_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_task ON remote_sessions (task_id);
    CREATE INDEX IF NOT EXISTS idx_events_task ON intrusion_events (task_id);
  `);

  // Migration for databases created by earlier versions: which vendor ACCOUNT a task request was sent to
  const taskCols = sqliteDb.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
  if (!taskCols.includes('assigned_vendor_user_id')) {
    sqliteDb.exec('ALTER TABLE tasks ADD COLUMN assigned_vendor_user_id INTEGER');
  }
  // Task type (e.g. "Billing"): the host agent looks it up in agent/policies.json to learn which apps and folders are allowed
  if (!taskCols.includes('task_type')) {
    sqliteDb.exec("ALTER TABLE tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT ''");
  }
  // Custom scope chosen by the Client when creating the ticket (JSON arrays, '' = none). Added on top of the task type's policy.
  if (!taskCols.includes('allowed_paths')) sqliteDb.exec("ALTER TABLE tasks ADD COLUMN allowed_paths TEXT NOT NULL DEFAULT ''");
  if (!taskCols.includes('allowed_apps')) sqliteDb.exec("ALTER TABLE tasks ADD COLUMN allowed_apps TEXT NOT NULL DEFAULT ''");
  // Client-chosen switch: may ScopeDesk show breach / termination alerts on this Client's screen? (Enforcement itself is never optional.)
  if (!taskCols.includes('alerts_enabled')) sqliteDb.exec('ALTER TABLE tasks ADD COLUMN alerts_enabled INTEGER NOT NULL DEFAULT 1');
  // BILLING: 'legacy' (payments off / created before billing existed), 'free' (counts against the monthly allowance) or 'paid'.
  // billing_month is "YYYY-MM" in the billing time zone, so the allowance check is a plain equality on an indexed column.
  if (!taskCols.includes('billing')) sqliteDb.exec("ALTER TABLE tasks ADD COLUMN billing TEXT NOT NULL DEFAULT 'legacy'");
  if (!taskCols.includes('billing_month')) sqliteDb.exec("ALTER TABLE tasks ADD COLUMN billing_month TEXT NOT NULL DEFAULT ''");
  if (!taskCols.includes('amount_paise')) sqliteDb.exec('ALTER TABLE tasks ADD COLUMN amount_paise INTEGER NOT NULL DEFAULT 0');
  if (!taskCols.includes('payment_order_id')) sqliteDb.exec('ALTER TABLE tasks ADD COLUMN payment_order_id INTEGER');
  // TOKEN REVOCATION: set when a task ends (terminated / expired / completed). A revoked token can never open a session again.
  if (!taskCols.includes('token_revoked')) {
    sqliteDb.exec('ALTER TABLE tasks ADD COLUMN token_revoked INTEGER NOT NULL DEFAULT 0');
    sqliteDb.exec("UPDATE tasks SET token_revoked = 1 WHERE status NOT IN ('pending', 'active')");   // tasks that already ended
  }
  sqliteDb.exec('CREATE INDEX IF NOT EXISTS idx_tasks_billing ON tasks (client_id, billing, billing_month)');
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS payment_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      razorpay_order_id TEXT UNIQUE,
      razorpay_payment_id TEXT,
      amount_paise INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR',
      duration_minutes INTEGER NOT NULL,
      request_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paid', 'fulfilled', 'unfulfilled')),
      task_id INTEGER,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      paid_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_payment_orders_client ON payment_orders (client_id);
  `);
  // MEMBERSHIP: what an order pays for ('task' = one paid task, 'membership' = monthly / yearly plan)
  const orderCols = sqliteDb.prepare('PRAGMA table_info(payment_orders)').all().map((c) => c.name);
  if (!orderCols.includes('kind')) sqliteDb.exec("ALTER TABLE payment_orders ADD COLUMN kind TEXT NOT NULL DEFAULT 'task'");
  if (!orderCols.includes('plan')) sqliteDb.exec("ALTER TABLE payment_orders ADD COLUMN plan TEXT NOT NULL DEFAULT ''");
  // users.membership_until: ISO time the paid membership ends ('' = never had one). The plan itself is worked out from this
  // and users.created_at (trial) every time, so there is no "plan" flag that could be stale.
  const memberCols = sqliteDb.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!memberCols.includes('membership_until')) sqliteDb.exec("ALTER TABLE users ADD COLUMN membership_until TEXT NOT NULL DEFAULT ''");
  if (!memberCols.includes('membership_plan')) sqliteDb.exec("ALTER TABLE users ADD COLUMN membership_plan TEXT NOT NULL DEFAULT ''");
  sqliteDb.exec('CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks (assigned_vendor_user_id)');
  sqliteDb.exec('CREATE INDEX IF NOT EXISTS idx_vendors_client ON vendors (client_id, vendor_user_id)');
  installTrustEngine();
  // Email verification: accounts created before this update stay verified (DEFAULT 1); new sign-ups are inserted with 0 by the server
  const userCols = sqliteDb.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  if (!userCols.includes('email_verified')) sqliteDb.exec('ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 1');
  // Account lifecycle: PENDING_VERIFICATION (signed up, code not entered yet) -> ACTIVE. email_verified mirrors it for the older queries.
  if (!userCols.includes('status')) {
    sqliteDb.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE'");
    sqliteDb.exec("UPDATE users SET status = 'PENDING_VERIFICATION' WHERE email_verified = 0");
  }
  // Password-reset codes are 6 digits, so wrong guesses are counted per code and the code dies after a few misses
  const resetCols = sqliteDb.prepare('PRAGMA table_info(password_resets)').all().map((c) => c.name);
  if (!resetCols.includes('attempts')) sqliteDb.exec('ALTER TABLE password_resets ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0');

  // Seed demo users on a brand-new database only
  const userCount = sqliteDb.prepare('SELECT COUNT(*) as count FROM users').get().count;
  const seedDemo = userCount === 0 && (!IS_PROD || process.env.SEED_DEMO === 'true');
  if (seedDemo) {
    const bcrypt = require('bcryptjs');
    const defaultPasswordHash = bcrypt.hashSync('Password123!', 10);

    const insertUser = sqliteDb.prepare(`
      INSERT INTO users (username, email, password_hash, role, organization)
      VALUES (?, ?, ?, ?, ?)
    `);

    insertUser.run('office_admin', 'admin@mapleoffice.com', defaultPasswordHash, 'client', 'Maple & Co. Financial Office');
    insertUser.run('it_vendor', 'mayo@northstar-it.com', defaultPasswordHash, 'vendor', 'Northstar IT Solutions');
    insertUser.run('tech_alpha', 'thao@helpworks.io', defaultPasswordHash, 'vendor', 'HelpWorks Managed Services');
    insertUser.run('secure_net', 'theo@securenet.tech', defaultPasswordHash, 'vendor', 'SecureNet Tech Partners');

    console.log('[DB] Pre-seeded demo accounts (password for all: Password123!)');
    console.log('     Client: office_admin');
    console.log('     Vendor: it_vendor');
  }

  const vendorCount = sqliteDb.prepare('SELECT COUNT(*) as count FROM vendors').get().count;
  // Demo vendor rows and demo tasks reference user ids 1-4. They are only created together with the demo users:
  // on a real database those ids belong to real people, who must never inherit fake ratings or fake tasks.
  if (seedDemo && vendorCount === 0) {
    const insertVendor = sqliteDb.prepare(`
      INSERT INTO vendors (client_id, vendor_user_id, name, email, organization, specialization, status, rating, tasks_completed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertVendor.run(1, 2, 'Mayo Patel', 'mayo@northstar-it.com', 'Northstar IT Solutions', 'ERP & Accounting Systems', 'Active', 4.9, 14);
    insertVendor.run(1, 3, 'Thao Tran', 'thao@helpworks.io', 'HelpWorks Managed Services', 'Network & Diagnostic Routines', 'Active', 4.8, 8);
    insertVendor.run(1, 4, 'Theo Grant', 'theo@securenet.tech', 'SecureNet Tech Partners', 'Database & Lab Software Support', 'Active', 5.0, 19);
  }

  const taskCount = sqliteDb.prepare('SELECT COUNT(*) as count FROM tasks').get().count;
  if (seedDemo && taskCount === 0) {
    const insertTask = sqliteDb.prepare(`
      INSERT INTO tasks (client_id, vendor_id, assigned_vendor_user_id, vendor_name, title, description, target_process, duration_minutes, token, status, window_start, window_end)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const start = new Date();
    const end30 = new Date(start.getTime() + 30 * 60000);
    const end45 = new Date(start.getTime() + 45 * 60000);

    insertTask.run(
      1, 2, 2, 'Northstar IT Solutions (it_vendor)',
      'Fix Billing Software Invoice PDF Export Engine Error',
      'Diagnose stuck export queue in Billing Manager v4 without touching payroll sheets',
      'billing_manager.exe', 30, 'SCD-1042-XP8B', 'pending',
      start.toISOString(), end30.toISOString()
    );
    insertTask.run(
      1, 4, 4, 'SecureNet Tech Partners (secure_net)',
      'Configure Split-Tunnel OpenVPN Gateway Routings',
      'Update gateway route configurations for dental workstation tunnel',
      'openvpn_gui.exe', 45, 'SCD-3091-ZN72', 'pending',
      start.toISOString(), end45.toISOString()
    );
  }
}

// ================= GAMIFIED TRUST ENGINE =================
// A database-level hook: every time a task's status changes TO 'completed', the vendor's rating inside THAT CLIENT's
// approved-vendor directory goes up by exactly one (rating = rating + 1). Because it is a trigger, it fires for every code path
// that completes a task (REST, sockets, future admin tools), exactly once per task (OLD.status <> 'completed'), and in the
// same transaction as the status change, so the two can never disagree.
//  - A vendor who has no directory row for this client yet gets one (rating 0 -> 1).
//  - A task that logged any security violation earns nothing.
//  - Other clients' directories are never touched.
function installTrustEngine() {
  sqliteDb.exec('DROP TRIGGER IF EXISTS trg_task_completed_rate_vendor');
  sqliteDb.exec(`
    CREATE TRIGGER trg_task_completed_rate_vendor
    AFTER UPDATE OF status ON tasks
    WHEN NEW.status = 'completed'
     AND OLD.status <> 'completed'
     AND COALESCE(NEW.vendor_id, NEW.assigned_vendor_user_id) IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM intrusion_events e WHERE e.task_id = NEW.id)
    BEGIN
      INSERT INTO vendors (client_id, vendor_user_id, name, email, organization, specialization, status, rating, tasks_completed)
      SELECT NEW.client_id, u.id, u.username, u.email, COALESCE(NULLIF(u.organization, ''), 'Independent Support Vendor'),
             COALESCE((SELECT g.specialization FROM vendors g WHERE g.vendor_user_id = u.id AND g.client_id IS NULL LIMIT 1), 'General Remote Diagnostics'),
             'Active', 0, 0
      FROM users u
      WHERE u.id = COALESCE(NEW.vendor_id, NEW.assigned_vendor_user_id)
        AND NOT EXISTS (SELECT 1 FROM vendors d WHERE d.client_id = NEW.client_id AND d.vendor_user_id = u.id);

      UPDATE vendors
         SET rating = rating + 1,
             tasks_completed = tasks_completed + 1
       WHERE client_id = NEW.client_id
         AND vendor_user_id = COALESCE(NEW.vendor_id, NEW.assigned_vendor_user_id);
    END;
  `);
}

initSqliteTables();

// Small async wrapper so the rest of the app can use `await db.get(...)`
const db = {
  driver: 'sqlite',
  async all(sql, params = []) { return sqliteDb.prepare(sql).all(...params); },
  async get(sql, params = []) { return sqliteDb.prepare(sql).get(...params); },
  async run(sql, params = []) {
    const result = sqliteDb.prepare(sql).run(...params);
    return { lastInsertRowid: Number(result.lastInsertRowid), changes: result.changes };
  },
  async exec(sql) { return sqliteDb.exec(sql); }
};

module.exports = db;
