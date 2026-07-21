const repo = require('./repository');
const { requestJson } = require('./upstreamClient');
const { fetchAllSub2APIKeys } = require('./keyImportService');
const { listSub2APIKeys, isCompleteApiKey } = require('./upstreamKeys');
const { nowIso } = require('./utils');
const { evaluateKeyConnectivity, deliverAlertNotifications } = require('./alertService');

const FAILURE_STATES = new Set(['timeout', 'auth_failed', 'quota_exhausted', 'upstream_error']);

function normalizedPlatform(value) {
  const platform = String(value || '').toLowerCase();
  if (platform.includes('anthropic') || platform.includes('claude')) return 'anthropic';
  if (platform.includes('openai') || platform.includes('gpt') || platform.includes('codex')) return 'openai';
  return platform || 'openai';
}

function probeModelForKey(site, key, repository = repo) {
  const keyId = key?.id ?? key?.upstream_key_id;
  const keyModel = site?.id != null && keyId != null
    ? repository.getKeyProbeModel?.(site.id, keyId)
    : '';
  if (keyModel) return String(keyModel).trim();
  const groupModel = site?.id != null && key?.group_id != null
    ? repository.getGroupProbeModel?.(site.id, key.group_id)
    : '';
  if (groupModel) return String(groupModel).trim();
  return normalizedPlatform(key.platform) === 'anthropic'
    ? String(site.anthropic_probe_model || '').trim()
    : String(site.openai_probe_model || '').trim();
}

function safeProbeError(value) {
  return String(value || 'Connectivity check failed')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[IP]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[KEY]')
    .slice(0, 500);
}

function classifyProbeError(error) {
  const status = Number(error?.status || 0) || null;
  const rawMessage = String(error?.message || 'Connectivity check failed');
  const searchable = `${rawMessage} ${JSON.stringify(error?.body || {})}`.toLowerCase();
  const message = safeProbeError(rawMessage);
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || searchable.includes('timeout')) {
    return { status: 'timeout', error_code: 'timeout', http_status: status, error_message: message };
  }
  if (status === 403 && /(access denied.*ip|ip.*(?:denied|blocked|allowlist)|\b1015\b)/i.test(searchable)) {
    return { status: 'upstream_error', error_code: 'ip_blocked', http_status: status, error_message: message };
  }
  if (status === 401 || status === 403) {
    return { status: 'auth_failed', error_code: `http_${status}`, http_status: status, error_message: message };
  }
  if (status === 402 || /(quota|balance|credit|insufficient|额度|余额)/i.test(searchable)) {
    return { status: 'quota_exhausted', error_code: status ? `http_${status}` : 'quota', http_status: status, error_message: message };
  }
  if (status === 429) {
    return { status: 'upstream_error', error_code: 'rate_limited', http_status: status, error_message: message };
  }
  return {
    status: 'upstream_error',
    error_code: status ? `http_${status}` : 'request_failed',
    http_status: status,
    error_message: message
  };
}

function prefersResponsesProtocol(model) {
  return /^(gpt-5|codex)/i.test(String(model || ''));
}

function probeAttempts(platform, model, key, timeoutMs) {
  if (platform === 'anthropic') {
    return [{
      endpoint: '/v1/messages',
      path: '/messages',
      options: {
        prefix: '/v1',
        method: 'POST',
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01'
        },
        body: {
          model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }]
        },
        timeoutMs
      }
    }];
  }
  const responses = {
    endpoint: '/v1/responses',
    path: '/responses',
    options: {
      prefix: '/v1',
      method: 'POST',
      token: key,
      body: { model, input: 'ping', max_output_tokens: 16, stream: false },
      timeoutMs
    }
  };
  const chat = {
    endpoint: '/v1/chat/completions',
    path: '/chat/completions',
    options: {
      prefix: '/v1',
      method: 'POST',
      token: key,
      body: {
        model,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
        stream: false
      },
      timeoutMs
    }
  };
  return prefersResponsesProtocol(model) ? [responses, chat] : [chat, responses];
}

function shouldTryProtocolFallback(error) {
  const status = Number(error?.status || 0);
  const searchable = `${error?.message || ''} ${JSON.stringify(error?.body || {})}`;
  return status === 404 || status === 405 || (status === 400 && /(endpoint|route|unsupported|not found)/i.test(searchable));
}

async function probeKey(site, key, { request = requestJson, timeoutMs = 15000, repo: repository = repo } = {}) {
  const checkedAt = nowIso();
  const platform = normalizedPlatform(key.platform);
  const model = probeModelForKey(site, key, repository);
  if (String(key.status || '').toLowerCase() === 'inactive' || String(key.status || '').toLowerCase() === 'disabled') {
    return {
      status: 'unavailable',
      probe_level: 'inference',
      platform,
      model,
      error_code: 'key_disabled',
      error_message: 'Key is disabled',
      checked_at: checkedAt
    };
  }
  if (!isCompleteApiKey(key.key_full)) {
    return {
      status: 'unavailable',
      probe_level: 'inference',
      platform,
      model,
      error_code: 'full_key_missing',
      error_message: '上游仅返回掉码 Key，无法发起真实检测',
      checked_at: checkedAt
    };
  }
  if (!model) {
    return {
      status: 'unconfigured',
      probe_level: 'inference',
      platform,
      model: '',
      error_code: 'probe_model_missing',
      error_message: `请为 ${platform === 'anthropic' ? 'Anthropic' : 'OpenAI'} 配置检测模型`,
      checked_at: checkedAt
    };
  }

  const startedAt = Date.now();
  const attempts = probeAttempts(platform, model, key.key_full, timeoutMs);
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    try {
      await request(site.base_url, attempt.path, attempt.options);
      return {
        status: 'connected',
        probe_level: 'inference',
        platform,
        model,
        endpoint: attempt.endpoint,
        latency_ms: Date.now() - startedAt,
        checked_at: checkedAt
      };
    } catch (error) {
      const canFallback = index < attempts.length - 1 && shouldTryProtocolFallback(error);
      if (canFallback) continue;
      return {
        ...classifyProbeError(error),
        probe_level: 'inference',
        platform,
        model,
        endpoint: attempt.endpoint,
        latency_ms: Date.now() - startedAt,
        checked_at: checkedAt
      };
    }
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length || 1) }, worker));
  return results;
}

