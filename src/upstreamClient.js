const dns = require('node:dns/promises');
const { assertSafeUpstreamUrl, isPrivateHostname, pickFirstNumber, toNumber } = require('./utils');

class UpstreamHTTPError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'UpstreamHTTPError';
    this.status = status;
    this.body = body;
  }
}

const API_PREFIXES = ['/api/v1', '/api'];

function joinUrl(baseUrl, path, prefix = '/api/v1') {
  return `${baseUrl.replace(/\/$/, '')}${prefix}${path.startsWith('/') ? path : `/${path}`}`;
}

function unwrapSub2API(payload) {
  if (payload && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'data')) {
    return payload.data;
  }
  return payload;
}

async function requestJson(baseUrl, path, options = {}) {
  const upstreamUrl = assertSafeUpstreamUrl(baseUrl);
  const addresses = await dns.lookup(upstreamUrl.hostname, { all: true }).catch(() => []);
  if (addresses.some((item) => isPrivateHostname(item.address))) {
    throw new Error('Base URL resolved to a private network address');
  }
  const headers = {
    accept: 'application/json',
    ...(options.body ? { 'content-type': 'application/json' } : {}),
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {})
  };
  const res = await fetch(joinUrl(baseUrl, path, options.prefix || '/api/v1'), {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeoutMs || 15000)
  });
  const text = await res.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text };
  }
  if (!res.ok) {
    throw new UpstreamHTTPError(`Upstream ${path} returned ${res.status}`, res.status, payload);
  }
  if (payload && typeof payload === 'object' && payload.code && payload.code !== 0) {
    throw new UpstreamHTTPError(payload.message || `Upstream ${path} returned code ${payload.code}`, res.status, payload);
  }
  return unwrapSub2API(payload);
}

async function loginWithPassword(baseUrl, email, password) {
  const attempts = [];
  for (const prefix of API_PREFIXES) {
    for (const path of ['/auth/login', '/login']) {
      try {
        const data = await requestJson(baseUrl, path, {
          method: 'POST',
          body: { email, password },
          prefix
        });
        const token = data?.access_token || data?.token || data?.jwt;
        if (!token) {
          throw new Error('Login succeeded but no access token was returned');
        }
        return {
          token,
          prefix,
          login_path: path,
          raw: data
        };
      } catch (err) {
        attempts.push(`${prefix}${path}: ${err.message}`);
      }
    }
  }
  throw new Error(`Login failed on known Sub2API paths: ${attempts.join('; ')}`);
}

function extractBalance(profile) {
  return pickFirstNumber(profile?.balance, profile?.user_balance, profile?.quota, profile?.credit);
}

function extractUsage(stats) {
  const totalTokens = pickFirstNumber(
    stats?.total_tokens,
    toNumber(stats?.total_input_tokens) + toNumber(stats?.total_output_tokens) + toNumber(stats?.total_cache_creation_tokens) + toNumber(stats?.total_cache_read_tokens)
  );
  const todayTokens = pickFirstNumber(
    stats?.today_tokens,
    toNumber(stats?.today_input_tokens) + toNumber(stats?.today_output_tokens) + toNumber(stats?.today_cache_creation_tokens) + toNumber(stats?.today_cache_read_tokens)
  );
  return {
    total_requests: toNumber(stats?.total_requests),
    today_requests: toNumber(stats?.today_requests),
    total_tokens: totalTokens || 0,
    today_tokens: todayTokens || 0,
    total_cost: toNumber(stats?.total_actual_cost ?? stats?.total_cost),
    today_cost: toNumber(stats?.today_actual_cost ?? stats?.today_cost),
    by_platform: Array.isArray(stats?.by_platform) ? stats.by_platform : []
  };
}

function extractPeriodUsage(stats) {
  if (!stats || typeof stats !== 'object') {
    return { requests: 0, tokens: 0, cost: 0 };
  }
  const tokens = pickFirstNumber(
    stats?.tokens,
    stats?.total_tokens,
    toNumber(stats?.input_tokens) + toNumber(stats?.output_tokens) + toNumber(stats?.cache_creation_tokens) + toNumber(stats?.cache_read_tokens),
    toNumber(stats?.total_input_tokens) + toNumber(stats?.total_output_tokens) + toNumber(stats?.total_cache_creation_tokens) + toNumber(stats?.total_cache_read_tokens)
  );
  return {
    requests: toNumber(stats?.requests ?? stats?.total_requests),
    tokens: tokens || 0,
    cost: toNumber(stats?.actual_cost ?? stats?.cost ?? stats?.total_actual_cost ?? stats?.total_cost)
  };
}

