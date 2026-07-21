const repo = require('./repository');
const { listSub2APIKeys } = require('./upstreamKeys');
const { nowIso } = require('./utils');

function keyIdentity(key) {
  return String(key?.id ?? key?.upstream_key_id ?? key?.key_masked ?? key?.name ?? '');
}

async function fetchAllSub2APIKeys(site, creds, { listKeys = listSub2APIKeys, pageSize = 100 } = {}) {
  const byId = new Map();
  let page = 1;
  let pages = 1;
  let reportedTotal = 0;

  while (page <= pages && page <= 1000) {
    const result = await listKeys(site, creds, { page, pageSize });
    const items = Array.isArray(result.items) ? result.items : [];
    reportedTotal = Math.max(reportedTotal, Number(result.total || 0));
    pages = Math.max(1, Number(result.pages || 0), Math.ceil(reportedTotal / pageSize));
    for (const item of items) {
      const identity = keyIdentity(item);
      if (identity) byId.set(identity, item);
    }
    if (!items.length || (reportedTotal && byId.size >= reportedTotal)) break;
    page += 1;
  }

  if (page > 1000) {
    throw new Error('Key import stopped because the upstream reported more than 1000 pages');
  }

  return {
    items: [...byId.values()],
    pages: Math.min(page, pages),
    total: reportedTotal || byId.size
  };
}

async function importAllKeys(siteId, dependencies = {}) {
  const repository = dependencies.repo || repo;
  const site = repository.getSite(siteId);
  if (!site) {
    const error = new Error('Upstream not found');
    error.status = 404;
    throw error;
  }
  if (site.status === 'disabled') {
    const error = new Error('Disabled upstreams cannot import Keys');
    error.status = 422;
    throw error;
  }

  const startedAt = nowIso();
  const runId = repository.startKeyImportRun(siteId, startedAt);
  try {
    const creds = repository.getCredentials(siteId) || {};
    const result = await fetchAllSub2APIKeys(site, creds, dependencies);
    const capturedAt = nowIso();
    const reconciled = repository.reconcileImportedKeys
      ? repository.reconcileImportedKeys(siteId, result.items, capturedAt, { markMissing: true })
      : {
          summary: repository.reconcileKeySnapshots(siteId, result.items, capturedAt, { markMissing: true }),
          secrets: repository.reconcileKeySecrets
            ? repository.reconcileKeySecrets(siteId, result.items, { removeMissing: true, at: capturedAt })
            : null
        };
    const summary = reconciled.summary;
    const fullKeyCount = reconciled.secrets?.full_key_count
      ?? result.items.filter((item) => Boolean(item.key_full)).length;
    const run = repository.finishKeyImportRun(runId, {
      status: 'success',
      pages: result.pages,
      total: summary.total,
      added: summary.added,
      updated: summary.updated,
      missing: summary.missing,
      group_changes: summary.group_changes,
      full_key_count: fullKeyCount
    }, capturedAt);
    return { run, summary, secret_summary: reconciled.secrets, full_key_count: fullKeyCount };
  } catch (error) {
    repository.finishKeyImportRun(runId, {
      status: 'failed',
      error_message: error.message
    });
    throw error;
  }
}

module.exports = {
  fetchAllSub2APIKeys,
  importAllKeys,
  keyIdentity
};
