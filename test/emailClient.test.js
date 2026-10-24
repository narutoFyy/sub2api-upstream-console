require('./testEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const repo = require('../src/repository');
const db = require('../src/db');
const { EMAIL_SETTINGS_KEY, emailStatus, saveEmailSettings, sendEmail } = require('../src/emailClient');
const { deliverAlertNotifications } = require('../src/alertService');
const { evaluateSiteAlerts } = require('../src/alertService');
const { defaultRuntimeSettings } = require('../src/runtimeSettings');

const input = {
  enabled: true, host: 'smtp.example.com', port: 465, security: 'tls',
  user: 'alerts@example.com', password: 'smtp-test-secret',
  from: 'alerts@example.com', to: ['ops@example.com'], timeout_ms: 1000
};

test.after(() => { db.close(); });

test('SMTP settings encrypt credentials, never return passwords and retain blank passwords', () => {
  saveEmailSettings(input);
  const row = db.prepare('SELECT encrypted_value FROM console_settings WHERE key=?').get(EMAIL_SETTINGS_KEY);
  assert.ok(!row.encrypted_value.includes(input.password));
  assert.ok(!JSON.stringify(emailStatus()).includes(input.password));
  assert.equal(emailStatus().has_password, true);
  saveEmailSettings({ ...input, password: '' });
  assert.equal(JSON.parse(repo.getSecretSetting(EMAIL_SETTINGS_KEY)).password, input.password);
  assert.throws(() => saveEmailSettings({ ...input, to: ['bad-address'] }));
  assert.throws(() => saveEmailSettings({ ...input, host: 'smtp.example.com\r\nother' }));
  assert.throws(() => saveEmailSettings({ ...input, from: 'a@example.com\r\nBcc: b@example.com' }));
  assert.throws(() => saveEmailSettings({ ...input, port: 0 }));
  assert.throws(() => saveEmailSettings({ ...input, security: 'none' }));
});

test('SMTP sends all recipients with required TLS and sanitizes failures', async () => {
  saveEmailSettings({ ...input, security: 'starttls', port: 587, to: ['a@example.com', 'b@example.com'] });
  let options;
  let closed = false;
  const result = await sendEmail({ title: '余额预警\r\n注入', content: '当前余额 5，阈值 10' }, {
    createTransport: (value) => {
      options = value;
      return {
        sendMail: async (mail) => {
          assert.deepEqual(mail.to, ['a@example.com', 'b@example.com']);
          assert.equal(mail.subject, '余额预警 注入');
          return { accepted: mail.to, rejected: [] };
        },
        close: () => { closed = true; }
      };
    }
  });
  assert.equal(result.accepted, 2);
  assert.equal(options.requireTLS, true);
  assert.equal(options.secure, false);
  assert.equal(options.auth.pass, input.password);
  assert.equal(closed, true);
  await assert.rejects(sendEmail({ title: 'test', content: 'test' }, {
    createTransport: () => ({
      sendMail: async () => { throw Object.assign(new Error(input.password), { code: 'EAUTH' }); },
      close() {}
    })
  }), (error) => error.message.includes('认证失败') && !error.message.includes(input.password));
  saveEmailSettings({ ...input, enabled: false });
  await assert.rejects(sendEmail({ title: 'test', content: 'test' }), /未配置或未启用/);
  let sent = false;
  await sendEmail({ title: 'test', content: 'test' }, {
    allowDisabled: true,
    createTransport: () => ({ sendMail: async () => { sent = true; return { accepted: input.to }; }, close() {} })
  });
  assert.equal(sent, true);
});

test('channels deliver independently and retry only failures, preserving repeat and recovery cycles', async () => {
  const alert = repo.openOrTouchAlert({ fingerprint: `mail-${process.pid}`, event_type: 'low_balance', title: '余额预警' });
  const settings = defaultRuntimeSettings();
  let emailFails = true;
  let pushCalls = 0;
  let emailCalls = 0;
  const channels = [
    { id: 'pushplus', send: async () => { pushCalls++; } },
    { id: 'email', send: async () => { emailCalls++; if (emailFails) throw new Error('SMTP unavailable'); } }
  ];
  const item = { kind: 'incident', alert, title: '余额预警', message: '余额 5' };
  const dependencies = { repo, settings, channels, onNotificationError() {} };
  const first = await deliverAlertNotifications([item], dependencies);
  assert.equal(first.errors.length, 1);
  assert.equal(repo.findOpenAlert(alert.fingerprint).notified_at, null);
  assert.equal(pushCalls, 1);
  assert.equal(emailCalls, 1);
  emailFails = false;
  await deliverAlertNotifications([item], dependencies);
  assert.equal(pushCalls, 1);
  assert.equal(emailCalls, 2);
  const notified = repo.findOpenAlert(alert.fingerprint);
  assert.ok(notified.notified_at);
  await deliverAlertNotifications([{ ...item, alert: notified }], dependencies);
  assert.equal(pushCalls, 2);
  assert.equal(emailCalls, 3);
  const resolved = repo.resolveAlert(alert.fingerprint);
  await deliverAlertNotifications([{ ...item, kind: 'recovery', alert: resolved }], dependencies);
  assert.equal(pushCalls, 3);
  assert.equal(emailCalls, 4);
  assert.ok(repo.findLatestAlert(alert.fingerprint).recovery_notified_at);
  db.prepare('DELETE FROM alert_events WHERE id=?').run(alert.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM alert_notification_deliveries WHERE alert_id=?').get(alert.id).count, 0);
});

test('notifications without alert rows can still use email or PushPlus', async () => {
  let sent = false;
  const result = await deliverAlertNotifications([{
    kind: 'incident', alert: {}, title: '涨价', message: '分组倍率变化'
  }], { repo, channels: [{ id: 'email', send: async () => { sent = true; } }] });
  assert.equal(sent, true);
  assert.equal(result.errors.length, 0);
});

test('recovery is delivered when only one channel received the incident', async () => {
  const site = repo.createSite({ name: 'Partial recovery', base_url: 'https://partial.example.com' });
  const alert = repo.openOrTouchAlert({ fingerprint: `low_balance:${site.id}`, event_type: 'low_balance', upstream_site_id: site.id });
  repo.recordNotificationDelivery(alert.id, 'incident', 'email', 'initial');
  let recoverySent = false;
  await evaluateSiteAlerts(site.id, {
    repo: { ...repo, listSites: () => [{ ...site, balance: 50 }] },
    channels: [{ id: 'email', send: async (payload) => { recoverySent = payload.title.includes('恢复'); } }]
  });
  assert.equal(recoverySent, true);
  repo.deleteSite(site.id);
});

test('email alone can deliver alerts when PushPlus is unconfigured', async () => {
  saveEmailSettings(input);
  repo.deleteSetting('pushplus_token');
  repo.deleteSetting('pushplus_targets');
  const result = await deliverAlertNotifications([{
    kind: 'incident', alert: {}, title: '余额预警', message: '当前余额 5'
  }], {
    repo,
    createTransport: () => ({ sendMail: async () => ({ accepted: input.to }), close() {} })
  });
  assert.equal(result.sent, 1);
  assert.equal(result.errors.length, 0);
});

test('real Nodemailer completes an authenticated TLS SMTP exchange', async (t) => {
  const tls = require('node:tls');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { execFileSync } = require('node:child_process');
  const nodemailer = require('nodemailer');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smtp-tls-test-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath,
    '-out', certPath, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const cert = fs.readFileSync(certPath);
  const sockets = new Set();
  const commands = [];
  let message = '';
  const server = tls.createServer({ key: fs.readFileSync(keyPath), cert }, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write('220 test.local ESMTP ready\r\n');
    let buffer = '';
    let data = false;
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n');
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data) {
          if (line === '.') { data = false; socket.write('250 Message accepted\r\n'); }
          else message += `${line}\r\n`;
          continue;
        }
        commands.push(line.split(' ')[0]);
        if (line.startsWith('EHLO')) socket.write('250-test.local\r\n250 AUTH PLAIN\r\n');
        else if (line.startsWith('AUTH')) socket.write('235 Authentication successful\r\n');
        else if (line === 'DATA') { data = true; socket.write('354 End with dot\r\n'); }
        else if (line === 'QUIT') socket.end('221 Bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  saveEmailSettings({ ...input, host: '127.0.0.1', port: server.address().port, timeout_ms: 3000 });
  const result = await sendEmail({ title: 'Balance alert', content: 'Balance 5 below threshold 10' }, {
    createTransport: (options) => nodemailer.createTransport({ ...options, tls: { ca: cert } })
  });
  assert.equal(result.accepted, 1);
  assert.ok(commands.includes('AUTH'));
  assert.ok(commands.includes('DATA'));
  assert.match(message, /Balance 5 below threshold 10/);
  assert.match(message, /To: ops@example.com/);
});
