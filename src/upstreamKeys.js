const { requestJson, getUpstreamToken } = require('./upstreamClient');

function maskApiKey(key) {
  if (!key) return '';
  if (key.length <= 12) return '******';
  return `${key.slice(0, 7)}...${key.slice(-4)}`;
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

function normalizeSub2APIKey(raw, siteMeta = {}) {
  const group = raw?.group && typeof raw.group === 'object' ? raw.group : {};
  const key = raw?.key || '';
  return {
    upstream_site_id: siteMeta.siteId,
    upstream_name: siteMeta.siteName || '',
    base_url: siteMeta.baseUrl || '',
    id: raw?.id ?? null,
    name: raw?.name || '',
    key_masked: maskApiKey(key),
    key_full: key || null,
    group_id: raw?.group_id ?? group.id ?? null,
    group_name: group.name || '',
    platform: group.platform || '',
    rate_multiplier: group.rate_multiplier ?? null,
    subscription_type: group.subscription_type || '',
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
  return {
    id,
    name: raw?.name || '',
    description: raw?.description || '',
    platform: raw?.platform || '',
    rate_multiplier: raw?.rate_multiplier ?? null,
    user_rate_multiplier: userRate ?? null,
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
    const data = await requestJson(site.base_url, `/keys?${params.toString()}`, {
      token: auth.token,
      prefix: auth.prefix
    });
    const pageData = unwrapPaginated(data);
    const siteMeta = { siteId: site.id, siteName: site.name, baseUrl: site.base_url };
    return {
      ...pageData,
      items: pageData.items.map((item) => normalizeSub2APIKey(item, siteMeta))
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
    const data = await requestJson(site.base_url, '/keys', {
      method: 'POST',
      body,
      token: auth.token,
      prefix: auth.prefix
    });
    return normalizeSub2APIKey(data, { siteId: site.id, siteName: site.name, baseUrl: site.base_url });
  });
}

async function updateSub2APIKey(site, creds, keyId, payload) {
  return withSub2APIAuth(site, creds, async (auth) => {
    const body = {};
    if (payload.name) body.name = payload.name;
    if (payload.group_id != null) body.group_id = payload.group_id;
    if (payload.status) body.status = payload.status;
    const data = await requestJson(site.base_url, `/keys/${keyId}`, {
      method: 'PUT',
      body,
      token: auth.token,
      prefix: auth.prefix
    });
    return normalizeSub2APIKey(data, { siteId: site.id, siteName: site.name, baseUrl: site.base_url });
  });
}

async function deleteSub2APIKey(site, creds, keyId) {
  return withSub2APIAuth(site, creds, async (auth) => {
    await requestJson(site.base_url, `/keys/${keyId}`, {
      method: 'DELETE',
      token: auth.token,
      prefix: auth.prefix
    });
    return { deleted: true, id: keyId };
  });
}

module.exports = {
  maskApiKey,
  normalizeSub2APIKey,
  normalizeSub2APIGroup,
  assertKeyManagementSupported,
  listSub2APIKeys,
  listSub2APIGroups,
  createSub2APIKey,
  updateSub2APIKey,
  deleteSub2APIKey
};
