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

function upstreamErrorMessage(path, status, payload) {
  const body = payload && typeof payload === 'object' ? payload : {};
  const message = body.message || body.error || body.reason || body.raw || '';
  const code = body.code || body.error_code || body.reason || '';
  const metadata = body.metadata && typeof body.metadata === 'object'
    ? Object.entries(body.metadata).map(([key, value]) => `${key}=${value}`).join(', ')
    : '';
  const detail = [code, message, metadata].filter(Boolean).join(' | ');
  return detail
    ? `Upstream ${path} returned ${status}: ${detail}`
    : `Upstream ${path} returned ${status}`;
}
function extractCookie(headers) {
  if (!headers || typeof headers.get !== 'function') return '';
  const setCookie = headers.get('set-cookie') || '';
  if (!setCookie) return '';
  return setCookie
    .split(/,(?=\s*[^;,=\s]+=[^;,]+)/)
    .map((cookie) => cookie.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
}

function defaultPaymentReturnUrl(baseUrl) {
  return `${baseUrl.replace(/\/$/, '')}/payment/result`;
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
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    ...(options.cookie ? { cookie: options.cookie } : {}),
    ...(options.headers || {})
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
    throw new UpstreamHTTPError(upstreamErrorMessage(path, res.status, payload), res.status, payload);
  }
  if (payload && typeof payload === 'object' && payload.code && payload.code !== 0) {
    throw new UpstreamHTTPError(upstreamErrorMessage(path, res.status, payload), res.status, payload);
  }
  if (payload && typeof payload === 'object' && payload.success === false) {
    throw new UpstreamHTTPError(upstreamErrorMessage(path, res.status, payload), res.status, payload);
  }
  const data = unwrapSub2API(payload);
  if (options.withMeta) {
    return { data, payload, headers: res.headers, cookie: extractCookie(res.headers), status: res.status };
  }
  return data;
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

async function loginWithNewAPI(baseUrl, email, password) {
  const login = await requestJson(baseUrl, '/user/login', {
    method: 'POST',
    body: { username: email, password },
    prefix: '/api',
    withMeta: true
  });
  const user = login.data || {};
  if (!user.id) {
    throw new Error('New API login succeeded but no user id was returned');
  }
  if (!login.cookie) {
    throw new Error('New API login succeeded but no session cookie was returned');
  }
  return {
    user,
    cookie: login.cookie,
    headers: { 'New-Api-User': String(user.id) },
    prefix: '/api',
    login_path: '/user/login'
  };
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
  const sourceMethods = source?.methods && typeof source.methods === 'object'
    ? Object.entries(source.methods)
    : [];
  const configTypes = Array.isArray(config?.enabled_payment_types) ? config.enabled_payment_types : [];
  const methods = sourceMethods
    .filter(([type, info]) => type && (info?.available ?? true))
    .map(([type, info]) => ({
      type,
      currency: info?.currency || '',
      single_min: pickFirstNumber(info?.single_min),
      single_max: pickFirstNumber(info?.single_max),
      fee_rate: pickFirstNumber(info?.fee_rate),
      available: Boolean(info?.available ?? true)
    }));
  if (methods.length === 0) {
    for (const type of configTypes) {
      methods.push({ type: String(type), currency: '', single_min: null, single_max: null, fee_rate: null, available: true });
    }
  }
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
    methods,
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

function normalizeAliases(aliases = ['codex']) {
  if (Array.isArray(aliases)) return aliases;
  if (typeof aliases === 'string') {
    return aliases.split(',').map((alias) => alias.trim()).filter(Boolean);
  }
  return ['codex'];
}

function matchesAnyAlias(rate, aliases = ['codex']) {
  const haystack = `${rate.group_name} ${rate.scope} ${rate.model}`.toLowerCase();
  return normalizeAliases(aliases)
    .map((alias) => String(alias || '').trim().toLowerCase())
    .filter(Boolean)
    .some((alias) => haystack.includes(alias));
}

function normalizeNewAPIRates(groupsPayload, ratioConfigPayload = null) {
  const out = [];
  const groups = groupsPayload && typeof groupsPayload === 'object' ? groupsPayload : {};
  for (const [groupName, info] of Object.entries(groups)) {
    const rate = pickFirstNumber(info?.ratio);
    if (rate !== null) {
      out.push({
        group_id: groupName,
        group_name: groupName,
        scope: 'new-api-group',
        model: '',
        rate,
        raw: info
      });
    }
  }

  const ratioConfig = ratioConfigPayload && typeof ratioConfigPayload === 'object' ? ratioConfigPayload : {};
  const modelRatio = ratioConfig.model_ratio || ratioConfig.modelRatio || {};
  const groupRatio = ratioConfig.group_ratio || ratioConfig.groupRatio || {};
  if (Object.keys(groups).length === 0 && groupRatio && typeof groupRatio === 'object') {
    for (const [groupName, value] of Object.entries(groupRatio)) {
      const rate = pickFirstNumber(value);
      if (rate !== null) {
        out.push({ group_id: groupName, group_name: groupName, scope: 'new-api-group', model: '', rate, raw: value });
      }
    }
  }
  if (modelRatio && typeof modelRatio === 'object') {
    for (const [model, value] of Object.entries(modelRatio)) {
      const rate = pickFirstNumber(value);
      if (rate !== null) {
        out.push({ group_id: model, group_name: model, scope: 'new-api-model', model, rate, raw: value });
      }
    }
  }
  return out;
}

function normalizeNewAPITokens(tokensPayload) {
  if (Array.isArray(tokensPayload)) return tokensPayload;
  if (Array.isArray(tokensPayload?.items)) return tokensPayload.items;
  if (Array.isArray(tokensPayload?.data)) return tokensPayload.data;
  return [];
}

function newAPIQuotaUnit(statusPayload) {
  const unit = pickFirstNumber(statusPayload?.quota_per_unit, statusPayload?.quotaPerUnit);
  return unit && unit > 0 ? unit : 500000;
}

function convertNewAPIQuota(value, unit) {
  const n = pickFirstNumber(value);
  return n === null ? null : n / unit;
}

function periodTimestampRange(days) {
  const now = new Date();
  const end = Math.floor(now.getTime() / 1000);
  const startDate = new Date(now);
  startDate.setHours(0, 0, 0, 0);
  if (days > 1) {
    startDate.setDate(startDate.getDate() - (days - 1));
  }
  return {
    start: Math.floor(startDate.getTime() / 1000),
    end
  };
}

function buildNewAPIStatPath(days) {
  const range = periodTimestampRange(days);
  return `/log/self/stat?start_timestamp=${range.start}&end_timestamp=${range.end}`;
}

function normalizeNewAPIUsage(self, totalStat, todayStat, weekStat, monthStat, quotaUnit) {
  return {
    total_requests: toNumber(self?.request_count),
    today_requests: 0,
    total_tokens: 0,
    today_tokens: 0,
    total_cost: convertNewAPIQuota(self?.used_quota, quotaUnit) || 0,
    today_cost: convertNewAPIQuota(todayStat?.quota, quotaUnit) || 0,
    week_cost: convertNewAPIQuota(weekStat?.quota, quotaUnit) || 0,
    month_cost: convertNewAPIQuota(monthStat?.quota, quotaUnit) || 0,
    stat_quota: totalStat?.quota ?? null,
    today_stat: todayStat || null,
    week_stat: weekStat || null,
    month_stat: monthStat || null,
    by_platform: []
  };
}

function arrayFromMaybe(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.data)) return value.data;
  if (value && Array.isArray(value.items)) return value.items;
  if (value && Array.isArray(value.records)) return value.records;
  if (value && Array.isArray(value.list)) return value.list;
  return [];
}

