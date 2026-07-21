require('./testEnv');

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeUsageQuery,
  sanitizeUsageRecord,
  enrichUsageRecord,
  queryUpstreamUsage,
  getUpstreamUsageDetail
} = require('../src/upstreamUsage');

test('usage query accepts only bounded whitelist fields', () => {
  const query = normalizeUsageQuery({
    page: '-4',
    page_size: '9999',
    api_key_id: '12',
    group_id: 'abc',
    model: 'gpt-test',
    sort_by: 'private_field',
    injected: 'secret'
  });
  assert.deepEqual(query, {
    page: '1',
    page_size: '100',
    sort_by: 'created_at',
    sort_order: 'desc',
    model: 'gpt-test',
    api_key_id: '12'
  });
});

test('usage records are enriched from local masked Key snapshots', () => {
  const safe = enrichUsageRecord({ api_key_id: 12, key_name: '', key_masked: '', group_name: '' }, new Map([
    ['12', { name: 'Local Key', key_masked: 'sk-...safe', group_id: '7', group_name: 'Stable' }]
  ]));
  assert.equal(safe.key_name, 'Local Key');
  assert.equal(safe.key_masked, 'sk-...safe');
  assert.equal(safe.group_name, 'Stable');
});

test('usage sanitization drops raw account data and masks full Keys', () => {
  const safe = sanitizeUsageRecord({
    id: 9,
    request_id: 'req-1',
    api_key: { id: 5, name: 'Customer', key: 'sk-this-is-a-full-secret-key' },
    user: { email: 'private@example.com', password: 'secret' },
    model: 'gpt-test',
    input_tokens: 10,
    raw_payload: { authorization: 'Bearer secret' }
  });
  const text = JSON.stringify(safe);
  assert.equal(safe.key_name, 'Customer');
  assert.equal(safe.key_masked, 'sk-this...-key');
  assert.equal(text.includes('private@example.com'), false);
  assert.equal(text.includes('Bearer secret'), false);
  assert.equal(text.includes('sk-this-is-a-full-secret-key'), false);
});

test('usage list and detail proxy only sanitized records', async () => {
  const repository = {
    getSite: () => ({ id: 2, name: 'Fixture', base_url: 'https://fixture.example' }),
    getCredentials: () => ({ token: 'account-token' })
  };
  const record = { id: 7, api_key: { key: 'sk-super-secret-value', name: 'Key A' }, model: 'gpt-test', actual_cost: 0.1 };
  const dependencies = {
    repo: repository,
    getAuth: async () => ({ token: 'session-token', prefix: '/api/v1' }),
    request: async (baseUrl, path) => path === '/usage/7' ? record : { items: [record], total: 1, page: 1, page_size: 20 }
  };
  const list = await queryUpstreamUsage(2, {}, dependencies);
  const detail = await getUpstreamUsageDetail(2, '7', dependencies);
  assert.equal(list.items[0].key_name, 'Key A');
  assert.equal(detail.item.model, 'gpt-test');
  assert.equal(JSON.stringify({ list, detail }).includes('sk-super-secret-value'), false);
});
