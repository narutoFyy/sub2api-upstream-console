require('./testEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildUpstreamMonitoring, siteFreshness } = require('../src/monitoringService');

test('siteFreshness marks missing and old data as stale', () => {
  assert.equal(siteFreshness({}, Date.now()).stale, true);
  assert.equal(siteFreshness({ last_sync_at: '2026-01-01T00:00:00.000Z', sync_interval_seconds: 180 }, Date.parse('2026-01-01T02:00:00.000Z')).stale, true);
  assert.equal(siteFreshness({ last_sync_at: '2026-01-01T00:30:00.000Z', sync_interval_seconds: 180 }, Date.parse('2026-01-01T01:00:00.000Z')).stale, false);
});

test('monitoring aggregation counts balance, active Keys and failures', () => {
  const repository = {
    listSites: () => [{
      id: 1,
      status: 'active',
      balance: 8,
      low_balance_threshold: 10,
      last_sync_at: '2026-01-01T00:59:00.000Z',
      sync_interval_seconds: 180
    }],
    listKeySnapshotsWithHealth: () => [
      { upstream_key_id: '1', import_state: 'present', connectivity_status: 'connected' },
      { upstream_key_id: '2', import_state: 'present', connectivity_status: 'timeout' },
      { upstream_key_id: '3', import_state: 'missing', connectivity_status: 'auth_failed' }
    ]
  };
  const result = buildUpstreamMonitoring(repository, Date.parse('2026-01-01T01:00:00.000Z'));
  assert.deepEqual(result.totals, {
    upstreams: 1,
    healthy: 0,
    balance: 8,
    keys: 2,
    key_abnormal: 1,
    low_balance: 1,
    abnormal: 1
  });
});
