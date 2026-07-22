const repo = require('./repository');
const { fetchAllSub2APIKeys } = require('./keyImportService');
const { listSub2APIKeys, listSub2APIGroups } = require('./upstreamKeys');
const { fetchSub2APIState, getUpstreamToken, requestJson } = require('./upstreamClient');
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

function isNewAPI(site) {
  const type = String(site?.upstream_type || '').toLowerCase();
  return type === 'new-api' || type === 'newapi';
}

function stringList(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.flatMap((item) => stringList(item)))];
  }
  if (value == null) return [];
  if (typeof value === 'string') {
    const normalized = value.trim();
    return normalized ? [normalized] : [];
  }
  if (typeof value === 'object') {
    for (const key of ['items', 'data', 'list', 'groups', 'enable_groups', 'enableGroups']) {
      if (value[key] != null) return stringList(value[key]);
    }
  }
  return [];
}

function newAPIModelName(item) {
  return String(typeof item === 'string'
    ? item
    : item?.model_name || item?.model || item?.id || item?.name || '').trim();
}

function newAPIModelGroups(item) {
  if (!item || typeof item !== 'object') return [];
  return stringList(item.enable_groups ?? item.enableGroups ?? item.groups ?? item.group);
}

function isNewAPIAllGroup(value) {
  return String(value || '').trim().toLowerCase() === 'all';
}

function newAPIModelPlatform(item) {
  const direct = String(item?.platform || '').trim();
  if (direct) return direct;
  const endpoints = stringList(item?.supported_endpoint_types ?? item?.supportedEndpointTypes)
    .map((value) => value.toLowerCase());
  const supportsOpenAI = endpoints.some((value) => value.includes('openai'));
  const supportsAnthropic = endpoints.some((value) => value.includes('anthropic'));
  if (supportsAnthropic && !supportsOpenAI) return 'anthropic';
  if (supportsOpenAI && !supportsAnthropic) return 'openai';
  return supportsOpenAI || supportsAnthropic ? 'new-api' : '';
}

function newAPIGroupEntries(groupsPayload) {
  const payload = groupsPayload?.groups ?? groupsPayload;
  if (Array.isArray(payload)) {
    return payload.map((item) => {
      if (typeof item === 'string') return { id: item, name: item, platform: '' };
      const id = String(item?.id ?? item?.group_id ?? item?.name ?? item?.group ?? '').trim();
      return { id, name: String(item?.name ?? item?.group_name ?? item?.group ?? id).trim(), platform: item?.platform || '' };
    }).filter((item) => item.id);
  }
  if (!payload || typeof payload !== 'object') return [];
  return Object.entries(payload).flatMap(([name, value]) => {
    if (Array.isArray(value)) return [];
    if (value && typeof value === 'object') {
      const id = String(value.id ?? value.group_id ?? value.name ?? name).trim();
      return id ? [{ id, name: String(value.name ?? value.group_name ?? name).trim(), platform: value.platform || '' }] : [];
    }
    return typeof value === 'string' && value.trim()
      ? [{ id: value.trim(), name, platform: '' }]
      : [{ id: name, name, platform: '' }];
  }).filter((item) => item.id);
}

function buildNewAPIProbeGroups(state) {
  const groups = new Map();
  const addGroup = (id, name = '', platform = '') => {
    const groupId = String(id || name || '').trim();
    if (!groupId) return null;
    const current = groups.get(groupId) || {
      group_id: groupId,
      group_name: String(name || groupId).trim(),
      platform: String(platform || '').trim(),
      models: [],
      platforms: new Set()
    };
    if (name) current.group_name = String(name).trim();
    if (platform) current.platform = String(platform).trim();
    groups.set(groupId, current);
    return current;
  };

  for (const group of newAPIGroupEntries(state?.raw?.groups)) {
    addGroup(group.id, group.name, group.platform);
  }
  for (const rate of state?.rates || []) {
    if (rate?.scope === 'new-api-group') addGroup(rate.group_id, rate.group_name);
  }

  const catalog = Array.isArray(state?.model_pricing) && state.model_pricing.length
    ? state.model_pricing
    : extractModelNames(state?.raw?.models).map((model) => ({ model_name: model }));
  for (const item of catalog) {
    for (const groupName of newAPIModelGroups(item)) {
      if (!isNewAPIAllGroup(groupName)) addGroup(groupName, groupName);
    }
  }
  if (!groups.size && catalog.length) addGroup('default', 'default');

  for (const item of catalog) {
    const model = newAPIModelName(item);
    if (!model) continue;
    const modelGroups = newAPIModelGroups(item);
    const targetIds = modelGroups.some(isNewAPIAllGroup)
      ? [...groups.keys()]
      : (modelGroups.length ? modelGroups : [...groups.keys()]);
    const platform = newAPIModelPlatform(item);
    for (const groupId of targetIds) {
      const group = addGroup(groupId, groupId);
      if (!group) continue;
      group.models.push({ model, source: 'pricing' });
      if (platform) group.platforms.add(platform);
    }
  }

  return [...groups.values()].map((group) => {
    if (!group.platform) {
      if (group.platforms.size === 1) {
        [group.platform] = group.platforms;
      } else if (group.platforms.size > 1) {
        group.platform = 'new-api';
      }
    }
    return {
      group_id: group.group_id,
      group_name: group.group_name || group.group_id,
      platform: group.platform || 'new-api',
      models: group.models,
      source: 'pricing',
      discovery_status: group.models.length ? 'pricing' : 'unavailable',
      discovery_error: group.models.length ? '' : 'New API 模型广场未返回该分组的模型'
    };
  }).sort((left, right) => left.group_name.localeCompare(right.group_name));
}

