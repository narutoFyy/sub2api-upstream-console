require('./testEnv');

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractModelNames,
  modelsFromUsage,
  safeDiscoveryError,
  buildNewAPIProbeGroups,
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

test('New API model pricing is grouped and retained as selectable local candidates', () => {
  const groups = buildNewAPIProbeGroups({
    raw: {
      groups: {
        default: { ratio: 1 },
        vip: { ratio: 2 }
      }
    },
    model_pricing: [
      { model_name: 'gpt-main', enable_groups: ['default', 'vip'], supported_endpoint_types: ['openai'] },
      { model_name: 'claude-main', enable_groups: ['vip'], supported_endpoint_types: ['anthropic'] },
      { model_name: 'shared-model', supported_endpoint_types: ['openai'] }
    ]
  });

  assert.deepEqual(groups.map((group) => group.group_id), ['default', 'vip']);
  assert.deepEqual(groups[0].models.map((item) => item.model), ['gpt-main', 'shared-model']);
  assert.deepEqual(groups[1].models.map((item) => item.model), ['gpt-main', 'claude-main', 'shared-model']);
  assert.equal(groups[0].platform, 'openai');
  assert.equal(groups[1].platform, 'new-api');
  assert.equal(groups[0].discovery_status, 'pricing');
});

test('New API models enabled for all groups are expanded without a phantom all group', () => {
  const groups = buildNewAPIProbeGroups({
    raw: { groups: { default: { ratio: 1 }, vip: { ratio: 2 } } },
    model_pricing: [
      { model_name: 'shared-model', enable_groups: ['all'], supported_endpoint_types: ['openai'] },
      { model_name: 'vip-model', enable_groups: ['vip'], supported_endpoint_types: ['openai'] }
    ]
  });

  assert.deepEqual(groups.map((group) => group.group_id), ['default', 'vip']);
  assert.deepEqual(groups[0].models.map((item) => item.model), ['shared-model']);
  assert.deepEqual(groups[1].models.map((item) => item.model), ['shared-model', 'vip-model']);
});

test('model sync uses the New API model catalog instead of Sub2API key endpoints', async () => {
  let saved = null;
  let requestInput = null;
  const repository = {
    getSite: () => ({ id: 4, upstream_type: 'new-api', base_url: 'https://fixture.example' }),
    getCredentials: () => ({ email: 'user@example.com', password: 'password' }),
    replaceUpstreamProbeModels: (siteId, groups, syncedAt) => {
      saved = { siteId, groups, syncedAt };
      return groups.map((group) => ({ ...group, selected_model: '' }));
    }
  };

  const result = await syncUpstreamModels(4, {
    repo: repository,
    fetchUpstreamState: async (input) => {
      requestInput = input;
      return {
        raw: { groups: { default: { ratio: 1 } } },
        model_pricing: [{ model_name: 'gpt-new-api', enable_groups: ['default'], supported_endpoint_types: ['openai'] }]
      };
    },
    listGroups: async () => {
      throw new Error('Sub2API group endpoint must not be called for New API');
    }
  });

  assert.equal(requestInput.upstreamType, 'new-api');
  assert.equal(requestInput.baseUrl, 'https://fixture.example');
  assert.equal(saved.siteId, 4);
  assert.equal(saved.groups[0].models[0].model, 'gpt-new-api');
  assert.equal(result.pricing_groups, 1);
  assert.equal(result.live_groups, 0);
});

test('model sync detects an auto-configured New API site before using Sub2API endpoints', async () => {
  let saved = null;
  const repository = {
    getSite: () => ({ id: 5, upstream_type: 'auto', base_url: 'https://fixture.example' }),
    getCredentials: () => ({ email: 'user@example.com', password: 'password' }),
    replaceUpstreamProbeModels: (_siteId, groups) => {
      saved = groups;
      return groups;
    }
  };

  const result = await syncUpstreamModels(5, {
    repo: repository,
    fetchUpstreamState: async (input) => {
      assert.equal(input.upstreamType, 'auto');
      return {
        login: { provider: 'new-api' },
        raw: { groups: { default: { ratio: 1 } } },
        model_pricing: [{ model_name: 'gpt-auto-new-api', enable_groups: ['default'] }]
      };
    },
    listGroups: async () => {
      throw new Error('Sub2API group endpoint must not be called for an auto-detected New API site');
    }
  });

  assert.equal(saved[0].models[0].model, 'gpt-auto-new-api');
  assert.equal(result.pricing_groups, 1);
});

test('New API model sync can use the public pricing catalog when account sync is unavailable', async () => {
  let saved = null;
  const repository = {
    getSite: () => ({ id: 9, upstream_type: 'new-api', base_url: 'https://fixture.example' }),
    getCredentials: () => ({ token: 'user-api-key' }),
    replaceUpstreamProbeModels: (siteId, groups) => {
      saved = { siteId, groups };
      return groups;
    }
  };
  const result = await syncUpstreamModels(9, {
    repo: repository,
    fetchUpstreamState: async () => {
      throw new Error('New API user data requires account/password login');
    },
    request: async (baseUrl, path, options) => {
      assert.equal(baseUrl, 'https://fixture.example');
      assert.equal(path, '/pricing');
      assert.equal(options.prefix, '/api');
      return [{ model_name: 'public-model', enable_groups: ['default'] }];
    }
  });

  assert.equal(saved.siteId, 9);
  assert.equal(saved.groups[0].models[0].model, 'public-model');
  assert.equal(result.pricing_groups, 1);
});

test('an empty New API model catalog does not replace the previous local candidates', async () => {
  let replaced = false;
  const repository = {
    getSite: () => ({ id: 10, upstream_type: 'new-api', base_url: 'https://fixture.example' }),
    getCredentials: () => ({ token: 'user-api-key' }),
    replaceUpstreamProbeModels: () => {
      replaced = true;
      return [];
    }
  };

  await assert.rejects(
    syncUpstreamModels(10, {
      repo: repository,
      fetchUpstreamState: async () => ({ model_pricing: [] }),
      request: async () => []
    }),
    /未返回可同步的模型/
  );
  assert.equal(replaced, false);
});

test('model sync uses live models and falls back to recent group usage', async () => {
  let saved = null;
  const repository = {
    getSite: () => ({ id: 4, upstream_type: 'sub2api', base_url: 'https://fixture.example', openai_probe_model: '', anthropic_probe_model: '' }),
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
