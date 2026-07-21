const { z } = require('zod');
const config = require('./config');
const repo = require('./repository');

const RUNTIME_SETTINGS_KEY = 'runtime_settings_v1';
const timePattern = /^([01]\d|2[0-3]):[0-5]\d$/;

const runtimeSettingsSchema = z.object({
  notifications_enabled: z.boolean(),
  notify_key_connectivity: z.boolean(),
  notify_low_balance: z.boolean(),
  notify_sync_failure: z.boolean(),
  notify_recovery: z.boolean(),
  notify_ip_blocked: z.boolean(),
  notification_grouping: z.enum(['upstream', 'key']),
  alert_failure_threshold: z.number().int().min(1).max(100),
  alert_recovery_threshold: z.number().int().min(1).max(100),
  alert_repeat_interval_seconds: z.number().int().min(0).max(604800),
  quiet_hours_enabled: z.boolean(),
  quiet_hours_start: z.string().regex(timePattern),
  quiet_hours_end: z.string().regex(timePattern),
  quiet_hours_critical_bypass: z.boolean(),
  pushplus_timeout_ms: z.number().int().min(1000).max(120000),
  sync_enabled: z.boolean(),
  sync_scheduler_scan_seconds: z.number().int().min(10).max(3600),
  sync_default_interval_seconds: z.number().int().min(30).max(86400),
  upstream_default_low_balance_threshold: z.number().min(0).max(100000000),
  upstream_default_rate_change_threshold_percent: z.number().min(0).max(100000),
  key_check_enabled: z.boolean(),
  key_scheduler_scan_seconds: z.number().int().min(10).max(3600),
  key_check_default_interval_seconds: z.number().int().min(60).max(86400),
  key_check_concurrency: z.number().int().min(1).max(20),
  key_check_timeout_ms: z.number().int().min(1000).max(120000),
  max_key_check_logs: z.number().int().min(100).max(1000000),
  max_sync_logs: z.number().int().min(100).max(1000000),
  max_rate_snapshots: z.number().int().min(100).max(1000000)
}).strict();

const runtimeSettingsPatchSchema = runtimeSettingsSchema.partial().strict();

function boundedNumber(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

function defaultRuntimeSettings(environment = config) {
  return {
    notifications_enabled: true,
    notify_key_connectivity: true,
    notify_low_balance: true,
    notify_sync_failure: true,
    notify_recovery: true,
    notify_ip_blocked: true,
    notification_grouping: 'upstream',
    alert_failure_threshold: boundedNumber(environment.alertFailureThreshold, 3, 1, 100),
    alert_recovery_threshold: boundedNumber(environment.alertRecoveryThreshold, 2, 1, 100),
    alert_repeat_interval_seconds: 0,
    quiet_hours_enabled: false,
    quiet_hours_start: '23:00',
    quiet_hours_end: '08:00',
    quiet_hours_critical_bypass: true,
    pushplus_timeout_ms: boundedNumber(environment.pushPlusTimeoutMs, 10000, 1000, 120000),
    sync_enabled: true,
    sync_scheduler_scan_seconds: boundedNumber(environment.syncSchedulerTickSeconds, 30, 10, 3600),
    sync_default_interval_seconds: 180,
    upstream_default_low_balance_threshold: 10,
    upstream_default_rate_change_threshold_percent: 20,
    key_check_enabled: true,
    key_scheduler_scan_seconds: boundedNumber(environment.keyCheckSchedulerTickSeconds, 30, 10, 3600),
    key_check_default_interval_seconds: 300,
    key_check_concurrency: boundedNumber(environment.keyCheckConcurrency, 3, 1, 20),
    key_check_timeout_ms: boundedNumber(environment.keyCheckTimeoutMs, 15000, 1000, 120000),
    max_key_check_logs: boundedNumber(environment.maxKeyCheckLogs, 10000, 100, 1000000),
    max_sync_logs: boundedNumber(environment.maxSyncLogs, 500, 100, 1000000),
    max_rate_snapshots: boundedNumber(environment.maxRateSnapshots, 2000, 100, 1000000)
  };
}

function loadRuntimeSettings({ repository = repo, environment = config } = {}) {
  const defaults = defaultRuntimeSettings(environment);
  const raw = repository.getSecretSetting(RUNTIME_SETTINGS_KEY);
  if (!raw) return { settings: defaults, source: 'defaults', warning: '' };
  try {
    const stored = runtimeSettingsPatchSchema.parse(JSON.parse(raw));
    return {
      settings: runtimeSettingsSchema.parse({ ...defaults, ...stored }),
      source: 'database',
      warning: ''
    };
  } catch {
    return {
      settings: defaults,
      source: 'defaults',
      warning: '已忽略无效的运行设置并回退到环境默认值'
    };
  }
}

function effectiveRuntimeSettings(settings, environment = config) {
  const syncEnvironmentEnabled = environment.syncSchedulerEnabled !== false;
  const keyEnvironmentEnabled = environment.keyCheckSchedulerEnabled !== false;
  return {
    ...settings,
    sync_enabled: syncEnvironmentEnabled && settings.sync_enabled,
    key_check_enabled: keyEnvironmentEnabled && settings.key_check_enabled
  };
}

function runtimeSettingsStatus(options = {}) {
  const environment = options.environment || config;
  const loaded = loadRuntimeSettings({ ...options, environment });
  return {
    source: loaded.source,
    warning: loaded.warning,
    settings: loaded.settings,
    effective: effectiveRuntimeSettings(loaded.settings, environment),
    locks: {
      sync_scheduler: environment.syncSchedulerEnabled === false,
      key_check_scheduler: environment.keyCheckSchedulerEnabled === false
    }
  };
}

function updateRuntimeSettings(input, { repository = repo, environment = config } = {}) {
  const patch = runtimeSettingsPatchSchema.parse(input || {});
  const current = loadRuntimeSettings({ repository, environment }).settings;
  const settings = runtimeSettingsSchema.parse({ ...current, ...patch });
  repository.setSecretSetting(RUNTIME_SETTINGS_KEY, JSON.stringify(settings));
  return runtimeSettingsStatus({ repository, environment });
}

module.exports = {
  RUNTIME_SETTINGS_KEY,
  runtimeSettingsSchema,
  runtimeSettingsPatchSchema,
  defaultRuntimeSettings,
  loadRuntimeSettings,
  effectiveRuntimeSettings,
  runtimeSettingsStatus,
  updateRuntimeSettings
};
