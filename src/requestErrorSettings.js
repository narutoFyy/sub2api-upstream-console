const { z } = require('zod');
const config = require('./config');
const repo = require('./repository');
const { maskSecret } = require('./crypto');

const REQUEST_ERROR_SETTINGS_KEY = 'request_error_monitor_v1';
const HERMES_SECRET_KEY = 'hermes_webhook_secret';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

const errorCode = z.string().trim().min(1).max(120).transform((value) => value.toLowerCase());
const codeList = z.array(errorCode).max(200).transform((items) => [...new Set(items)]);

function isAllowedHermesUrl(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

const hermesUrl = z.string().trim().max(500).refine(isAllowedHermesUrl, {
  message: 'Hermes Webhook 只能是服务器回环地址（http://127.0.0.1:端口/...）或 https 地址，且不能包含账号密码'
});

const requestErrorSettingsSchema = z.object({
  enabled: z.boolean(),
  poll_interval_seconds: z.number().int().min(15).max(86400),
  lookback_minutes: z.number().int().min(1).max(43200),
  request_timeout_ms: z.number().int().min(1000).max(120000),
  max_details_per_poll: z.number().int().min(1).max(200),
  max_retries: z.number().int().min(0).max(50),
  retry_backoff_seconds: z.number().int().min(5).max(86400),
  hermes_codes: codeList,
  manual_codes: codeList,
  hermes_enabled: z.boolean(),
  hermes_webhook_url: hermesUrl,
  hermes_prompt: z.string().max(20000),
  hermes_report_target: z.string().trim().max(200),
  hermes_receipt_enabled: z.boolean(),
  hermes_receipt_timeout_minutes: z.number().int().min(5).max(10080)
}).strict();

const requestErrorSettingsPatchSchema = requestErrorSettingsSchema.partial().extend({
  hermes_secret: z.string().max(500).optional()
}).strict();

function defaultRequestErrorSettings() {
  return {
    enabled: false,
    poll_interval_seconds: 60,
    lookback_minutes: 30,
    request_timeout_ms: 15000,
    max_details_per_poll: 20,
    max_retries: 5,
    retry_backoff_seconds: 60,
    hermes_codes: [],
    manual_codes: [],
    hermes_enabled: false,
    hermes_webhook_url: 'http://127.0.0.1:18644/webhooks/sub2api-errors',
    hermes_prompt: '',
    hermes_report_target: '',
    hermes_receipt_enabled: true,
    hermes_receipt_timeout_minutes: 1440
  };
}

function environmentOverrides(environment = config) {
  return {
    disabled: environment.requestErrorMonitorEnabled === false,
    url: environment.hermesWebhookUrl || '',
    secret: environment.hermesWebhookSecret || ''
  };
}

function loadRequestErrorSettings({ repository = repo } = {}) {
  const defaults = defaultRequestErrorSettings();
  const raw = repository.getSecretSetting(REQUEST_ERROR_SETTINGS_KEY);
  if (!raw) return { settings: defaults, source: 'defaults', warning: '' };
  try {
    const stored = requestErrorSettingsSchema.partial().parse(JSON.parse(raw));
    return { settings: requestErrorSettingsSchema.parse({ ...defaults, ...stored }), source: 'database', warning: '' };
  } catch {
    return { settings: defaults, source: 'defaults', warning: '已忽略无效的错误监控设置并回退到默认值' };
  }
}

// Returns the settings the monitor actually runs with, including the HMAC secret.
// Never send this object to the browser; use requestErrorSettingsStatus instead.
function effectiveRequestErrorSettings({ repository = repo, environment = config } = {}) {
  const { settings } = loadRequestErrorSettings({ repository });
  const overrides = environmentOverrides(environment);
  return {
    ...settings,
    enabled: !overrides.disabled && settings.enabled,
    hermes_webhook_url: overrides.url || settings.hermes_webhook_url,
    hermes_secret: overrides.secret || repository.getSecretSetting(HERMES_SECRET_KEY)
  };
}

function requestErrorSettingsStatus({ repository = repo, environment = config } = {}) {
  const loaded = loadRequestErrorSettings({ repository });
  const overrides = environmentOverrides(environment);
  const storedSecret = repository.getSecretSetting(HERMES_SECRET_KEY);
  const effective = effectiveRequestErrorSettings({ repository, environment });
  return {
    source: loaded.source,
    warning: loaded.warning,
    settings: loaded.settings,
    effective: { ...effective, hermes_secret: undefined },
    hermes_secret: {
      configured: Boolean(effective.hermes_secret),
      source: overrides.secret ? 'environment' : (storedSecret ? 'database' : 'none'),
      masked: overrides.secret ? '环境变量已设置' : maskSecret(storedSecret)
    },
    locks: {
      monitor: overrides.disabled,
      hermes_webhook_url: Boolean(overrides.url),
      hermes_secret: Boolean(overrides.secret)
    }
  };
}

function updateRequestErrorSettings(input, { repository = repo, environment = config } = {}) {
  const { hermes_secret: secret, ...patch } = requestErrorSettingsPatchSchema.parse(input || {});
  const current = loadRequestErrorSettings({ repository }).settings;
  const settings = requestErrorSettingsSchema.parse({ ...current, ...patch });
  const overlap = settings.hermes_codes.filter((code) => settings.manual_codes.includes(code));
  const nextSecret = String(secret || '').trim();
  if (nextSecret && nextSecret.length < 16) {
    throw Object.assign(new Error('Hermes HMAC 密钥至少 16 个字符'), { status: 422 });
  }
  repository.setSecretSetting(REQUEST_ERROR_SETTINGS_KEY, JSON.stringify(settings));
  if (nextSecret) repository.setSecretSetting(HERMES_SECRET_KEY, nextSecret);
  return {
    ...requestErrorSettingsStatus({ repository, environment }),
    overlap_codes: overlap
  };
}

function clearHermesSecret({ repository = repo, environment = config } = {}) {
  repository.deleteSetting(HERMES_SECRET_KEY);
  return requestErrorSettingsStatus({ repository, environment });
}

module.exports = {
  REQUEST_ERROR_SETTINGS_KEY,
  HERMES_SECRET_KEY,
  requestErrorSettingsSchema,
  defaultRequestErrorSettings,
  loadRequestErrorSettings,
  effectiveRequestErrorSettings,
  requestErrorSettingsStatus,
  updateRequestErrorSettings,
  clearHermesSecret,
  isAllowedHermesUrl
};
