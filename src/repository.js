const db = require('./db');
const { encryptSecret, decryptSecret, maskSecret } = require('./crypto');
const config = require('./config');
const { normalizeBaseUrl, nowIso, safeJson } = require('./utils');

function rowToSite(row) {
  if (!row) return null;
  let paymentMethods = [];
  try {
    paymentMethods = JSON.parse(row.payment_methods || '[]');
  } catch {
    paymentMethods = [];
  }
  return {
    ...row,
    tags: JSON.parse(row.tags || '[]'),
    codex_aliases: JSON.parse(row.codex_aliases || '["codex"]'),
    payment_methods: paymentMethods
  };
}

function listSites() {
  return db.prepare(`
    SELECT s.*, c.captured_at, c.balance, c.balance_currency, c.today_tokens, c.today_cost,
           c.today_requests, c.week_tokens, c.week_cost, c.month_tokens, c.month_cost,
           c.total_requests, c.total_tokens, c.total_cost,
           c.codex_rate, c.min_rate, c.max_rate,
           c.payment_enabled, c.balance_recharge_disabled, c.balance_recharge_multiplier,
           c.recharge_fee_rate, c.payment_plan_count, c.payment_methods,
           c.group_count, c.key_count, c.channel_count
    FROM upstream_sites s
    LEFT JOIN upstream_current_snapshots c ON c.upstream_site_id = s.id
    ORDER BY s.id DESC
  `).all().map(rowToSite);
}

function getSite(id) {
  return rowToSite(db.prepare('SELECT * FROM upstream_sites WHERE id = ?').get(id));
}

function getCredentials(siteId) {
  const row = db.prepare('SELECT * FROM upstream_credentials WHERE upstream_site_id = ?').get(siteId);
  if (!row) return null;
  return {
    email: decryptSecret(row.encrypted_email),
    password: decryptSecret(row.encrypted_password),
    token: decryptSecret(row.encrypted_token),
    token_expires_at: row.token_expires_at
  };
}

function getMaskedCredentials(siteId) {
  const creds = getCredentials(siteId);
  if (!creds) return {};
  return {
    email: creds.email,
    password_masked: maskSecret(creds.password),
    token_masked: maskSecret(creds.token)
  };
}

