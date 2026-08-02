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
    ],
    listUpstreamProbeModels: () => [{
      group_id: '9',
      synced_at: '2026-01-01T00:58:00.000Z',
      discovery_status: 'live',
      models: [{ model: 'gpt-monitor' }, { model: 'gpt-monitor' }, { model: 'gpt-fast' }]
    }]
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
  assert.deepEqual(result.items[0].model_sync, {
    status: 'success',
    synced_at: '2026-01-01T00:58:00.000Z',
    group_count: 1,
    model_count: 2,
    unavailable_groups: 0,
    stale_groups: 0,
    error_groups: 0
  });
});

test('monitoring excludes missing balances from totals and low-balance counts', () => {
  const repository = {
    listSites: () => [{
      id: 2,
      status: 'active',
      balance: null,
      low_balance_threshold: 10,
      last_sync_at: '2026-01-01T00:59:00.000Z',
      sync_interval_seconds: 180
    }],
    listKeySnapshotsWithHealth: () => [],
    listUpstreamProbeModels: () => []
  };

  const result = buildUpstreamMonitoring(repository, Date.parse('2026-01-01T01:00:00.000Z'));
  assert.equal(result.totals.balance, 0);
  assert.equal(result.totals.low_balance, 0);
  assert.equal(result.totals.healthy, 1);
  assert.equal(result.items[0].model_sync.status, 'never');
});

test('monitoring reports partial model discovery without dropping cached options', () => {
  const repository = {
    listSites: () => [{ id: 3, status: 'active', balance: 20, last_sync_at: '2026-01-01T00:59:00.000Z' }],
    listKeySnapshotsWithHealth: () => [],
    listUpstreamProbeModels: () => [
      { group_id: 'a', synced_at: '2026-01-01T00:55:00.000Z', discovery_status: 'live', discovery_error: '', models: [{ model: 'gpt-ok' }] },
      { group_id: 'b', synced_at: '2026-01-01T00:56:00.000Z', discovery_status: 'unavailable', discovery_error: '模型接口不可用', models: [] }
    ]
  };

  const result = buildUpstreamMonitoring(repository, Date.parse('2026-01-01T01:00:00.000Z'));
  assert.equal(result.items[0].model_sync.status, 'partial');
  assert.equal(result.items[0].model_sync.synced_at, '2026-01-01T00:56:00.000Z');
  assert.equal(result.items[0].model_sync.model_count, 1);
  assert.equal(result.items[0].model_sync.error_groups, 1);
});
