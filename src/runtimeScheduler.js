const config = require('./config');
const { runtimeSettingsStatus } = require('./runtimeSettings');
const { syncDueSites } = require('./syncService');
const { checkDueUpstreams } = require('./keyConnectivityService');

function createSchedulerState() {
  return {
    lastSyncScanAt: 0,
    lastKeyScanAt: 0,
    syncRunning: false,
    keyRunning: false
  };
}

function scanDue(lastAt, intervalSeconds, now) {
  return !lastAt || now - lastAt >= Number(intervalSeconds || 10) * 1000;
}

async function runRuntimeScheduler(state, dependencies = {}) {
  const getStatus = dependencies.getStatus || runtimeSettingsStatus;
  const status = getStatus();
  const settings = status.settings;
  const effective = status.effective;
  const now = dependencies.now || Date.now();
  const jobs = [];

  if (effective.sync_enabled && !state.syncRunning && scanDue(state.lastSyncScanAt, settings.sync_scheduler_scan_seconds, now)) {
    state.lastSyncScanAt = now;
    state.syncRunning = true;
    jobs.push(Promise.resolve((dependencies.syncDue || syncDueSites)({ settings, now }))
      .finally(() => { state.syncRunning = false; }));
  }

  if (effective.key_check_enabled && !state.keyRunning && scanDue(state.lastKeyScanAt, settings.key_scheduler_scan_seconds, now)) {
    state.lastKeyScanAt = now;
    state.keyRunning = true;
    jobs.push(Promise.resolve((dependencies.checkDue || checkDueUpstreams)({
      settings,
      now,
      concurrency: settings.key_check_concurrency,
      timeoutMs: settings.key_check_timeout_ms,
      maxKeyCheckLogs: settings.max_key_check_logs
    })).finally(() => { state.keyRunning = false; }));
  }

  await Promise.all(jobs);
  return { jobs: jobs.length, status };
}

function startRuntimeScheduler(dependencies = {}) {
  const state = dependencies.state || createSchedulerState();
  const interval = (dependencies.setIntervalImpl || setInterval)(() => {
    runRuntimeScheduler(state, dependencies).catch((error) => {
      (dependencies.onError || console.error)('Scheduled runtime task failed:', error);
    });
  }, 10000);
  interval.unref?.();
  return { interval, state };
}

function schedulerAllowed(environment = config) {
  return environment.syncSchedulerEnabled !== false || environment.keyCheckSchedulerEnabled !== false;
}

module.exports = {
  createSchedulerState,
  scanDue,
  runRuntimeScheduler,
  startRuntimeScheduler,
  schedulerAllowed
};
