require('./testEnv');

const test = require('node:test');
const assert = require('node:assert/strict');
const repo = require('../src/repository');
const db = require('../src/db');

test('secret settings are encrypted at rest and exposed only through explicit reads', () => {
  const saved = repo.setSecretSetting('pushplus_token', 'pushplus-test-secret');
  assert.equal(saved.masked_value, 'pus...ret');
  assert.equal(repo.getSecretSetting('pushplus_token'), 'pushplus-test-secret');
  assert.equal(repo.getMaskedSecretSetting('pushplus_token'), 'pus...ret');
  assert.equal(repo.deleteSetting('pushplus_token'), true);
  assert.equal(repo.getSecretSetting('pushplus_token'), '');
});

test('model catalog replacement preserves selected group models', () => {
  const site = repo.createSite({
    name: 'Model Catalog Test',
    base_url: `https://model-catalog-${process.pid}.example`,
    upstream_type: 'sub2api',
    auth_mode: 'password',
    email: 'test@example.com',
    password: 'secret'
  });
  repo.replaceUpstreamProbeModels(site.id, [{
    group_id: 7,
    group_name: 'OpenAI Stable',
    platform: 'openai',
    source: 'live',
    models: ['gpt-5.4', 'gpt-5.5']
  }], '2026-07-21T00:00:00.000Z');
  repo.setGroupProbeModel(site.id, 7, {
    group_name: 'OpenAI Stable',
    platform: 'openai',
    selected_model: 'gpt-5.5'
  });

  const replaced = repo.replaceUpstreamProbeModels(site.id, [{
    group_id: 7,
    group_name: 'OpenAI Stable',
    platform: 'openai',
    source: 'usage',
    models: [{ model: 'gpt-5.5', source: 'usage' }]
  }], '2026-07-21T01:00:00.000Z');

  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].selected_model, 'gpt-5.5');
  assert.deepEqual(replaced[0].models.map((item) => item.model), ['gpt-5.5']);
  assert.equal(repo.getGroupProbeModel(site.id, 7), 'gpt-5.5');
});

test('complete upstream Keys are encrypted and masked refreshes retain them', () => {
  const site = repo.createSite({
    name: 'Encrypted Key Test',
    base_url: `https://encrypted-key-${process.pid}.example`,
    upstream_type: 'sub2api',
    auth_mode: 'password',
    email: 'test@example.com',
    password: 'secret'
  });
  const complete = 'sk-complete-secret-value-123456';
  const first = repo.reconcileImportedKeys(site.id, [{
    id: 91,
    name: 'Secure Key',
    key_masked: 'sk-comp...3456',
    key_full: complete
  }]);
  assert.equal(first.secrets.full_key_count, 1);
  assert.equal(repo.getKeySecret(site.id, 91), complete);

  const retained = repo.reconcileImportedKeys(site.id, [{
    id: 91,
    name: 'Secure Key',
    key_masked: 'sk-comp...3456',
    key_full: null
  }]);
  assert.equal(retained.secrets.retained, 1);
  assert.equal(repo.attachKeySecrets(site.id, [{ id: 91 }])[0].key_full, complete);

  const removed = repo.reconcileImportedKeys(site.id, []);
  assert.equal(removed.secrets.removed, 1);
  assert.equal(repo.getKeySecret(site.id, 91), '');
});

test('failed model discovery retains the previous cached candidates', () => {
  const site = repo.createSite({
    name: 'Stale Model Cache Test',
    base_url: `https://stale-model-${process.pid}.example`,
    upstream_type: 'sub2api',
    auth_mode: 'password'
  });
  repo.replaceUpstreamProbeModels(site.id, [{
    group_id: 4,
    group_name: 'Stable',
    platform: 'openai',
    discovery_status: 'live',
    models: [{ model: 'gpt-existing', source: 'live' }]
  }], '2026-07-21T00:00:00.000Z');

  const result = repo.replaceUpstreamProbeModels(site.id, [{
    group_id: 4,
    group_name: 'Stable',
    platform: 'openai',
    discovery_status: 'unavailable',
    discovery_error: 'temporary failure',
    models: []
  }], '2026-07-21T01:00:00.000Z');

  assert.equal(result[0].discovery_status, 'stale');
  assert.equal(result[0].discovery_error, 'temporary failure');
  assert.deepEqual(result[0].models.map((item) => item.model), ['gpt-existing']);
});

test('per-Key probe models persist and can return to the group default', () => {
  const site = repo.createSite({
    name: 'Key Probe Model Test',
    base_url: `https://key-probe-${process.pid}.example`,
    upstream_type: 'sub2api',
    auth_mode: 'password'
  });
  repo.reconcileImportedKeys(site.id, [{
    id: 73,
    name: 'Probe Key',
    key_masked: 'sk-prob...0073'
  }]);

  const saved = repo.setKeyProbeModel(site.id, 73, 'gpt-key-specific');
  assert.equal(saved.selected_model, 'gpt-key-specific');
  assert.equal(repo.getKeyProbeModel(site.id, 73), 'gpt-key-specific');
  assert.equal(repo.listKeySnapshotsWithHealth(site.id)[0].selected_probe_model, 'gpt-key-specific');

  const cleared = repo.setKeyProbeModel(site.id, 73, '');
  assert.equal(cleared.selected_model, '');
  assert.equal(repo.getKeyProbeModel(site.id, 73), '');
});