function createSite(input) {
  const baseUrl = normalizeBaseUrl(input.base_url);
  const now = nowIso();
  const insertSite = db.prepare(`
    INSERT INTO upstream_sites (
      name, base_url, upstream_type, auth_mode, status, tags, notes, codex_aliases,
      low_balance_threshold, rate_change_threshold_percent, sync_interval_seconds, created_at, updated_at
    )
    VALUES (
      @name, @base_url, @upstream_type, @auth_mode, 'active', @tags, @notes, @codex_aliases,
      @low_balance_threshold, @rate_change_threshold_percent, @sync_interval_seconds, @now, @now
    )
  `);
  const tx = db.transaction(() => {
    const result = insertSite.run({
      name: input.name,
      base_url: baseUrl,
      upstream_type: input.upstream_type || 'auto',
      auth_mode: input.auth_mode || 'password',
      tags: safeJson(input.tags || []),
      notes: input.notes || '',
      codex_aliases: safeJson(input.codex_aliases || ['codex']),
      low_balance_threshold: input.low_balance_threshold ?? 10,
      rate_change_threshold_percent: input.rate_change_threshold_percent ?? 20,
      sync_interval_seconds: input.sync_interval_seconds || 180,
      now
    });
    db.prepare(`
      INSERT INTO upstream_credentials (upstream_site_id, encrypted_email, encrypted_password, encrypted_token, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(result.lastInsertRowid, encryptSecret(input.email || ''), encryptSecret(input.password || ''), encryptSecret(input.token || ''), now, now);
    return getSite(result.lastInsertRowid);
  });
  return tx();
}

function updateSite(id, input) {
  const site = getSite(id);
  if (!site) return null;
  const now = nowIso();
  const next = {
    name: input.name ?? site.name,
    base_url: input.base_url ? normalizeBaseUrl(input.base_url) : site.base_url,
    upstream_type: input.upstream_type ?? site.upstream_type ?? 'auto',
    auth_mode: input.auth_mode ?? site.auth_mode,
    status: input.status ?? site.status,
    tags: safeJson(input.tags ?? site.tags),
    notes: input.notes ?? site.notes,
    codex_aliases: safeJson(input.codex_aliases ?? site.codex_aliases ?? ['codex']),
    low_balance_threshold: input.low_balance_threshold ?? site.low_balance_threshold ?? 10,
    rate_change_threshold_percent: input.rate_change_threshold_percent ?? site.rate_change_threshold_percent ?? 20,
    sync_interval_seconds: input.sync_interval_seconds ?? site.sync_interval_seconds,
    id,
    now
  };
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE upstream_sites
      SET name=@name, base_url=@base_url, upstream_type=@upstream_type, auth_mode=@auth_mode, status=@status, tags=@tags,
          notes=@notes, codex_aliases=@codex_aliases, low_balance_threshold=@low_balance_threshold,
          rate_change_threshold_percent=@rate_change_threshold_percent,
          sync_interval_seconds=@sync_interval_seconds, updated_at=@now
      WHERE id=@id
    `).run(next);
    const currentCreds = getCredentials(id) || {};
    db.prepare(`
      INSERT INTO upstream_credentials (upstream_site_id, encrypted_email, encrypted_password, encrypted_token, created_at, updated_at)
      VALUES (@id, @email, @password, @token, @now, @now)
      ON CONFLICT(upstream_site_id) DO UPDATE SET
        encrypted_email=@email,
        encrypted_password=@password,
        encrypted_token=@token,
        updated_at=@now
    `).run({
      id,
      email: encryptSecret(input.email ?? currentCreds.email ?? ''),
      password: encryptSecret(input.password ?? currentCreds.password ?? ''),
      token: encryptSecret(input.token ?? currentCreds.token ?? ''),
      now
    });
    return getSite(id);
  });
  return tx();
}

function deleteSite(id) {
  return db.prepare('DELETE FROM upstream_sites WHERE id = ?').run(id).changes > 0;
}

function latestRatesByGroup(siteId) {
  const rows = db.prepare(`
    SELECT group_id, group_name, scope, model, rate
    FROM group_rate_snapshots
    WHERE upstream_site_id = ?
    ORDER BY captured_at DESC, id DESC
  `).all(siteId);
  const map = new Map();
  for (const row of rows) {
    const key = `${row.group_id}::${row.group_name}::${row.scope}::${row.model}`;
    if (!map.has(key)) map.set(key, row);
  }
  return map;
}

