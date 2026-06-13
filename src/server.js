const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { z } = require('zod');
const config = require('./config');
const repo = require('./repository');
const { seedFromEnv } = require('./seed');
const { syncSite, syncAllSites, syncDueSites } = require('./syncService');
const { createPaymentOrder, fetchSub2APIState, getPaymentOrder } = require('./upstreamClient');
const {
  listSub2APIKeys,
  listSub2APIGroups,
  createSub2APIKey,
  updateSub2APIKey,
  deleteSub2APIKey
} = require('./upstreamKeys');

const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(config.rootDir, 'public')));

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => {
    const index = part.indexOf('=');
    if (index === -1) return null;
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(Boolean));
}

function signSession(value) {
  return crypto.createHmac('sha256', config.sessionSecret).update(value).digest('hex');
}

function makeSessionCookie() {
  const value = `admin.${Date.now()}`;
  return `${value}.${signSession(value)}`;
}

function isValidSession(cookieValue) {
  if (!config.adminPassword) return true;
  if (!cookieValue || typeof cookieValue !== 'string') return false;
  const parts = cookieValue.split('.');
  if (parts.length < 3) return false;
  const signature = parts.pop();
  const value = parts.join('.');
  const expected = signSession(value);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireAuth(req, res, next) {
  if (!config.adminPassword) return next();
  const cookies = parseCookies(req.headers.cookie || '');
  if (isValidSession(cookies[config.sessionCookieName])) return next();
  return res.status(401).json({ error: '请先登录控制台' });
}

function maskEmail(email) {
  if (!email || typeof email !== 'string') return email;
  const [name, domain] = email.split('@');
  if (!domain) return email;
  return `${name.slice(0, 2)}${'*'.repeat(Math.max(3, name.length - 2))}@${domain}`;
}

function withoutRawPayload(row) {
  if (!row) return row;
  const { raw_payload, raw, ...safeRow } = row;
  if (typeof safeRow.payment_methods === 'string') {
    try {
      safeRow.payment_methods = JSON.parse(safeRow.payment_methods || '[]');
    } catch {
      safeRow.payment_methods = [];
    }
  }
  if (typeof safeRow.subscription_summary === 'string') {
    try {
      safeRow.subscription_summary = JSON.parse(safeRow.subscription_summary || '{}');
    } catch {
      safeRow.subscription_summary = {};
    }
  }
  if (typeof safeRow.pricing_summary === 'string') {
    try {
      safeRow.pricing_summary = JSON.parse(safeRow.pricing_summary || '{}');
    } catch {
      safeRow.pricing_summary = {};
    }
  }
  for (const field of ['enable_groups', 'supported_endpoint_types']) {
    if (typeof safeRow[field] === 'string') {
      try {
        safeRow[field] = JSON.parse(safeRow[field] || '[]');
      } catch {
        safeRow[field] = [];
      }
    }
  }
  return safeRow;
}

function availablePaymentMethods(snapshot) {
  if (!snapshot) return [];
  if (Array.isArray(snapshot.payment_methods)) return snapshot.payment_methods;
  if (typeof snapshot.payment_methods === 'string') {
    try {
      return JSON.parse(snapshot.payment_methods || '[]');
    } catch {
      return [];
    }
  }
  return [];
}

function safeCredentials(credentials) {
  return { ...credentials, email: maskEmail(credentials.email) };
}

function parseList(value, fallback = []) {
  if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
  if (typeof value === 'string') return value.split(',').map((item) => item.trim()).filter(Boolean);
  return fallback;
}

function sanitizeSitePayload(payload, { partial = false } = {}) {
  const next = { ...payload };
  if ('tags' in next || !partial) {
    next.tags = parseList(next.tags);
  }
  if ('codex_aliases' in next || !partial) {
    next.codex_aliases = parseList(next.codex_aliases, ['codex']);
  }
  if ('low_balance_threshold' in next || !partial) {
    next.low_balance_threshold = Number(next.low_balance_threshold ?? 10);
  }
  if ('rate_change_threshold_percent' in next || !partial) {
    next.rate_change_threshold_percent = Number(next.rate_change_threshold_percent ?? 20);
  }
  if ('sync_interval_seconds' in next || !partial) {
    next.sync_interval_seconds = Number(next.sync_interval_seconds ?? 180);
  }
  return {
    ...next
  };
}

const siteSchema = z.object({
  name: z.string().min(1),
  base_url: z.string().url(),
  upstream_type: z.enum(['auto', 'sub2api', 'new-api']).optional().default('auto'),
  auth_mode: z.enum(['password', 'token', 'api_key', 'admin']).default('password'),
  email: z.string().optional().default(''),
  password: z.string().optional().default(''),
  token: z.string().optional().default(''),
  tags: z.array(z.string()).optional().default([]),
  codex_aliases: z.array(z.string()).optional().default(['codex']),
  notes: z.string().optional().default(''),
  low_balance_threshold: z.number().min(0).max(100000000).optional().default(10),
  rate_change_threshold_percent: z.number().min(0).max(100000).optional().default(20),
  sync_interval_seconds: z.number().int().min(30).max(86400).optional().default(180)
});

const siteUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  base_url: z.string().url().optional(),
  upstream_type: z.enum(['auto', 'sub2api', 'new-api']).optional(),
  auth_mode: z.enum(['password', 'token', 'api_key', 'admin']).optional(),
  email: z.string().optional(),
  password: z.string().optional(),
  token: z.string().optional(),
  tags: z.array(z.string()).optional(),
  codex_aliases: z.array(z.string()).optional(),
  notes: z.string().optional(),
  low_balance_threshold: z.number().min(0).max(100000000).optional(),
  rate_change_threshold_percent: z.number().min(0).max(100000).optional(),
  sync_interval_seconds: z.number().int().min(30).max(86400).optional()
});

