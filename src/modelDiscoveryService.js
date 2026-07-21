const repo = require('./repository');
const { fetchAllSub2APIKeys } = require('./keyImportService');
const { listSub2APIKeys, listSub2APIGroups } = require('./upstreamKeys');
const { getUpstreamToken, requestJson } = require('./upstreamClient');
const { nowIso } = require('./utils');

function extractModelNames(payload) {
  const items = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : [];
  return [...new Set(items.map((item) => String(
    typeof item === 'string' ? item : item?.id || item?.model || item?.name || ''
  ).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function modelsFromUsage(payload, groupId) {
  const items = Array.isArray(payload?.items) ? payload.items : Array.isArray(payload) ? payload : [];
  return [...new Set(items.filter((item) => {
    if (groupId == null || groupId === '') return true;
    const itemGroupId = item?.group_id ?? item?.group?.id;
    return itemGroupId == null || String(itemGroupId) === String(groupId);
  }).map((item) => String(item?.model || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

function safeDiscoveryError(value) {
  return String(value || '')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[IP]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[KEY]')
    .slice(0, 500);
}

function modelRequestOptions(key, timeoutMs) {
  const platform = String(key.platform || '').toLowerCase();
  if (platform.includes('anthropic') || platform.includes('claude')) {
    return {
      prefix: '/v1',
      headers: {
        'x-api-key': key.key_full,
        'anthropic-version': '2023-06-01'
      },
      timeoutMs
    };
  }
  return { prefix: '/v1', token: key.key_full, timeoutMs };
}

async function discoverGroupModels(site, auth, group, key, dependencies = {}) {
  const request = dependencies.request || requestJson;
  const timeoutMs = Number(dependencies.timeoutMs || 15000);
  let liveError = '';
  if (key?.key_full) {
    try {
      const payload = await request(site.base_url, '/models', modelRequestOptions(key, timeoutMs));
      const models = extractModelNames(payload);
      if (models.length) {
        return {
          models: models.map((model) => ({ model, source: 'live' })),
          status: 'live',
          error: ''
        };
      }
      liveError = '上游模型接口返回空列表';
    } catch (error) {
      liveError = safeDiscoveryError(error.message || '模型接口不可用');
    }
  } else {
    liveError = '该分组没有可用于同步模型的启用 Key';
  }

  try {
    const params = new URLSearchParams({
      page: '1',
      page_size: '100',
      sort_by: 'created_at',
      sort_order: 'desc',
      group_id: String(group.id ?? '')
    });
    const usage = await request(site.base_url, `/usage?${params.toString()}`, {
      prefix: auth.prefix,
      token: auth.token,
      timeoutMs
    });
    const models = modelsFromUsage(usage, group.id);
    if (models.length) {
      return {
        models: models.map((model) => ({ model, source: 'usage' })),
        status: 'usage',
        error: liveError
      };
    }
  } catch (error) {
    liveError = safeDiscoveryError([liveError, String(error.message || '')].filter(Boolean).join('；'));
  }

  const platform = String(group.platform || '').toLowerCase();
  const manual = platform.includes('anthropic') || platform.includes('claude')
    ? site.anthropic_probe_model
    : site.openai_probe_model;
  return {
    models: manual ? [{ model: manual, source: 'manual' }] : [],
    status: manual ? 'manual_only' : 'unavailable',
    error: liveError
  };
}

async function syncUpstreamModels(siteId, dependencies = {}) {
  const repository = dependencies.repo || repo;
  const site = repository.getSite(siteId);
  if (!site) {
    const error = new Error('Upstream not found');
    error.status = 404;
    throw error;
  }
  const credentials = repository.getCredentials(siteId) || {};
  const listGroups = dependencies.listGroups || listSub2APIGroups;
  const fetchKeys = dependencies.fetchKeys || ((target, creds) => fetchAllSub2APIKeys(target, creds, {
    listKeys: dependencies.listKeys || listSub2APIKeys,
    pageSize: dependencies.pageSize || 100
  }));
  const getAuth = dependencies.getAuth || getUpstreamToken;
  const [groups, keyResult, auth] = await Promise.all([
    listGroups(site, credentials),
    fetchKeys(site, credentials),
    getAuth({
      baseUrl: site.base_url,
      email: credentials.email,
      password: credentials.password,
      token: credentials.token
    })
  ]);
  const representative = new Map();
  for (const key of keyResult.items || []) {
    const groupId = String(key.group_id ?? '');
    if (!representative.has(groupId) && key.key_full && String(key.status || '').toLowerCase() === 'active') {
      representative.set(groupId, key);
    }
  }

  const discovered = [];
  for (const group of groups || []) {
    const groupId = String(group.id ?? '');
    const result = await discoverGroupModels(site, auth, group, representative.get(groupId), dependencies);
    discovered.push({
      group_id: groupId,
      group_name: group.name || '',
      platform: group.platform || '',
      models: result.models,
      source: result.status,
      discovery_status: result.status,
      discovery_error: result.error
    });
  }
  const syncedAt = nowIso();
  const items = repository.replaceUpstreamProbeModels(siteId, discovered, syncedAt);
  return {
    upstream_site_id: siteId,
    synced_at: syncedAt,
    groups: items.length,
    live_groups: items.filter((item) => item.discovery_status === 'live').length,
    fallback_groups: items.filter((item) => item.discovery_status === 'usage').length,
    unavailable_groups: items.filter((item) => item.discovery_status === 'unavailable').length,
    items
  };
}

module.exports = {
  extractModelNames,
  modelsFromUsage,
  safeDiscoveryError,
  modelRequestOptions,
  discoverGroupModels,
  syncUpstreamModels
};