function uniqueSubscriptions(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const sub = item?.subscription || item || {};
    const key = sub.id !== undefined && sub.id !== null
      ? `id:${sub.id}`
      : JSON.stringify([sub.plan_id, sub.start_time, sub.end_time, sub.status]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function isActiveNewAPISubscription(item, nowSeconds) {
  const sub = item?.subscription || item || {};
  if (!sub || typeof sub !== 'object') return false;
  if (sub.status && sub.status !== 'active') return false;
  if (sub.end_time && Number(sub.end_time) > 0 && Number(sub.end_time) <= nowSeconds) return false;
  return true;
}

function normalizeNewAPISubscription(subscriptionPayload, plansPayload, quotaUnit) {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const activeItems = uniqueSubscriptions(arrayFromMaybe(subscriptionPayload?.subscriptions));
  const explicitAllItems = uniqueSubscriptions(arrayFromMaybe(subscriptionPayload?.all_subscriptions));
  const allItems = explicitAllItems.length ? explicitAllItems : activeItems;
  const normalizedActiveItems = activeItems.length
    ? activeItems
    : allItems.filter((item) => isActiveNewAPISubscription(item, nowSeconds));
  const plans = Array.isArray(plansPayload) ? plansPayload : [];
  const planMap = new Map();
  for (const item of plans) {
    const plan = item?.plan || item;
    if (plan?.id !== undefined) planMap.set(Number(plan.id), plan);
  }
  const subscriptions = normalizedActiveItems.map((item) => {
    const sub = item?.subscription || item || {};
    const plan = planMap.get(Number(sub.plan_id)) || {};
    const total = convertNewAPIQuota(sub.amount_total, quotaUnit);
    const used = convertNewAPIQuota(sub.amount_used, quotaUnit);
    const remaining = total === null || used === null ? null : Math.max(total - used, 0);
    const usagePercent = total && used !== null ? Math.min(Math.max((used / total) * 100, 0), 100) : null;
    const daysRemaining = sub.end_time ? Math.max(Math.ceil((Number(sub.end_time) - nowSeconds) / 86400), 0) : null;
    return {
      id: sub.id ?? null,
      plan_id: sub.plan_id ?? null,
      plan_title: plan.title || '',
      status: sub.status || '',
      source: sub.source || '',
      billing_preference: subscriptionPayload?.billing_preference || '',
      amount_total: total,
      amount_used: used,
      amount_remaining: remaining,
      usage_percent: usagePercent,
      start_time: sub.start_time || null,
      end_time: sub.end_time || null,
      days_remaining: daysRemaining,
      next_reset_time: sub.next_reset_time || null,
      raw: sub
    };
  });
  const primary = subscriptions[0] || null;
  return {
    enabled: subscriptions.length > 0 || allItems.length > 0,
    billing_preference: subscriptionPayload?.billing_preference || '',
    active_count: subscriptions.length,
    total_count: allItems.length,
    primary,
    subscriptions
  };
}

function normalizeEndpointTypes(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (typeof value === 'object') return Object.keys(value);
  return [String(value)].filter(Boolean);
}

function normalizeNewAPIPricing(pricingPayload, ratioConfigPayload = null, codexAliases = []) {
  const pricingItems = arrayFromMaybe(pricingPayload);
  const pricingOuter = pricingPayload?.payload || pricingPayload || {};
  const ratioConfig = ratioConfigPayload && typeof ratioConfigPayload === 'object' ? ratioConfigPayload : {};
  const vendors = Array.isArray(ratioConfig?.vendors) ? ratioConfig.vendors : Array.isArray(ratioConfig?.vendor) ? ratioConfig.vendor : [];
  const vendorMap = new Map();
  if (Array.isArray(pricingOuter?.vendors)) {
    for (const vendor of pricingOuter.vendors) vendorMap.set(Number(vendor.id), vendor.name || '');
  }
  for (const vendor of vendors) vendorMap.set(Number(vendor.id), vendor.name || '');

  const sourceItems = pricingItems.length
    ? pricingItems
    : Object.entries(ratioConfig.model_ratio || ratioConfig.modelRatio || {}).map(([model, ratio]) => ({
      model_name: model,
      model_ratio: ratio,
      completion_ratio: ratioConfig.completion_ratio?.[model] ?? ratioConfig.completionRatio?.[model] ?? null,
      cache_ratio: ratioConfig.cache_ratio?.[model] ?? ratioConfig.cacheRatio?.[model] ?? null,
      create_cache_ratio: ratioConfig.create_cache_ratio?.[model] ?? ratioConfig.createCacheRatio?.[model] ?? null,
      model_price: ratioConfig.model_price?.[model] ?? ratioConfig.modelPrice?.[model] ?? null,
      quota_type: ratioConfig.model_price?.[model] || ratioConfig.modelPrice?.[model] ? 1 : 0
    }));

  const items = sourceItems.map((item) => ({
    model_name: item.model_name || item.model || item.name || '',
    vendor: item.vendor || vendorMap.get(Number(item.vendor_id)) || '',
    vendor_id: item.vendor_id ?? null,
    tags: item.tags || '',
    quota_type: Number(item.quota_type || 0),
    model_ratio: pickFirstNumber(item.model_ratio, item.modelRatio),
    model_price: pickFirstNumber(item.model_price, item.modelPrice),
    completion_ratio: pickFirstNumber(item.completion_ratio, item.completionRatio),
    cache_ratio: pickFirstNumber(item.cache_ratio, item.cacheRatio),
    create_cache_ratio: pickFirstNumber(item.create_cache_ratio, item.createCacheRatio),
    image_ratio: pickFirstNumber(item.image_ratio, item.imageRatio),
    audio_ratio: pickFirstNumber(item.audio_ratio, item.audioRatio),
    audio_completion_ratio: pickFirstNumber(item.audio_completion_ratio, item.audioCompletionRatio),
    billing_mode: item.billing_mode || item.billingMode || '',
    billing_expr: item.billing_expr || item.billingExpr || '',
    enable_groups: arrayFromMaybe(item.enable_groups || item.enableGroups),
    supported_endpoint_types: normalizeEndpointTypes(item.supported_endpoint_types || item.supportedEndpointTypes),
    pricing_version: item.pricing_version || '',
    source: pricingItems.length ? 'pricing' : 'ratio_config',
    raw: item
  })).filter((item) => item.model_name);

  const ratioValues = items
    .map((item) => item.quota_type === 1 ? item.model_price : item.model_ratio)
    .filter(Number.isFinite);
  const aliases = normalizeAliases(codexAliases);
  const codexItems = items.filter((item) => {
    const text = `${item.model_name} ${item.vendor} ${item.tags}`.toLowerCase();
    return aliases.some((alias) => text.includes(String(alias).toLowerCase()));
  });
  const vendorNames = new Set(items.map((item) => item.vendor).filter(Boolean));
  const pricingVersion = pricingOuter?.pricing_version || pricingItems.find((item) => item.pricing_version)?.pricing_version || '';
  const groupRatio = pricingOuter?.group_ratio && typeof pricingOuter.group_ratio === 'object' ? pricingOuter.group_ratio : {};
  return {
    summary: {
      enabled: items.length > 0,
      source: pricingItems.length ? 'pricing' : (items.length ? 'ratio_config' : ''),
      model_count: items.length,
      vendor_count: vendorNames.size,
      min_model_rate: ratioValues.length ? Math.min(...ratioValues) : null,
      max_model_rate: ratioValues.length ? Math.max(...ratioValues) : null,
      codex_model_count: codexItems.length,
      codex_min_rate: codexItems.length
        ? Math.min(...codexItems.map((item) => item.quota_type === 1 ? item.model_price : item.model_ratio).filter(Number.isFinite))
        : null,
      pricing_version: pricingVersion,
      group_ratio: groupRatio
    },
    items
  };
}

async function fetchNewAPIState({ baseUrl, email, password, token, codexAliases }) {
  if (token && (!email || !password)) {
    throw new Error('New API user data requires account/password login because user endpoints require a session and New-Api-User header');
  }
  const login = await loginWithNewAPI(baseUrl, email, password);
  const auth = { cookie: login.cookie, headers: login.headers, prefix: login.prefix };
  const results = {};
  const errors = {};

  async function optional(name, path, options = {}) {
    try {
      results[name] = await requestJson(baseUrl, path, { ...auth, ...options });
    } catch (err) {
      errors[name] = [{ path, message: err.message, status: err.status || null }];
      results[name] = null;
    }
  }

  await optional('profile', '/user/self');
  await optional('groups', '/user/self/groups');
  await optional('models', '/models');
  await optional('keys', '/token/?p=0&page_size=100');
  await optional('totalStats', '/log/self/stat');
  await optional('todayStats', buildNewAPIStatPath(1));
  await optional('weekStats', buildNewAPIStatPath(7));
  await optional('monthStats', buildNewAPIStatPath(30));
  await optional('status', '/status');
  await optional('subscriptionSelf', '/subscription/self');
  await optional('subscriptionPlans', '/subscription/plans');
  await optional('pricing', '/pricing', { withMeta: true });
  await optional('ratioConfig', '/ratio_config', { cookie: '', headers: {} });

  const profile = results.profile || login.user || {};
  const quotaUnit = newAPIQuotaUnit(results.status || {});
  const rates = normalizeNewAPIRates(results.groups, results.ratioConfig);
  const codexRates = rates.filter((item) => matchesAnyAlias(item, codexAliases));
  const allRateValues = rates.map((item) => item.rate).filter(Number.isFinite);
  const codexRate = codexRates.length ? Math.min(...codexRates.map((item) => item.rate)) : null;
  const keyItems = normalizeNewAPITokens(results.keys);
  const usage = normalizeNewAPIUsage(profile, results.totalStats, results.todayStats, results.weekStats, results.monthStats, quotaUnit);
  const subscription = normalizeNewAPISubscription(results.subscriptionSelf, results.subscriptionPlans, quotaUnit);
  const pricing = normalizeNewAPIPricing(results.pricing, results.ratioConfig, codexAliases);
  const payment = {
    enabled: false,
    balance_recharge_disabled: true,
    balance_recharge_multiplier: null,
    recharge_fee_rate: null,
    payment_plan_count: 0,
    methods: [],
    plans: []
  };

  return {
    token: token || null,
    login: {
      provider: 'new-api',
      prefix: login.prefix,
      login_path: login.login_path,
      user_id: login.user.id,
      raw: login.user
    },
    profile,
    usage,
    rates,
    keys: keyItems,
    channels: null,
    groups: results.groups,
    payment,
    subscription,
    pricing: pricing.summary,
    model_pricing: pricing.items,
    errors,
    snapshot: {
      balance: convertNewAPIQuota(profile?.quota, quotaUnit),
      balance_currency: results.status?.quota_display_type || results.status?.display_in_currency || 'quota',
      username: profile?.username || profile?.display_name || '',
      email: profile?.email || email || '',
      role: String(profile?.role ?? ''),
      total_requests: usage.total_requests,
      today_requests: usage.today_requests,
      total_tokens: usage.total_tokens,
      today_tokens: usage.today_tokens,
      total_cost: usage.total_cost,
      today_cost: usage.today_cost,
      week_requests: 0,
      week_tokens: 0,
      week_cost: usage.week_cost,
      month_requests: 0,
      month_tokens: 0,
      month_cost: usage.month_cost,
      codex_rate: codexRate,
      min_rate: allRateValues.length ? Math.min(...allRateValues) : null,
      max_rate: allRateValues.length ? Math.max(...allRateValues) : null,
      payment_enabled: 0,
      balance_recharge_disabled: 1,
      balance_recharge_multiplier: null,
      recharge_fee_rate: null,
      payment_plan_count: 0,
      payment_methods: '[]',
      subscription_summary: JSON.stringify(subscription),
      pricing_summary: JSON.stringify(pricing.summary),
      group_count: rates.length,
      key_count: keyItems.length,
      channel_count: 0
    },
    raw: results
  };
}

async function fetchSub2APICompatibleState({ baseUrl, email, password, token, codexAliases }) {
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
  const subscription = { enabled: false, billing_preference: '', active_count: 0, total_count: 0, primary: null, subscriptions: [] };
  const pricing = { summary: { enabled: false, source: '', model_count: 0, vendor_count: 0, min_model_rate: null, max_model_rate: null, codex_model_count: 0, codex_min_rate: null, pricing_version: '' }, items: [] };

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
    subscription,
    pricing: pricing.summary,
    model_pricing: pricing.items,
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
      payment_methods: JSON.stringify(payment.methods || []),
      subscription_summary: JSON.stringify(subscription),
      pricing_summary: JSON.stringify(pricing.summary),
      group_count: rates.length,
      key_count: keyItems.length,
      channel_count: channelItems.length
    },
    raw: results
  };
}

