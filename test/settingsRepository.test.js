require('./testEnv');

const test = require('node:test');
const assert = require('node:assert/strict');
const repo = require('../src/repository');

test('secret settings are encrypted at rest and exposed only through explicit reads', () => {
  const saved = repo.setSecretSetting('pushplus_token', 'pushplus-test-secret');
  assert.equal(saved.masked_value, 'pus...ret');
  assert.equal(repo.getSecretSetting('pushplus_token'), 'pushplus-test-secret');
  assert.equal(repo.getMaskedSecretSetting('pushplus_token'), 'pus...ret');
  assert.equal(repo.deleteSetting('pushplus_token'), true);
  assert.equal(repo.getSecretSetting('pushplus_token'), '');
});

test('model catalog replacement preserves selected group models', () => {
  const site = repo.createSite({
    name: 'Model Catalog Test',
    base_url: `https://model-catalog-${process.pid}.example`,
    upstream_type: 'sub2api',
    auth_mode: 'password',
    email: 'test@example.com',
    password: 'secret'
  });
  repo.replaceUpstreamProbeModels(site.id, [{
    group_id: 7,
    group_name: 'OpenAI Stable',
    platform: 'openai',
    source: 'live',
    models: ['gpt-5.4', 'gpt-5.5']
  }], '2026-07-21T00:00:00.000Z');
  repo.setGroupProbeModel(site.id, 7, {
    group_name: 'OpenAI Stable',
    platform: 'openai',
    selected_model: 'gpt-5.5'
  });

  const replaced = repo.replaceUpstreamProbeModels(site.id, [{
    group_id: 7,
    group_name: 'OpenAI Stable',
    platform: 'openai',
    source: 'usage',
    models: [{ model: 'gpt-5.5', source: 'usage' }]
  }], '2026-07-21T01:00:00.000Z');

  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].selected_model, 'gpt-5.5');
  assert.deepEqual(replaced[0].models.map((item) => item.model), ['gpt-5.5']);
  assert.equal(repo.getGroupProbeModel(site.id, 7), 'gpt-5.5');
});
