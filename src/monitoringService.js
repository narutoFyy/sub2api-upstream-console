const repo = require('./repository');

const KEY_FAILURE_STATES = new Set(['timeout', 'auth_failed', 'quota_exhausted', 'upstream_error']);

function siteFreshness(site, now = Date.now()) {
  if (!site.last_sync_at) return { stale: true, age_ms: null };
  const ageMs = Math.max(0, now - new Date(site.last_sync_at).getTime());
  const staleAfterMs = Math.max(Number(site.sync_interval_seconds || 180) * 3, 3600) * 1000;
  return { stale: ageMs > staleAfterMs, age_ms: ageMs };
}

function buildUpstreamMonitoring(repository = repo, now = Date.now()) {
  const items = repository.listSites().map((site) => {
    const keys = repository.listKeySnapshotsWithHealth(site.id, { includeMissing: true }, 5000);
    const freshness = siteFreshness(site, now);
    const activeKeys = keys.filter((key) => key.import_state !== 'missing');
    const abnormalKeys = activeKeys.filter((key) => KEY_FAILURE_STATES.has(key.connectivity_status)).length;
    const untestedKeys = activeKeys.filter((key) => !key.connectivity_status || ['untested', 'unconfigured', 'unavailable'].includes(key.connectivity_status)).length;
    return {
      ...site,
      balance_stale: freshness.stale,
      balance_age_ms: freshness.age_ms,
      key_count: activeKeys.length,
      key_abnormal_count: abnormalKeys,
      key_untested_count: untestedKeys,
      keys
    };
  });
  const totals = items.reduce((acc, site) => {
    const lowBalance = Number.isFinite(Number(site.balance)) && Number(site.balance) < Number(site.low_balance_threshold || 10);
    const hasOperationalIssue = site.status === 'sync_failed' || site.balance_stale || site.key_abnormal_count > 0 || lowBalance;
    acc.upstreams += 1;
    if (site.status === 'active' && !hasOperationalIssue) acc.healthy += 1;
    if (Number.isFinite(Number(site.balance))) acc.balance += Number(site.balance);
    acc.keys += Number(site.key_count || 0);
    acc.key_abnormal += Number(site.key_abnormal_count || 0);
    if (lowBalance) acc.low_balance += 1;
    if (hasOperationalIssue) acc.abnormal += 1;
    return acc;
  }, { upstreams: 0, healthy: 0, balance: 0, keys: 0, key_abnormal: 0, low_balance: 0, abnormal: 0 });
  return { totals, items };
}

module.exports = {
  KEY_FAILURE_STATES,
  siteFreshness,
  buildUpstreamMonitoring
};
