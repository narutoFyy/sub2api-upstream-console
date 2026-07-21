require('./testEnv');

const test = require('node:test');
const assert = require('node:assert/strict');
const { updateManagedKey, deleteManagedKey } = require('../src/keyMutationService');

function fixture() {
  let keys = [
    { id: 1, name: 'A', status: 'active', key_masked: 'sk-...a' },
    { id: 2, name: 'B', status: 'active', key_masked: 'sk-...b' }
  ];
  const snapshots = [];
  const repository = {
    getSite: () => ({ id: 3, base_url: 'https://fixture.example' }),
    getCredentials: () => ({ token: 'admin' }),
    reconcileKeySnapshots: (siteId, items, capturedAt, options) => {
      snapshots.push(items.map((item) => ({ ...item })));
      return { total: items.length, missing: options.markMissing ? 1 : 0 };
    }
  };
  return {
    repository,
    snapshots,
    listKeys: async () => ({ items: keys.map((key) => ({ ...key })), total: keys.length, pages: 1 }),
    updateKey: async (site, credentials, keyId, payload) => {
      keys = keys.map((key) => String(key.id) === String(keyId) ? { ...key, ...payload } : key);
    },
    deleteKey: async (site, credentials, keyId) => {
      keys = keys.filter((key) => String(key.id) !== String(keyId));
    }
  };
}

test('managed Key update returns only after the refreshed upstream state is reconciled', async () => {
  const target = fixture();
  const result = await updateManagedKey(3, 1, { status: 'inactive' }, { repo: target.repository, listKeys: target.listKeys, updateKey: target.updateKey });
  assert.equal(result.item.status, 'inactive');
  assert.equal(target.snapshots.length, 1);
  assert.equal(target.snapshots[0].find((key) => key.id === 1).status, 'inactive');
});

test('managed Key delete verifies absence before returning success', async () => {
  const target = fixture();
  const result = await deleteManagedKey(3, 2, { repo: target.repository, listKeys: target.listKeys, deleteKey: target.deleteKey });
  assert.equal(result.deleted, true);
  assert.equal(target.snapshots.length, 1);
  assert.equal(target.snapshots[0].some((key) => key.id === 2), false);
});

test('failed upstream mutations do not reconcile a false local state', async () => {
  const target = fixture();
  await assert.rejects(
    updateManagedKey(3, 1, { status: 'inactive' }, {
      repo: target.repository,
      listKeys: target.listKeys,
      updateKey: async () => { throw new Error('upstream rejected'); }
    }),
    /upstream rejected/
  );
  assert.equal(target.snapshots.length, 0);
});
