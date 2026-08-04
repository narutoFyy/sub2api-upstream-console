require('./testEnv');

const test = require('node:test');
const assert = require('node:assert/strict');
const repo = require('../src/repository');
const db = require('../src/db');

test('deleting an upstream removes local dependent data through cascade', () => {
  const site = repo.createSite({
    name: 'Delete Cascade Test',
    base_url: `https://delete-cascade-${process.pid}.example`,
    auth_mode: 'password',
    email: 'delete@example.com',
    password: 'delete-secret'
  });
  const capturedAt = new Date().toISOString();
  db.prepare(`INSERT INTO upstream_current_snapshots (upstream_site_id, balance, captured_at) VALUES (?, ?, ?)`)
    .run(site.id, 12.5, capturedAt);
  db.prepare(`INSERT INTO upstream_api_key_snapshots (upstream_site_id, upstream_key_id, captured_at) VALUES (?, ?, ?)`)
    .run(site.id, 'key-1', capturedAt);
  db.prepare(`INSERT INTO sync_logs (upstream_site_id, sync_type, status, started_at, finished_at, duration_ms) VALUES (?, 'manual', 'success', ?, ?, 1)`)
    .run(site.id, capturedAt, capturedAt);

  assert.equal(repo.deleteSite(site.id), true);
  assert.equal(repo.getSite(site.id), null);
  assert.equal(repo.getCredentials(site.id), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM upstream_current_snapshots WHERE upstream_site_id = ?').get(site.id).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM upstream_api_key_snapshots WHERE upstream_site_id = ?').get(site.id).count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sync_logs WHERE upstream_site_id = ?').get(site.id).count, 0);
  assert.equal(repo.deleteSite(site.id), false);
});
