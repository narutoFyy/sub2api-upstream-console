const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const { z } = require('zod');
const config = require('./config');
const repo = require('./repository');
const { seedFromEnv } = require('./seed');
const { syncSite, syncAllSites, syncDueSites } = require('./syncService');
const { fetchSub2APIState } = require('./upstreamClient');

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
  return safeRow;
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
  const sites = repo.listSites();
  const changes = repo.listRateChanges(20);
  const totals = sites.reduce((acc, site) => {
    acc.today_tokens += Number(site.today_tokens || 0);
    acc.today_cost += Number(site.today_cost || 0);
    if (site.status === 'active') acc.active += 1;
    if (site.status === 'sync_failed' || site.status === 'login_failed') acc.failed += 1;
    if (Number(site.balance) > 0 && Number(site.balance) < Number(site.low_balance_threshold || 10)) acc.low_balance += 1;
    if (site.last_sync_at) acc.synced += 1;
    return acc;
  }, { upstreams: sites.length, active: 0, failed: 0, low_balance: 0, synced: 0, today_tokens: 0, today_cost: 0 });
  res.json({ totals, sites, changes });
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
  res.json({
    site,
    credentials: safeCredentials(repo.getMaskedCredentials(id)),
    snapshot: withoutRawPayload(repo.getSnapshot(id)),
    rates: repo.listRates(id, 300).map(withoutRawPayload),
    logs: repo.listSyncLogs(id, 100),
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
    const payload = siteSchema.partial().parse(sanitizeSitePayload(req.body, { partial: true }));
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
