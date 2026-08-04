require('./testEnv');

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractBalance,
  extractDiscoveredBaseUrl,
  fetchNewAPIState,
  normalizeNewAPIRates,
  normalizeNewAPITokens,
  normalizeNewAPIUsage,
  requestJson,
  refreshAccessToken,
  sanitizeUpstreamText,
  tokenExpiryIso,
  tokenNeedsRefresh,
  upstreamErrorMessage
} = require('../src/upstreamClient');

test('New API response codes and array-shaped groups normalize without losing usage', () => {
  assert.deepEqual(normalizeNewAPIRates([{ id: 'default', ratio: 1.2 }]).map((item) => item.group_id), ['default']);
  assert.equal(normalizeNewAPITokens([{ id: 1, status: 1, group: 'default', remain_quota: 12 }])[0].status, 'active');
  assert.equal(normalizeNewAPITokens([{ id: 1, status: 1, group: 'default', remain_quota: 12 }])[0].quota, 12);
  const usage = normalizeNewAPIUsage(
    { request_count: 12, used_quota: 500000, total_tokens: 40 },
    { quota: 600000, total_tokens: 50 },
    { requests: 2, tokens: 5, quota: 100000 },
    { requests: 7, tokens: 18, quota: 200000 },
    { quota: 300000, total_tokens: 25 },
    500000
  );
  assert.equal(usage.total_requests, 12);
  assert.equal(usage.today_requests, 2);
  assert.equal(usage.total_tokens, 40);
  assert.equal(usage.today_tokens, 5);
  assert.equal(usage.today_cost, 0.2);
  assert.equal(usage.month_cost, 0.6);
});

test('New API state follows paginated token results and accepts code 200 login responses', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, name: `Key ${index + 1}` }));
  const secondPage = [{ id: 101, name: 'Key 101' }];
  global.fetch = async (url, options) => {
    const parsed = new URL(String(url));
    calls.push({ path: `${parsed.pathname}${parsed.search}`, options });
    const path = parsed.pathname;
    const query = parsed.search;
    let body = { code: 0, data: {} };
    if (path === '/api/user/login') {
      body = { code: 200, success: true, data: { id: 7, email: 'fixture@example.com' } };
    } else if (path === '/api/user/self') {
      body = { code: 0, data: { id: 7, quota: 1000000, request_count: 12, used_quota: 500000, total_tokens: 40 } };
    } else if (path === '/api/user/self/groups') {
      body = { code: 0, data: [{ id: 'default', name: 'default', ratio: 1.2 }] };
    } else if (path === '/api/models') {
      body = { code: 0, data: [{ id: 'gpt-fixture' }] };
    } else if (path === '/api/token/' && query.includes('p=0')) {
      body = { code: 0, data: { items: firstPage, total: 101 } };
    } else if (path === '/api/token/' && query.includes('p=1')) {
      body = { code: 0, data: { items: secondPage, total: 101 } };
    } else if (path === '/api/log/self/stat' && !query) {
      body = { code: 0, data: { quota: 600000, total_tokens: 50 } };
    } else if (path === '/api/log/self/stat') {
      body = { code: 0, data: { requests: 2, tokens: 5, quota: 100000 } };
    } else if (path === '/api/status') {
      body = { code: 0, data: { quota_per_unit: 500000 } };
    } else if (path === '/api/pricing') {
      body = { code: 0, data: [] };
    } else if (path === '/api/ratio_config') {
      body = { code: 0, data: { model_ratio: {} } };
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers(path === '/api/user/login' ? { 'set-cookie': 'session=fixture; Path=/' } : {}),
      text: async () => JSON.stringify(body)
    };
  };
  try {
    const state = await fetchNewAPIState({
      baseUrl: 'https://1.1.1.1',
      email: 'fixture@example.com',
      password: 'fixture-password'
    });
    assert.equal(state.login.user_id, 7);
    assert.equal(state.keys.length, 101);
    assert.equal(state.snapshot.key_count, 101);
    assert.equal(state.snapshot.today_tokens, 5);
    assert.equal(state.snapshot.today_requests, 2);
    assert.equal(state.snapshot.balance, 2);
    assert.equal(calls.filter((item) => item.path.startsWith('/api/token/')).length, 2);
    assert.equal(calls.find((item) => item.path === '/api/user/self').options.headers.cookie, 'session=fixture');
  } finally {
    global.fetch = originalFetch;
  }
});

