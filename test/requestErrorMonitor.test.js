require('./testEnv');

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const repo = require('../src/repository');
const errorRepo = require('../src/requestErrorRepository');
const {
  classifyRoute,
  extractErrorCodes,
  matchCandidates,
  runRequestErrorMonitor,
  createRequestErrorState,
  dispatchDueDeliveries,
  buildHermesPayload
} = require('../src/requestErrorMonitor');
const { signBody, receiptUrl, healthUrl, submitHermesEvent } = require('../src/hermesClient');
const {
  defaultRequestErrorSettings,
  updateRequestErrorSettings,
  requestErrorSettingsStatus,
  effectiveRequestErrorSettings
} = require('../src/requestErrorSettings');

const ADMIN_KEY = 'admin-key-should-never-leak-123456';
const HERMES_SECRET = 'hermes-secret-should-never-leak';

function settings(overrides = {}) {
  return {
    ...defaultRequestErrorSettings(),
    enabled: true,
    hermes_enabled: true,
    hermes_secret: HERMES_SECRET,
    hermes_prompt: 'HERMES_PROMPT: 请排查以下错误',
    hermes_codes: ['upstream_error', '5xx'],
    manual_codes: ['429', 'insufficient_quota'],
    max_retries: 2,
    retry_backoff_seconds: 5,
    ...overrides
  };
}

function createSite(name) {
  for (const existing of errorRepo.listMonitorSites()) errorRepo.saveMonitorSite(existing.own_site_id, { enabled: false });
  const site = repo.createOwnSite({ name, base_url: `https://${name}.example.com`, auth_mode: 'token' });
  errorRepo.saveMonitorSite(site.id, { enabled: true, admin_api_key: ADMIN_KEY, group_ids: ['7', '9'] });
  return site;
}

function fakeClient(items, details = {}, { failDetail = new Set(), failRelated = new Set() } = {}) {
  const calls = { list: [], detail: [] };
  return {
    calls,
    async listRequestErrors(options) {
      calls.list.push(options);
      return items.filter((item) => String(item.group_id) === String(options.groupId));
    },
    async getRequestErrorDetail({ errorId, apiKey }) {
      calls.detail.push({ errorId, apiKey });
      if (failDetail.has(String(errorId))) throw Object.assign(new Error('detail down'), { status: 502 });
      return details[errorId] || {};
    },
    async listRelatedUpstreamErrors({ errorId }) {
      if (failRelated.has(String(errorId))) throw new Error('related down');
      return [];
    }
  };
}

function notifiers() {
  const sent = { pushplus: [], email: [], hermes: [] };
  return {
    sent,
    pushPlusStatus: () => ({ configured: true }),
    emailStatus: () => ({ enabled: true }),
    sendPushPlus: async (message) => { sent.pushplus.push(message); },
    sendEmail: async (message) => { sent.email.push(message); },
    submitHermesEvent: async (payload) => { sent.hermes.push(payload); return { status: 'accepted' }; }
  };
}

test('routing gives manual_codes priority and supports status-class wildcards', () => {
  const config = settings();
  assert.deepEqual(classifyRoute(['upstream_error', '429'], config), { route: 'manual', matched: ['429'] });
  assert.deepEqual(classifyRoute(['502', 'upstream'], config), { route: 'hermes', matched: ['5xx'] });
  assert.deepEqual(classifyRoute(['400', 'request'], config), { route: 'none', matched: [] });
});

test('upstream-scoped globs only match upstream errors; * catches everything else', () => {
  const config = settings({ manual_codes: ['upstream:*insufficient*'], hermes_codes: ['*'] });
  const upstreamQuota = matchCandidates({
    status_code: 502, error_type: 'upstream_error', upstream_status_code: 403,
    upstream_error_message: 'Insufficient account balance',
    upstream_errors: [{ upstream_status_code: 403, upstream_response_body: '{"error":{"code":"insufficient_quota"}}' }]
  });
  assert.deepEqual(classifyRoute(upstreamQuota, config), { route: 'manual', matched: ['upstream:*insufficient*'] });
  const localQuota = matchCandidates({
    status_code: 402, error_type: 'insufficient_balance', message: 'Insufficient balance',
    error_body: '{"error":{"type":"insufficient_balance"}}', upstream_errors: [], related_upstream_errors: []
  });
  assert.deepEqual(classifyRoute(localQuota, config), { route: 'hermes', matched: ['*'] });
  assert.equal(classifyRoute(localQuota, settings({ manual_codes: ['*insufficient*'], hermes_codes: [] })).route, 'manual');
  assert.equal(classifyRoute(localQuota, settings({ manual_codes: ['insufficient'], hermes_codes: [] })).route, 'none');
});

