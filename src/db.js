const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const config = require('./config');

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });

const db = new Database(config.databasePath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS upstream_sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  upstream_type TEXT NOT NULL DEFAULT 'auto',
  auth_mode TEXT NOT NULL DEFAULT 'password',
  status TEXT NOT NULL DEFAULT 'active',
  tags TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  codex_aliases TEXT NOT NULL DEFAULT '["codex"]',
  low_balance_threshold REAL NOT NULL DEFAULT 10,
  rate_change_threshold_percent REAL NOT NULL DEFAULT 20,
  sync_interval_seconds INTEGER NOT NULL DEFAULT 180,
  last_sync_at TEXT,
  last_sync_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_upstream_sites_base_url ON upstream_sites(base_url);

CREATE TABLE IF NOT EXISTS upstream_credentials (
  upstream_site_id INTEGER PRIMARY KEY,
  encrypted_email TEXT NOT NULL DEFAULT '',
  encrypted_password TEXT NOT NULL DEFAULT '',
  encrypted_token TEXT NOT NULL DEFAULT '',
  token_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (upstream_site_id) REFERENCES upstream_sites(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS upstream_current_snapshots (
  upstream_site_id INTEGER PRIMARY KEY,
  balance REAL,
  balance_currency TEXT NOT NULL DEFAULT 'unknown',
  username TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  total_requests INTEGER NOT NULL DEFAULT 0,
  today_requests INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  today_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost REAL NOT NULL DEFAULT 0,
  today_cost REAL NOT NULL DEFAULT 0,
  week_requests INTEGER NOT NULL DEFAULT 0,
  week_tokens INTEGER NOT NULL DEFAULT 0,
  week_cost REAL NOT NULL DEFAULT 0,
  month_requests INTEGER NOT NULL DEFAULT 0,
  month_tokens INTEGER NOT NULL DEFAULT 0,
  month_cost REAL NOT NULL DEFAULT 0,
  codex_rate REAL,
  min_rate REAL,
  max_rate REAL,
  payment_enabled INTEGER NOT NULL DEFAULT 0,
  balance_recharge_disabled INTEGER NOT NULL DEFAULT 0,
  balance_recharge_multiplier REAL,
  recharge_fee_rate REAL,
  payment_plan_count INTEGER NOT NULL DEFAULT 0,
  payment_methods TEXT NOT NULL DEFAULT '[]',
  group_count INTEGER NOT NULL DEFAULT 0,
  key_count INTEGER NOT NULL DEFAULT 0,
  channel_count INTEGER NOT NULL DEFAULT 0,
  raw_payload TEXT NOT NULL DEFAULT '{}',
  captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (upstream_site_id) REFERENCES upstream_sites(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS upstream_snapshot_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  upstream_site_id INTEGER NOT NULL,
  balance REAL,
  balance_currency TEXT NOT NULL DEFAULT 'unknown',
  total_requests INTEGER NOT NULL DEFAULT 0,
  today_requests INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  today_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost REAL NOT NULL DEFAULT 0,
  today_cost REAL NOT NULL DEFAULT 0,
  week_requests INTEGER NOT NULL DEFAULT 0,
  week_tokens INTEGER NOT NULL DEFAULT 0,
  week_cost REAL NOT NULL DEFAULT 0,
  month_requests INTEGER NOT NULL DEFAULT 0,
  month_tokens INTEGER NOT NULL DEFAULT 0,
  month_cost REAL NOT NULL DEFAULT 0,
  codex_rate REAL,
  min_rate REAL,
  max_rate REAL,
  payment_enabled INTEGER NOT NULL DEFAULT 0,
  balance_recharge_disabled INTEGER NOT NULL DEFAULT 0,
  balance_recharge_multiplier REAL,
  recharge_fee_rate REAL,
  payment_plan_count INTEGER NOT NULL DEFAULT 0,
  payment_methods TEXT NOT NULL DEFAULT '[]',
  group_count INTEGER NOT NULL DEFAULT 0,
  key_count INTEGER NOT NULL DEFAULT 0,
  channel_count INTEGER NOT NULL DEFAULT 0,
  captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (upstream_site_id) REFERENCES upstream_sites(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_upstream_snapshot_history_site_time ON upstream_snapshot_history(upstream_site_id, captured_at);

CREATE TABLE IF NOT EXISTS group_rate_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  upstream_site_id INTEGER NOT NULL,
  group_id TEXT NOT NULL DEFAULT '',
  group_name TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  rate REAL NOT NULL,
  raw_payload TEXT NOT NULL DEFAULT '{}',
  captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (upstream_site_id) REFERENCES upstream_sites(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_group_rate_snapshots_site_time ON group_rate_snapshots(upstream_site_id, captured_at);

CREATE TABLE IF NOT EXISTS rate_change_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  upstream_site_id INTEGER NOT NULL,
  group_id TEXT NOT NULL DEFAULT '',
  group_name TEXT NOT NULL DEFAULT '',
  old_rate REAL,
  new_rate REAL NOT NULL,
  change_percent REAL,
  detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  acknowledged_at TEXT,
  FOREIGN KEY (upstream_site_id) REFERENCES upstream_sites(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sync_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  upstream_site_id INTEGER NOT NULL,
  sync_type TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  http_status INTEGER,
  error_message TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (upstream_site_id) REFERENCES upstream_sites(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS recharge_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  upstream_site_id INTEGER NOT NULL,
  upstream_order_id TEXT NOT NULL DEFAULT '',
  out_trade_no TEXT NOT NULL DEFAULT '',
  amount REAL,
  pay_amount REAL,
  fee_rate REAL,
  payment_type TEXT NOT NULL DEFAULT '',
  payment_mode TEXT NOT NULL DEFAULT '',
  result_type TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  pay_url TEXT NOT NULL DEFAULT '',
  qr_code TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL DEFAULT '',
  raw_payload TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (upstream_site_id) REFERENCES upstream_sites(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_recharge_orders_site_time ON recharge_orders(upstream_site_id, created_at);
`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all().map((item) => item.name);
  if (!columns.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

ensureColumn('upstream_sites', 'codex_aliases', `TEXT NOT NULL DEFAULT '["codex"]'`);
ensureColumn('upstream_sites', 'upstream_type', `TEXT NOT NULL DEFAULT 'auto'`);
ensureColumn('upstream_sites', 'low_balance_threshold', 'REAL NOT NULL DEFAULT 10');
ensureColumn('upstream_sites', 'rate_change_threshold_percent', 'REAL NOT NULL DEFAULT 20');
ensureColumn('upstream_current_snapshots', 'week_requests', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('upstream_current_snapshots', 'week_tokens', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('upstream_current_snapshots', 'week_cost', 'REAL NOT NULL DEFAULT 0');
ensureColumn('upstream_current_snapshots', 'month_requests', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('upstream_current_snapshots', 'month_tokens', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('upstream_current_snapshots', 'month_cost', 'REAL NOT NULL DEFAULT 0');
ensureColumn('upstream_current_snapshots', 'channel_count', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('upstream_current_snapshots', 'payment_enabled', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('upstream_current_snapshots', 'balance_recharge_disabled', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('upstream_current_snapshots', 'balance_recharge_multiplier', 'REAL');
ensureColumn('upstream_current_snapshots', 'recharge_fee_rate', 'REAL');
ensureColumn('upstream_current_snapshots', 'payment_plan_count', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('upstream_current_snapshots', 'payment_methods', `TEXT NOT NULL DEFAULT '[]'`);
ensureColumn('upstream_snapshot_history', 'week_requests', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('upstream_snapshot_history', 'week_tokens', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('upstream_snapshot_history', 'week_cost', 'REAL NOT NULL DEFAULT 0');
ensureColumn('upstream_snapshot_history', 'month_requests', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('upstream_snapshot_history', 'month_tokens', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('upstream_snapshot_history', 'month_cost', 'REAL NOT NULL DEFAULT 0');
ensureColumn('upstream_snapshot_history', 'channel_count', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('upstream_snapshot_history', 'payment_enabled', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('upstream_snapshot_history', 'balance_recharge_disabled', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('upstream_snapshot_history', 'balance_recharge_multiplier', 'REAL');
ensureColumn('upstream_snapshot_history', 'recharge_fee_rate', 'REAL');
ensureColumn('upstream_snapshot_history', 'payment_plan_count', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('upstream_snapshot_history', 'payment_methods', `TEXT NOT NULL DEFAULT '[]'`);

module.exports = db;
