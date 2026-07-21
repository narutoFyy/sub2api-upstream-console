const repo = require('./repository');
const { sendPushPlus } = require('./pushPlusClient');
const { defaultRuntimeSettings, runtimeSettingsStatus } = require('./runtimeSettings');

const KEY_FAILURE_STATES = new Set(['timeout', 'auth_failed', 'quota_exhausted', 'upstream_error']);

function keyStatusLabel(status, errorCode = '') {
  if (errorCode === 'ip_blocked') return '出口 IP 被拒绝';
  return {
    timeout: '超时',
    auth_failed: '鉴权失败',
    quota_exhausted: '额度不足',
    upstream_error: '上游错误'
  }[status] || status || '未知错误';
}

function alertSettings(dependencies = {}) {
  const repository = dependencies.repo || repo;
  let settings = dependencies.settings;
  if (!settings) {
    settings = typeof repository.getSecretSetting === 'function'
      ? runtimeSettingsStatus({ repository }).settings
      : defaultRuntimeSettings();
  }
  return {
    ...settings,
    alert_failure_threshold: Number(dependencies.failureThreshold || settings.alert_failure_threshold || 3),
    alert_recovery_threshold: Number(dependencies.recoveryThreshold || settings.alert_recovery_threshold || 2)
  };
}

function minutesFromClock(value) {
  const [hour, minute] = String(value || '').split(':').map(Number);
  return (hour * 60) + minute;
}