const rechargeOrderSchema = z.object({
  amount: z.number().positive().max(1000000),
  payment_type: z.string().min(1).default('alipay'),
  order_type: z.enum(['balance', 'subscription']).default('balance'),
  plan_id: z.number().int().positive().optional(),
  return_url: z.string().url().optional(),
  is_mobile: z.boolean().optional().default(false),
  payment_source: z.string().min(1).optional().default('hosted_redirect')
});

const createUpstreamKeySchema = z.object({
  name: z.string().min(1).max(100),
  group_id: z.number().int().positive(),
  custom_key: z.string().min(16).max(200).optional(),
  quota: z.number().min(0).max(1000000).optional(),
  expires_in_days: z.number().int().min(1).max(3650).optional()
});

const updateUpstreamKeySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  group_id: z.number().int().positive().optional(),
  status: z.enum(['active', 'inactive']).optional()
});

function getSiteCredentials(siteId) {
  const site = repo.getSite(siteId);
  if (!site) return null;
  return { site, creds: repo.getCredentials(siteId) || {} };
}

function sanitizeUpstreamKey(item) {
  if (!item) return item;
  const { key_full, ...safe } = item;
  return safe;
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get('/api/session', (req, res) => {
  const cookies = parseCookies(req.headers.cookie || '');
  const authenticated = isValidSession(cookies[config.sessionCookieName]);
  res.json({ auth_enabled: Boolean(config.adminPassword), authenticated });
});

app.post('/api/login', (req, res) => {
  if (!config.adminPassword) {
    return res.json({ ok: true, auth_enabled: false });
  }
  if (req.body?.password !== config.adminPassword) {
    return res.status(401).json({ error: '控制台密码错误' });
  }
  res.setHeader('Set-Cookie', `${config.sessionCookieName}=${encodeURIComponent(makeSessionCookie())}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
  return res.json({ ok: true, auth_enabled: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', `${config.sessionCookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.use('/api', requireAuth);

app.get('/api/dashboard', (req, res) => {
  const allUnacknowledgedChanges = repo.listRateChanges(1000).filter((item) => !item.acknowledged_at);
  const changedSiteIds = new Set(allUnacknowledgedChanges.map((item) => Number(item.upstream_site_id)));
  const sites = repo.listSites().map((site) => ({
    ...site,
    has_unacknowledged_rate_change: changedSiteIds.has(Number(site.id))
  }));
  const rechargeAlerts = sites
    .filter((site) => Number.isFinite(Number(site.balance)) && Number(site.balance) < Number(site.low_balance_threshold || 10))
    .map((site) => {
      const threshold = Number(site.low_balance_threshold || 10);
      const balance = Number(site.balance || 0);
      const methods = availablePaymentMethods(site).filter((item) => item?.type && item?.available !== false);
      return {
        id: site.id,
        name: site.name,
        base_url: site.base_url,
        balance,
        threshold,
        suggested_amount: Math.max(1, Number((threshold - balance).toFixed(2))),
        payment_supported: Boolean(Number(site.payment_enabled) && !Number(site.balance_recharge_disabled) && methods.length > 0),
        payment_methods: methods
      };
    });
  const changes = repo.listRateChanges(20);
  const unacknowledgedChanges = repo.countUnacknowledgedRateChanges();
  const totals = sites.reduce((acc, site) => {
    acc.today_tokens += Number(site.today_tokens || 0);
    acc.today_cost += Number(site.today_cost || 0);
    if (site.status === 'active') acc.active += 1;
    if (site.status === 'sync_failed' || site.status === 'login_failed') acc.failed += 1;
    if (Number.isFinite(Number(site.balance)) && Number(site.balance) < Number(site.low_balance_threshold || 10)) acc.low_balance += 1;
    if (site.last_sync_at) acc.synced += 1;
    return acc;
  }, { upstreams: sites.length, active: 0, failed: 0, low_balance: 0, synced: 0, today_tokens: 0, today_cost: 0 });
  res.json({ totals: { ...totals, unacknowledged_changes: unacknowledgedChanges }, sites, changes, recharge_alerts: rechargeAlerts });
});

app.get('/api/export', (req, res) => {
  res.json({
    exported_at: new Date().toISOString(),
    include_secrets: false,
    sites: repo.exportSites({ includeSecrets: false })
  });
});

app.post('/api/import', (req, res, next) => {
  try {
    const items = Array.isArray(req.body?.sites) ? req.body.sites : [];
    const results = [];
    for (const item of items) {
      const credentials = item.credentials || {};
      const payload = siteSchema.parse(sanitizeSitePayload({
        ...item,
        email: credentials.email || item.email || '',
        password: credentials.password || item.password || '',
        token: credentials.token || item.token || ''
      }));
      const existing = repo.listSites().find((site) => site.base_url === payload.base_url);
      const site = existing ? repo.updateSite(existing.id, payload) : repo.createSite(payload);
      results.push({ id: site.id, name: site.name, base_url: site.base_url, action: existing ? 'updated' : 'created' });
    }
    res.json({ imported: results.length, results });
  } catch (err) {
    next(err);
  }
});

app.get('/api/backup/database', (req, res) => {
  res.download(config.databasePath, `sub2api-upstream-console-${Date.now()}.sqlite`);
});

app.get('/api/upstreams', (req, res) => {
  res.json({ items: repo.listSites() });
});

app.post('/api/upstreams', (req, res, next) => {
  try {
    const payload = siteSchema.parse(sanitizeSitePayload(req.body));
    res.status(201).json(repo.createSite(payload));
  } catch (err) {
    next(err);
  }
});

app.post('/api/upstreams/test', async (req, res, next) => {
  try {
    const payload = siteSchema.partial({ name: true }).parse(sanitizeSitePayload({ name: 'Test', ...req.body }));
    const result = await fetchSub2APIState({
      baseUrl: payload.base_url,
      upstreamType: payload.upstream_type,
      email: payload.email,
      password: payload.password,
      token: payload.token,
      codexAliases: payload.codex_aliases
    });
    res.json({
      ok: true,
      snapshot: result.snapshot,
      rates_count: result.rates.length,
      keys_count: result.keys.length,
      model_pricing_count: result.model_pricing?.length || 0,
      warnings: result.errors
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/upstreams/:id', (req, res) => {
  const id = Number(req.params.id);
  const site = repo.getSite(id);
  if (!site) return res.status(404).json({ error: 'Not found' });
  const snapshot = withoutRawPayload(repo.getSnapshot(id));
  if (snapshot) {
    snapshot.pricing_summary = repo.getDetailPricingSummary(id);
  }
  res.json({
    site,
    credentials: safeCredentials(repo.getMaskedCredentials(id)),
    snapshot,
    rates: repo.listRates(id, 300).map(withoutRawPayload),
    model_pricing: repo.listModelPricing(id, 300).map(withoutRawPayload),
    logs: repo.listSyncLogs(id, 100),
    recharge_orders: repo.listRechargeOrders(id, 20).map(withoutRawPayload),
    history: repo.listSnapshotHistory(id, 120).map(withoutRawPayload),
    capabilities: repo.capabilityMatrix(id)
  });
});

app.get('/api/upstreams/:id/trends', (req, res) => {
  const id = Number(req.params.id);
  if (!repo.getSite(id)) return res.status(404).json({ error: 'Not found' });
  res.json({ items: repo.listSnapshotHistory(id, 240).reverse().map(withoutRawPayload) });
});

app.put('/api/upstreams/:id', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const payload = siteUpdateSchema.parse(sanitizeSitePayload(req.body, { partial: true }));
    for (const field of ['email', 'password', 'token']) {
      if (payload[field] === '') delete payload[field];
    }
    const site = repo.updateSite(id, payload);
    if (!site) return res.status(404).json({ error: 'Not found' });
    res.json(site);
  } catch (err) {
    next(err);
  }
});

app.delete('/api/upstreams/:id', (req, res) => {
  res.json({ deleted: repo.deleteSite(Number(req.params.id)) });
});

app.post('/api/upstreams/:id/status', (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const status = z.enum(['active', 'disabled']).parse(req.body?.status);
    const site = repo.updateSite(id, { status });
    if (!site) return res.status(404).json({ error: 'Not found' });
    res.json(site);
  } catch (err) {
    next(err);
  }
});

app.post('/api/upstreams/:id/sync', async (req, res, next) => {
  try {
    const result = await syncSite(Number(req.params.id));
    res.json({
      ok: true,
      snapshot: withoutRawPayload(result.snapshot),
      errors: result.errors,
      rates: result.rates.slice(0, 50).map(withoutRawPayload)
    });
  } catch (err) {
    next(err);
  }
});

app.post('/api/sync-all', async (req, res, next) => {
  try {
    res.json({ results: await syncAllSites() });
  } catch (err) {
    next(err);
  }
});

app.get('/api/rate-changes', (req, res) => {
  res.json({ items: repo.listRateChanges(200) });
});

app.get('/api/model-pricing', (req, res) => {
  res.json({ items: repo.listAllModelPricing(2000).map(withoutRawPayload) });
});

app.get('/api/model-pricing/board', (req, res) => {
  res.json(repo.getModelPricingBoard());
});

app.get('/api/upstream-keys', async (req, res, next) => {
  try {
    const upstreamSiteId = req.query.upstream_site_id ? Number(req.query.upstream_site_id) : null;
    const platform = String(req.query.platform || '').trim();
    const status = String(req.query.status || '').trim();
    const search = String(req.query.search || '').trim();
    const live = req.query.live !== 'false';
    const sites = repo.listSites().filter((site) => site.status !== 'disabled');
    const targetSites = upstreamSiteId
      ? sites.filter((site) => Number(site.id) === upstreamSiteId)
      : sites;
    const items = [];
    const errors = [];
    if (live) {
      for (const site of targetSites) {
        try {
          const creds = repo.getCredentials(site.id) || {};
          const result = await listSub2APIKeys(site, creds, {
            page: 1,
            pageSize: 100,
            search,
            status,
            groupId: null
          });
          const filtered = platform
            ? result.items.filter((item) => String(item.platform || '').toLowerCase() === platform.toLowerCase())
            : result.items;
          items.push(...filtered.map(sanitizeUpstreamKey));
        } catch (err) {
          errors.push({ upstream_site_id: site.id, upstream_name: site.name, error: err.message });
        }
      }
    }
    if (!items.length) {
      const snapshots = repo.listAllKeySnapshots({
        upstreamSiteId,
        platform,
        status,
        search
      }, 500);
      items.push(...snapshots.map((row) => ({
        upstream_site_id: row.upstream_site_id,
        upstream_name: row.upstream_name,
        base_url: row.base_url,
        id: row.upstream_key_id,
        name: row.name,
        key_masked: row.key_masked,
        group_id: row.group_id ? Number(row.group_id) : null,
        group_name: row.group_name,
        platform: row.platform,
        status: row.status,
        quota: row.quota,
        quota_used: row.quota_used,
        expires_at: row.expires_at,
        last_used_at: row.last_used_at,
        captured_at: row.captured_at,
        source: 'snapshot'
      })));
    }
    res.json({ items, errors, live });
  } catch (err) {
    next(err);
  }
});

app.get('/api/upstreams/:id/keys', async (req, res, next) => {
  try {
    const ctx = getSiteCredentials(Number(req.params.id));
    if (!ctx) return res.status(404).json({ error: 'Not found' });
    const result = await listSub2APIKeys(ctx.site, ctx.creds, {
      page: Number(req.query.page || 1),
      pageSize: Number(req.query.page_size || 100),
      search: String(req.query.search || ''),
      status: String(req.query.status || ''),
      groupId: req.query.group_id ?? null
    });
    res.json({
      items: result.items.map(sanitizeUpstreamKey),
      total: result.total,
      page: result.page,
      page_size: result.page_size,
      pages: result.pages
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/upstreams/:id/key-groups', async (req, res, next) => {
  try {
    const ctx = getSiteCredentials(Number(req.params.id));
    if (!ctx) return res.status(404).json({ error: 'Not found' });
    const platform = String(req.query.platform || '').trim().toLowerCase();
    let groups = await listSub2APIGroups(ctx.site, ctx.creds);
    if (platform) {
      groups = groups.filter((group) => String(group.platform || '').toLowerCase() === platform);
    }
    res.json({ items: groups });
  } catch (err) {
    next(err);
  }
});

app.post('/api/upstreams/:id/keys', async (req, res, next) => {
  try {
    const ctx = getSiteCredentials(Number(req.params.id));
    if (!ctx) return res.status(404).json({ error: 'Not found' });
    const payload = createUpstreamKeySchema.parse(req.body || {});
    const created = await createSub2APIKey(ctx.site, ctx.creds, payload);
    repo.saveKeyCreateLog(ctx.site.id, created);
    syncSite(ctx.site.id).catch((err) => console.error('Post key-create sync failed:', err));
    res.status(201).json({
      key: created.key_full,
      item: sanitizeUpstreamKey(created),
      message: 'Key 已创建。完整密钥只会在本次响应中返回一次，请立即复制保存。'
    });
  } catch (err) {
    next(err);
  }
});

app.put('/api/upstreams/:id/keys/:keyId', async (req, res, next) => {
  try {
    const ctx = getSiteCredentials(Number(req.params.id));
    if (!ctx) return res.status(404).json({ error: 'Not found' });
    const payload = updateUpstreamKeySchema.parse(req.body || {});
    const updated = await updateSub2APIKey(ctx.site, ctx.creds, req.params.keyId, payload);
    syncSite(ctx.site.id).catch((err) => console.error('Post key-update sync failed:', err));
    res.json({ item: sanitizeUpstreamKey(updated) });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/upstreams/:id/keys/:keyId', async (req, res, next) => {
  try {
    const ctx = getSiteCredentials(Number(req.params.id));
    if (!ctx) return res.status(404).json({ error: 'Not found' });
    const result = await deleteSub2APIKey(ctx.site, ctx.creds, req.params.keyId);
    syncSite(ctx.site.id).catch((err) => console.error('Post key-delete sync failed:', err));
    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.post('/api/upstreams/:id/recharge-orders', async (req, res, next) => {
  try {
    const siteId = Number(req.params.id);
    const site = repo.getSite(siteId);
    if (!site) return res.status(404).json({ error: 'Not found' });
    const snapshot = repo.getSnapshot(siteId);
    const methods = availablePaymentMethods(snapshot).filter((item) => item?.type && item?.available !== false);
    const paymentSupported = Boolean(snapshot && Number(snapshot.payment_enabled) && !Number(snapshot.balance_recharge_disabled) && methods.length > 0);
    if (!paymentSupported) {
      return res.status(422).json({ error: '该上游不支持在线充值或已关闭余额充值' });
    }
    const payload = rechargeOrderSchema.parse(req.body || {});
    if (!methods.some((item) => item.type === payload.payment_type)) {
      return res.status(422).json({ error: `该上游不支持 ${payload.payment_type} 充值` });
    }
    const creds = repo.getCredentials(siteId) || {};
    const order = await createPaymentOrder({
      baseUrl: site.base_url,
      email: creds.email,
      password: creds.password,
      token: creds.token,
      amount: payload.amount,
      paymentType: payload.payment_type,
      orderType: payload.order_type,
      planId: payload.plan_id,
      returnUrl: payload.return_url,
      isMobile: payload.is_mobile,
      paymentSource: payload.payment_source
    });
    const saved = repo.saveRechargeOrder(siteId, order);
    res.status(201).json({ order: withoutRawPayload(saved) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/recharge-orders/:id/refresh', async (req, res, next) => {
  try {
    const localOrder = repo.getRechargeOrder(Number(req.params.id));
    if (!localOrder) return res.status(404).json({ error: 'Not found' });
    if (!localOrder.upstream_order_id) {
      return res.status(422).json({ error: '该订单缺少上游订单 ID，无法回查' });
    }
    const site = repo.getSite(localOrder.upstream_site_id);
    const creds = repo.getCredentials(localOrder.upstream_site_id) || {};
    const order = await getPaymentOrder({
      baseUrl: site.base_url,
      email: creds.email,
      password: creds.password,
      token: creds.token,
      orderId: localOrder.upstream_order_id
    });
    const saved = repo.updateRechargeOrder(localOrder.id, order);
    if (['COMPLETED', 'PAID', 'RECHARGING'].includes(String(saved.status).toUpperCase())) {
      syncSite(localOrder.upstream_site_id).catch((err) => console.error('Post-recharge sync failed:', err));
    }
    res.json({ order: withoutRawPayload(saved) });
  } catch (err) {
    next(err);
  }
});

app.post('/api/rate-changes/:id/ack', (req, res) => {
  res.json({ acknowledged: repo.acknowledgeRateChange(Number(req.params.id)) });
});

app.get('/api/sync-logs', (req, res) => {
  res.json({ items: repo.listSyncLogs(null, 200) });
});

if (config.syncSchedulerEnabled) {
  setInterval(() => {
    syncDueSites().catch((err) => {
      console.error('Scheduled sync failed:', err);
    });
  }, Math.max(10, config.syncSchedulerTickSeconds) * 1000).unref();
}

app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 400;
  res.status(status >= 100 && status < 600 ? status : 500).json({
    error: err.message || 'Request failed',
    details: err.issues || undefined
  });
});

seedFromEnv();

app.listen(config.port, () => {
  console.log(`Sub2API Upstream Console running at http://localhost:${config.port}`);
});