function normalizePaymentInfo(checkoutInfo, configInfo = null, plansInfo = null) {
  const checkout = unwrapSub2API(checkoutInfo);
  const config = unwrapSub2API(configInfo) || {};
  const source = checkout && typeof checkout === 'object' ? checkout : config;
  const planSource = plansInfo ?? checkout?.plans ?? [];
  const plans = Array.isArray(unwrapSub2API(planSource))
    ? unwrapSub2API(planSource)
    : Array.isArray(unwrapSub2API(planSource)?.items)
      ? unwrapSub2API(planSource).items
      : [];
  const multiplier = pickFirstNumber(source?.balance_recharge_multiplier, config?.balance_recharge_multiplier);
  const feeRate = pickFirstNumber(source?.recharge_fee_rate, config?.recharge_fee_rate);
  const balanceDisabled = Boolean(source?.balance_disabled || source?.balance_recharge_disabled);
  return {
    enabled: Boolean(source?.enabled ?? (checkout !== null && checkout !== undefined)),
    balance_recharge_disabled: balanceDisabled,
    balance_recharge_multiplier: multiplier,
    recharge_fee_rate: feeRate,
    payment_plan_count: plans.length,
    plans: plans.map((plan) => ({
      id: plan?.id ?? null,
      name: plan?.name || plan?.product_name || '',
      price: pickFirstNumber(plan?.price),
      original_price: pickFirstNumber(plan?.original_price),
      group_name: plan?.group_name || '',
      group_platform: plan?.group_platform || '',
      rate_multiplier: pickFirstNumber(plan?.rate_multiplier),
      raw: plan
    }))
  };
}

function flattenRateEntry(group, path = []) {
  const out = [];
  if (!group || typeof group !== 'object') return out;
  const groupId = String(group.id ?? group.group_id ?? group.key ?? path.join('.') ?? '');
  const groupName = String(group.name ?? group.group_name ?? group.label ?? group.title ?? groupId);
  const directRate = pickFirstNumber(group.rate, group.rate_multiplier, group.multiplier, group.cost_multiplier);
  if (directRate !== null) {
    out.push({
      group_id: groupId,
      group_name: groupName,
      scope: String(group.platform ?? group.scope ?? ''),
      model: String(group.model ?? ''),
      rate: directRate,
      raw: group
    });
  }
  for (const key of ['rates', 'rate_multipliers', 'model_rates', 'models', 'platform_rates']) {
    const nested = group[key];
    if (Array.isArray(nested)) {
      for (const item of nested) {
        out.push(...flattenRateEntry({ ...item, group_id: groupId, group_name: groupName }, path.concat(key)));
      }
    } else if (nested && typeof nested === 'object') {
      for (const [model, value] of Object.entries(nested)) {
        const rate = typeof value === 'object' ? pickFirstNumber(value.rate, value.multiplier, value.rate_multiplier) : pickFirstNumber(value);
        if (rate !== null) {
          out.push({
            group_id: groupId,
            group_name: groupName,
            scope: key,
            model,
            rate,
            raw: value
          });
        }
      }
    }
  }
  return out;
}

function normalizeRates(ratesPayload) {
  const data = unwrapSub2API(ratesPayload);
  if (Array.isArray(data)) {
    return data.flatMap((item, index) => flattenRateEntry(item, [String(index)]));
  }
  if (data && typeof data === 'object') {
    const candidates = data.groups || data.items || data.rates || data.data;
    if (Array.isArray(candidates)) {
      return candidates.flatMap((item, index) => flattenRateEntry(item, [String(index)]));
    }
    const out = [];
    for (const [groupName, value] of Object.entries(data)) {
      if (typeof value === 'number' || typeof value === 'string') {
        const rate = pickFirstNumber(value);
        if (rate !== null) {
          out.push({ group_id: groupName, group_name: groupName, scope: '', model: '', rate, raw: value });
        }
      } else if (value && typeof value === 'object') {
        out.push(...flattenRateEntry({ ...value, group_id: value.id ?? groupName, group_name: value.name ?? groupName }, [groupName]));
      }
    }
    return out;
  }
  return [];
}

function matchesAnyAlias(rate, aliases = ['codex']) {
  const haystack = `${rate.group_name} ${rate.scope} ${rate.model}`.toLowerCase();
  return aliases
    .map((alias) => String(alias || '').trim().toLowerCase())
    .filter(Boolean)
    .some((alias) => haystack.includes(alias));
}

