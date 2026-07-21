require('./testEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const { pushPlusStatus, resolvePushPlusToken, sendPushPlus } = require('../src/pushPlusClient');
const {
  evaluateKeyConnectivity,
  evaluateSiteAlerts,
  deliverAlertNotifications,
  isQuietHours
} = require('../src/alertService');

function alertRepository() {
  const alerts = [];
  return {
    alerts,
    findOpenAlert(fingerprint) {
      return alerts.find((item) => item.fingerprint === fingerprint && item.status === 'open') || null;
    },
    findLatestAlert(fingerprint) {
      return [...alerts].reverse().find((item) => item.fingerprint === fingerprint) || null;
    },
    openOrTouchAlert(input) {
      const existing = this.findOpenAlert(input.fingerprint);
      if (existing) return existing;
      const alert = { id: alerts.length + 1, status: 'open', notified_at: null, recovery_notified_at: null, ...input };
      alerts.push(alert);
      return alert;
    },
    markAlertNotified(id) {
      const alert = alerts.find((item) => item.id === id);
      const now = new Date().toISOString();
      alert.notified_at ||= now;
      alert.last_notified_at = now;
      alert.notification_count = Number(alert.notification_count || 0) + 1;
      return alert;
    },
    resolveAlert(fingerprint) {
      const alert = this.findOpenAlert(fingerprint);
      alert.status = 'resolved';
      alert.resolved_at = new Date().toISOString();
      return alert;
    },
    markRecoveryNotified(id) {
      const alert = alerts.find((item) => item.id === id);
      alert.recovery_notified_at = new Date().toISOString();
      return alert;
    }
  };
}

test('sendPushPlus posts the expected safe payload', async () => {
  let body = null;
  const result = await sendPushPlus({ title: 'Title', content: 'Body' }, {
    token: 'push-token',
    baseUrl: 'https://push.example/send',
    fetchImpl: async (url, options) => {
      body = JSON.parse(options.body);
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 200, msg: 'ok' }) };
    }
  });
  assert.equal(result.ok, true);
  assert.deepEqual(body, { token: 'push-token', title: 'Title', content: 'Body', template: 'txt' });
});

test('PushPlus resolves database settings without exposing the full token', () => {
  const repository = {
    getSecretSetting: () => 'database-push-token',
    getMaskedSecretSetting: () => 'dat...ken'
  };
  assert.deepEqual(resolvePushPlusToken({ repo: repository }), {
    token: 'database-push-token',
    source: 'database'
  });
  const status = pushPlusStatus({ repo: repository });
  assert.equal(status.configured, true);
  assert.equal(status.source, 'database');
  assert.equal(status.token_masked, 'dat...ken');
  assert.equal(JSON.stringify(status).includes('database-push-token'), false);
});

test('Key incident notifies once at threshold and once after recovery', async () => {
  const repository = alertRepository();
  const messages = [];
  const dependencies = {
    repo: repository,
    notify: async (message) => { messages.push(message); return { ok: true }; },
    failureThreshold: 3,
    recoveryThreshold: 2
  };
  const site = { id: 1, name: 'Stone API' };
  const key = { id: 9, name: 'Codex', key_masked: 'sk-...1234' };
  await evaluateKeyConnectivity(site, key, { status: 'timeout', consecutive_failures: 3, last_checked_at: 'now' }, dependencies);
  await evaluateKeyConnectivity(site, key, { status: 'timeout', consecutive_failures: 4, last_checked_at: 'now' }, dependencies);
  await evaluateKeyConnectivity(site, key, { status: 'connected', consecutive_successes: 2, latency_ms: 123, last_checked_at: 'later' }, dependencies);
  assert.equal(messages.length, 2);
  assert.equal(messages.some((item) => JSON.stringify(item).includes('sk-secret')), false);
  assert.equal(repository.alerts[0].status, 'resolved');
});

test('site balance alert includes zero balance and deduplicates', async () => {
  const repository = alertRepository();
  repository.listSites = () => [{
    id: 4,
    name: 'Zero API',
    balance: 0,
    low_balance_threshold: 10,
    status: 'active',
    sync_success_count: 1
  }];
  const messages = [];
  const dependencies = { repo: repository, notify: async (message) => { messages.push(message); return { ok: true }; } };
  await evaluateSiteAlerts(4, dependencies);
  await evaluateSiteAlerts(4, dependencies);
  assert.equal(messages.length, 1);
  assert.equal(repository.alerts[0].severity, 'critical');
});

test('notification failure keeps the incident recorded without throwing', async () => {
  const repository = alertRepository();
  const errors = [];
  const result = await evaluateKeyConnectivity(
    { id: 8, name: 'Fixture' },
    { id: 2, name: 'Key', key_masked: 'sk-...safe' },
    { status: 'timeout', consecutive_failures: 3, last_checked_at: 'now' },
    {
      repo: repository,
      notify: async () => { throw new Error('PushPlus unavailable'); },
      onNotificationError: (error) => errors.push(error.message)
    }
  );
  assert.equal(repository.alerts.length, 1);
  assert.equal(result.notification_error, 'PushPlus unavailable');
  assert.deepEqual(errors, ['PushPlus unavailable']);
});

