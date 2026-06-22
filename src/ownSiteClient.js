const { requestJson, loginWithPassword } = require('./upstreamClient');

const CHANNEL_PATHS = [
  '/admin/accounts',
  '/channels',
  '/channels/available',
  '/admin/channels',
  '/channel',
  '/admin/channel',
  '/api/channels',
  '/routes',
  '/admin/routes'
];

function unwrapItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.items)) return payload.items;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.channels)) return payload.channels;
  if (Array.isArray(payload?.routes)) return payload.routes;
  return [];
}

function pickString(...values) {
  const value = values.find((item) => item !== undefined && item !== null && String(item).trim() !== '');
  return value === undefined ? '' : String(value).trim();
}

function maskKeyLike(value) {
  const key = pickString(value);
  if (!key) return '';
  if (key.includes('*') || key.includes('...')) return key;
  if (key.length <= 12) return '******';
  return `${key.slice(0, 7)}...${key.slice(-4)}`;
}

function mappingText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(mappingText).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    return Object.entries(value).slice(0, 6).map(([key, item]) => `${key}->${item}`).join(', ');
  }
  return String(value);
}

function normalizeOwnSiteRoute(raw, index = 0) {
  const upstreamUrl = pickString(
    raw?.upstream_api_url,
    raw?.upstream_url,
    raw?.base_url,
    raw?.baseURL,
    raw?.url,
    raw?.api_url,
    raw?.api_base,
    raw?.proxy_url
  );
  const keyValue = pickString(
    raw?.upstream_key,
    raw?.api_key,
    raw?.key,
    raw?.token,
    raw?.auth_token,
    raw?.sk
  );
  return {
    route_id: pickString(raw?.id, raw?.channel_id, raw?.route_id, raw?.key, index + 1),
    route_name: pickString(raw?.name, raw?.channel_name, raw?.route_name, raw?.label, `渠道 ${index + 1}`),
    model_pattern: pickString(raw?.model, raw?.models, raw?.model_name, raw?.model_pattern, raw?.match, raw?.matcher),
    upstream_api_url: upstreamUrl,
    upstream_key_masked: maskKeyLike(keyValue || raw?.upstream_key_masked || raw?.key_masked),
    upstream_key_id: pickString(raw?.upstream_key_id, raw?.key_id, raw?.token_id),
    route_status: pickString(raw?.status, raw?.state, raw?.enabled === false ? 'disabled' : 'active'),
    raw_payload: raw || {}
  };
}

function normalizeKeyAsRoute(key, site, index = 0) {
  const group = key?.group && typeof key.group === 'object' ? key.group : {};
  const groupName = group.name || key?.group_name || key?.group_id || '';
  return {
    route_id: `key:${key?.id ?? index + 1}`,
    route_name: key?.name || `Key ${key?.id ?? index + 1}`,
    model_pattern: group.platform || groupName || '按 Key 绑定分组',
    upstream_api_url: site.baseUrl,
    upstream_key_masked: maskKeyLike(key?.key || key?.key_masked),
    upstream_key_id: pickString(key?.id, key?.key_id),
    route_status: pickString(key?.status, 'active'),
    group_id: pickString(key?.group_id, group.id),
    group_name: pickString(groupName),
    platform: pickString(group.platform, key?.platform),
    group_rate: group.rate_multiplier ?? key?.group_rate ?? key?.rate_multiplier ?? null,
    raw_payload: {
      id: key?.id,
      name: key?.name,
      group_id: key?.group_id,
      group_name: groupName,
      platform: group.platform || key?.platform || '',
      status: key?.status || ''
    }
  };
}

function normalizeAccountAsRoute(account, index = 0) {
  const credentials = account?.credentials && typeof account.credentials === 'object' ? account.credentials : {};
  const groups = Array.isArray(account?.groups)
    ? account.groups
    : Array.isArray(account?.account_groups)
      ? account.account_groups.map((item) => item.group).filter(Boolean)
      : [];
  const primaryGroup = groups[0] || {};
  const baseUrl = pickString(
    credentials.base_url,
    credentials.baseURL,
    credentials.api_base,
    credentials.api_url,
    account?.base_url,
    account?.upstream_url
  );
  return {
    route_id: `account:${account?.id ?? index + 1}`,
    route_name: pickString(account?.name, `账号 ${account?.id ?? index + 1}`),
    model_pattern: pickString(mappingText(credentials.model_mapping), mappingText(account?.model_mapping), account?.platform, primaryGroup.platform),
    upstream_api_url: baseUrl,
    upstream_key_masked: account?.credentials_status?.has_api_key ? '已配置' : '',
    upstream_key_id: pickString(account?.id),
    upstream_buy_rate: null,
    route_status: pickString(account?.status, account?.schedulable === false ? 'disabled' : 'active'),
    group_id: pickString(primaryGroup.id, account?.group_ids?.[0]),
    group_name: pickString(primaryGroup.name),
    platform: pickString(primaryGroup.platform, account?.platform),
    group_rate: primaryGroup.rate_multiplier ?? account?.rate_multiplier ?? null,
    raw_payload: {
      id: account?.id,
      name: account?.name,
      platform: account?.platform,
      type: account?.type,
      status: account?.status,
      error_message: account?.error_message || '',
      has_api_key: Boolean(account?.credentials_status?.has_api_key),
      group_ids: account?.group_ids || groups.map((group) => group.id),
      groups: groups.map((group) => ({
        id: group.id,
        name: group.name,
        platform: group.platform,
        rate_multiplier: group.rate_multiplier,
        status: group.status
      }))
    }
  };
}

async function getOwnSiteAuth({ baseUrl, email, password, token }) {
  if (token) return { token, prefix: '/api/v1' };
  const login = await loginWithPassword(baseUrl, email, password);
  return { token: login.token, prefix: login.prefix || '/api/v1' };
}

async function fetchOwnSiteRoutes({ baseUrl, email, password, token }) {
  const auth = await getOwnSiteAuth({ baseUrl, email, password, token });
  const attempts = [];
  for (const path of CHANNEL_PATHS) {
    try {
      const data = await requestJson(baseUrl, path, {
        token: auth.token,
        prefix: auth.prefix
      });
      const items = unwrapItems(data);
      if (items.length > 0) {
        const normalize = path === '/admin/accounts' ? normalizeAccountAsRoute : normalizeOwnSiteRoute;
        return {
          routes: items.map((item, index) => normalize(item, index)),
          source_path: path,
          attempts
        };
      }
      attempts.push({ path, message: 'empty list', status: 200 });
    } catch (err) {
      attempts.push({ path, message: err.message, status: err.status || null });
    }
  }
  throw new Error(`自己站账号/渠道接口读取失败：${attempts.map((item) => `${item.path}: ${item.message}`).join('; ')}`);
}

module.exports = {
  fetchOwnSiteRoutes,
  normalizeOwnSiteRoute,
  maskKeyLike
};