async function fetchSub2APIState({ baseUrl, email, password, token, codexAliases }) {
  let activeToken = token;
  let login = null;
  if (!activeToken) {
    login = await loginWithPassword(baseUrl, email, password);
    activeToken = login.token;
  }
  const apiPrefix = login?.prefix || '/api/v1';

  const results = {};
  const errors = {};

  async function optional(name, paths) {
    const pathList = Array.isArray(paths) ? paths : [paths];
    const attempts = [];
    for (const path of pathList) {
      try {
        results[name] = await requestJson(baseUrl, path, { token: activeToken, prefix: apiPrefix });
        return;
      } catch (err) {
        attempts.push({
          path,
          message: err.message,
          status: err.status || null
        });
      }
    }
    errors[name] = attempts;
    results[name] = null;
  }

  await optional('profile', ['/user/profile', '/profile', '/admin/user/profile']);
  await optional('dashboardStats', ['/usage/dashboard/stats', '/admin/usage/dashboard/stats']);
  await optional('todayStats', ['/usage/stats?period=today', '/admin/usage/stats?period=today']);
  await optional('weekStats', ['/usage/stats?period=week', '/admin/usage/stats?period=week']);
  await optional('monthStats', ['/usage/stats?period=month', '/admin/usage/stats?period=month']);
  await optional('groups', ['/groups/available', '/admin/groups', '/groups']);
  await optional('rates', ['/groups/rates', '/admin/groups/rates', '/rates']);
  await optional('keys', ['/keys', '/admin/keys']);
  await optional('channels', ['/channels/available', '/admin/channels', '/channels']);
  await optional('paymentCheckout', ['/payment/checkout-info']);
  if (!results.paymentCheckout) {
    await optional('paymentConfig', ['/payment/config']);
    await optional('paymentPlans', ['/payment/plans']);
  }

  const profile = results.profile || {};
  const usage = extractUsage(results.dashboardStats || results.todayStats || {});
  const weekUsage = extractPeriodUsage(results.weekStats);
  const monthUsage = extractPeriodUsage(results.monthStats);
  const keyItems = Array.isArray(results.keys?.items) ? results.keys.items : Array.isArray(results.keys) ? results.keys : [];
  const channelItems = Array.isArray(results.channels?.items) ? results.channels.items : Array.isArray(results.channels) ? results.channels : [];
  let rates = normalizeRates(results.rates);
  if (rates.length === 0) {
    rates = normalizeRates(results.groups);
  }
  if (rates.length === 0 && keyItems.length > 0) {
    rates = keyItems.flatMap((key) => key.group ? flattenRateEntry(key.group) : []);
  }

  const codexRates = rates.filter((item) => matchesAnyAlias(item, codexAliases));
  const allRateValues = rates.map((item) => item.rate).filter(Number.isFinite);
  const codexRate = codexRates.length ? Math.min(...codexRates.map((item) => item.rate)) : null;
  const payment = normalizePaymentInfo(results.paymentCheckout, results.paymentConfig, results.paymentPlans);

  return {
    token: activeToken,
    login,
    profile,
    usage,
    rates,
    keys: keyItems,
    channels: results.channels,
    groups: results.groups,
    payment,
    errors,
    snapshot: {
      balance: extractBalance(profile),
      balance_currency: profile?.currency || profile?.balance_currency || 'unknown',
      username: profile?.username || profile?.name || '',
      email: profile?.email || '',
      role: profile?.role || '',
      ...usage,
      week_requests: weekUsage.requests,
      week_tokens: weekUsage.tokens,
      week_cost: weekUsage.cost,
      month_requests: monthUsage.requests,
      month_tokens: monthUsage.tokens,
      month_cost: monthUsage.cost,
      codex_rate: codexRate,
      min_rate: allRateValues.length ? Math.min(...allRateValues) : null,
      max_rate: allRateValues.length ? Math.max(...allRateValues) : null,
      payment_enabled: payment.enabled ? 1 : 0,
      balance_recharge_disabled: payment.balance_recharge_disabled ? 1 : 0,
      balance_recharge_multiplier: payment.balance_recharge_multiplier,
      recharge_fee_rate: payment.recharge_fee_rate,
      payment_plan_count: payment.payment_plan_count,
      group_count: rates.length,
      key_count: keyItems.length,
      channel_count: channelItems.length
    },
    raw: results
  };
}

module.exports = {
  UpstreamHTTPError,
  fetchSub2APIState,
  normalizeRates,
  loginWithPassword,
  requestJson
};
