require('./testEnv');
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('SMTP APIs require console auth and support safe save/read/test/delete', async (t) => {
  const reservation = net.createServer();
  await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smtp-api-test-'));
  const server = spawn(process.execPath, ['src/server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env, PORT: String(port), DATABASE_PATH: path.join(dir, 'console.sqlite'),
      ADMIN_PASSWORD: 'api-test-password', SESSION_SECRET: 'api-test-session',
      SEED_UPSTREAM_EMAIL: '', SEED_UPSTREAM_PASSWORD: '',
      SYNC_SCHEDULER_ENABLED: 'false', KEY_CHECK_SCHEDULER_ENABLED: 'false'
    }, stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    server.kill('SIGTERM');
    if (server.exitCode === null) await new Promise((resolve) => server.once('exit', resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server startup timed out')), 10000);
    server.once('exit', () => { clearTimeout(timeout); reject(new Error('Server exited before ready')); });
    server.stdout.on('data', (data) => {
      if (data.toString().includes('running at')) { clearTimeout(timeout); resolve(); }
    });
  });
  const url = `http://127.0.0.1:${port}`;
  for (const [method, endpoint] of [
    ['GET', '/api/notifications/email/settings'], ['PUT', '/api/notifications/email/settings'],
    ['DELETE', '/api/notifications/email/settings'], ['POST', '/api/notifications/email/test']
  ]) {
    assert.equal((await fetch(url + endpoint, { method })).status, 401);
  }
  const login = await fetch(url + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'api-test-password' })
  });
  assert.equal(login.status, 200);
  const headers = { cookie: login.headers.get('set-cookie').split(';')[0], 'content-type': 'application/json' };
  const input = {
    enabled: false, host: '127.0.0.1', port: 1, security: 'tls',
    user: 'fixture@example.com', password: 'never-return-this-secret',
    from: 'fixture@example.com', to: ['ops@example.com'], timeout_ms: 1000
  };
  const saved = await fetch(url + '/api/notifications/email/settings', { method: 'PUT', headers, body: JSON.stringify(input) });
  assert.equal(saved.status, 200);
  const safe = await saved.json();
  assert.equal(safe.has_password, true);
  assert.equal(safe.password, undefined);
  const monitoring = await (await fetch(url + '/api/monitoring/upstreams', { headers })).text();
  assert.ok(!monitoring.includes(input.password));
  assert.equal(JSON.parse(monitoring).email.has_password, true);
  const invalid = await fetch(url + '/api/notifications/email/settings', {
    method: 'PUT', headers, body: JSON.stringify({ ...input, to: ['invalid'] })
  });
  assert.equal(invalid.status, 400);
  const tested = await fetch(url + '/api/notifications/email/test', { method: 'POST', headers });
  assert.equal(tested.status, 502);
  assert.ok(!(await tested.text()).includes(input.password));
  const deleted = await fetch(url + '/api/notifications/email/settings', { method: 'DELETE', headers });
  assert.equal((await deleted.json()).configured, false);
  const missing = await fetch(url + '/api/notifications/email/test', { method: 'POST', headers });
  assert.equal(missing.status, 422);
});
