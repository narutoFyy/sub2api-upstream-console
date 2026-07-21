const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const Database = require('better-sqlite3');

const databasePath = path.join(os.tmpdir(), `sub2api-console-legacy-${process.pid}.sqlite`);
process.env.DATABASE_PATH = databasePath;
process.env.APP_SECRET = 'test-only-secret';
process.env.SYNC_SCHEDULER_ENABLED = 'false';
process.env.KEY_CHECK_SCHEDULER_ENABLED = 'false';

fs.rmSync(databasePath, { force: true });
const legacy = new Database(databasePath);
legacy.exec(`
  CREATE TABLE upstream_sites (
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
  CREATE TABLE upstream_api_key_snapshots (
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
    captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE alert_events (
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
    recovery_notified_at TEXT
  );
  INSERT INTO upstream_sites (name, base_url) VALUES ('Legacy API', 'https://legacy.example');
  INSERT INTO upstream_api_key_snapshots (upstream_site_id, upstream_key_id, name, key_masked)
    VALUES (1, '7', 'Legacy Key', 'sk-...old');
  INSERT INTO alert_events (fingerprint, event_type, notified_at)
    VALUES ('legacy-notified', 'key_connectivity', '2026-01-01T00:00:00.000Z');
`);
legacy.close();

test('legacy database migrates in place without losing rows', () => {
  const db = require('../src/db');
  const siteColumns = db.prepare('PRAGMA table_info(upstream_sites)').all().map((item) => item.name);
  const keyColumns = db.prepare('PRAGMA table_info(upstream_api_key_snapshots)').all().map((item) => item.name);
  assert.ok(siteColumns.includes('key_check_interval_seconds'));
  assert.ok(siteColumns.includes('sync_enabled'));
  assert.ok(siteColumns.includes('key_check_enabled'));
  assert.ok(siteColumns.includes('alert_notifications_enabled'));
  assert.ok(siteColumns.includes('low_balance_alert_enabled'));
  assert.ok(siteColumns.includes('openai_probe_model'));
  assert.ok(keyColumns.includes('import_state'));
  assert.equal(db.prepare('SELECT name FROM upstream_sites WHERE id=1').get().name, 'Legacy API');
  assert.equal(db.prepare('SELECT name FROM upstream_api_key_snapshots WHERE upstream_key_id=?').get('7').name, 'Legacy Key');
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='alert_events'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='console_settings'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='upstream_group_probe_settings'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='upstream_probe_model_catalog'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='upstream_api_key_secrets'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='upstream_key_probe_settings'").get());
  assert.ok(db.prepare('PRAGMA table_info(upstream_key_connectivity_checks)').all().some((item) => item.name === 'endpoint'));
  assert.ok(db.prepare('PRAGMA table_info(upstream_key_connectivity_state)').all().some((item) => item.name === 'endpoint'));
  const alertColumns = db.prepare('PRAGMA table_info(alert_events)').all().map((item) => item.name);
  assert.ok(alertColumns.includes('last_notified_at'));
  assert.ok(alertColumns.includes('notification_count'));
  assert.ok(alertColumns.includes('acknowledged_at'));
  assert.equal(db.prepare('SELECT notification_count FROM alert_events WHERE fingerprint=?').get('legacy-notified').notification_count, 1);
  db.close();
});

test.after(() => {
  fs.rmSync(databasePath, { force: true });
  fs.rmSync(`${databasePath}-wal`, { force: true });
  fs.rmSync(`${databasePath}-shm`, { force: true });
});
