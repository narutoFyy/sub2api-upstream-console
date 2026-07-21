require('./testEnv');

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractDiscoveredBaseUrl,
  sanitizeUpstreamText,
  upstreamErrorMessage
} = require('../src/upstreamClient');

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
