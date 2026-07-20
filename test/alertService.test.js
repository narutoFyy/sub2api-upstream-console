require('./testEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const { sendPushPlus } = require('../src/pushPlusClient');
const { evaluateKeyConnectivity, evaluateSiteAlerts } = require('../src/alertService');

function alertRepository() {
  const alerts = [];
  return {
    alerts,
    findOpenAlert(fingerprint) {
      return alerts.find((item) => item.fingerprint === fingerprint && item.status === 'open') || null;
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
      alert.notified_at = new Date().toISOString();
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