async function fetchSub2APIState(input) {
  const upstreamType = input.upstreamType || input.upstream_type || 'auto';
  if (upstreamType === 'sub2api') {
    return fetchSub2APICompatibleState(input);
  }
  if (upstreamType === 'new-api' || upstreamType === 'newapi') {
    return fetchNewAPIState(input);
  }
  try {
    return await fetchSub2APICompatibleState(input);
  } catch (sub2apiError) {
    try {
      return await fetchNewAPIState(input);
    } catch (newAPIError) {
      throw new Error(`Sync failed. Sub2API: ${sub2apiError.message}; New API: ${newAPIError.message}`);
    }
  }
}

async function getUpstreamToken({ baseUrl, email, password, token }) {
  if (token) {
    return { token, prefix: '/api/v1' };
  }
  const login = await loginWithPassword(baseUrl, email, password);
  return { token: login.token, prefix: login.prefix || '/api/v1' };
}

function normalizePaymentOrder(payload) {
  const data = unwrapSub2API(payload) || {};
  return {
    raw: data,
    order_id: data.order_id ?? data.id ?? null,
    out_trade_no: data.out_trade_no || data.trade_no || '',
    status: data.status || '',
    amount: data.amount ?? null,
    pay_amount: data.pay_amount ?? data.amount ?? null,
    fee_rate: data.fee_rate ?? null,
    payment_type: data.payment_type || '',
    payment_mode: data.payment_mode || '',
    result_type: data.result_type || '',
    pay_url: data.pay_url || data.payment_url || data.checkout_url || data.url || data.oauth?.authorize_url || '',
    qr_code: data.qr_code || data.qrcode || data.code_url || data.qr_url || '',
    expires_at: data.expires_at || '',
    resume_token: data.resume_token || '',
    oauth: data.oauth || null,
    jsapi: data.jsapi || data.jsapi_payload || null
  };
}

