require('./testEnv');

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildUpstreamDetail } = require('../src/upstreamDetail');

function fakeRepository() {
  const calls = [];
  const repository = {
    getSite: (id) => ({ id, name: 'Test upstream' }),
    getSnapshot: () => ({ balance: 10, pricing_summary: '{}' }),
    getMaskedCredentials: () => ({ email: 'te***@example.com' }),
    getDetailPricingSummary: () => {
      calls.push('pricing-summary');
      return { enabled: true };
    },
    listRates: (id, limit) => {
      calls.push(`rates:${limit}`);
      return [];
    },
    listSyncLogs: (id, limit) => {
      calls.push(`logs:${limit}`);
      return [];
    },
    capabilityMatrix: () => ({}),
    listModelPricing: (id, limit) => {
      calls.push(`pricing:${limit}`);
      return [];
    },
    listRechargeOrders: (id, limit) => {
      calls.push(`orders:${limit}`);
      return [];
    },
    listSnapshotHistory: (id, limit) => {
      calls.push(`history:${limit}`);
      return [];
    }
  };
  return { repository, calls };
}

test('upstream detail defaults to the lightweight first-screen payload', () => {
  const target = fakeRepository();
  const detail = buildUpstreamDetail(7, { repository: target.repository });

  assert.equal(detail.site.id, 7);
  assert.deepEqual(target.calls, ['rates:20', 'logs:12']);
  assert.equal(Object.hasOwn(detail, 'model_pricing'), false);
  assert.equal(Object.hasOwn(detail, 'recharge_orders'), false);
  assert.equal(Object.hasOwn(detail, 'history'), false);
});

test('full upstream detail preserves the previous data sets and limits', () => {
  const target = fakeRepository();
  const detail = buildUpstreamDetail(7, { repository: target.repository, full: true });

  assert.deepEqual(target.calls, [
    'pricing-summary',
    'rates:300',
    'logs:100',
    'pricing:300',
    'orders:20',
    'history:120'
  ]);
  assert.deepEqual(detail.snapshot.pricing_summary, { enabled: true });
  assert.deepEqual(detail.model_pricing, []);
  assert.deepEqual(detail.recharge_orders, []);
  assert.deepEqual(detail.history, []);
});