async function fetchLiveKeys(site, credentials, dependencies = {}) {
  return fetchAllSub2APIKeys(site, credentials, {
    listKeys: dependencies.listKeys || listSub2APIKeys,
    pageSize: dependencies.pageSize || 100
  });
}

async function checkUpstreamKeys(siteId, { keyId = null, concurrency = 3, ...dependencies } = {}) {
  const repository = dependencies.repo || repo;
  const site = repository.getSite(siteId);
  if (!site) {
    const error = new Error('Upstream not found');
    error.status = 404;
    throw error;
  }
  const credentials = repository.getCredentials(siteId) || {};
  const live = await fetchLiveKeys(site, credentials, dependencies);
  const capturedAt = nowIso();
  if (repository.reconcileImportedKeys) {
    repository.reconcileImportedKeys(siteId, live.items, capturedAt, { markMissing: false });
  } else {
    repository.reconcileKeySnapshots(siteId, live.items, capturedAt, { markMissing: false });
    repository.reconcileKeySecrets?.(siteId, live.items, { removeMissing: false, at: capturedAt });
  }
  const liveKeys = repository.attachKeySecrets
    ? repository.attachKeySecrets(siteId, live.items)
    : live.items;
  const targetKeys = keyId == null
    ? liveKeys
    : liveKeys.filter((key) => String(key.id) === String(keyId));
  if (keyId != null && !targetKeys.length) {
    const error = new Error('Key not found on upstream');
    error.status = 404;
    throw error;
  }
  const probe = dependencies.probe || probeKey;
  const pendingNotifications = [];
  const checks = await mapWithConcurrency(targetKeys, concurrency, async (key) => {
    const result = await probe(site, key, dependencies);
    const saved = repository.recordKeyConnectivityCheck(siteId, key.id, result);
    const evaluateAlert = dependencies.evaluateAlert || evaluateKeyConnectivity;
    try {
      const evaluation = await evaluateAlert(site, key, saved.current, {
        ...dependencies,
        deferNotification: true
      });
      if (evaluation?.notification) pendingNotifications.push(evaluation.notification);
    } catch (error) {
      console.error(`Key alert delivery failed for upstream ${site.id}:`, error.message);
    }
    return {
      upstream_key_id: String(key.id),
      name: key.name || '',
      key_masked: key.key_masked || '',
      ...saved.current
    };
  });
  const deliverAlerts = dependencies.deliverAlerts || deliverAlertNotifications;
  await deliverAlerts(pendingNotifications, dependencies);
  repository.pruneKeyConnectivityChecks?.(siteId, dependencies.maxKeyCheckLogs);
  return {
    site: { id: site.id, name: site.name },
    checked: checks.length,
    connected: checks.filter((item) => item.status === 'connected').length,
    failed: checks.filter((item) => FAILURE_STATES.has(item.status)).length,
    unavailable: checks.filter((item) => ['unconfigured', 'unavailable'].includes(item.status)).length,
    items: checks
  };
}

function shouldCheckSite(site, now = Date.now(), defaultIntervalSeconds = 300) {
  if (site.status === 'disabled' || Number(site.key_check_enabled ?? 1) === 0) return false;
  if (!site.last_key_check_at) return true;
  return now - new Date(site.last_key_check_at).getTime() >= Number(site.key_check_interval_seconds || defaultIntervalSeconds) * 1000;
}

async function checkDueUpstreams(dependencies = {}) {
  const repository = dependencies.repo || repo;
  const settings = dependencies.settings || {};
  const now = dependencies.now || Date.now();
  const sites = repository.listSites().filter((site) => (
    shouldCheckSite(site, now, settings.key_check_default_interval_seconds || 300)
  ));
  const results = [];
  for (const site of sites) {
    try {
      results.push({ upstream_site_id: site.id, status: 'success', ...(await checkUpstreamKeys(site.id, dependencies)) });
    } catch (error) {
      results.push({ upstream_site_id: site.id, status: 'failed', error: error.message });
    }
  }
  return results;
}

module.exports = {
  FAILURE_STATES,
  normalizedPlatform,
  probeModelForKey,
  safeProbeError,
  classifyProbeError,
  prefersResponsesProtocol,
  probeAttempts,
  shouldTryProtocolFallback,
  probeKey,
  mapWithConcurrency,
  checkUpstreamKeys,
  checkDueUpstreams,
  shouldCheckSite
};