async function createPaymentOrder({ baseUrl, email, password, token, amount, paymentType, orderType = 'balance', planId, returnUrl, isMobile = false, paymentSource = 'hosted_redirect' }) {
  const auth = await getUpstreamToken({ baseUrl, email, password, token });
  const body = {
    amount,
    payment_type: paymentType,
    order_type: orderType,
    is_mobile: isMobile,
    payment_source: paymentSource,
    ...(planId ? { plan_id: planId } : {}),
    return_url: returnUrl || defaultPaymentReturnUrl(baseUrl)
  };
  const data = await requestJson(baseUrl, '/payment/orders', {
    method: 'POST',
    body,
    token: auth.token,
    prefix: auth.prefix
  });
  return normalizePaymentOrder(data);
}

async function getPaymentOrder({ baseUrl, email, password, token, orderId }) {
  const auth = await getUpstreamToken({ baseUrl, email, password, token });
  const data = await requestJson(baseUrl, `/payment/orders/${orderId}`, {
    token: auth.token,
    prefix: auth.prefix
  });
  return normalizePaymentOrder(data);
}

module.exports = {
  UpstreamHTTPError,
  fetchSub2APIState,
  normalizeRates,
  loginWithPassword,
  requestJson,
  createPaymentOrder,
  getPaymentOrder
};
