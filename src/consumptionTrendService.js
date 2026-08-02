const repo = require('./repository');
const { finiteNumberOrNull } = require('./utils');

const PERIODS = {
  '24h': { duration_ms: 24 * 60 * 60 * 1000, bucket_ms: 60 * 60 * 1000 },
  '7d': { duration_ms: 7 * 24 * 60 * 60 * 1000, bucket_ms: 6 * 60 * 60 * 1000 },
  '30d': { duration_ms: 30 * 24 * 60 * 60 * 1000, bucket_ms: 24 * 60 * 60 * 1000 }
};

function normalizePeriod(value) {
  const period = String(value || '24h').toLowerCase();
  return Object.hasOwn(PERIODS, period) ? period : '24h';
}

function validTimestamp(value) {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSamples(samples, sinceMs, nowMs) {
  return (Array.isArray(samples) ? samples : [])
    .map((sample) => ({
      captured_at: sample?.captured_at || null,
      timestamp_ms: validTimestamp(sample?.captured_at),
      balance: finiteNumberOrNull(sample?.balance),
      total_cost: finiteNumberOrNull(sample?.total_cost)
    }))
    .filter((sample) => sample.timestamp_ms !== null && sample.timestamp_ms >= sinceMs && sample.timestamp_ms <= nowMs)
    .sort((left, right) => left.timestamp_ms - right.timestamp_ms);
}

function bucketIndex(timestampMs, sinceMs, bucketMs, bucketCount) {
  return Math.min(bucketCount - 1, Math.max(0, Math.floor((timestampMs - sinceMs) / bucketMs)));
}

function summarizeConsumption(samples, currentSnapshot, periodValue = '24h', now = Date.now()) {
  const period = normalizePeriod(periodValue);
  const definition = PERIODS[period];
  const nowMs = Number(now);
  const sinceMs = nowMs - definition.duration_ms;
  const normalized = normalizeSamples(samples, sinceMs, nowMs);
  const bucketCount = Math.ceil(definition.duration_ms / definition.bucket_ms);
  const buckets = Array.from({ length: bucketCount }, (_, index) => ({
    started_at: new Date(sinceMs + index * definition.bucket_ms).toISOString(),
    ended_at: new Date(Math.min(nowMs, sinceMs + (index + 1) * definition.bucket_ms)).toISOString(),
    cost_consumption: 0,
    balance_consumption: 0,
    balance: null
  }));

  let costConsumption = 0;
  let balanceConsumption = 0;
  for (let index = 0; index < normalized.length; index += 1) {
    const current = normalized[index];
    const target = buckets[bucketIndex(current.timestamp_ms, sinceMs, definition.bucket_ms, bucketCount)];
    if (current.balance !== null) target.balance = current.balance;
    if (index === 0) continue;
    const previous = normalized[index - 1];
    if (previous.total_cost !== null && current.total_cost !== null) {
      const delta = current.total_cost - previous.total_cost;
      if (delta > 0) {
        costConsumption += delta;
        target.cost_consumption += delta;
      }
    }
    if (previous.balance !== null && current.balance !== null) {
      const delta = previous.balance - current.balance;
      if (delta > 0) {
        balanceConsumption += delta;
        target.balance_consumption += delta;
      }
    }
  }

  let carriedBalance = null;
  for (const bucket of buckets) {
    if (bucket.balance !== null) carriedBalance = bucket.balance;
    else bucket.balance = carriedBalance;
  }

  const source = costConsumption > 0 || balanceConsumption === 0 ? 'actual_cost' : 'balance_estimate';
  for (const bucket of buckets) {
    bucket.consumption = source === 'actual_cost' ? bucket.cost_consumption : bucket.balance_consumption;
    delete bucket.cost_consumption;
    delete bucket.balance_consumption;
  }

  const first = normalized[0] || null;
  const last = normalized.at(-1) || null;
  const coverageMs = first && last ? Math.max(0, last.timestamp_ms - first.timestamp_ms) : 0;
  const enoughData = normalized.length >= 2 && coverageMs >= 60 * 60 * 1000;
  const consumption = source === 'actual_cost' ? costConsumption : balanceConsumption;
  const averagePerHour = enoughData && coverageMs > 0 ? consumption / (coverageMs / (60 * 60 * 1000)) : null;
  const currentBalance = finiteNumberOrNull(currentSnapshot?.balance) ?? last?.balance ?? null;
  const runwayHours = averagePerHour !== null && averagePerHour > 0 && currentBalance !== null && currentBalance >= 0
    ? currentBalance / averagePerHour
    : null;

  return {
    period,
    since: new Date(sinceMs).toISOString(),
    until: new Date(nowMs).toISOString(),
    bucket_ms: definition.bucket_ms,
    sample_count: normalized.length,
    coverage_ms: coverageMs,
    coverage_started_at: first?.captured_at || null,
    coverage_ended_at: last?.captured_at || null,
    enough_data: enoughData,
    source,
    estimated: source === 'balance_estimate',
    current_balance: currentBalance,
    consumption,
    average_per_hour: averagePerHour,
    average_per_day: averagePerHour === null ? null : averagePerHour * 24,
    runway_hours: runwayHours,
    buckets
  };
}

function buildConsumptionDashboard(repository = repo, periodValue = '24h', now = Date.now()) {
  const period = normalizePeriod(periodValue);
  const definition = PERIODS[period];
  const since = new Date(Number(now) - definition.duration_ms).toISOString();
  const items = repository.listSites().map((site) => ({
    id: site.id,
    name: site.name,
    base_url: site.base_url,
    status: site.status,
    ...summarizeConsumption(
      repository.listSnapshotHistoryRange(site.id, since),
      repository.getSnapshot?.(site.id) || site,
      period,
      now
    )
  })).sort((left, right) => right.consumption - left.consumption || String(left.name).localeCompare(String(right.name), 'zh-CN'));

  return {
    period,
    generated_at: new Date(Number(now)).toISOString(),
    total_consumption: items.reduce((total, item) => total + item.consumption, 0),
    items
  };
}

module.exports = {
  PERIODS,
  normalizePeriod,
  normalizeSamples,
  summarizeConsumption,
  buildConsumptionDashboard
};
