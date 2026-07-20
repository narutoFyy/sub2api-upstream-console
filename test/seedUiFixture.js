const db = require('../src/db');
const repo = require('../src/repository');

const now = new Date();
const minutesAgo = (minutes) => new Date(now.getTime() - minutes * 60_000).toISOString();

function createSite(input) {
  const site = repo.createSite({
    name: input.name,
    base_url: input.baseUrl,
    upstream_type: 'sub2api',
    auth_mode: 'token',
    token: 'fixture-token',
    tags: [],
    low_balance_threshold: input.threshold ?? 10,
    sync_interval_seconds: 180,
    key_check_interval_seconds: 300,
    openai_probe_model: 'fixture-openai-model',
    anthropic_probe_model: 'fixture-anthropic-model'
  });
  db.prepare(`
    UPDATE upstream_sites
    SET status=?, last_sync_at=?, last_sync_error=?, last_key_import_at=?, last_key_check_at=?
    WHERE id=?
  `).run(input.status || 'active', minutesAgo(input.minutesAgo || 1), input.error || '', minutesAgo(1), minutesAgo(input.minutesAgo || 1), site.id);
  db.prepare(`
    INSERT INTO upstream_current_snapshots (
      upstream_site_id, balance, balance_currency, today_tokens, today_cost,
      openai_rate, anthropic_rate, key_count, captured_at
    ) VALUES (?, ?, 'USD', ?, ?, ?, ?, ?, ?)
  `).run(site.id, input.balance, input.todayTokens || 0, input.todayCost || 0, input.openaiRate ?? null, input.anthropicRate ?? null, input.keys.length, minutesAgo(input.minutesAgo || 1));
  repo.reconcileKeySnapshots(site.id, input.keys, minutesAgo(2), { markMissing: true });
  for (const key of input.keys) {
    repo.recordKeyConnectivityCheck(site.id, String(key.id), {
      status: key.connectivity || 'connected',
      platform: key.platform,
      model: key.platform === 'anthropic' ? 'fixture-anthropic-model' : 'fixture-openai-model',
      latency_ms: key.latency ?? null,
      error_code: key.connectivity === 'timeout' ? 'timeout' : key.connectivity === 'unconfigured' ? 'probe_model_missing' : '',
      error_message: key.connectivity === 'timeout' ? 'Upstream request timed out' : '',
      checked_at: minutesAgo(key.checkMinutesAgo ?? 1)
    });
  }
  return site;
}

const stone = createSite({
  name: 'Stone API', baseUrl: 'https://api.stone.example', balance: 286.42, openaiRate: 0.12, anthropicRate: 0.18,
  keys: [
    { id: 1, name: 'Codex Primary', key_masked: 'sk-...8F2A', group_id: 1, group_name: 'OpenAI-Pro', platform: 'openai', group_rate: 0.12, status: 'active', connectivity: 'connected', latency: 428 },
    { id: 2, name: 'Claude Main', key_masked: 'sk-...13BC', group_id: 2, group_name: 'Anthropic-A', platform: 'anthropic', group_rate: 0.18, status: 'active', connectivity: 'connected', latency: 612 },
    { id: 3, name: 'Codex Backup', key_masked: 'sk-...77D1', group_id: 3, group_name: 'OpenAI-Backup', platform: 'openai', group_rate: 0.15, status: 'active', connectivity: 'timeout', checkMinutesAgo: 2 },
    { id: 4, name: 'Claude Spare', key_masked: 'sk-...A920', group_id: 4, group_name: 'Anthropic-B', platform: 'anthropic', group_rate: 0.22, status: 'active', connectivity: 'unconfigured' },
    { id: 5, name: 'OpenAI Batch', key_masked: 'sk-...B371', group_id: 1, group_name: 'OpenAI-Pro', platform: 'openai', group_rate: 0.12, status: 'active', connectivity: 'connected', latency: 502 },
    { id: 6, name: 'Claude Batch', key_masked: 'sk-...C119', group_id: 2, group_name: 'Anthropic-A', platform: 'anthropic', group_rate: 0.18, status: 'active', connectivity: 'connected', latency: 584 }
  ]
});

createSite({
  name: 'Claude Hub', baseUrl: 'https://api.claudehub.example', balance: 18.7, threshold: 30, anthropicRate: 0.2, minutesAgo: 2,
  keys: Array.from({ length: 4 }, (_, index) => ({ id: index + 10, name: `Claude ${index + 1}`, key_masked: `sk-...CH${index + 1}`, group_id: 2, group_name: 'Anthropic', platform: 'anthropic', group_rate: 0.2, status: 'active', connectivity: index === 0 ? 'auth_failed' : 'connected', latency: 620 + index }))
});

const north = createSite({
  name: 'North Relay', baseUrl: 'https://api.northrelay.example', balance: 0, status: 'sync_failed', error: 'Upstream returned 503', minutesAgo: 12,
  keys: Array.from({ length: 8 }, (_, index) => ({ id: index + 20, name: `North ${index + 1}`, key_masked: `sk-...NR${index + 1}`, group_id: 1, group_name: 'OpenAI', platform: 'openai', group_rate: 0.16, status: 'active', connectivity: index < 2 ? 'timeout' : 'connected', latency: 700 + index }))
});

createSite({
  name: 'Open Gateway', baseUrl: 'https://api.opengateway.example', balance: 536.81, openaiRate: 0.14,
  keys: Array.from({ length: 11 }, (_, index) => ({ id: index + 40, name: `Gateway ${index + 1}`, key_masked: `sk-...OG${index + 1}`, group_id: 1, group_name: 'OpenAI-Core', platform: 'openai', group_rate: 0.14, status: 'active', connectivity: 'connected', latency: 390 + index }))
});

repo.openOrTouchAlert({
  fingerprint: `sync_failed:${north.id}`,
  event_type: 'sync_failed',
  severity: 'critical',
  upstream_site_id: north.id,
  title: '[同步失败] North Relay',
  message: '连续同步失败，上游返回 503'
});

repo.openOrTouchAlert({
  fingerprint: `key_connectivity:${stone.id}:3`,
  event_type: 'key_connectivity',
  severity: 'warning',
  upstream_site_id: stone.id,
  upstream_key_id: '3',
  title: '[上游异常] Stone API · Codex Backup',
  message: 'Key：sk-...77D1\n状态：超时'
});

console.log(JSON.stringify({ ok: true, upstreams: repo.listSites().length }));
db.close();
