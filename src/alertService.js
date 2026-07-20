const config = require('./config');
const repo = require('./repository');
const { sendPushPlus } = require('./pushPlusClient');

const KEY_FAILURE_STATES = new Set(['timeout', 'auth_failed', 'quota_exhausted', 'upstream_error']);

function keyStatusLabel(status) {
  return {
    timeout: '超时',
    auth_failed: '鉴权失败',
    quota_exhausted: '额度不足',
    upstream_error: '上游错误'
  }[status] || status || '未知错误';
}

async function notifyIncident(alert, dependencies = {}) {
  const notify = dependencies.notify || sendPushPlus;
  return notify({ title: alert.title, content: alert.message }, dependencies);
}

async function openAndNotify(input, dependencies = {}) {
  const repository = dependencies.repo || repo;
  const alert = repository.openOrTouchAlert(input);
  if (!alert.notified_at) {
    try {
      await notifyIncident(alert, dependencies);
      return repository.markAlertNotified(alert.id);
    } catch (error) {
      if (dependencies.onNotificationError) dependencies.onNotificationError(error);
      else console.error('PushPlus incident delivery failed:', error.message);
      return { ...alert, notification_error: error.message };
    }
  }
  return alert;
}

async function resolveAndNotify(fingerprint, recoveryTitle, recoveryMessage, dependencies = {}) {
  const repository = dependencies.repo || repo;
  const open = repository.findOpenAlert(fingerprint);
  if (!open) return null;
  const resolved = repository.resolveAlert(fingerprint);
  if (open.notified_at && !resolved.recovery_notified_at) {
    try {
      await notifyIncident({ title: recoveryTitle, message: recoveryMessage }, dependencies);
      return repository.markRecoveryNotified(resolved.id);
    } catch (error) {
      if (dependencies.onNotificationError) dependencies.onNotificationError(error);
      else console.error('PushPlus recovery delivery failed:', error.message);
      return { ...resolved, notification_error: error.message };
    }
  }
  return resolved;
}

async function evaluateKeyConnectivity(site, key, state, dependencies = {}) {
  const failureThreshold = Number(dependencies.failureThreshold || config.alertFailureThreshold || 3);
  const recoveryThreshold = Number(dependencies.recoveryThreshold || config.alertRecoveryThreshold || 2);
  const fingerprint = `key_connectivity:${site.id}:${key.upstream_key_id || key.id}`;
  const masked = key.key_masked || `Key #${key.upstream_key_id || key.id}`;

  if (KEY_FAILURE_STATES.has(state.status) && Number(state.consecutive_failures || 0) >= failureThreshold) {
    return openAndNotify({
      fingerprint,
      event_type: 'key_connectivity',
      severity: state.status === 'quota_exhausted' || state.status === 'auth_failed' ? 'critical' : 'warning',
      upstream_site_id: site.id,
      upstream_key_id: String(key.upstream_key_id || key.id || ''),
      title: `[上游异常] ${site.name} · ${key.name || masked}`,
      message: [
        `上游：${site.name}`,
        `Key：${masked}`,
        `状态：${keyStatusLabel(state.status)}`,
        state.model ? `检测模型：${state.model}` : '',
        state.error_message ? `原因：${state.error_message}` : '',
        `连续失败：${state.consecutive_failures} 次`,
        `时间：${state.last_checked_at || new Date().toISOString()}`
      ].filter(Boolean).join('\n')
    }, dependencies);
  }

  if (state.status === 'connected' && Number(state.consecutive_successes || 0) >= recoveryThreshold) {
    return resolveAndNotify(
      fingerprint,
      `[上游恢复] ${site.name} · ${key.name || masked}`,
      `上游：${site.name}\nKey：${masked}\n状态：已恢复联通\n耗时：${state.latency_ms ?? '-'}ms\n时间：${state.last_checked_at || new Date().toISOString()}`,
      dependencies
    );
  }
  return null;
}

async function evaluateSiteAlerts(siteId, dependencies = {}) {
  const repository = dependencies.repo || repo;
  const site = repository.listSites().find((item) => Number(item.id) === Number(siteId));
  if (!site) return [];
  const results = [];
  const lowBalanceFingerprint = `low_balance:${site.id}`;
  const balance = Number(site.balance);
  const threshold = Number(site.low_balance_threshold || 10);
  if (Number.isFinite(balance) && balance < threshold) {
    results.push(await openAndNotify({
      fingerprint: lowBalanceFingerprint,
      event_type: 'low_balance',
      severity: balance <= 0 ? 'critical' : 'warning',
      upstream_site_id: site.id,
      title: `[余额预警] ${site.name}`,
      message: `上游：${site.name}\n当前余额：${balance}\n预警阈值：${threshold}\n时间：${site.last_sync_at || new Date().toISOString()}`
    }, dependencies));
  } else if (Number.isFinite(balance)) {
    results.push(await resolveAndNotify(
      lowBalanceFingerprint,
      `[余额恢复] ${site.name}`,
      `上游：${site.name}\n当前余额：${balance}\n状态：已高于预警阈值`,
      dependencies
    ));
  }

  const syncFingerprint = `sync_failed:${site.id}`;
  if (site.status === 'sync_failed' && Number(site.sync_failure_count || 0) >= Number(config.alertFailureThreshold || 3)) {
    results.push(await openAndNotify({
      fingerprint: syncFingerprint,
      event_type: 'sync_failed',
      severity: 'critical',
      upstream_site_id: site.id,
      title: `[同步失败] ${site.name}`,
      message: `上游：${site.name}\n连续失败：${site.sync_failure_count} 次\n原因：${site.last_sync_error || '未知'}\n时间：${new Date().toISOString()}`
    }, dependencies));
  } else if (site.status === 'active' && Number(site.sync_success_count || 0) >= Number(config.alertRecoveryThreshold || 2)) {
    results.push(await resolveAndNotify(
      syncFingerprint,
      `[同步恢复] ${site.name}`,
      `上游：${site.name}\n状态：同步已恢复\n时间：${site.last_sync_at || new Date().toISOString()}`,
      dependencies
    ));
  }
  return results.filter(Boolean);
}

module.exports = {
  KEY_FAILURE_STATES,
  keyStatusLabel,
  openAndNotify,
  resolveAndNotify,
  evaluateKeyConnectivity,
  evaluateSiteAlerts
};
