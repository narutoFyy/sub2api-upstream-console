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
  maxSyncLogs: Number(process.env.MAX_SYNC_LOGS || 500),
  maxRateSnapshots: Number(process.env.MAX_RATE_SNAPSHOTS || 2000),
  seed: {
    name: process.env.SEED_UPSTREAM_NAME || 'Stone API',
    baseUrl: process.env.SEED_UPSTREAM_BASE_URL || 'https://www.shitoutk.com',
    email: process.env.SEED_UPSTREAM_EMAIL || '',
    password: process.env.SEED_UPSTREAM_PASSWORD || ''
  }
};