test('HERMES_PROMPT {codes} shows real codes even when routed by a wildcard', () => {
  const payload = buildHermesPayload({
    delivery_id: 'sub2api-1-8', error_id: '8', own_site_id: 1, occurred_at: '2026-10-30T00:00:00Z',
    status_code: 503, error_type: 'upstream_error', upstream_status_code: 529, matched_codes: ['*'],
    error_codes: ['overloaded_error', '529', 'upstream_error'], upstream_errors: [], related_upstream_errors: [],
    detail_status: 'complete'
  }, { name: 'yf-mail', base_url: 'https://yf-mail.com' }, settings({ hermes_prompt: '报错代码是 {codes}，请检查' }));
  assert.ok(payload.prompt.startsWith('报错代码是 overloaded_error, 529, upstream_error，请检查'));
});

test('error codes include local classification, status codes, and structured upstream codes', () => {
  const codes = extractErrorCodes({
    phase: 'upstream',
    error_type: 'upstream_error',
    status_code: 502,
    upstream_status_code: 429,
    error_body: '{"error":{"type":"api_error"}}',
    upstream_errors: [{ upstream_status_code: 429, kind: 'http_error', upstream_response_body: '{"error":{"code":"insufficient_quota","type":"rate_limit"}}' }],
    related_upstream_errors: []
  });
  for (const code of ['upstream', 'upstream_error', '502', '429', 'http_error', 'insufficient_quota', 'rate_limit', 'api_error']) {
    assert.ok(codes.includes(code), `missing ${code}`);
  }
});

test('monitor stores, dedupes, routes, and notifies without leaking credentials', async () => {
  const site = createSite('route-flow');
  const items = [
    { id: 101, group_id: 7, group_name: '公共分组', created_at: '2026-10-30T10:00:00Z', status_code: 502, phase: 'upstream', type: 'upstream_error', message: 'bad gateway' },
    { id: 102, group_id: 9, group_name: '专属分组', created_at: '2026-10-30T10:01:00Z', status_code: 429, phase: 'upstream', type: 'upstream_error', message: 'rate limited' },
    { id: 103, group_id: 7, group_name: '公共分组', created_at: '2026-10-30T10:02:00Z', status_code: 400, phase: 'request', type: 'invalid_request', message: 'bad input' }
  ];
  const details = {
    101: {
      ...items[0],
      upstream_status_code: 503,
      upstream_error_message: 'service unavailable Bearer abcdefghijkl',
      upstream_errors: JSON.stringify([{ upstream_status_code: 503, kind: 'http_error', upstream_response_body: '{"error":{"message":"overloaded","api_key":"sk-leakedleaked123"}}' }])
    },
    102: { ...items[1], upstream_status_code: 429, upstream_error_message: 'quota' }
  };
  const client = fakeClient(items, details);
  const deps = { ...notifiers(), client, settings: settings(), now: Date.parse('2026-10-30T10:05:00Z') };
  const state = createRequestErrorState();

  await runRequestErrorMonitor(state, deps);
  assert.deepEqual(client.calls.list.map((call) => call.groupId), ['7', '9']);
  assert.ok(client.calls.list.every((call) => call.apiKey === ADMIN_KEY));

  const { items: events } = errorRepo.listEvents({ ownSiteId: site.id });
  assert.equal(events.length, 3);
  const byError = Object.fromEntries(events.map((event) => [event.error_id, event]));
  assert.equal(byError['101'].route, 'hermes');
  assert.equal(byError['102'].route, 'manual');
  assert.equal(byError['103'].route, 'none');
  assert.deepEqual(byError['103'].deliveries, []);
  assert.equal(byError['101'].detail_status, 'complete');

  assert.equal(deps.sent.hermes.length, 1);
  const payload = deps.sent.hermes[0];
  assert.equal(payload.delivery_id, `sub2api-${site.id}-101`);
  assert.ok(payload.prompt.startsWith('HERMES_PROMPT: 请排查以下错误'));
  assert.ok(payload.prompt.includes('overloaded'));
  const serialized = JSON.stringify(payload);
  assert.ok(!serialized.includes(ADMIN_KEY));
  assert.ok(!serialized.includes(HERMES_SECRET));
  assert.ok(!serialized.includes('sk-leakedleaked123'));
  assert.ok(!serialized.includes('abcdefghijkl'));

  assert.equal(deps.sent.pushplus.length, 2);
  assert.equal(deps.sent.email.length, 2);
  const handoff = deps.sent.pushplus.find((message) => message.title.includes('已移交 Hermes'));
  for (const text of ['route-flow', '公共分组', '5xx', '用户状态码：502', '上游状态码：503', `sub2api-${site.id}-101`]) {
    assert.ok(handoff.content.includes(text), `handoff missing ${text}`);
  }
  const manual = deps.sent.pushplus.find((message) => message.title.includes('需人工处理'));
  assert.ok(manual.content.includes('本地消息：rate limited'));
  assert.ok(manual.content.includes('上游错误：quota'));

  const hermesEvent = errorRepo.getEvent(byError['101'].id);
  assert.deepEqual(hermesEvent.deliveries.map((item) => [item.channel, item.status]), [
    ['pushplus', 'sent'], ['email', 'sent'], ['hermes', 'sent'], ['weixin', 'pending']
  ]);

  await runRequestErrorMonitor(state, { ...deps, now: deps.now + 120000 });
  assert.equal(errorRepo.listEvents({ ownSiteId: site.id }).total, 3);
  assert.equal(deps.sent.pushplus.length, 2);
  assert.equal(deps.sent.hermes.length, 1);
});