function savedModelSyncResult(repository, siteId, discovered, syncedAt) {
  const items = repository.replaceUpstreamProbeModels(siteId, discovered, syncedAt);
  return {
    upstream_site_id: siteId,
    synced_at: syncedAt,
    groups: items.length,
    live_groups: items.filter((item) => item.discovery_status === 'live').length,
    pricing_groups: items.filter((item) => item.discovery_status === 'pricing').length,
    fallback_groups: items.filter((item) => item.discovery_status === 'usage').length,
    stale_groups: items.filter((item) => item.discovery_status === 'stale').length,
    unavailable_groups: items.filter((item) => item.discovery_status === 'unavailable').length,
    items
  };
}

async function syncNewAPIModels(site, credentials, dependencies = {}) {
  const fetchState = dependencies.fetchUpstreamState || fetchSub2APIState;
  try {
    const state = dependencies.initialState || await fetchState({
      baseUrl: site.base_url,
      upstreamType: 'new-api',
      email: credentials.email,
      password: credentials.password,
      token: credentials.token
    });
    const groups = buildNewAPIProbeGroups(state);
    if (groups.some((group) => group.models.length)) return groups;
  } catch {
    // The New API model plaza is commonly public, so a bad account session should not block model selection.
  }

  const request = dependencies.request || requestJson;
  const pricing = await request(site.base_url, '/pricing', {
    prefix: '/api',
    timeoutMs: Number(dependencies.timeoutMs || 15000)
  });
  const groups = buildNewAPIProbeGroups({
    raw: { models: [] },
    model_pricing: Array.isArray(pricing) ? pricing : extractModelNames(pricing).map((model) => ({ model_name: model }))
  });
  if (!groups.some((group) => group.models.length)) {
    throw new Error('New API 模型广场未返回可同步的模型，已保留上次本地缓存');
  }
  return groups;
}

async function detectAutoNewAPIState(site, credentials, dependencies = {}) {
  if (String(site?.upstream_type || 'auto').toLowerCase() !== 'auto') return null;
  const fetchState = dependencies.fetchUpstreamState || fetchSub2APIState;
  try {
    const state = await fetchState({
      baseUrl: site.base_url,
      upstreamType: 'auto',
      email: credentials.email,
      password: credentials.password,
      token: credentials.token,
      refreshToken: credentials.refresh_token,
      tokenExpiresAt: credentials.token_expires_at
    });
    return state?.login?.provider === 'new-api' ? state : null;
  } catch {
    return null;
  }
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
  const autoNewAPIState = isNewAPI(site) ? null : await detectAutoNewAPIState(site, credentials, dependencies);
  if (isNewAPI(site) || autoNewAPIState) {
    const discovered = await syncNewAPIModels(site, credentials, { ...dependencies, initialState: autoNewAPIState });
    return savedModelSyncResult(repository, siteId, discovered, nowIso());
  }
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
  const keys = repository.attachKeySecrets
    ? repository.attachKeySecrets(siteId, keyResult.items || [])
    : (keyResult.items || []);
  const representative = new Map();
  for (const key of keys) {
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
  return savedModelSyncResult(repository, siteId, discovered, nowIso());
}

module.exports = {
  extractModelNames,
  modelsFromUsage,
  safeDiscoveryError,
  modelRequestOptions,
  discoverGroupModels,
  isNewAPI,
  newAPIGroupEntries,
  buildNewAPIProbeGroups,
  syncNewAPIModels,
  detectAutoNewAPIState,
  syncUpstreamModels
};
