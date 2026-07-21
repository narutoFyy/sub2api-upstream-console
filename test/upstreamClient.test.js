require('./testEnv');

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractDiscoveredBaseUrl,
  refreshAccessToken,
  sanitizeUpstreamText,
  tokenExpiryIso,
  tokenNeedsRefresh,
  upstreamErrorMessage
} = require('../src/upstreamClient');

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