test('detail failures retry with backoff and then become explicit partial details', async () => {
  const site = createSite('partial-flow');
  const items = [{ id: 201, group_id: 7, created_at: '2026-10-30T11:00:00Z', status_code: 502, phase: 'upstream', type: 'upstream_error', message: 'boom' }];
  const client = fakeClient(items, {}, { failDetail: new Set(['201']) });
  const base = Date.parse('2026-10-30T11:01:00Z');
  const deps = { ...notifiers(), client, settings: settings({ max_retries: 1 }) };
  const state = createRequestErrorState();
  await runRequestErrorMonitor(state, { ...deps, now: base });
  let [event] = errorRepo.listEvents({ ownSiteId: site.id }).items;
  assert.equal(event.detail_status, 'pending');
  assert.equal(deps.sent.pushplus.length, 0);

  await runRequestErrorMonitor(state, { ...deps, now: base + 1000 });
  assert.equal(client.calls.detail.length, 1, 'retry waits for backoff');

  await runRequestErrorMonitor(state, { ...deps, now: base + 10000 });
  [event] = errorRepo.listEvents({ ownSiteId: site.id }).items;
  assert.equal(event.detail_status, 'partial');
  assert.equal(event.route, 'hermes');
  const full = errorRepo.getEvent(event.id);
  assert.match(full.detail_error, /详情接口失败/);
  assert.match(deps.sent.hermes[0].prompt, /部分详情/);
});

test('Hermes outage keeps the event queued, then receipt confirms Weixin delivery', async () => {
  const site = createSite('hermes-outage');
  const items = [{ id: 301, group_id: 9, created_at: '2026-10-30T12:00:00Z', status_code: 503, phase: 'upstream', type: 'upstream_error', message: 'down' }];
  const base = Date.parse('2026-10-30T12:01:00Z');
  let hermesOnline = false;
  let receipt = { processing: 'accepted', delivery: 'unknown', result: '' };
  const submitted = [];
  const deps = {
    ...notifiers(),
    client: fakeClient(items, { 301: items[0] }),
    settings: settings({ max_retries: 0 }),
    submitHermesEvent: async (payload) => {
      if (!hermesOnline) throw Object.assign(new Error('tunnel down'), { status: 503 });
      submitted.push(payload);
      return { status: 'accepted' };
    },
    fetchHermesReceipt: async () => receipt
  };
  const state = createRequestErrorState();
  await runRequestErrorMonitor(state, { ...deps, now: base });
  let [event] = errorRepo.listEvents({ ownSiteId: site.id }).items;
  let hermes = errorRepo.getEvent(event.id).deliveries.find((item) => item.channel === 'hermes');
  assert.equal(hermes.status, 'pending', 'transient outage does not exhaust max_retries');
  assert.match(hermes.last_error, /tunnel down/);

  hermesOnline = true;
  await dispatchDueDeliveries(deps.settings, { ...deps, now: base + 60000 });
  assert.equal(submitted.length, 1);
  let weixin = errorRepo.getEvent(event.id).deliveries.find((item) => item.channel === 'weixin');
  assert.equal(weixin.status, 'pending');

  await dispatchDueDeliveries(deps.settings, { ...deps, now: base + 120000 });
  weixin = errorRepo.getEvent(event.id).deliveries.find((item) => item.channel === 'weixin');
  assert.equal(weixin.status, 'pending', 'accepted is not reported as solved');
  assert.match(weixin.last_error, /accepted/);

  receipt = { processing: 'completed', delivery: 'delivered', result: '已处理：切换账号；仍需人工：无' };
  await dispatchDueDeliveries(deps.settings, { ...deps, now: base + 240000 });
  event = errorRepo.getEvent(event.id);
  weixin = event.deliveries.find((item) => item.channel === 'weixin');
  assert.equal(weixin.status, 'sent');
  assert.equal(event.hermes_delivery, 'delivered');
  assert.match(event.hermes_result, /切换账号/);
});

