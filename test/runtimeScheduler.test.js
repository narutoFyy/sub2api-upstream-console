require('./testEnv');

const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldSyncSite } = require('../src/syncService');
const { shouldCheckSite } = require('../src/keyConnectivityService');
const { createSchedulerState, runRuntimeScheduler } = require('../src/runtimeScheduler');

function settingsStatus(overrides = {}) {
  const settings = {
    sync_scheduler_scan_seconds: 30,
    sync_default_interval_seconds: 180,
    key_scheduler_scan_seconds: 30,
    key_check_default_interval_seconds: 300,
    key_check_concurrency: 4,
    key_check_timeout_ms: 9000,
    max_key_check_logs: 1200,
    ...overrides
  };
  return { settings, effective: { ...settings, sync_enabled: true, key_check_enabled: true } };
}

test('runtime scheduler reads current settings, avoids overlap and waits for scan intervals', async () => {
  const state = createSchedulerState();
  const syncCalls = [];
  const keyCalls = [];
  const dependencies = {
    getStatus: () => settingsStatus(),
    syncDue: async (options) => { syncCalls.push(options); },
    checkDue: async (options) => { keyCalls.push(options); }
  };

  await runRuntimeScheduler(state, { ...dependencies, now: 100000 });
  await runRuntimeScheduler(state, { ...dependencies, now: 110000 });
  assert.equal(syncCalls.length, 1);
  assert.equal(keyCalls.length, 1);
  assert.equal(keyCalls[0].concurrency, 4);
  assert.equal(keyCalls[0].timeoutMs, 9000);

  state.syncRunning = true;
  await runRuntimeScheduler(state, { ...dependencies, now: 130000 });
  assert.equal(syncCalls.length, 1);
  assert.equal(keyCalls.length, 2);
  state.syncRunning = false;
});

test('runtime scheduler environment-effective disables prevent jobs', async () => {
  const calls = [];
  const status = settingsStatus();
  status.effective.sync_enabled = false;
  status.effective.key_check_enabled = false;
  const result = await runRuntimeScheduler(createSchedulerState(), {
    now: 100000,
    getStatus: () => status,
    syncDue: async () => calls.push('sync'),
    checkDue: async () => calls.push('key')
  });
  assert.equal(result.jobs, 0);
  assert.deepEqual(calls, []);
});

test('site due checks honor per-upstream task switches and intervals', () => {
  const now = Date.parse('2026-07-21T12:00:00.000Z');
  const old = '2026-07-21T11:50:00.000Z';
  assert.equal(shouldSyncSite({ sync_enabled: 0, last_sync_at: old }, now), false);
  assert.equal(shouldCheckSite({ key_check_enabled: 0, last_key_check_at: old }, now), false);
  assert.equal(shouldSyncSite({ sync_enabled: 1, last_sync_at: old, sync_interval_seconds: 300 }, now), true);
  assert.equal(shouldCheckSite({ key_check_enabled: 1, last_key_check_at: old, key_check_interval_seconds: 900 }, now), false);
});
