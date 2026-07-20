require('./testEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchAllSub2APIKeys, importAllKeys } = require('../src/keyImportService');

test('fetchAllSub2APIKeys follows pagination and deduplicates IDs', async () => {
  const calls = [];
  const listKeys = async (site, creds, options) => {
    calls.push(options.page);
    const pages = {
      1: [{ id: 1 }, { id: 2 }],
      2: [{ id: 2 }, { id: 3 }],
      3: [{ id: 4 }]
    };
    return { items: pages[options.page], total: 4, pages: 3 };
  };
  const result = await fetchAllSub2APIKeys({}, {}, { listKeys, pageSize: 2 });
  assert.deepEqual(calls, [1, 2, 3]);
  assert.deepEqual(result.items.map((item) => item.id), [1, 2, 3, 4]);
  assert.equal(result.pages, 3);
});

test('fetchAllSub2APIKeys derives pages from total when pages is omitted', async () => {
  const calls = [];
  const listKeys = async (site, creds, options) => {
    calls.push(options.page);
    return {
      items: options.page === 1 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }],
      total: 3,
      pages: 0
    };
  };
  const result = await fetchAllSub2APIKeys({}, {}, { listKeys, pageSize: 2 });
  assert.deepEqual(calls, [1, 2]);
  assert.equal(result.items.length, 3);
});

test('importAllKeys reconciles only after the complete fetch succeeds', async () => {
  const events = [];
  const repository = {
    getSite: () => ({ id: 7, name: 'Fixture', status: 'active' }),
    getCredentials: () => ({ token: 'secret' }),
    startKeyImportRun: () => 11,
    reconcileKeySnapshots: (siteId, items, capturedAt, options) => {
      events.push({ type: 'reconcile', siteId, count: items.length, options });
      return { total: items.length, added: 2, updated: 0, missing: 1, group_changes: 0 };
    },
    finishKeyImportRun: (runId, result) => ({ id: runId, ...result })
  };
  const listKeys = async (site, creds, options) => ({
    items: options.page === 1
      ? [{ id: 1, key_full: 'sk-a' }]
      : [{ id: 2, key_full: null }],
    total: 2,
    pages: 2
  });
  const result = await importAllKeys(7, { repo: repository, listKeys, pageSize: 1 });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: 'reconcile', siteId: 7, count: 2, options: { markMissing: true } });
  assert.equal(result.full_key_count, 1);
});