test('multiple Key incidents keep separate records but send one upstream notification', async () => {
  const repository = alertRepository();
  const messages = [];
  const settings = {
    notifications_enabled: true,
    notify_key_connectivity: true,
    notify_ip_blocked: true,
    notification_grouping: 'upstream',
    alert_failure_threshold: 1,
    alert_recovery_threshold: 1,
    alert_repeat_interval_seconds: 0,
    quiet_hours_enabled: false,
    pushplus_timeout_ms: 10000
  };
  const site = { id: 11, name: 'Grouped API', alert_notifications_enabled: 1 };
  const first = await evaluateKeyConnectivity(site, { id: 1, name: 'A', key_masked: 'sk-a...0001' }, {
    status: 'timeout', consecutive_failures: 1
  }, { repo: repository, settings, deferNotification: true });
  const second = await evaluateKeyConnectivity(site, { id: 2, name: 'B', key_masked: 'sk-b...0002' }, {
    status: 'auth_failed', consecutive_failures: 1
  }, { repo: repository, settings, deferNotification: true });

  await deliverAlertNotifications([first.notification, second.notification], {
    repo: repository,
    settings,
    notify: async (message) => { messages.push(message); }
  });
  assert.equal(repository.alerts.length, 2);
  assert.equal(messages.length, 1);
  assert.match(messages[0].title, /2 个事件/);
  assert.equal(repository.alerts.every((item) => item.notified_at), true);
});

test('IP blocks and quiet hours can suppress delivery without hiding incidents', async () => {
  const repository = alertRepository();
  const settings = {
    notifications_enabled: true,
    notify_key_connectivity: true,
    notify_ip_blocked: false,
    notification_grouping: 'upstream',
    alert_failure_threshold: 1,
    alert_recovery_threshold: 1,
    alert_repeat_interval_seconds: 0,
    quiet_hours_enabled: false
  };
  const result = await evaluateKeyConnectivity(
    { id: 12, name: 'Muted API', alert_notifications_enabled: 1 },
    { id: 3, key_masked: 'sk-c...0003' },
    { status: 'upstream_error', error_code: 'ip_blocked', consecutive_failures: 1 },
    { repo: repository, settings, deferNotification: true }
  );
  assert.equal(repository.alerts.length, 1);
  assert.equal(result.notification, null);
  assert.equal(isQuietHours({ quiet_hours_enabled: true, quiet_hours_start: '22:00', quiet_hours_end: '07:00' }, new Date(2026, 0, 1, 23, 30)), true);
});

test('open incidents become eligible for reminders only after the configured interval', async () => {
  const repository = alertRepository();
  const settings = {
    notifications_enabled: true,
    notify_key_connectivity: true,
    notify_ip_blocked: true,
    notification_grouping: 'key',
    alert_failure_threshold: 1,
    alert_recovery_threshold: 1,
    alert_repeat_interval_seconds: 60,
    quiet_hours_enabled: false,
    pushplus_timeout_ms: 10000
  };
  const site = { id: 13, name: 'Reminder API', alert_notifications_enabled: 1 };
  const key = { id: 4, key_masked: 'sk-d...0004' };
  const initial = await evaluateKeyConnectivity(site, key, { status: 'timeout', consecutive_failures: 1 }, {
    repo: repository,
    settings,
    deferNotification: true,
    now: new Date('2026-07-21T00:00:00.000Z')
  });
  await deliverAlertNotifications([initial.notification], { repo: repository, settings, notify: async () => {} });
  repository.alerts[0].last_notified_at = '2026-07-21T00:00:00.000Z';

  const early = await evaluateKeyConnectivity(site, key, { status: 'timeout', consecutive_failures: 2 }, {
    repo: repository,
    settings,
    deferNotification: true,
    now: new Date('2026-07-21T00:00:30.000Z')
  });
  const due = await evaluateKeyConnectivity(site, key, { status: 'timeout', consecutive_failures: 3 }, {
    repo: repository,
    settings,
    deferNotification: true,
    now: new Date('2026-07-21T00:01:01.000Z')
  });
  assert.equal(early.notification, null);
  assert.ok(due.notification);
});

test('acknowledged incidents suppress retries but still resolve on recovery', async () => {
  const repository = alertRepository();
  const settings = {
    notifications_enabled: true,
    notify_key_connectivity: true,
    notify_recovery: true,
    notify_ip_blocked: true,
    notification_grouping: 'key',
    alert_failure_threshold: 1,
    alert_recovery_threshold: 1,
    alert_repeat_interval_seconds: 1,
    quiet_hours_enabled: false
  };
  const site = { id: 14, name: 'Handled API', alert_notifications_enabled: 1 };
  const key = { id: 5, key_masked: 'sk-e...0005' };
  const incident = await evaluateKeyConnectivity(site, key, { status: 'timeout', consecutive_failures: 1 }, {
    repo: repository, settings, deferNotification: true
  });
  repository.markAlertNotified(incident.alert.id);
  incident.alert.acknowledged_at = '2026-07-21T00:00:00.000Z';

  const repeated = await evaluateKeyConnectivity(site, key, { status: 'timeout', consecutive_failures: 2 }, {
    repo: repository,
    settings,
    deferNotification: true,
    now: new Date('2026-07-21T00:10:00.000Z')
  });
  assert.equal(repeated.notification, null);

  const recovered = await evaluateKeyConnectivity(site, key, { status: 'connected', consecutive_successes: 1 }, {
    repo: repository, settings, deferNotification: true
  });
  assert.equal(recovered.alert.status, 'resolved');
  assert.ok(recovered.notification);
});
