require('./testEnv');

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizePeriod,
  summarizeConsumption,
  buildConsumptionDashboard
} = require('../src/consumptionTrendService');

const NOW = Date.parse('2026-08-02T12:00:00.000Z');

function sample(hoursAgo, balance, totalCost) {
  return {
    captured_at: new Date(NOW - hoursAgo * 60 * 60 * 1000).toISOString(),
    balance,
    total_cost: totalCost
  };
}

test('period selection is restricted to supported dashboard ranges', () => {
  assert.equal(normalizePeriod('7D'), '7d');
  assert.equal(normalizePeriod('year'), '24h');
});

test('consumption uses positive cumulative cost deltas and ignores resets and recharges', () => {
  const result = summarizeConsumption([
    sample(4, 100, 10),
    sample(3, 97, 12),
    sample(2, 120, 1),
    sample(1, 116, 4)
  ], { balance: 116 }, '24h', NOW);

  assert.equal(result.source, 'actual_cost');
  assert.equal(result.estimated, false);
  assert.equal(result.consumption, 5);
  assert.equal(result.coverage_ms, 3 * 60 * 60 * 1000);
  assert.equal(result.average_per_hour, 5 / 3);
  assert.equal(result.runway_hours, 116 / result.runway_per_hour);
  assert.equal(result.buckets.reduce((total, item) => total + item.consumption, 0), 5);
});

test('consumption ignores a temporary fallback from cumulative usage to daily usage', () => {
  const result = summarizeConsumption([
    sample(4, 100, 14950.6060154877),
    sample(3, 81.20628943, 265.940802206),
    sample(2, 75.77519188, 14974.8308233677),
    sample(1, 67.29350162, 14983.3125136252)
  ], { balance: 67.29350162 }, '24h', NOW);

  assert.equal(result.source, 'actual_cost');
  assert.equal(result.consumption, 32.70649837750031);
  assert.ok(result.consumption < 100);
});

test('runway weights recent intervals above older ones', () => {
  const steady = summarizeConsumption([
    sample(4, 40, 0), sample(3, 30, 10), sample(2, 20, 20), sample(1, 10, 30)
  ], { balance: 10 }, '24h', NOW);

  const accelerating = summarizeConsumption([
    sample(4, 40, 0), sample(3, 38, 2), sample(2, 34, 6), sample(1, 10, 30)
  ], { balance: 10 }, '24h', NOW);

  assert.equal(steady.consumption, 30);
  assert.equal(accelerating.consumption, 30);
  assert.equal(steady.average_per_hour, accelerating.average_per_hour);
  assert.ok(accelerating.recent_per_hour > accelerating.average_per_hour);
  assert.ok(accelerating.runway_hours < steady.runway_hours);
});

test('runway excludes intervals with no usable reading from the denominator', () => {
  const gapped = summarizeConsumption([
    sample(6, 100, 0),
    sample(5, 94, 0),
    sample(3, null, 0),
    sample(2, null, 0),
    sample(1, 88, 0)
  ], { balance: 88 }, '24h', NOW);

  assert.equal(gapped.consumption, 6);
  assert.equal(gapped.average_per_hour, 6 / 5);
  assert.equal(gapped.recent_per_hour, 6);
  assert.equal(gapped.runway_per_hour, 6);
  assert.equal(gapped.runway_hours, 88 / 6);
});

test('runway falls back to the window average when no interval carries weight', () => {
  const result = summarizeConsumption([
    sample(4, 100, null), sample(2, 100, null), sample(1, 100, null)
  ], { balance: 100 }, '24h', NOW);

  assert.equal(result.consumption, 0);
  assert.equal(result.recent_per_hour, null);
  assert.equal(result.runway_per_hour, 0);
  assert.equal(result.runway_hours, null);
});

test('balance decline is an explicit estimate when cumulative cost is unavailable', () => {
  const result = summarizeConsumption([
    sample(5, 20, 0),
    sample(3, 18, 0),
    sample(2, 30, 0),
    sample(1, 27, 0)
  ], { balance: 27 }, '24h', NOW);

  assert.equal(result.source, 'balance_estimate');
  assert.equal(result.estimated, true);
  assert.equal(result.consumption, 5);
  assert.equal(result.average_per_hour, 1.25);
});

test('recharges are reported separately and buckets record whether a snapshot landed', () => {
  const result = summarizeConsumption([
    sample(5, 20, 0),
    sample(4, 18, 0),
    sample(3, 50, 0),
    sample(1, 47, 0)
  ], { balance: 47 }, '24h', NOW);

  assert.equal(result.consumption, 5);
  assert.equal(result.recharge, 32);
  assert.deepEqual(result.buckets.filter((bucket) => bucket.recharge > 0).map((bucket) => bucket.recharge), [32]);
  assert.equal(result.buckets.filter((bucket) => bucket.observed).length, 4);
  assert.equal(result.buckets.at(0).observed, false);
  assert.ok(result.buckets.every((bucket) => !Object.hasOwn(bucket, 'sample_count')));
});

test('speed and runway are withheld for sparse coverage', () => {
  const result = summarizeConsumption([
    sample(0.5, 10, 1),
    sample(0.25, 9, 2)
  ], { balance: 9 }, '24h', NOW);

  assert.equal(result.enough_data, false);
  assert.equal(result.consumption, 1);
  assert.equal(result.average_per_hour, null);
  assert.equal(result.recent_per_hour, null);
  assert.equal(result.runway_hours, null);
});

test('dashboard returns every upstream ordered by period consumption', () => {
  const histories = new Map([
    [1, [sample(3, 10, 0), sample(1, 8, 0)]],
    [2, [sample(3, 20, 1), sample(1, 18, 6)]]
  ]);
  const repository = {
    listSites: () => [
      { id: 1, name: 'Estimate', base_url: 'https://a.example', status: 'active', balance: 8 },
      { id: 2, name: 'Actual', base_url: 'https://b.example', status: 'active', balance: 18 }
    ],
    listSnapshotHistoryRange: (siteId, since) => {
      assert.match(since, /^2026-08-01T12:00:00/);
      return histories.get(siteId);
    },
    getSnapshot: (siteId) => ({ balance: siteId === 1 ? 8 : 18 })
  };

  const result = buildConsumptionDashboard(repository, '24h', NOW);
  assert.deepEqual(result.items.map((item) => item.name), ['Actual', 'Estimate']);
  assert.equal(result.total_consumption, 7);
  assert.equal(result.items[0].buckets.length, 24);
});
