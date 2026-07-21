const repo = require('./repository');
const { getUpstreamToken, requestJson } = require('./upstreamClient');
const { maskApiKey } = require('./upstreamKeys');

const SORT_FIELDS = new Set(['created_at', 'model', 'actual_cost', 'duration_ms']);
const QUERY_TEXT_FIELDS = new Set(['start_date', 'end_date', 'model', 'request_type', 'billing_mode']);

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function normalizeUsageQuery(query = {}) {
  const normalized = {
    page: String(boundedInteger(query.page, 1, 1, 1000000)),
    page_size: String(boundedInteger(query.page_size, 20, 1, 100)),
    sort_by: SORT_FIELDS.has(String(query.sort_by || '')) ? String(query.sort_by) : 'created_at',
    sort_order: String(query.sort_order).toLowerCase() === 'asc' ? 'asc' : 'desc'
  };
  for (const field of QUERY_TEXT_FIELDS) {
    const value = String(query[field] || '').trim().slice(0, 200);
    if (value) normalized[field] = value;
  }
  for (const field of ['api_key_id', 'group_id', 'billing_type']) {
    const value = String(query[field] ?? '').trim();
    if (/^\d+$/.test(value)) normalized[field] = value;
  }
  return normalized;
}

function finiteValue(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function keyMetadata(record) {
  const apiKey = record?.api_key && typeof record.api_key === 'object' ? record.api_key : {};
  const rawKey = typeof record?.api_key === 'string'
    ? record.api_key
    : apiKey.key || record?.key || '';
  return {
    api_key_id: record?.api_key_id ?? apiKey.id ?? null,
    key_name: record?.key_name || apiKey.name || '',
    key_masked: rawKey ? maskApiKey(String(rawKey)) : ''
  };
}

function sanitizeUsageRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const group = record.group && typeof record.group === 'object' ? record.group : {};
  return {
    id: record.id ?? null,
    request_id: String(record.request_id || '').slice(0, 200),
    created_at: record.created_at || null,
    ...keyMetadata(record),
    group_id: record.group_id ?? group.id ?? null,
    group_name: record.group_name || group.name || '',
    model: String(record.model || '').slice(0, 200),
    inbound_endpoint: String(record.inbound_endpoint || '').slice(0, 300),
    request_type: String(record.request_type || '').slice(0, 100),
    stream: Boolean(record.stream),
    billing_type: record.billing_type ?? null,
    billing_mode: String(record.billing_mode || '').slice(0, 100),
    input_tokens: finiteValue(record.input_tokens),
    output_tokens: finiteValue(record.output_tokens),
    cache_read_tokens: finiteValue(record.cache_read_tokens),
    cache_creation_tokens: finiteValue(record.cache_creation_tokens),
    cache_creation_1h_tokens: finiteValue(record.cache_creation_1h_tokens),
    cache_creation_5m_tokens: finiteValue(record.cache_creation_5m_tokens),
    actual_cost: finiteValue(record.actual_cost),
    total_cost: finiteValue(record.total_cost),
    rate_multiplier: finiteValue(record.rate_multiplier),
    duration_ms: finiteValue(record.duration_ms),
    first_token_ms: finiteValue(record.first_token_ms),
    reasoning_effort: String(record.reasoning_effort || '').slice(0, 100),
    ip_address: String(record.ip_address || '').slice(0, 100),
    user_agent: String(record.user_agent || '').slice(0, 500)
  };
}

function enrichUsageRecord(record, keyLookup) {
  const key = keyLookup.get(String(record.api_key_id ?? ''));
  if (!key) return record;
  return {
    ...record,
    key_name: record.key_name || key.name || '',
    key_masked: record.key_masked || key.key_masked || '',
    group_id: record.group_id ?? key.group_id ?? null,
    group_name: record.group_name || key.group_name || ''
  };
}

async function usageContext(siteId, dependencies = {}) {
  const repository = dependencies.repo || repo;
  const site = repository.getSite(siteId);
  if (!site) {
    const error = new Error('Upstream not found');
    error.status = 404;
    throw error;
  }
  const credentials = repository.getCredentials(siteId) || {};
  const getAuth = dependencies.getAuth || getUpstreamToken;
  const auth = await getAuth({
    baseUrl: site.base_url,
    email: credentials.email,
    password: credentials.password,
    token: credentials.token
  });
  return { site, auth, repository };
}

async function queryUpstreamUsage(siteId, query = {}, dependencies = {}) {
  const { site, auth, repository } = await usageContext(siteId, dependencies);
  const params = new URLSearchParams(normalizeUsageQuery(query));
  const request = dependencies.request || requestJson;
  const payload = await request(site.base_url, `/usage?${params.toString()}`, {
    token: auth.token,
    prefix: auth.prefix,
    timeoutMs: Number(dependencies.timeoutMs || 20000)
  });
  const items = Array.isArray(payload?.items) ? payload.items : Array.isArray(payload) ? payload : [];
  const keyLookup = new Map((repository.listKeySnapshots?.(siteId, 5000) || [])
    .map((key) => [String(key.upstream_key_id), key]));
  return {
    upstream: { id: site.id, name: site.name },
    items: items.map(sanitizeUsageRecord).filter(Boolean).map((item) => enrichUsageRecord(item, keyLookup)),
    total: Number(payload?.total ?? items.length),
    page: Number(payload?.page ?? params.get('page')),
    page_size: Number(payload?.page_size ?? params.get('page_size')),
    pages: Number(payload?.pages ?? Math.max(1, Math.ceil(Number(payload?.total ?? items.length) / Number(params.get('page_size')))))
  };
}

async function getUpstreamUsageDetail(siteId, usageId, dependencies = {}) {
  const safeId = String(usageId || '').trim();
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(safeId)) {
    const error = new Error('Invalid usage record ID');
    error.status = 400;
    throw error;
  }
  const { site, auth, repository } = await usageContext(siteId, dependencies);
  const request = dependencies.request || requestJson;
  const payload = await request(site.base_url, `/usage/${safeId}`, {
    token: auth.token,
    prefix: auth.prefix,
    timeoutMs: Number(dependencies.timeoutMs || 20000)
  });
  const keyLookup = new Map((repository.listKeySnapshots?.(siteId, 5000) || [])
    .map((key) => [String(key.upstream_key_id), key]));
  return {
    upstream: { id: site.id, name: site.name },
    item: enrichUsageRecord(sanitizeUsageRecord(payload), keyLookup)
  };
}

module.exports = {
  normalizeUsageQuery,
  sanitizeUsageRecord,
  enrichUsageRecord,
  queryUpstreamUsage,
  getUpstreamUsageDetail
};
