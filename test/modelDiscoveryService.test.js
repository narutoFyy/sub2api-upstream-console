require('./testEnv');

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractModelNames,
  modelsFromUsage,
  safeDiscoveryError,
  syncUpstreamModels
} = require('../src/modelDiscoveryService');

test('model payload and usage records normalize to unique names', () => {
  assert.deepEqual(extractModelNames({ data: [{ id: 'gpt-b' }, { id: 'gpt-a' }, { id: 'gpt-a' }] }), ['gpt-a', 'gpt-b']);
  assert.deepEqual(modelsFromUsage({ items: [
    { group_id: 2, model: 'claude-a' },
    { group_id: 3, model: 'other' },
    { group_id: 2, model: 'claude-a' }
  ] }, 2), ['claude-a']);
});

test('model discovery errors redact network and credential details', () => {
  const safe = safeDiscoveryError('Denied IP 185.220.239.32 Bearer abc123 sk-full-secret-value');
  assert.equal(safe.includes('185.220.239.32'), false);
  assert.equal(safe.includes('abc123'), false);
  assert.equal(safe.includes('sk-full-secret-value'), false);
});

test('model sync uses live models and falls back to recent group usage', async () => {
  let saved = null;
  const repository = {
    getSite: () => ({ id: 4, base_url: 'https://fixture.example', openai_probe_model: '', anthropic_probe_model: '' }),
    getCredentials: () => ({ token: 'account-token' }),
    attachKeySecrets: (siteId, keys) => keys.map((key) => ({
      ...key,
      key_full: key.id === 10 ? 'sk-live' : 'sk-blocked'
    })),
    replaceUpstreamProbeModels: (siteId, groups, syncedAt) => {
      saved = { siteId, groups, syncedAt };
      return groups.map((group) => ({ ...group, selected_model: '' }));
    }
  };
  const request = async (baseUrl, path, options) => {
    if (path === '/models' && options.token === 'sk-live') return [{ id: 'gpt-live' }];
    if (path === '/models') throw Object.assign(new Error('forbidden'), { status: 403 });
    if (path.includes('/usage?') && path.includes('group_id=2')) return { items: [{ group_id: 2, model: 'claude-used' }] };
    return { items: [] };
  };
  const result = await syncUpstreamModels(4, {
    repo: repository,
    listGroups: async () => [
      { id: 1, name: 'OpenAI', platform: 'openai' },
      { id: 2, name: 'Claude', platform: 'anthropic' }
    ],
    fetchKeys: async () => ({ items: [
      { id: 10, group_id: 1, platform: 'openai', status: 'active', key_full: null },
      { id: 11, group_id: 2, platform: 'anthropic', status: 'active', key_full: null }
    ] }),
    getAuth: async () => ({ token: 'account-token', prefix: '/api/v1' }),
    request
  });

  assert.equal(result.live_groups, 1);
  assert.equal(result.fallback_groups, 1);
  assert.equal(saved.groups[0].models[0].model, 'gpt-live');
  assert.equal(saved.groups[1].models[0].model, 'claude-used');
  assert.equal(JSON.stringify(result).includes('sk-live'), false);
});