test('Hermes client signs requests with the gateway V2 scheme', async () => {
  const requests = [];
  const config = settings({ hermes_webhook_url: 'http://127.0.0.1:18644/webhooks/sub2api-errors' });
  await submitHermesEvent({ delivery_id: 'evt-1', event_type: 'sub2api.request_error', prompt: 'x' }, config, {
    now: 1_700_000_000_000,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ status: 'accepted' }), { status: 202 });
    }
  });
  const { init } = requests[0];
  const expected = crypto.createHmac('sha256', HERMES_SECRET).update(`1700000000.${init.body}`).digest('hex');
  assert.equal(init.headers['x-webhook-timestamp'], '1700000000');
  assert.equal(init.headers['x-webhook-signature-v2'], expected);
  assert.equal(signBody(HERMES_SECRET, '1700000000', init.body), expected);
  assert.equal(receiptUrl(config.hermes_webhook_url), 'http://127.0.0.1:18644/webhooks/sub2api-errors/receipt');
  assert.equal(healthUrl(config.hermes_webhook_url), 'http://127.0.0.1:18644/health');
});

test('settings validate Hermes URLs, mask the HMAC secret, and keep code lists normalized', () => {
  assert.throws(() => updateRequestErrorSettings({ hermes_webhook_url: 'http://203.0.113.5:8644/webhooks/x' }));
  assert.throws(() => updateRequestErrorSettings({ hermes_secret: 'short' }));
  const status = updateRequestErrorSettings({
    enabled: true,
    hermes_codes: ['Upstream_Error', 'upstream_error', '429'],
    manual_codes: ['429'],
    hermes_secret: 'a-long-enough-hmac-secret'
  });
  assert.deepEqual(status.settings.hermes_codes, ['upstream_error', '429']);
  assert.deepEqual(status.overlap_codes, ['429']);
  assert.equal(status.hermes_secret.configured, true);
  assert.ok(!JSON.stringify(requestErrorSettingsStatus()).includes('a-long-enough-hmac-secret'));
  assert.equal(effectiveRequestErrorSettings().hermes_secret, 'a-long-enough-hmac-secret');
  const monitorSite = errorRepo.listMonitorSites()[0];
  assert.ok(monitorSite && !JSON.stringify(monitorSite).includes(ADMIN_KEY));
});

test('Hermes payload carries prompt plus error details only', () => {
  const payload = buildHermesPayload({
    delivery_id: 'sub2api-1-9', error_id: '9', own_site_id: 1, group_id: '7', group_name: 'g',
    occurred_at: '2026-10-30T00:00:00Z', status_code: 502, upstream_status_code: 500,
    upstream_errors: [], related_upstream_errors: [], matched_codes: ['5xx'], error_codes: ['502'],
    detail_status: 'complete'
  }, { name: 's', base_url: 'https://s.example.com' }, settings({ hermes_prompt: '' }));
  assert.ok(payload.prompt.startsWith('## Sub2API 用户请求错误'));
  assert.deepEqual(Object.keys(payload).sort(), ['delivery_id', 'event', 'event_type', 'prompt', 'report_target']);
});
