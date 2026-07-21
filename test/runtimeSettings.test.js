require('./testEnv');

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const repo = require('../src/repository');
const {
  RUNTIME_SETTINGS_KEY,
  defaultRuntimeSettings,
  runtimeSettingsStatus,
  updateRuntimeSettings
} = require('../src/runtimeSettings');

test('runtime settings default to current environment behavior and respect hard scheduler locks', () => {
  const repository = {
    getSecretSetting: () => '',
    setSecretSetting: () => {}
  };
  const environment = {
    ...config,
    syncSchedulerEnabled: false,
    keyCheckSchedulerEnabled: false,
    alertFailureThreshold: 4,
    alertRecoveryThreshold: 3
  };
  const status = runtimeSettingsStatus({ repository, environment });
  assert.equal(status.settings.alert_failure_threshold, 4);
  assert.equal(status.settings.alert_recovery_threshold, 3);
  assert.equal(status.settings.sync_enabled, true);
  assert.equal(status.effective.sync_enabled, false);
  assert.equal(status.effective.key_check_enabled, false);
  assert.deepEqual(status.locks, { sync_scheduler: true, key_check_scheduler: true });
});

test('runtime settings merge validated partial updates and reject unsafe fields', () => {
  let stored = '';
  const repository = {
    getSecretSetting: () => stored,
    setSecretSetting: (key, value) => {
      assert.equal(key, RUNTIME_SETTINGS_KEY);
      stored = value;
    }
  };
  const saved = updateRuntimeSettings({
    key_check_concurrency: 6,
    notification_grouping: 'key',
    quiet_hours_start: '22:30'
  }, { repository, environment: config });
  assert.equal(saved.settings.key_check_concurrency, 6);
  assert.equal(saved.settings.notification_grouping, 'key');
  assert.equal(saved.settings.quiet_hours_start, '22:30');
  assert.equal(saved.settings.sync_default_interval_seconds, defaultRuntimeSettings().sync_default_interval_seconds);
  assert.throws(() => updateRuntimeSettings({ APP_SECRET: 'nope' }, { repository }), /Unrecognized key/);
  assert.throws(() => updateRuntimeSettings({ key_check_concurrency: 0 }, { repository }), />=1/);
  assert.throws(() => updateRuntimeSettings({ quiet_hours_start: '25:00' }, { repository }), /Invalid string/);
});

test('runtime settings are encrypted through the repository setting store', () => {
  repo.deleteSetting(RUNTIME_SETTINGS_KEY);
  const saved = updateRuntimeSettings({ alert_failure_threshold: 7 });
  assert.equal(saved.settings.alert_failure_threshold, 7);
  assert.equal(runtimeSettingsStatus().settings.alert_failure_threshold, 7);
  const encrypted = require('../src/db').prepare(
    'SELECT encrypted_value FROM console_settings WHERE key = ?'
  ).get(RUNTIME_SETTINGS_KEY).encrypted_value;
  assert.equal(encrypted.includes('alert_failure_threshold'), false);
  repo.deleteSetting(RUNTIME_SETTINGS_KEY);
});
