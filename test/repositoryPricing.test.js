require('./testEnv');

const test = require('node:test');
const assert = require('node:assert/strict');
const repo = require('../src/repository');
const db = require('../src/db');

test('model pricing queries return only the latest row per model before applying the limit', () => {
  const site = repo.createSite({
    name: 'Pricing query test',
    base_url: `https://pricing-query-${process.pid}.example`
  });
  const insert = db.prepare(`
    INSERT INTO model_pricing_snapshots (upstream_site_id, model_name, model_ratio, captured_at)
    VALUES (?, ?, ?, ?)
  `);
  insert.run(site.id, 'model-a', 1, '2026-08-10T00:00:00.000Z');
  insert.run(site.id, 'model-c', 3, '2026-08-10T01:00:00.000Z');
  insert.run(site.id, 'model-b', 2, '2026-08-10T02:00:00.000Z');
  insert.run(site.id, 'model-a', 4, '2026-08-10T03:00:00.000Z');

  const rows = repo.listModelPricing(site.id, 2);

  assert.deepEqual(rows.map((row) => row.model_name), ['model-a', 'model-b']);
  assert.equal(rows[0].model_ratio, 4);
  assert.equal(rows.some((row) => row.model_name === 'model-a' && row.model_ratio === 1), false);
});