function saveSyncSuccess(siteId, result) {
  const now = nowIso();
  const snapshot = result.snapshot;
  const site = getSite(siteId) || {};
  const rateChangeThreshold = Number(site.rate_change_threshold_percent ?? 20);
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO upstream_current_snapshots (
        upstream_site_id, balance, balance_currency, username, email, role,
        total_requests, today_requests, total_tokens, today_tokens, total_cost, today_cost,
        week_requests, week_tokens, week_cost, month_requests, month_tokens, month_cost,
        codex_rate, min_rate, max_rate, payment_enabled, balance_recharge_disabled,
        balance_recharge_multiplier, recharge_fee_rate, payment_plan_count, payment_methods,
        group_count, key_count, channel_count, raw_payload, captured_at
      ) VALUES (
        @siteId, @balance, @balance_currency, @username, @email, @role,
        @total_requests, @today_requests, @total_tokens, @today_tokens, @total_cost, @today_cost,
        @week_requests, @week_tokens, @week_cost, @month_requests, @month_tokens, @month_cost,
        @codex_rate, @min_rate, @max_rate, @payment_enabled, @balance_recharge_disabled,
        @balance_recharge_multiplier, @recharge_fee_rate, @payment_plan_count, @payment_methods,
        @group_count, @key_count, @channel_count, @raw_payload, @now
      )
      ON CONFLICT(upstream_site_id) DO UPDATE SET
        balance=@balance, balance_currency=@balance_currency, username=@username, email=@email, role=@role,
        total_requests=@total_requests, today_requests=@today_requests, total_tokens=@total_tokens,
        today_tokens=@today_tokens, total_cost=@total_cost, today_cost=@today_cost, codex_rate=@codex_rate,
        week_requests=@week_requests, week_tokens=@week_tokens, week_cost=@week_cost,
        month_requests=@month_requests, month_tokens=@month_tokens, month_cost=@month_cost,
        min_rate=@min_rate, max_rate=@max_rate, group_count=@group_count, key_count=@key_count,
        payment_enabled=@payment_enabled, balance_recharge_disabled=@balance_recharge_disabled,
        balance_recharge_multiplier=@balance_recharge_multiplier, recharge_fee_rate=@recharge_fee_rate,
        payment_plan_count=@payment_plan_count, payment_methods=@payment_methods,
        channel_count=@channel_count,
        raw_payload=@raw_payload, captured_at=@now
    `).run({
      siteId,
      ...snapshot,
      raw_payload: safeJson({ profile: result.profile, usage: result.usage, payment: result.payment, errors: result.errors }),
      now
    });

    db.prepare(`
      INSERT INTO upstream_snapshot_history (
        upstream_site_id, balance, balance_currency, total_requests, today_requests,
        total_tokens, today_tokens, total_cost, today_cost, codex_rate, min_rate,
        week_requests, week_tokens, week_cost, month_requests, month_tokens, month_cost,
        max_rate, payment_enabled, balance_recharge_disabled, balance_recharge_multiplier,
        recharge_fee_rate, payment_plan_count, payment_methods, group_count, key_count, channel_count, captured_at
      ) VALUES (
        @siteId, @balance, @balance_currency, @total_requests, @today_requests,
        @total_tokens, @today_tokens, @total_cost, @today_cost, @codex_rate, @min_rate,
        @week_requests, @week_tokens, @week_cost, @month_requests, @month_tokens, @month_cost,
        @max_rate, @payment_enabled, @balance_recharge_disabled, @balance_recharge_multiplier,
        @recharge_fee_rate, @payment_plan_count, @payment_methods, @group_count, @key_count, @channel_count, @now
      )
    `).run({
      siteId,
      ...snapshot,
      now
    });

    const previous = latestRatesByGroup(siteId);
    for (const rate of result.rates) {
      db.prepare(`
        INSERT INTO group_rate_snapshots (upstream_site_id, group_id, group_name, scope, model, rate, raw_payload, captured_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(siteId, rate.group_id, rate.group_name, rate.scope, rate.model, rate.rate, safeJson(rate.raw), now);
      const key = `${rate.group_id}::${rate.group_name}::${rate.scope}::${rate.model}`;
      const old = previous.get(key);
      if (old && Number(old.rate) !== Number(rate.rate)) {
        const changePercent = old.rate ? ((rate.rate - old.rate) / old.rate) * 100 : null;
        const shouldAlert = changePercent === null || Math.abs(changePercent) >= rateChangeThreshold;
        if (shouldAlert) {
          db.prepare(`
            INSERT INTO rate_change_events (upstream_site_id, group_id, group_name, old_rate, new_rate, change_percent, detected_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(siteId, rate.group_id, rate.group_name, old.rate, rate.rate, changePercent, now);
        }
      }
    }

    db.prepare(`
      UPDATE upstream_sites
      SET status='active', last_sync_at=?, last_sync_error='', updated_at=?
      WHERE id=?
    `).run(now, now, siteId);

    pruneTelemetry(siteId);
  });
  tx();
}

function pruneTelemetry(siteId) {
  db.prepare(`
    DELETE FROM sync_logs
    WHERE upstream_site_id = ?
      AND id NOT IN (
        SELECT id FROM sync_logs
        WHERE upstream_site_id = ?
        ORDER BY started_at DESC, id DESC
        LIMIT ?
      )
  `).run(siteId, siteId, config.maxSyncLogs);

  db.prepare(`
    DELETE FROM group_rate_snapshots
    WHERE upstream_site_id = ?
      AND id NOT IN (
        SELECT id FROM group_rate_snapshots
        WHERE upstream_site_id = ?
        ORDER BY captured_at DESC, id DESC
        LIMIT ?
      )
  `).run(siteId, siteId, config.maxRateSnapshots);
}

function saveSyncLog(siteId, syncType, startedAt, status, error, summary = '') {
  const finishedAt = nowIso();
  const duration = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  db.prepare(`
    INSERT INTO sync_logs (upstream_site_id, sync_type, status, started_at, finished_at, duration_ms, http_status, error_message, summary)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(siteId, syncType, status, startedAt, finishedAt, duration, error?.status || null, error?.message || '', summary);
  if (status !== 'success') {
    db.prepare(`
      UPDATE upstream_sites SET status='sync_failed', last_sync_error=?, updated_at=? WHERE id=?
    `).run(error?.message || 'Sync failed', finishedAt, siteId);
  }
}

function getSnapshot(siteId) {
  return db.prepare('SELECT * FROM upstream_current_snapshots WHERE upstream_site_id = ?').get(siteId) || null;
}

function listSnapshotHistory(siteId, limit = 120) {
  return db.prepare(`
    SELECT *
    FROM upstream_snapshot_history
    WHERE upstream_site_id = ?
    ORDER BY captured_at DESC, id DESC
    LIMIT ?
  `).all(siteId, limit);
}

function listRates(siteId, limit = 200) {
  return db.prepare(`
    SELECT * FROM group_rate_snapshots
    WHERE upstream_site_id = ?
    ORDER BY captured_at DESC, id DESC
    LIMIT ?
  `).all(siteId, limit);
}

function listRateChanges(limit = 100) {
  return db.prepare(`
    SELECT e.*, s.name AS upstream_name, s.base_url
    FROM rate_change_events e
    JOIN upstream_sites s ON s.id = e.upstream_site_id
    ORDER BY e.detected_at DESC, e.id DESC
    LIMIT ?
  `).all(limit);
}

function countUnacknowledgedRateChanges() {
  return db.prepare(`
    SELECT COUNT(*) AS count
    FROM rate_change_events
    WHERE acknowledged_at IS NULL
  `).get().count;
}

function acknowledgeRateChange(id) {
  const now = nowIso();
  const result = db.prepare(`
    UPDATE rate_change_events
    SET acknowledged_at = COALESCE(acknowledged_at, ?)
    WHERE id = ?
  `).run(now, id);
  return result.changes > 0;
}

function listSyncLogs(siteId = null, limit = 100) {
  if (siteId) {
    return db.prepare(`
      SELECT l.*, s.name AS upstream_name
      FROM sync_logs l JOIN upstream_sites s ON s.id = l.upstream_site_id
      WHERE l.upstream_site_id = ?
      ORDER BY l.started_at DESC, l.id DESC
      LIMIT ?
    `).all(siteId, limit);
  }
  return db.prepare(`
    SELECT l.*, s.name AS upstream_name
    FROM sync_logs l JOIN upstream_sites s ON s.id = l.upstream_site_id
    ORDER BY l.started_at DESC, l.id DESC
    LIMIT ?
  `).all(limit);
}

function capabilityMatrix(siteId) {
  const snapshot = getSnapshot(siteId);
  const rates = listRates(siteId, 1);
  const logs = listSyncLogs(siteId, 20);
  const latestLog = logs[0];
  return {
    login: latestLog?.status === 'success' || Boolean(snapshot),
    balance: snapshot?.balance !== null && snapshot?.balance !== undefined,
    usage: Boolean(snapshot && (snapshot.total_tokens || snapshot.total_requests || snapshot.today_tokens || snapshot.today_requests)),
    rates: rates.length > 0 || Number(snapshot?.group_count || 0) > 0,
    keys: Number(snapshot?.key_count || 0) > 0,
    channels: Number(snapshot?.channel_count || 0) > 0,
    payment: Boolean(snapshot && Number(snapshot.payment_enabled) && !Number(snapshot.balance_recharge_disabled)),
    errors: latestLog?.status === 'failed' ? [latestLog.error_message] : []
  };
}

function saveRechargeOrder(siteId, order) {
  const now = nowIso();
  const result = db.prepare(`
    INSERT INTO recharge_orders (
      upstream_site_id, upstream_order_id, out_trade_no, amount, pay_amount, fee_rate,
      payment_type, payment_mode, result_type, status, pay_url, qr_code, expires_at,
      raw_payload, created_at, updated_at
    ) VALUES (
      @siteId, @upstream_order_id, @out_trade_no, @amount, @pay_amount, @fee_rate,
      @payment_type, @payment_mode, @result_type, @status, @pay_url, @qr_code, @expires_at,
      @raw_payload, @now, @now
    )
  `).run({
    siteId,
    upstream_order_id: String(order.order_id || ''),
    out_trade_no: order.out_trade_no || '',
    amount: order.amount,
    pay_amount: order.pay_amount,
    fee_rate: order.fee_rate,
    payment_type: order.payment_type || '',
    payment_mode: order.payment_mode || '',
    result_type: order.result_type || '',
    status: order.status || '',
    pay_url: order.pay_url || '',
    qr_code: order.qr_code || '',
    expires_at: order.expires_at || '',
    raw_payload: safeJson(order.raw || {}),
    now
  });
  return getRechargeOrder(result.lastInsertRowid);
}

function updateRechargeOrder(id, order) {
  const existing = getRechargeOrder(id);
  if (!existing) return null;
  const now = nowIso();
  db.prepare(`
    UPDATE recharge_orders
    SET status=@status, pay_url=@pay_url, qr_code=@qr_code, expires_at=@expires_at,
        raw_payload=@raw_payload, updated_at=@now
    WHERE id=@id
  `).run({
    id,
    status: order.status || existing.status || '',
    pay_url: order.pay_url || existing.pay_url || '',
    qr_code: order.qr_code || existing.qr_code || '',
    expires_at: order.expires_at || existing.expires_at || '',
    raw_payload: safeJson(order.raw || {}),
    now
  });
  return getRechargeOrder(id);
}

function getRechargeOrder(id) {
  return db.prepare('SELECT * FROM recharge_orders WHERE id = ?').get(id) || null;
}

function listRechargeOrders(siteId, limit = 20) {
  return db.prepare(`
    SELECT * FROM recharge_orders
    WHERE upstream_site_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(siteId, limit);
}

function exportSites({ includeSecrets = false } = {}) {
  return listSites().map((site) => {
    const credentials = includeSecrets ? getCredentials(site.id) : getMaskedCredentials(site.id);
    return {
      ...site,
      credentials: includeSecrets ? credentials : {
        email: credentials.email || '',
        password_masked: credentials.password_masked || '',
        token_masked: credentials.token_masked || ''
      }
    };
  });
}

module.exports = {
  listSites,
  getSite,
  getCredentials,
  getMaskedCredentials,
  createSite,
  updateSite,
  deleteSite,
  saveSyncSuccess,
  saveSyncLog,
  getSnapshot,
  listSnapshotHistory,
  listRates,
  listRateChanges,
  countUnacknowledgedRateChanges,
  acknowledgeRateChange,
  listSyncLogs,
  capabilityMatrix,
  saveRechargeOrder,
  updateRechargeOrder,
  getRechargeOrder,
  listRechargeOrders,
  exportSites,
  pruneTelemetry
};
