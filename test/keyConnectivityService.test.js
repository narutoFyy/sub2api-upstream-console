require('./testEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyProbeError,
  probeModelForKey,
  probeKey,
  checkUpstreamKeys,
  shouldCheckSite
} = require('../src/keyConnectivityService');

test('probeModelForKey prefers a group selection over site platform defaults', () => {
  const repository = { getGroupProbeModel: (siteId, groupId) => siteId === 3 && groupId === 9 ? 'group-model' : '' };
  assert.equal(probeModelForKey({ id: 3, openai_probe_model: 'site-model' }, { group_id: 9, platform: 'openai' }, repository), 'group-model');
  assert.equal(probeModelForKey({ id: 3, openai_probe_model: 'site-model' }, { group_id: 10, platform: 'openai' }, repository), 'site-model');
});

test('classifyProbeError distinguishes timeout, auth, quota and rate limit', () => {
  assert.equal(classifyProbeError({ name: 'TimeoutError', message: 'timeout' }).status, 'timeout');
  assert.equal(classifyProbeError({ status: 401, message: 'no' }).status, 'auth_failed');
  assert.equal(classifyProbeError({ status: 402, message: 'no credit' }).status, 'quota_exhausted');
  assert.equal(classifyProbeError({ status: 429, message: 'busy' }).error_code, 'rate_limited');
});

test('probeKey requires a full Key and configured model', async () => {
  const site = { base_url: 'https://fixture.example', openai_probe_model: '' };
  const unavailable = await probeKey(site, { platform: 'openai', key_full: null });
  assert.equal(unavailable.status, 'unavailable');
  const unconfigured = await probeKey(site, { platform: 'openai', key_full: 'sk-secret' });
  assert.equal(unconfigured.status, 'unconfigured');
});

test('probeKey sends an inference request without exposing the Key in its result', async () => {
  let requestOptions = null;
  const result = await probeKey(
    { base_url: 'https://fixture.example', openai_probe_model: 'probe-model' },
    { platform: 'openai', key_full: 'sk-secret' },
    { request: async (baseUrl, path, options) => { requestOptions = { baseUrl, path, options }; return {}; } }
  );
  assert.equal(result.status, 'connected');
  assert.equal(requestOptions.path, '/chat/completions');
  assert.equal(requestOptions.options.token, 'sk-secret');
  assert.equal(JSON.stringify(result).includes('sk-secret'), false);
});

test('checkUpstreamKeys records all live results and returns safe rows', async () => {
  const recorded = [];
  const repository = {
    getSite: () => ({ id: 2, name: 'Fixture', status: 'active', openai_probe_model: 'model' }),
    getCredentials: () => ({ token: 'admin' }),
    reconcileKeySnapshots: () => ({}),
    recordKeyConnectivityCheck: (siteId, keyId, result) => {
      recorded.push({ siteId, keyId, result });
      return { current: { ...result, consecutive_failures: result.status === 'timeout' ? 1 : 0 } };
    }
  };
  const listKeys = async () => ({
    items: [{ id: 1, name: 'A', key_full: 'sk-a' }, { id: 2, name: 'B', key_full: 'sk-b' }],
    total: 2,
    pages: 1
  });
  const probe = async (site, key) => ({ status: key.id === 1 ? 'connected' : 'timeout', checked_at: new Date().toISOString() });
  const result = await checkUpstreamKeys(2, { repo: repository, listKeys, probe, concurrency: 2 });
  assert.equal(recorded.length, 2);
  assert.equal(result.connected, 1);
  assert.equal(result.failed, 1);
  assert.equal(JSON.stringify(result).includes('sk-a'), false);
});

test('shouldCheckSite respects disabled state and interval', () => {
  assert.equal(shouldCheckSite({ status: 'disabled' }), false);
  assert.equal(shouldCheckSite({ status: 'active', last_key_check_at: null }), true);
  assert.equal(shouldCheckSite({
    status: 'active',
    last_key_check_at: '2026-01-01T00:00:00.000Z',
    key_check_interval_seconds: 300
  }, Date.parse('2026-01-01T00:04:00.000Z')), false);
});