test('requestJson accepts explicit HTTP-style New API success codes', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () => JSON.stringify({ code: 200, success: true, data: { ok: true } })
  });
  try {
    assert.deepEqual(await requestJson('https://1.1.1.1', '/status', { prefix: '/api' }), { ok: true });
  } finally {
    global.fetch = originalFetch;
  }
});

test('Sub2API balance accepts only explicit balance fields', () => {
  assert.equal(extractBalance({ balance: 7.25, quota: 94.28, credit: 88 }), 7.25);
  assert.equal(extractBalance({ balance: null, user_balance: '7.5', quota: 94.28 }), 7.5);
  assert.equal(extractBalance({ balance: '', user_balance: undefined, quota: 94.28, credit: 88 }), null);
});

test('access token refresh uses the Sub2API refresh contract', async () => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url: String(url), options };
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify({
        code: 0,
        data: {
          access_token: 'access-two',
          refresh_token: 'refresh-two',
          expires_in: 3600
        }
      })
    };
  };
  try {
    const refreshed = await refreshAccessToken('https://1.1.1.1', 'refresh-one');
    assert.equal(request.url, 'https://1.1.1.1/api/v1/auth/refresh');
    assert.deepEqual(JSON.parse(request.options.body), { refresh_token: 'refresh-one' });
    assert.equal(refreshed.token, 'access-two');
    assert.equal(refreshed.refresh_token, 'refresh-two');
    assert.ok(Date.parse(refreshed.token_expires_at) > Date.now());
  } finally {
    global.fetch = originalFetch;
  }
});

test('JWT expiry controls proactive access token refresh', () => {
  const now = Date.parse('2026-07-22T00:00:00.000Z');
  const jwt = (expiresAt) => `header.${Buffer.from(JSON.stringify({ exp: expiresAt / 1000 })).toString('base64url')}.signature`;
  const longLived = jwt(now + 60 * 60 * 1000);
  const expiring = jwt(now + 2 * 60 * 1000);

  assert.equal(tokenExpiryIso(longLived), '2026-07-22T01:00:00.000Z');
  assert.equal(tokenNeedsRefresh(longLived, null, now), false);
  assert.equal(tokenNeedsRefresh(expiring, null, now), true);
  assert.equal(tokenNeedsRefresh('', null, now), true);
});

test('upstream HTML errors are reduced to a bounded safe summary', () => {
  const html = '<html><head><title>405 Not Allowed</title></head><body><script>token=secret</script><p>debug payload</p></body></html>';
  const message = upstreamErrorMessage('/auth/login', 405, { raw: html });
  assert.equal(message, 'Upstream /auth/login returned 405: 405 Not Allowed');
  assert.doesNotMatch(message, /<html|script|secret|debug payload/i);
  assert.ok(message.length <= 480);
});

test('upstream diagnostics redact secrets and cap long messages', () => {
  const message = sanitizeUpstreamText(`password=hunter2 Bearer abc.def ${'x'.repeat(800)}`, 120);
  assert.match(message, /password=\[redacted\]/);
  assert.match(message, /Bearer \[redacted\]/);
  assert.doesNotMatch(message, /hunter2|abc\.def/);
  assert.ok(message.length <= 120);
});

test('API discovery follows public config and service links on the same site', () => {
  const configHtml = '<script>window.__APP_CONFIG__={"api_base_url":"https://sub2.congmingai.com"}</script>';
  assert.equal(
    extractDiscoveredBaseUrl(configHtml, 'https://sub2.congmingai.com/', 'https://congmingai.com/'),
    'https://sub2.congmingai.com'
  );

  const portalHtml = '<a href="https://api.qlhazycoder.top/">API</a><a href="https://example.com/">Other</a>';
  assert.equal(
    extractDiscoveredBaseUrl(portalHtml, 'https://qlhazycoder.top/', 'https://qlhazycoder.top/'),
    'https://api.qlhazycoder.top'
  );
});