test('connectivity persistence and legacy history reads redact network and credential details', () => {
  const site = repo.createSite({
    name: 'Connectivity Redaction Test',
    base_url: `https://connectivity-redaction-${process.pid}.example`,
    upstream_type: 'sub2api',
    auth_mode: 'password'
  });
  repo.reconcileImportedKeys(site.id, [{
    id: 81,
    name: 'Redacted Key',
    key_masked: 'sk-reda...0081'
  }]);

  const unsafe = 'Access denied for 185.220.239.32 Bearer abc-secret sk-complete-secret-123456';
  const recorded = repo.recordKeyConnectivityCheck(site.id, 81, {
    status: 'upstream_error',
    error_code: 'ip_blocked',
    error_message: unsafe
  });
  assert.equal(recorded.current.error_message.includes('185.220.239.32'), false);
  assert.equal(recorded.current.error_message.includes('abc-secret'), false);
  assert.equal(recorded.current.error_message.includes('sk-complete-secret'), false);

  db.prepare(`
    UPDATE upstream_key_connectivity_checks SET error_message = ?
    WHERE upstream_site_id = ? AND upstream_key_id = ?
  `).run(unsafe, site.id, '81');
  db.prepare(`
    UPDATE upstream_key_connectivity_state SET error_message = ?
    WHERE upstream_site_id = ? AND upstream_key_id = ?
  `).run(unsafe, site.id, '81');

  assert.equal(repo.listKeyConnectivityChecks(site.id)[0].error_message.includes('185.220.239.32'), false);
  assert.equal(repo.listKeySnapshotsWithHealth(site.id)[0].connectivity_error_message.includes('sk-complete-secret'), false);
});

test('per-upstream scheduler and notification policies persist independently', () => {
  const site = repo.createSite({
    name: 'Runtime Policy Test',
    base_url: `https://runtime-policy-${process.pid}.example`,
    upstream_type: 'sub2api',
    auth_mode: 'password',
    sync_enabled: false,
    key_check_enabled: false,
    alert_notifications_enabled: false,
    low_balance_alert_enabled: false,
    sync_interval_seconds: 900,
    key_check_interval_seconds: 1200
  });
  assert.equal(site.sync_enabled, 0);
  assert.equal(site.key_check_enabled, 0);
  assert.equal(site.alert_notifications_enabled, 0);
  assert.equal(site.low_balance_alert_enabled, 0);

  const updated = repo.updateSite(site.id, {
    sync_enabled: true,
    key_check_enabled: true,
    alert_notifications_enabled: true
  });
  assert.equal(updated.sync_enabled, 1);
  assert.equal(updated.key_check_enabled, 1);
  assert.equal(updated.alert_notifications_enabled, 1);
  assert.equal(updated.low_balance_alert_enabled, 0);
});

test('alert acknowledgement remains open until recovery and resets for a later incident', () => {
  const fingerprint = `ack-lifecycle:${process.pid}`;
  const opened = repo.openOrTouchAlert({
    fingerprint,
    event_type: 'key_connectivity',
    severity: 'warning',
    title: 'Needs attention'
  });
  const acknowledged = repo.acknowledgeAlert(opened.id, '2026-07-21T10:00:00.000Z');
  assert.equal(acknowledged.status, 'open');
  assert.equal(acknowledged.acknowledged_at, '2026-07-21T10:00:00.000Z');

  const touched = repo.openOrTouchAlert({ fingerprint, event_type: 'key_connectivity', title: 'Still failing' });
  assert.equal(touched.id, opened.id);
  assert.equal(touched.acknowledged_at, '2026-07-21T10:00:00.000Z');

  repo.resolveAlert(fingerprint, '2026-07-21T11:00:00.000Z');
  const reopened = repo.openOrTouchAlert({ fingerprint, event_type: 'key_connectivity', title: 'Failed again' });
  assert.notEqual(reopened.id, opened.id);
  assert.equal(reopened.acknowledged_at, null);
});

test('bulk alert acknowledgement supports selected rows and all open rows', () => {
  const first = repo.openOrTouchAlert({ fingerprint: `bulk-a:${process.pid}`, event_type: 'sync_failed' });
  const second = repo.openOrTouchAlert({ fingerprint: `bulk-b:${process.pid}`, event_type: 'sync_failed' });
  const selected = repo.acknowledgeAlerts([first.id]);
  assert.equal(selected.acknowledged, 1);
  assert.equal(repo.findLatestAlert(first.fingerprint).acknowledged_at != null, true);
  assert.equal(repo.findLatestAlert(second.fingerprint).acknowledged_at, null);
  const remaining = repo.acknowledgeAlerts([]);
  assert.ok(remaining.acknowledged >= 1);
  assert.equal(repo.findLatestAlert(second.fingerprint).acknowledged_at != null, true);
});
