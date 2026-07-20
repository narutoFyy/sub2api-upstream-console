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
  key_check_interval_seconds INTEGER NOT NULL DEFAULT 300,
  openai_probe_model TEXT NOT NULL DEFAULT '',
  anthropic_probe_model TEXT NOT NULL DEFAULT '',
  last_sync_at TEXT,
  last_sync_error TEXT NOT NULL DEFAULT '',
  sync_failure_count INTEGER NOT NULL DEFAULT 0,
  sync_success_count INTEGER NOT NULL DEFAULT 0,
  last_key_import_at TEXT,
  last_key_check_at TEXT,
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
  subscription_summary TEXT NOT NULL DEFAULT '{}',
  pricing_summary TEXT NOT NULL DEFAULT '{}',
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

CREATE TABLE IF NOT EXISTS model_pricing_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  upstream_site_id INTEGER NOT NULL,
  model_name TEXT NOT NULL DEFAULT '',
  vendor TEXT NOT NULL DEFAULT '',
  vendor_id INTEGER,
  tags TEXT NOT NULL DEFAULT '',
  quota_type INTEGER NOT NULL DEFAULT 0,
  model_ratio REAL,
  model_price REAL,
  completion_ratio REAL,
  cache_ratio REAL,
  create_cache_ratio REAL,
  image_ratio REAL,
  audio_ratio REAL,
  audio_completion_ratio REAL,
  billing_mode TEXT NOT NULL DEFAULT '',
  billing_expr TEXT NOT NULL DEFAULT '',
  enable_groups TEXT NOT NULL DEFAULT '[]',
  supported_endpoint_types TEXT NOT NULL DEFAULT '[]',
  effective_group TEXT NOT NULL DEFAULT '',
  effective_group_ratio REAL,
  official_input_usd_per_1m REAL,
  official_output_usd_per_1m REAL,
  official_cache_read_usd_per_1m REAL,
  official_cache_write_usd_per_1m REAL,
  official_request_usd REAL,
  upstream_input_usd_per_1m REAL,
  upstream_output_usd_per_1m REAL,
  upstream_cache_read_usd_per_1m REAL,
  upstream_cache_write_usd_per_1m REAL,
  upstream_request_usd REAL,
  pricing_version TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'pricing',
  raw_payload TEXT NOT NULL DEFAULT '{}',
  captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (upstream_site_id) REFERENCES upstream_sites(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_model_pricing_snapshots_site_time ON model_pricing_snapshots(upstream_site_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_model_pricing_snapshots_model ON model_pricing_snapshots(model_name);

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

CREATE TABLE IF NOT EXISTS upstream_api_key_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  upstream_site_id INTEGER NOT NULL,
  upstream_key_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  key_masked TEXT NOT NULL DEFAULT '',
  group_id TEXT NOT NULL DEFAULT '',
  group_name TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  group_rate REAL,
  status TEXT NOT NULL DEFAULT '',
  quota REAL,
  quota_used REAL,
  expires_at TEXT,
  last_used_at TEXT,
  captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (upstream_site_id) REFERENCES upstream_sites(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_upstream_api_key_snapshots_site ON upstream_api_key_snapshots(upstream_site_id, captured_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_upstream_api_key_snapshots_unique ON upstream_api_key_snapshots(upstream_site_id, upstream_key_id);

CREATE TABLE IF NOT EXISTS upstream_key_create_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  upstream_site_id INTEGER NOT NULL,
  upstream_key_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  group_id TEXT NOT NULL DEFAULT '',
  group_name TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  encrypted_key TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (upstream_site_id) REFERENCES upstream_sites(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_upstream_key_create_logs_site ON upstream_key_create_logs(upstream_site_id, created_at);

CREATE TABLE IF NOT EXISTS upstream_key_import_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  upstream_site_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  pages INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  missing INTEGER NOT NULL DEFAULT 0,
  group_changes INTEGER NOT NULL DEFAULT 0,
  full_key_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  FOREIGN KEY (upstream_site_id) REFERENCES upstream_sites(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_upstream_key_import_runs_site ON upstream_key_import_runs(upstream_site_id, started_at);

CREATE TABLE IF NOT EXISTS upstream_key_connectivity_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  upstream_site_id INTEGER NOT NULL,
  upstream_key_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  probe_level TEXT NOT NULL DEFAULT 'inference',
  platform TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  latency_ms INTEGER,
  http_status INTEGER,
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (upstream_site_id) REFERENCES upstream_sites(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_key_checks_site_key_time
  ON upstream_key_connectivity_checks(upstream_site_id, upstream_key_id, checked_at);

CREATE TABLE IF NOT EXISTS upstream_key_connectivity_state (
  upstream_site_id INTEGER NOT NULL,
  upstream_key_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'untested',
  probe_level TEXT NOT NULL DEFAULT 'inference',
  platform TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  latency_ms INTEGER,
  http_status INTEGER,
  error_code TEXT NOT NULL DEFAULT '',
  error_message TEXT NOT NULL DEFAULT '',
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  consecutive_successes INTEGER NOT NULL DEFAULT 0,
  last_checked_at TEXT,
  last_success_at TEXT,
  last_failure_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (upstream_site_id, upstream_key_id),
  FOREIGN KEY (upstream_site_id) REFERENCES upstream_sites(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS alert_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint TEXT NOT NULL,
  event_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning',
  status TEXT NOT NULL DEFAULT 'open',
  upstream_site_id INTEGER,
  upstream_key_id TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  opened_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notified_at TEXT,
  resolved_at TEXT,
  recovery_notified_at TEXT,
  FOREIGN KEY (upstream_site_id) REFERENCES upstream_sites(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_alert_events_status_time ON alert_events(status, opened_at);
CREATE INDEX IF NOT EXISTS idx_alert_events_fingerprint ON alert_events(fingerprint, status);

CREATE TABLE IF NOT EXISTS own_sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  own_site_type TEXT NOT NULL DEFAULT 'auto',
  auth_mode TEXT NOT NULL DEFAULT 'token',
  status TEXT NOT NULL DEFAULT 'active',
  notes TEXT NOT NULL DEFAULT '',
  last_sync_at TEXT,
  last_sync_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_own_sites_base_url ON own_sites(base_url);

CREATE TABLE IF NOT EXISTS own_site_credentials (
  own_site_id INTEGER PRIMARY KEY,
  encrypted_email TEXT NOT NULL DEFAULT '',
  encrypted_password TEXT NOT NULL DEFAULT '',
  encrypted_token TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (own_site_id) REFERENCES own_sites(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS own_site_route_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  own_site_id INTEGER NOT NULL,
  route_id TEXT NOT NULL DEFAULT '',
  route_name TEXT NOT NULL DEFAULT '',
  model_pattern TEXT NOT NULL DEFAULT '',
  upstream_api_url TEXT NOT NULL DEFAULT '',
  matched_upstream_site_id INTEGER,
  upstream_key_masked TEXT NOT NULL DEFAULT '',
  upstream_key_id TEXT NOT NULL DEFAULT '',
  upstream_buy_rate REAL,
  matched_upstream_key_id TEXT NOT NULL DEFAULT '',
  matched_group_id TEXT NOT NULL DEFAULT '',
  matched_group_name TEXT NOT NULL DEFAULT '',
  matched_platform TEXT NOT NULL DEFAULT '',
  matched_group_rate REAL,
  route_status TEXT NOT NULL DEFAULT '',
  match_status TEXT NOT NULL DEFAULT '',
  match_reason TEXT NOT NULL DEFAULT '',
  raw_payload TEXT NOT NULL DEFAULT '{}',
  captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (own_site_id) REFERENCES own_sites(id) ON DELETE CASCADE,
  FOREIGN KEY (matched_upstream_site_id) REFERENCES upstream_sites(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_own_site_route_snapshots_site ON own_site_route_snapshots(own_site_id, captured_at);

CREATE TABLE IF NOT EXISTS own_site_route_manual_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  own_site_id INTEGER NOT NULL,
  route_id TEXT NOT NULL DEFAULT '',
  upstream_site_id INTEGER,
  upstream_key_id TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (own_site_id, route_id),
  FOREIGN KEY (own_site_id) REFERENCES own_sites(id) ON DELETE CASCADE,
  FOREIGN KEY (upstream_site_id) REFERENCES upstream_sites(id) ON DELETE SET NULL
);
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
ensureColumn('upstream_sites', 'key_check_interval_seconds', 'INTEGER NOT NULL DEFAULT 300');
ensureColumn('upstream_sites', 'openai_probe_model', `TEXT NOT NULL DEFAULT ''`);
ensureColumn('upstream_sites', 'anthropic_probe_model', `TEXT NOT NULL DEFAULT ''`);
ensureColumn('upstream_sites', 'last_key_import_at', 'TEXT');
ensureColumn('upstream_sites', 'last_key_check_at', 'TEXT');
ensureColumn('upstream_sites', 'sync_failure_count', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('upstream_sites', 'sync_success_count', 'INTEGER NOT NULL DEFAULT 0');
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
ensureColumn('upstream_current_snapshots', 'subscription_summary', `TEXT NOT NULL DEFAULT '{}'`);
ensureColumn('upstream_current_snapshots', 'pricing_summary', `TEXT NOT NULL DEFAULT '{}'`);
ensureColumn('upstream_current_snapshots', 'openai_rate', 'REAL');
ensureColumn('upstream_current_snapshots', 'anthropic_rate', 'REAL');
ensureColumn('upstream_snapshot_history', 'week_requests', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('upstream_snapshot_history', 'week_tokens', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('upstream_snapshot_history', 'week_cost', 'REAL NOT NULL DEFAULT 0');
ensureColumn('upstream_snapshot_history', 'month_requests', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('upstream_snapshot_history', 'month_tokens', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('upstream_snapshot_history', 'month_cost', 'REAL NOT NULL DEFAULT 0');
ensureColumn('upstream_snapshot_history', 'channel_count', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('upstream_snapshot_history', 'openai_rate', 'REAL');
ensureColumn('upstream_snapshot_history', 'anthropic_rate', 'REAL');
ensureColumn('upstream_snapshot_history', 'payment_enabled', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('upstream_snapshot_history', 'balance_recharge_disabled', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('upstream_snapshot_history', 'balance_recharge_multiplier', 'REAL');
ensureColumn('upstream_snapshot_history', 'recharge_fee_rate', 'REAL');
ensureColumn('upstream_snapshot_history', 'payment_plan_count', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('upstream_snapshot_history', 'payment_methods', `TEXT NOT NULL DEFAULT '[]'`);
ensureColumn('model_pricing_snapshots', 'effective_group', `TEXT NOT NULL DEFAULT ''`);
ensureColumn('model_pricing_snapshots', 'effective_group_ratio', 'REAL');
ensureColumn('model_pricing_snapshots', 'official_input_usd_per_1m', 'REAL');
ensureColumn('model_pricing_snapshots', 'official_output_usd_per_1m', 'REAL');
ensureColumn('model_pricing_snapshots', 'official_cache_read_usd_per_1m', 'REAL');
ensureColumn('model_pricing_snapshots', 'official_cache_write_usd_per_1m', 'REAL');
ensureColumn('model_pricing_snapshots', 'official_request_usd', 'REAL');
ensureColumn('model_pricing_snapshots', 'upstream_input_usd_per_1m', 'REAL');
ensureColumn('model_pricing_snapshots', 'upstream_output_usd_per_1m', 'REAL');
ensureColumn('model_pricing_snapshots', 'upstream_cache_read_usd_per_1m', 'REAL');
ensureColumn('model_pricing_snapshots', 'upstream_cache_write_usd_per_1m', 'REAL');
ensureColumn('model_pricing_snapshots', 'upstream_request_usd', 'REAL');
ensureColumn('upstream_api_key_snapshots', 'group_rate', 'REAL');
ensureColumn('upstream_api_key_snapshots', 'first_seen_at', 'TEXT');
ensureColumn('upstream_api_key_snapshots', 'last_seen_at', 'TEXT');
ensureColumn('upstream_api_key_snapshots', 'missing_since', 'TEXT');
ensureColumn('upstream_api_key_snapshots', 'import_state', `TEXT NOT NULL DEFAULT 'present'`);
ensureColumn('own_site_route_snapshots', 'upstream_buy_rate', 'REAL');

module.exports = db;
