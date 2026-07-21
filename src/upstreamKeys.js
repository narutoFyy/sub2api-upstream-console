const { requestJson, getUpstreamToken } = require('./upstreamClient');

const USER_UI_HEADERS = { 'X-User-UI-Request': '1' };

function maskApiKey(key) {
  if (!key) return '';
  if (key.length <= 12) return '******';
  return `${key.slice(0, 7)}...${key.slice(-4)}`;
}

function isCompleteApiKey(value) {
  const key = String(value || '').trim();
  return key.length > 12 && !key.includes('...') && !key.includes('…') && !key.includes('*');
}

function unwrapPaginated(data) {
  if (Array.isArray(data)) return { items: data, total: data.length, page: 1, page_size: data.length, pages: 1 };
  if (Array.isArray(data?.items)) {
    return {
      items: data.items,
      total: Number(data.total || data.items.length),
      page: Number(data.page || 1),
      page_size: Number(data.page_size || data.items.length),
      pages: Number(data.pages || 1)
    };
  }
  return { items: [], total: 0, page: 1, page_size: 0, pages: 0 };
}

function firstPresent(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function firstNumber(...values) {
  const value = firstPresent(...values);
  if (value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function buildGroupLookup(groups = []) {
  const lookup = new Map();
  for (const group of groups) {
    if (group?.id !== undefined && group.id !== null) {
      lookup.set(`id:${String(group.id)}`, group);
    }
    if (group?.name) {
      lookup.set(`name:${String(group.name).toLowerCase()}`, group);
    }
  }
  return lookup;
}

function findGroupMeta(groupLookup, groupId, raw = {}, group = {}) {
  if (!groupLookup || typeof groupLookup.get !== 'function') return {};
  if (groupId !== undefined && groupId !== null && groupId !== '') {
    const byId = groupLookup.get(`id:${String(groupId)}`);
    if (byId) return byId;
  }
  const name = firstPresent(group.name, group.group_name, raw.group_name, raw.groupName);
  if (name) {
    return groupLookup.get(`name:${String(name).toLowerCase()}`) || {};
  }
  return {};
}

function normalizeSub2APIKey(raw, siteMeta = {}, groupLookup = null) {
  const group = raw?.group && typeof raw.group === 'object' ? raw.group : {};
  const primitiveGroup = raw?.group && typeof raw.group !== 'object' ? raw.group : null;
  const groupId = firstPresent(
    raw?.group_id,
    raw?.groupId,
    group.id,
    group.group_id,
    group.groupId,
    raw?.group_info?.id,
    raw?.groupInfo?.id,
    primitiveGroup
  );
  const groupMeta = findGroupMeta(groupLookup, groupId, raw, group);
  const key = String(firstPresent(raw?.key, raw?.key_masked) || '').trim();
  const completeKey = isCompleteApiKey(key) ? key : '';
  const groupRate = firstNumber(
    raw?.group_rate,
    raw?.groupRate,
    raw?.user_rate_multiplier,
    raw?.userRateMultiplier,
    group.user_rate_multiplier,
    group.userRateMultiplier,
    groupMeta.user_rate_multiplier,
    raw?.rate_multiplier,
    raw?.rateMultiplier,
    group.rate_multiplier,
    group.rateMultiplier,
    groupMeta.rate_multiplier
  );
  return {
    upstream_site_id: siteMeta.siteId,
    upstream_name: siteMeta.siteName || '',
    base_url: siteMeta.baseUrl || '',
    id: raw?.id ?? null,
    name: raw?.name || '',
    key_masked: completeKey ? maskApiKey(completeKey) : key,
    key_full: completeKey || null,
    group_id: groupId ?? null,
    group_name: firstPresent(group.name, group.group_name, raw?.group_name, raw?.groupName, groupMeta.name) || '',
    platform: firstPresent(group.platform, raw?.group_platform, raw?.groupPlatform, raw?.platform, groupMeta.platform) || '',
    group_rate: groupRate,
    rate_multiplier: groupRate,
    subscription_type: firstPresent(group.subscription_type, raw?.subscription_type, groupMeta.subscription_type) || '',
    status: raw?.status || '',
    quota: raw?.quota ?? null,
    quota_used: raw?.quota_used ?? null,
    expires_at: raw?.expires_at || null,
    last_used_at: raw?.last_used_at || null,
    created_at: raw?.created_at || null,
    updated_at: raw?.updated_at || null
  };
}

function normalizeSub2APIGroup(raw, userRates = {}) {
  const id = raw?.id;
  const userRate = id != null ? (userRates[id] ?? userRates[String(id)]) : null;
  const groupRate = firstNumber(userRate, raw?.user_rate_multiplier, raw?.rate_multiplier);
  return {
    id,
    name: raw?.name || '',
    description: raw?.description || '',
    platform: raw?.platform || '',
    rate_multiplier: raw?.rate_multiplier ?? null,
    user_rate_multiplier: userRate ?? null,
    group_rate: groupRate,
    subscription_type: raw?.subscription_type || '',
    status: raw?.status || ''
  };
}

function assertKeyManagementSupported(site) {
  if (site.auth_mode === 'api_key') {
    const err = new Error('当前上游使用 API Key 认证，无法代登录管理密钥。请改用账号密码或 Token 模式。');
    err.status = 422;
    throw err;
  }
  if (site.upstream_type === 'new-api') {
    const err = new Error('new-api 上游的 Key 管理尚未接入，当前仅支持 Sub2API。');
    err.status = 422;
    throw err;
  }
}

async function withSub2APIAuth(site, creds, fn) {
  assertKeyManagementSupported(site);
  const auth = await getUpstreamToken({
    baseUrl: site.base_url,
    email: creds.email,
    password: creds.password,
    token: creds.token
  });
  return fn(auth);
}

async function fetchSub2APIGroupLookup(site, auth) {
  const [groups, rates] = await Promise.all([
    requestJson(site.base_url, '/groups/available', { token: auth.token, prefix: auth.prefix }).catch(() => []),
    requestJson(site.base_url, '/groups/rates', { token: auth.token, prefix: auth.prefix }).catch(() => ({}))
  ]);
  const groupList = Array.isArray(groups) ? groups : Array.isArray(groups?.items) ? groups.items : [];
  const userRates = rates && typeof rates === 'object' && !Array.isArray(rates) ? rates : {};
  return buildGroupLookup(groupList.map((group) => normalizeSub2APIGroup(group, userRates)));
}

async function listSub2APIKeys(site, creds, { page = 1, pageSize = 100, search = '', status = '', groupId = null } = {}) {
  return withSub2APIAuth(site, creds, async (auth) => {
    const params = new URLSearchParams({
      page: String(page),
      page_size: String(pageSize),
      sort_by: 'created_at',
      sort_order: 'desc'
    });
    if (search) params.set('search', search);
    if (status) params.set('status', status);
    if (groupId != null && groupId !== '') params.set('group_id', String(groupId));
    const [data, groupLookup] = await Promise.all([
      requestJson(site.base_url, `/keys?${params.toString()}`, {
        token: auth.token,
        prefix: auth.prefix,
        headers: USER_UI_HEADERS
      }),
      fetchSub2APIGroupLookup(site, auth)
    ]);
    const pageData = unwrapPaginated(data);
    const siteMeta = { siteId: site.id, siteName: site.name, baseUrl: site.base_url };
    return {
      ...pageData,
      items: pageData.items.map((item) => normalizeSub2APIKey(item, siteMeta, groupLookup))
    };
  });
}

async function listSub2APIGroups(site, creds) {
  return withSub2APIAuth(site, creds, async (auth) => {
    const [groups, rates] = await Promise.all([
      requestJson(site.base_url, '/groups/available', { token: auth.token, prefix: auth.prefix }),
      requestJson(site.base_url, '/groups/rates', { token: auth.token, prefix: auth.prefix }).catch(() => ({}))
    ]);
    const groupList = Array.isArray(groups) ? groups : Array.isArray(groups?.items) ? groups.items : [];
    const userRates = rates && typeof rates === 'object' && !Array.isArray(rates) ? rates : {};
    return groupList.map((group) => normalizeSub2APIGroup(group, userRates));
  });
}

async function createSub2APIKey(site, creds, payload) {
  return withSub2APIAuth(site, creds, async (auth) => {
    const body = {
      name: payload.name,
      group_id: payload.group_id
    };
    if (payload.custom_key) body.custom_key = payload.custom_key;
    if (payload.quota != null && Number(payload.quota) > 0) body.quota = Number(payload.quota);
    if (payload.expires_in_days != null && Number(payload.expires_in_days) > 0) {
      body.expires_in_days = Number(payload.expires_in_days);
    }
    const [data, groupLookup] = await Promise.all([
      requestJson(site.base_url, '/keys', {
        method: 'POST',
        body,
        token: auth.token,
        prefix: auth.prefix,
        headers: USER_UI_HEADERS
      }),
      fetchSub2APIGroupLookup(site, auth)
    ]);
    return normalizeSub2APIKey(data, { siteId: site.id, siteName: site.name, baseUrl: site.base_url }, groupLookup);
  });
}

async function updateSub2APIKey(site, creds, keyId, payload) {
  return withSub2APIAuth(site, creds, async (auth) => {
    const body = {};
    if (payload.name) body.name = payload.name;
    if (payload.group_id != null) body.group_id = payload.group_id;
    if (payload.status) body.status = payload.status;
    const [data, groupLookup] = await Promise.all([
      requestJson(site.base_url, `/keys/${keyId}`, {
        method: 'PUT',
        body,
        token: auth.token,
        prefix: auth.prefix,
        headers: USER_UI_HEADERS
      }),
      fetchSub2APIGroupLookup(site, auth)
    ]);
    return normalizeSub2APIKey(data, { siteId: site.id, siteName: site.name, baseUrl: site.base_url }, groupLookup);
  });
}

async function deleteSub2APIKey(site, creds, keyId) {
  return withSub2APIAuth(site, creds, async (auth) => {
    await requestJson(site.base_url, `/keys/${keyId}`, {
      method: 'DELETE',
      token: auth.token,
      prefix: auth.prefix,
      headers: USER_UI_HEADERS
    });
    return { deleted: true, id: keyId };
  });
}

module.exports = {
  maskApiKey,
  isCompleteApiKey,
  normalizeSub2APIKey,
  normalizeSub2APIGroup,
  assertKeyManagementSupported,
  listSub2APIKeys,
  listSub2APIGroups,
  createSub2APIKey,
  updateSub2APIKey,
  deleteSub2APIKey
};
