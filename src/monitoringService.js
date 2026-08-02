const repo = require('./repository');
const { finiteNumberOrNull } = require('./utils');

const KEY_FAILURE_STATES = new Set(['timeout', 'auth_failed', 'quota_exhausted', 'upstream_error']);

function siteFreshness(site, now = Date.now()) {
  if (!site.last_sync_at) return { stale: true, age_ms: null };
  const ageMs = Math.max(0, now - new Date(site.last_sync_at).getTime());
  const staleAfterMs = Math.max(Number(site.sync_interval_seconds || 180) * 3, 3600) * 1000;
  return { stale: ageMs > staleAfterMs, age_ms: ageMs };
}

function buildUpstreamMonitoring(repository = repo, now = Date.now()) {
  const items = repository.listSites().map((site) => {
    const modelGroups = repository.listUpstreamProbeModels?.(site.id) || [];
    const syncedAt = modelGroups.map((group) => group.synced_at).filter(Boolean).sort().at(-1) || null;
    const uniqueModels = new Set(modelGroups.flatMap((group) => (group.models || []).map((item) => item.model).filter(Boolean)));
    const unavailableGroups = modelGroups.filter((group) => group.discovery_status === 'unavailable').length;
    const staleGroups = modelGroups.filter((group) => group.discovery_status === 'stale').length;
    const errorGroups = modelGroups.filter((group) => String(group.discovery_error || '').trim()).length;
    const modelSyncStatus = !modelGroups.length
      ? 'never'
      : uniqueModels.size === 0
        ? 'failed'
        : unavailableGroups || errorGroups
          ? 'partial'
          : staleGroups
            ? 'stale'
            : 'success';
    const modelsByGroup = new Map(modelGroups.map((group) => [
      String(group.group_id),
      (group.models || []).map((item) => item.model).filter(Boolean)
    ]));
    const modelsByPlatform = new Map();
    for (const group of modelGroups) {
      const platform = String(group.platform || '').toLowerCase();
      const normalized = platform.includes('anthropic') || platform.includes('claude') ? 'anthropic' : 'openai';
      const current = modelsByPlatform.get(normalized) || new Set();
      for (const item of group.models || []) {
        if (item.model) current.add(item.model);
      }
      modelsByPlatform.set(normalized, current);
    }
    const keys = repository.listKeySnapshotsWithHealth(site.id, { includeMissing: true }, 5000).map((key) => {
      const platform = String(key.platform || '').toLowerCase();
      const platformFallback = platform.includes('anthropic') || platform.includes('claude')
        ? site.anthropic_probe_model
        : site.openai_probe_model;
      const normalizedPlatform = platform.includes('anthropic') || platform.includes('claude') ? 'anthropic' : 'openai';
      const groupOptions = modelsByGroup.get(String(key.group_id ?? '')) || [];
      return {
        ...key,
        probe_model_options: groupOptions.length
          ? groupOptions
          : [...(modelsByPlatform.get(normalizedPlatform) || [])],
        effective_probe_model: key.selected_probe_model || key.group_probe_model || platformFallback || ''
      };
    });
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
      model_sync: {
        status: modelSyncStatus,
        synced_at: syncedAt,
        group_count: modelGroups.length,
        model_count: uniqueModels.size,
        unavailable_groups: unavailableGroups,
        stale_groups: staleGroups,
        error_groups: errorGroups
      },
      keys
    };
  });
  const totals = items.reduce((acc, site) => {
    const balance = finiteNumberOrNull(site.balance);
    const lowBalance = balance !== null && balance < Number(site.low_balance_threshold || 10);
    const hasOperationalIssue = site.status === 'sync_failed' || site.balance_stale || site.key_abnormal_count > 0 || lowBalance;
    acc.upstreams += 1;
    if (site.status === 'active' && !hasOperationalIssue) acc.healthy += 1;
    if (balance !== null) acc.balance += balance;
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
