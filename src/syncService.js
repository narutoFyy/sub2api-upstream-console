const repo = require('./repository');
const { fetchSub2APIState } = require('./upstreamClient');
const { nowIso } = require('./utils');
const { evaluateSiteAlerts } = require('./alertService');
const { runtimeSettingsStatus } = require('./runtimeSettings');

function rechargeSummary(snapshot) {
  const multiplier = Number(snapshot?.balance_recharge_multiplier);
  if (!Number.isFinite(multiplier) || Number(snapshot?.balance_recharge_disabled)) {
    return 'recharge=n/a';
  }
  return `recharge=1 RMB->${multiplier} balance`;
}

async function syncSite(siteId, dependencies = {}) {
  const repository = dependencies.repo || repo;
  const settings = dependencies.settings || runtimeSettingsStatus({ repository }).settings;
  const site = repository.getSite(siteId);
  if (!site) {
    throw new Error(`Upstream site ${siteId} not found`);
  }
  const creds = repository.getCredentials(siteId) || {};
  const startedAt = nowIso();
  try {
    const result = await fetchSub2APIState({
      baseUrl: site.base_url,
      upstreamType: site.upstream_type || 'auto',
      email: creds.email,
      password: creds.password,
      token: creds.token
    });
    repository.saveSyncSuccess(siteId, result, {
      maxSyncLogs: settings.max_sync_logs,
      maxRateSnapshots: settings.max_rate_snapshots
    });
    repository.saveSyncLog(
      siteId,
      'full',
      startedAt,
      'success',
      null,
      `balance=${result.snapshot.balance ?? 'n/a'}, rates=${result.rates.length}, modelPricing=${result.model_pricing?.length || 0}, keys=${result.keys.length}, todayTokens=${result.snapshot.today_tokens}, ${rechargeSummary(result.snapshot)}`
    );
    (dependencies.evaluateAlerts || evaluateSiteAlerts)(siteId, {
      ...dependencies,
      settings,
      repo: repository
    }).catch((error) => {
      console.error(`Site alert delivery failed for upstream ${siteId}:`, error.message);
    });
    return result;
  } catch (err) {
    repository.saveSyncLog(siteId, 'full', startedAt, 'failed', err);
    (dependencies.evaluateAlerts || evaluateSiteAlerts)(siteId, {
      ...dependencies,
      settings,
      repo: repository
    }).catch((error) => {
      console.error(`Site alert delivery failed for upstream ${siteId}:`, error.message);
    });
    throw err;
  }
}

async function syncAllSites(dependencies = {}) {
  const repository = dependencies.repo || repo;
  const sites = repository.listSites().filter((site) => site.status !== 'disabled');
  const results = [];
  for (const site of sites) {
    try {
      const result = await syncSite(site.id, dependencies);
      results.push({ site_id: site.id, status: 'success', snapshot: result.snapshot });
    } catch (err) {
      results.push({ site_id: site.id, status: 'failed', error: err.message });
    }
  }
  return results;
}

function shouldSyncSite(site, now = Date.now(), defaultIntervalSeconds = 180) {
  if (site.status === 'disabled' || Number(site.sync_enabled ?? 1) === 0) return false;
  if (!site.last_sync_at) return true;
  const intervalMs = Number(site.sync_interval_seconds || defaultIntervalSeconds) * 1000;
  return now - new Date(site.last_sync_at).getTime() >= intervalMs;
}

async function syncDueSites(dependencies = {}) {
  const repository = dependencies.repo || repo;
  const settings = dependencies.settings || runtimeSettingsStatus({ repository }).settings;
  const now = dependencies.now || Date.now();
  const sites = repository.listSites().filter((site) => (
    shouldSyncSite(site, now, settings.sync_default_interval_seconds)
  ));
  const results = [];
  for (const site of sites) {
    try {
      const result = await syncSite(site.id, { ...dependencies, repo: repository, settings });
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
