require('./testEnv');

const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { createUpdateService } = require('../src/updateService');

function updateEnvironment(enabled = true) {
  return {
    ...config,
    selfUpdateEnabled: enabled,
    selfUpdateRemote: 'origin',
    selfUpdateBranch: 'main',
    updateBackupDir: path.join(os.tmpdir(), `sub2api-update-test-${process.pid}-${Date.now()}-${Math.random()}`)
  };
}

function commandRunner() {
  let merged = false;
  return async (command, args) => {
    if (command === 'npm') return '';
    const key = args.join(' ');
    if (key === 'rev-parse --is-inside-work-tree') return 'true';
    if (key === 'fetch --quiet origin main') return '';
    if (key === 'rev-parse HEAD') return merged ? 'bbbbbbbb22222222' : 'aaaaaaaa11111111';
    if (key === 'rev-parse origin/main') return 'bbbbbbbb22222222';
    if (key === 'status --porcelain') return '';
    if (key === 'rev-list --left-right --count HEAD...origin/main') return merged ? '0\t0' : '0\t2';
    if (key === 'show origin/main:package.json') return JSON.stringify({ version: '1.8.1' });
    if (key === 'log --format=%h%x09%s -10 HEAD..origin/main') return merged ? '' : 'bbbbbbbb\tAdd updater\nbbbbbbbc\tFix backup';
    if (key === 'merge --ff-only origin/main') { merged = true; return 'Fast-forward'; }
    if (key.startsWith('reset --hard ')) { merged = false; return ''; }
    throw new Error(`Unexpected command: ${command} ${key}`);
  };
}

test('update inspection reports versions and pending commits', async () => {
  const service = createUpdateService({ environment: updateEnvironment(), run: commandRunner() });
  const status = await service.check();
  assert.equal(status.enabled, true);
  assert.equal(status.available, true);
  assert.equal(status.behind, 2);
  assert.equal(status.latest_version, '1.8.1');
  assert.deepEqual(status.commits.map((item) => item.subject), ['Add updater', 'Fix backup']);
});

test('disabled update service exposes local version without touching Git', async () => {
  const service = createUpdateService({
    environment: updateEnvironment(false),
    run: async () => { throw new Error('Git must not run'); }
  });
  const status = await service.inspect();
  assert.equal(status.enabled, false);
  assert.equal(status.available, false);
  assert.match(status.message, /未启用/);
});

test('update backs up, tests and requests a supervised restart', async () => {
  let backupPath = '';
  let resolveRestart;
  const restarted = new Promise((resolve) => { resolveRestart = resolve; });
  const service = createUpdateService({
    environment: updateEnvironment(),
    run: commandRunner(),
    database: { backup: async (target) => { backupPath = target; } },
    restart: resolveRestart
  });
  const accepted = await service.start();
  assert.equal(accepted.accepted, true);
  await restarted;
  assert.match(backupPath, /upstream-console-before-update/);
  const status = await service.inspect();
  assert.equal(status.current_commit, 'bbbbbbbb');
  assert.equal(status.operation.phase, 'restarting');
});
