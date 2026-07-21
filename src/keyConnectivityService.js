const repo = require('./repository');
const { requestJson } = require('./upstreamClient');
const { fetchAllSub2APIKeys } = require('./keyImportService');
const { listSub2APIKeys } = require('./upstreamKeys');
const { nowIso } = require('./utils');
const { evaluateKeyConnectivity } = require('./alertService');

const FAILURE_STATES = new Set(['timeout', 'auth_failed', 'quota_exhausted', 'upstream_error']);

function normalizedPlatform(value) {
  const platform = String(value || '').toLowerCase();
  if (platform.includes('anthropic') || platform.includes('claude')) return 'anthropic';
  if (platform.includes('openai') || platform.includes('gpt') || platform.includes('codex')) return 'openai';
  return platform || 'openai';
}

function probeModelForKey(site, key, repository = repo) {
  const groupModel = site?.id != null && key?.group_id != null
    ? repository.getGroupProbeModel?.(site.id, key.group_id)
    : '';
  if (groupModel) return String(groupModel).trim();
  return normalizedPlatform(key.platform) === 'anthropic'
    ? String(site.anthropic_probe_model || '').trim()
    : String(site.openai_probe_model || '').trim();
}

function classifyProbeError(error) {
  const status = Number(error?.status || 0) || null;
  const message = String(error?.message || 'Connectivity check failed');
  const searchable = `${message} ${JSON.stringify(error?.body || {})}`.toLowerCase();
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || searchable.includes('timeout')) {
    return { status: 'timeout', error_code: 'timeout', http_status: status, error_message: message };
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
  if (!key.key_full) {
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
  try {
    if (platform === 'anthropic') {
      await request(site.base_url, '/messages', {
        prefix: '/v1',
        method: 'POST',
        headers: {
          'x-api-key': key.key_full,
          'anthropic-version': '2023-06-01'
        },
        body: {
          model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }]
        },
        timeoutMs
      });
    } else {
      await request(site.base_url, '/chat/completions', {
        prefix: '/v1',
        method: 'POST',
        token: key.key_full,
        body: {
          model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
          stream: false
        },
        timeoutMs
      });
    }
    return {
      status: 'connected',
      probe_level: 'inference',
      platform,
      model,
      latency_ms: Date.now() - startedAt,
      checked_at: checkedAt
    };
  } catch (error) {
    return {
      ...classifyProbeError(error),
      probe_level: 'inference',
      platform,
      model,
      latency_ms: Date.now() - startedAt,
      checked_at: checkedAt
    };
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
  repository.reconcileKeySnapshots(siteId, live.items, nowIso(), { markMissing: false });
  const targetKeys = keyId == null
    ? live.items
    : live.items.filter((key) => String(key.id) === String(keyId));
  if (keyId != null && !targetKeys.length) {
    const error = new Error('Key not found on upstream');
    error.status = 404;
    throw error;
  }
  const probe = dependencies.probe || probeKey;
  const checks = await mapWithConcurrency(targetKeys, concurrency, async (key) => {
    const result = await probe(site, key, dependencies);
    const saved = repository.recordKeyConnectivityCheck(siteId, key.id, result);
    const evaluateAlert = dependencies.evaluateAlert || evaluateKeyConnectivity;
    try {
      await evaluateAlert(site, key, saved.current, dependencies);
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
  repository.pruneKeyConnectivityChecks?.(siteId);
  return {
    site: { id: site.id, name: site.name },
    checked: checks.length,
    connected: checks.filter((item) => item.status === 'connected').length,
    failed: checks.filter((item) => FAILURE_STATES.has(item.status)).length,
    unavailable: checks.filter((item) => ['unconfigured', 'unavailable'].includes(item.status)).length,
    items: checks
  };
}

function shouldCheckSite(site, now = Date.now()) {
  if (site.status === 'disabled') return false;
  if (!site.last_key_check_at) return true;
  return now - new Date(site.last_key_check_at).getTime() >= Number(site.key_check_interval_seconds || 300) * 1000;
}

async function checkDueUpstreams(dependencies = {}) {
  const repository = dependencies.repo || repo;
  const sites = repository.listSites().filter((site) => shouldCheckSite(site));
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
  classifyProbeError,
  probeKey,
  mapWithConcurrency,
  checkUpstreamKeys,
  checkDueUpstreams,
  shouldCheckSite
};
