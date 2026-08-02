const test = require('node:test');
const assert = require('node:assert/strict');

process.env.APP_SECRET = 'sync-service-test-secret';
process.env.SYNC_SCHEDULER_ENABLED = 'false';
process.env.KEY_CHECK_SCHEDULER_ENABLED = 'false';

const { syncSite } = require('../src/syncService');

function state(balance, token = 'token') {
  return {
    token,
    refresh_token: '',
    token_expires_at: null,
    snapshot: { balance, today_tokens: 0 },
    rates: [],
    model_pricing: [],
    keys: []
  };
}

function fakeRepository() {
  const events = [];
  return {
    events,
    getSite: () => ({ id: 1, name: 'Fixture', base_url: 'https://fixture.example', upstream_type: 'sub2api' }),
    getCredentials: () => ({ token: 'old-token' }),
    saveCredentialTokens: () => events.push('tokens'),
    saveSyncSuccess: (siteId, result) => events.push(`save:${result.snapshot.balance}`),
    saveSyncLog: (siteId, type, startedAt, status, error) => events.push(`log:${status}:${error?.message || ''}`)
  };
}

test('transient zero balance is replaced by the confirmed normal response before persistence', async () => {
  const repository = fakeRepository();
  const responses = [state(0, 'fresh-token'), state(42, 'confirmed-token')];
  const delays = [];
  let alerts = 0;

  const result = await syncSite(1, {
    repo: repository,
    settings: {},
    fetchUpstreamState: async (input) => {
      if (responses.length === 1) assert.equal(input.token, 'fresh-token');
      return responses.shift();
    },
    delay: async (ms) => delays.push(ms),
    evaluateAlerts: async () => { alerts += 1; }
  });

  assert.equal(result.snapshot.balance, 42);
  assert.deepEqual(delays, [5000]);
  assert.deepEqual(repository.events, ['tokens', 'save:42', 'log:success:']);
  assert.equal(alerts, 1);
});

test('confirmed zero balance is persisted and evaluated once', async () => {
  const repository = fakeRepository();
  let calls = 0;
  let alerts = 0;

  const result = await syncSite(1, {
    repo: repository,
    settings: {},
    fetchUpstreamState: async () => { calls += 1; return state(0); },
    delay: async () => {},
    evaluateAlerts: async () => { alerts += 1; }
  });

  assert.equal(result.snapshot.balance, 0);
  assert.equal(calls, 2);
  assert.deepEqual(repository.events, ['tokens', 'save:0', 'log:success:']);
  assert.equal(alerts, 1);
});

test('failed zero-balance confirmation preserves the previous snapshot and records a sync failure', async () => {
  const repository = fakeRepository();
  let calls = 0;
  let alerts = 0;

  await assert.rejects(() => syncSite(1, {
    repo: repository,
    settings: {},
    fetchUpstreamState: async () => {
      calls += 1;
      if (calls === 1) return state(0);
      throw new Error('temporary outage');
    },
    delay: async () => {},
    evaluateAlerts: async () => { alerts += 1; }
  }), /余额首次返回 0，复查失败，已保留上一有效余额/);

  assert.equal(repository.events.some((item) => item.startsWith('save:')), false);
  assert.equal(repository.events.some((item) => item.includes('log:failed:余额首次返回 0')), true);
  assert.equal(alerts, 1);
});

test('missing balance twice is rejected instead of being persisted as zero', async () => {
  const repository = fakeRepository();
  let calls = 0;

  await assert.rejects(() => syncSite(1, {
    repo: repository,
    settings: {},
    fetchUpstreamState: async () => { calls += 1; return state(null); },
    delay: async () => {},
    evaluateAlerts: async () => {}
  }), /余额首次缺失，复查仍未返回有效数值，已保留上一有效余额/);

  assert.equal(calls, 2);
  assert.equal(repository.events.some((item) => item.startsWith('save:')), false);
});

test('a single zero after a missing balance is not considered confirmed', async () => {
  const repository = fakeRepository();
  const responses = [state(undefined), state(0)];

  await assert.rejects(() => syncSite(1, {
    repo: repository,
    settings: {},
    fetchUpstreamState: async () => responses.shift(),
    delay: async () => {},
    evaluateAlerts: async () => {}
  }), /余额首次缺失，复查仅返回一次 0，已保留上一有效余额/);

  assert.equal(repository.events.some((item) => item.startsWith('save:')), false);
});
