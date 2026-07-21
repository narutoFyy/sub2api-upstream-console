const path = require('node:path');
const dotenv = require('dotenv');

dotenv.config();

const rootDir = path.resolve(__dirname, '..');

function resolveProjectPath(value, fallback) {
  const raw = value || fallback;
  return path.isAbsolute(raw) ? raw : path.join(rootDir, raw);
}

module.exports = {
  rootDir,
  port: Number(process.env.PORT || 4317),
  databasePath: resolveProjectPath(process.env.DATABASE_PATH, './data/upstream-console.sqlite'),
  appSecret: process.env.APP_SECRET || 'dev-only-change-me',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  sessionCookieName: 'sub2api_console_session',
  sessionSecret: process.env.SESSION_SECRET || process.env.APP_SECRET || 'dev-session-only-change-me',
  syncSchedulerEnabled: process.env.SYNC_SCHEDULER_ENABLED !== 'false',
  syncSchedulerTickSeconds: Number(process.env.SYNC_SCHEDULER_TICK_SECONDS || 30),
  keyCheckSchedulerEnabled: process.env.KEY_CHECK_SCHEDULER_ENABLED !== 'false',
  keyCheckSchedulerTickSeconds: Number(process.env.KEY_CHECK_SCHEDULER_TICK_SECONDS || 30),
  keyCheckConcurrency: Number(process.env.KEY_CHECK_CONCURRENCY || 3),
  keyCheckTimeoutMs: Number(process.env.KEY_CHECK_TIMEOUT_MS || 15000),
  pushPlusToken: process.env.PUSHPLUS_TOKEN || '',
  pushPlusBaseUrl: process.env.PUSHPLUS_BASE_URL || 'https://www.pushplus.plus/send',
  pushPlusTimeoutMs: Number(process.env.PUSHPLUS_TIMEOUT_MS || 10000),
  alertFailureThreshold: Number(process.env.ALERT_FAILURE_THRESHOLD || 3),
  alertRecoveryThreshold: Number(process.env.ALERT_RECOVERY_THRESHOLD || 2),
  maxKeyCheckLogs: Number(process.env.MAX_KEY_CHECK_LOGS || 10000),
  maxSyncLogs: Number(process.env.MAX_SYNC_LOGS || 500),
  maxRateSnapshots: Number(process.env.MAX_RATE_SNAPSHOTS || 2000),
  selfUpdateEnabled: process.env.SELF_UPDATE_ENABLED === 'true',
  selfUpdateRemote: process.env.SELF_UPDATE_REMOTE || 'origin',
  selfUpdateBranch: process.env.SELF_UPDATE_BRANCH || 'main',
  updateBackupDir: resolveProjectPath(
    process.env.UPDATE_BACKUP_DIR,
    path.join(path.dirname(resolveProjectPath(process.env.DATABASE_PATH, './data/upstream-console.sqlite')), 'backups')
  ),
  seed: {
    name: process.env.SEED_UPSTREAM_NAME || 'Stone API',
    baseUrl: process.env.SEED_UPSTREAM_BASE_URL || 'https://www.shitoutk.com',
    email: process.env.SEED_UPSTREAM_EMAIL || '',
    password: process.env.SEED_UPSTREAM_PASSWORD || ''
  }
};
