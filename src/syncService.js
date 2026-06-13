const repo = require('./repository');
const { fetchSub2APIState } = require('./upstreamClient');
const { nowIso } = require('./utils');

function rechargeSummary(snapshot) {
  const multiplier = Number(snapshot?.balance_recharge_multiplier);
  if (!Number.isFinite(multiplier) || Number(snapshot?.balance_recharge_disabled)) {
    return 'recharge=n/a';
  }
  return `recharge=1 RMB->${multiplier} balance`;
}

async function syncSite(siteId) {
  const site = repo.getSite(siteId);
  if (!site) {
    throw new Error(`Upstream site ${siteId} not found`);
  }
  const creds = repo.getCredentials(siteId) || {};
  const startedAt = nowIso();
  try {
    const result = await fetchSub2APIState({
      baseUrl: site.base_url,
      upstreamType: site.upstream_type || 'auto',
      email: creds.email,
      password: creds.password,
      token: creds.token
    });
    repo.saveSyncSuccess(siteId, result);
    repo.saveSyncLog(
      siteId,
      'full',
      startedAt,
      'success',
      null,
      `balance=${result.snapshot.balance ?? 'n/a'}, rates=${result.rates.length}, modelPricing=${result.model_pricing?.length || 0}, keys=${result.keys.length}, todayTokens=${result.snapshot.today_tokens}, ${rechargeSummary(result.snapshot)}`
    );
    return result;
  } catch (err) {
    repo.saveSyncLog(siteId, 'full', startedAt, 'failed', err);
    throw err;
  }
}

async function syncAllSites() {
  const sites = repo.listSites().filter((site) => site.status !== 'disabled');
  const results = [];
  for (const site of sites) {
    try {
      const result = await syncSite(site.id);
      results.push({ site_id: site.id, status: 'success', snapshot: result.snapshot });
    } catch (err) {
      results.push({ site_id: site.id, status: 'failed', error: err.message });
    }
  }
  return results;
}

function shouldSyncSite(site, now = Date.now()) {
  if (site.status === 'disabled') return false;
  if (!site.last_sync_at) return true;
  const intervalMs = Number(site.sync_interval_seconds || 180) * 1000;
  return now - new Date(site.last_sync_at).getTime() >= intervalMs;
}

async function syncDueSites() {
  const now = Date.now();
  const sites = repo.listSites().filter((site) => shouldSyncSite(site, now));
  const results = [];
  for (const site of sites) {
    try {
      const result = await syncSite(site.id);
      results.push({ site_id: site.id, status: 'success', snapshot: result.snapshot });
    } catch (err) {
      results.push({ site_id: site.id, status: 'failed', error: err.message });
    }
  }
  return results;
}

module.exports = {
  syncSite,
  syncAllSites,
  syncDueSites,
  shouldSyncSite
};
