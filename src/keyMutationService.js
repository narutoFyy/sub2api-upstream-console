const repo = require('./repository');
const { fetchAllSub2APIKeys } = require('./keyImportService');
const { listSub2APIKeys, updateSub2APIKey, deleteSub2APIKey } = require('./upstreamKeys');
const { nowIso } = require('./utils');

function managedKeyContext(siteId, repository) {
  const site = repository.getSite(siteId);
  if (!site) {
    const error = new Error('Upstream not found');
    error.status = 404;
    throw error;
  }
  return { site, credentials: repository.getCredentials(siteId) || {} };
}

async function refreshManagedKeys(siteId, dependencies = {}) {
  const repository = dependencies.repo || repo;
  const { site, credentials } = managedKeyContext(siteId, repository);
  const result = await fetchAllSub2APIKeys(site, credentials, {
    listKeys: dependencies.listKeys || listSub2APIKeys,
    pageSize: dependencies.pageSize || 100
  });
  const capturedAt = nowIso();
  const reconciled = repository.reconcileImportedKeys
    ? repository.reconcileImportedKeys(siteId, result.items, capturedAt, { markMissing: true })
    : { summary: repository.reconcileKeySnapshots(siteId, result.items, capturedAt, { markMissing: true }) };
  const summary = reconciled.summary;
  return { items: result.items, summary };
}

async function updateManagedKey(siteId, keyId, payload, dependencies = {}) {
  const repository = dependencies.repo || repo;
  const { site, credentials } = managedKeyContext(siteId, repository);
  const updateKey = dependencies.updateKey || updateSub2APIKey;
  await updateKey(site, credentials, keyId, payload);
  const refreshed = await refreshManagedKeys(siteId, dependencies);
  const item = refreshed.items.find((key) => String(key.id) === String(keyId));
  if (!item) {
    const error = new Error('上游已接受修改，但刷新后未找到该 Key');
    error.status = 502;
    throw error;
  }
  return { item, summary: refreshed.summary };
}

async function deleteManagedKey(siteId, keyId, dependencies = {}) {
  const repository = dependencies.repo || repo;
  const { site, credentials } = managedKeyContext(siteId, repository);
  const deleteKey = dependencies.deleteKey || deleteSub2APIKey;
  await deleteKey(site, credentials, keyId);
  const refreshed = await refreshManagedKeys(siteId, dependencies);
  if (refreshed.items.some((key) => String(key.id) === String(keyId))) {
    const error = new Error('上游删除后仍返回该 Key，请稍后重试');
    error.status = 502;
    throw error;
  }
  return { deleted: true, id: String(keyId), summary: refreshed.summary };
}

module.exports = {
  refreshManagedKeys,
  updateManagedKey,
  deleteManagedKey
};