function isQuietHours(settings, date = new Date()) {
  if (!settings.quiet_hours_enabled) return false;
  const start = minutesFromClock(settings.quiet_hours_start);
  const end = minutesFromClock(settings.quiet_hours_end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
  const current = (date.getHours() * 60) + date.getMinutes();
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
}

function eventDeliveryEnabled(eventType, settings) {
  return {
    key_connectivity: settings.notify_key_connectivity,
    low_balance: settings.notify_low_balance,
    sync_failed: settings.notify_sync_failure
  }[eventType] !== false;
}

function quietHoursBlock(settings, severity, now) {
  return isQuietHours(settings, now)
    && !(settings.quiet_hours_critical_bypass && severity === 'critical');
}

function incidentNotificationDue(alert, input, settings, now = new Date()) {
  if (!settings.notifications_enabled || input.delivery_enabled === false) return false;
  if (!eventDeliveryEnabled(input.event_type, settings)) return false;
  if (input.error_code === 'ip_blocked' && !settings.notify_ip_blocked) return false;
  if (alert.acknowledged_at || quietHoursBlock(settings, input.severity, now)) return false;
  if (!alert.notified_at) return true;
  const repeatSeconds = Number(settings.alert_repeat_interval_seconds || 0);
  if (!repeatSeconds) return false;
  const last = new Date(alert.last_notified_at || alert.notified_at).getTime();
  return Number.isFinite(last) && now.getTime() - last >= repeatSeconds * 1000;
}

function recoveryNotificationDue(alert, input, settings, now = new Date()) {
  if (!settings.notifications_enabled || !settings.notify_recovery || input.delivery_enabled === false) return false;
  if (!alert.notified_at || alert.recovery_notified_at) return false;
  return !quietHoursBlock(settings, input.severity, now);
}

function notificationDescriptor(kind, alert, input) {
  return {
    kind,
    alert,
    title: input.title,
    message: input.message,
    severity: input.severity || alert.severity || 'warning',
    upstream_site_id: input.upstream_site_id ?? alert.upstream_site_id,
    upstream_name: input.upstream_name || '',
    event_type: input.event_type || alert.event_type
  };
}

function groupedPayload(group) {
  if (group.length === 1) return { title: group[0].title, content: group[0].message };
  const first = group[0];
  const prefix = first.kind === 'recovery' ? '上游恢复' : '上游异常';
  const title = `[${prefix}] ${first.upstream_name || `#${first.upstream_site_id}`} · ${group.length} 个事件`;
  const content = group.map((item, index) => (
    `${index + 1}. ${item.title}\n${item.message}`
  )).join('\n\n').slice(0, 5000);
  return { title, content };
}

function groupNotifications(items, grouping) {
  if (grouping === 'key') return items.map((item) => [item]);
  const groups = new Map();
  for (const item of items) {
    const key = `${item.kind}:${item.upstream_site_id ?? 'global'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()];
}

async function deliverAlertNotifications(items, dependencies = {}) {
  const notifications = (items || []).filter(Boolean);
  if (!notifications.length) return { sent: 0, errors: [] };
  const repository = dependencies.repo || repo;
  const settings = alertSettings(dependencies);
  const notify = dependencies.notify || sendPushPlus;
  let sent = 0;
  const errors = [];

  for (const group of groupNotifications(notifications, settings.notification_grouping)) {
    try {
      await notify(groupedPayload(group), {
        ...dependencies,
        timeoutMs: settings.pushplus_timeout_ms
      });
      for (const item of group) {
        if (item.kind === 'recovery') repository.markRecoveryNotified(item.alert.id);
        else repository.markAlertNotified(item.alert.id);
      }
      sent += 1;
    } catch (error) {
      errors.push(error);
      if (dependencies.onNotificationError) dependencies.onNotificationError(error);
      else console.error('PushPlus alert delivery failed:', error.message);
    }
  }
  return { sent, errors };
}

async function openAndNotify(input, dependencies = {}) {
  const repository = dependencies.repo || repo;
  const settings = alertSettings(dependencies);
  const alert = repository.openOrTouchAlert(input);
  const now = dependencies.now instanceof Date ? dependencies.now : new Date(dependencies.now || Date.now());
  const notification = incidentNotificationDue(alert, input, settings, now)
    ? notificationDescriptor('incident', alert, input)
    : null;
  if (dependencies.deferNotification) return { alert, notification };
  const delivery = await deliverAlertNotifications([notification], { ...dependencies, settings });
  return delivery.errors.length ? { ...alert, notification_error: delivery.errors[0].message } : alert;
}

async function resolveAndNotify(fingerprint, input, dependencies = {}) {
  const repository = dependencies.repo || repo;
  const settings = alertSettings(dependencies);
  const open = repository.findOpenAlert(fingerprint);
  let resolved = open ? repository.resolveAlert(fingerprint) : repository.findLatestAlert?.(fingerprint);
  if (!resolved || resolved.status !== 'resolved') return null;
  const now = dependencies.now instanceof Date ? dependencies.now : new Date(dependencies.now || Date.now());
  const notification = recoveryNotificationDue(resolved, input, settings, now)
    ? notificationDescriptor('recovery', resolved, input)
    : null;
  if (dependencies.deferNotification) return { alert: resolved, notification };
  const delivery = await deliverAlertNotifications([notification], { ...dependencies, settings });
  return delivery.errors.length ? { ...resolved, notification_error: delivery.errors[0].message } : resolved;
}

async function evaluateKeyConnectivity(site, key, state, dependencies = {}) {
  const settings = alertSettings(dependencies);
  const failureThreshold = settings.alert_failure_threshold;
  const recoveryThreshold = settings.alert_recovery_threshold;
  const fingerprint = `key_connectivity:${site.id}:${key.upstream_key_id || key.id}`;
  const masked = key.key_masked || `Key #${key.upstream_key_id || key.id}`;
  const deliveryEnabled = Number(site.alert_notifications_enabled ?? 1) !== 0;

  if (KEY_FAILURE_STATES.has(state.status) && Number(state.consecutive_failures || 0) >= failureThreshold) {
    return openAndNotify({
      fingerprint,
      event_type: 'key_connectivity',
      error_code: state.error_code || '',
      severity: state.status === 'quota_exhausted' || state.status === 'auth_failed' ? 'critical' : 'warning',
      delivery_enabled: deliveryEnabled,
      upstream_site_id: site.id,
      upstream_name: site.name,
      upstream_key_id: String(key.upstream_key_id || key.id || ''),
      title: `[上游异常] ${site.name} · ${key.name || masked}`,
      message: [
        `上游：${site.name}`,
        `Key：${masked}`,
        `状态：${keyStatusLabel(state.status, state.error_code)}`,
        state.model ? `检测模型：${state.model}` : '',
        state.error_message ? `原因：${state.error_message}` : '',
        `连续失败：${state.consecutive_failures} 次`,
        `时间：${state.last_checked_at || new Date().toISOString()}`
      ].filter(Boolean).join('\n')
    }, { ...dependencies, settings });
  }

  if (state.status === 'connected' && Number(state.consecutive_successes || 0) >= recoveryThreshold) {
    return resolveAndNotify(fingerprint, {
      event_type: 'key_connectivity',
      severity: 'warning',
      delivery_enabled: deliveryEnabled,
      upstream_site_id: site.id,
      upstream_name: site.name,
      title: `[上游恢复] ${site.name} · ${key.name || masked}`,
      message: `上游：${site.name}\nKey：${masked}\n状态：已恢复联通\n耗时：${state.latency_ms ?? '-'}ms\n时间：${state.last_checked_at || new Date().toISOString()}`
    }, { ...dependencies, settings });
  }
  return null;
}

async function evaluateSiteAlerts(siteId, dependencies = {}) {
  const repository = dependencies.repo || repo;
  const settings = alertSettings(dependencies);
  const site = repository.listSites().find((item) => Number(item.id) === Number(siteId));
  if (!site) return [];
  const results = [];
  const deliveryEnabled = Number(site.alert_notifications_enabled ?? 1) !== 0;
  const lowBalanceFingerprint = `low_balance:${site.id}`;
  const balance = Number(site.balance);
  const threshold = Number(site.low_balance_threshold || settings.upstream_default_low_balance_threshold || 10);
  if (Number(site.low_balance_alert_enabled ?? 1) !== 0 && Number.isFinite(balance) && balance < threshold) {
    results.push(await openAndNotify({
      fingerprint: lowBalanceFingerprint,
      event_type: 'low_balance',
      severity: balance <= 0 ? 'critical' : 'warning',
      delivery_enabled: deliveryEnabled,
      upstream_site_id: site.id,
      upstream_name: site.name,
      title: `[余额预警] ${site.name}`,
      message: `上游：${site.name}\n当前余额：${balance}\n预警阈值：${threshold}\n时间：${site.last_sync_at || new Date().toISOString()}`
    }, { ...dependencies, settings, deferNotification: true }));
  } else if (Number.isFinite(balance) && balance >= threshold) {
    results.push(await resolveAndNotify(lowBalanceFingerprint, {
      event_type: 'low_balance',
      severity: 'warning',
      delivery_enabled: deliveryEnabled,
      upstream_site_id: site.id,
      upstream_name: site.name,
      title: `[余额恢复] ${site.name}`,
      message: `上游：${site.name}\n当前余额：${balance}\n状态：已高于预警阈值`
    }, { ...dependencies, settings, deferNotification: true }));
  }

  const syncFingerprint = `sync_failed:${site.id}`;
  if (site.status === 'sync_failed' && Number(site.sync_failure_count || 0) >= settings.alert_failure_threshold) {
    results.push(await openAndNotify({
      fingerprint: syncFingerprint,
      event_type: 'sync_failed',
      severity: 'critical',
      delivery_enabled: deliveryEnabled,
      upstream_site_id: site.id,
      upstream_name: site.name,
      title: `[同步失败] ${site.name}`,
      message: `上游：${site.name}\n连续失败：${site.sync_failure_count} 次\n原因：${site.last_sync_error || '未知'}\n时间：${new Date().toISOString()}`
    }, { ...dependencies, settings, deferNotification: true }));
  } else if (site.status === 'active' && Number(site.sync_success_count || 0) >= settings.alert_recovery_threshold) {
    results.push(await resolveAndNotify(syncFingerprint, {
      event_type: 'sync_failed',
      severity: 'critical',
      delivery_enabled: deliveryEnabled,
      upstream_site_id: site.id,
      upstream_name: site.name,
      title: `[同步恢复] ${site.name}`,
      message: `上游：${site.name}\n状态：同步已恢复\n时间：${site.last_sync_at || new Date().toISOString()}`
    }, { ...dependencies, settings, deferNotification: true }));
  }

  const notifications = results.filter(Boolean).map((item) => item.notification).filter(Boolean);
  await deliverAlertNotifications(notifications, { ...dependencies, settings });
  return results.filter(Boolean).map((item) => item.alert);
}

module.exports = {
  KEY_FAILURE_STATES,
  keyStatusLabel,
  alertSettings,
  isQuietHours,
  eventDeliveryEnabled,
  incidentNotificationDue,
  recoveryNotificationDue,
  groupNotifications,
  deliverAlertNotifications,
  openAndNotify,
  resolveAndNotify,
  evaluateKeyConnectivity,
  evaluateSiteAlerts
};
