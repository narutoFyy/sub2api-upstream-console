const db = require('./db');
const { encryptSecret, decryptSecret, maskSecret } = require('./crypto');
const config = require('./config');
const { normalizeBaseUrl, nowIso, safeJson } = require('./utils');
const { buildSub2APISiteModelPricing, calculatePricingFields, groupModelPricingBoard } = require('./modelPricing');
const { normalizeSub2APIKey } = require('./upstreamKeys');

function rowToSite(row) {
  if (!row) return null;
  let paymentMethods = [];
  let subscriptionSummary = {};
  let pricingSummary = {};
  try {
    paymentMethods = JSON.parse(row.payment_methods || '[]');
  } catch {
    paymentMethods = [];
  }
  try {
    subscriptionSummary = JSON.parse(row.subscription_summary || '{}');
  } catch {
    subscriptionSummary = {};
  }
  try {
    pricingSummary = JSON.parse(row.pricing_summary || '{}');
  } catch {
    pricingSummary = {};
  }
  return {
    ...row,
    tags: JSON.parse(row.tags || '[]'),
    codex_aliases: JSON.parse(row.codex_aliases || '["codex"]'),
    payment_methods: paymentMethods,
    subscription_summary: subscriptionSummary,
    pricing_summary: pricingSummary
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
           c.subscription_summary, c.pricing_summary,
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
        subscription_summary, pricing_summary, group_count, key_count, channel_count, raw_payload, captured_at
      ) VALUES (
        @siteId, @balance, @balance_currency, @username, @email, @role,
        @total_requests, @today_requests, @total_tokens, @today_tokens, @total_cost, @today_cost,
        @week_requests, @week_tokens, @week_cost, @month_requests, @month_tokens, @month_cost,
        @codex_rate, @min_rate, @max_rate, @payment_enabled, @balance_recharge_disabled,
        @balance_recharge_multiplier, @recharge_fee_rate, @payment_plan_count, @payment_methods,
        @subscription_summary, @pricing_summary, @group_count, @key_count, @channel_count, @raw_payload, @now
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
        subscription_summary=@subscription_summary,
        pricing_summary=@pricing_summary,
        channel_count=@channel_count,
        raw_payload=@raw_payload, captured_at=@now
    `).run({
      siteId,
      ...snapshot,
      raw_payload: safeJson({ profile: result.profile, usage: result.usage, payment: result.payment, subscription: result.subscription, pricing: result.pricing, errors: result.errors }),
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

    if (Array.isArray(result.keys)) {
      saveKeySnapshots(siteId, result.keys.map((item) => normalizeSub2APIKey(item, {
        siteId,
        siteName: site.name,
        baseUrl: site.base_url
      })), now);
    }

    if (Array.isArray(result.model_pricing)) {
      for (const item of result.model_pricing) {
        const priceFields = calculatePricingFields(item, result.pricing?.group_ratio || {});
        db.prepare(`
          INSERT INTO model_pricing_snapshots (
            upstream_site_id, model_name, vendor, vendor_id, tags, quota_type,
            model_ratio, model_price, completion_ratio, cache_ratio, create_cache_ratio,
            image_ratio, audio_ratio, audio_completion_ratio, billing_mode, billing_expr,
            enable_groups, supported_endpoint_types, effective_group, effective_group_ratio,
            official_input_usd_per_1m, official_output_usd_per_1m,
            official_cache_read_usd_per_1m, official_cache_write_usd_per_1m, official_request_usd,
            upstream_input_usd_per_1m, upstream_output_usd_per_1m,
            upstream_cache_read_usd_per_1m, upstream_cache_write_usd_per_1m, upstream_request_usd,
            pricing_version, source, raw_payload, captured_at
          ) VALUES (
            @siteId, @model_name, @vendor, @vendor_id, @tags, @quota_type,
            @model_ratio, @model_price, @completion_ratio, @cache_ratio, @create_cache_ratio,
            @image_ratio, @audio_ratio, @audio_completion_ratio, @billing_mode, @billing_expr,
            @enable_groups, @supported_endpoint_types, @effective_group, @effective_group_ratio,
            @official_input_usd_per_1m, @official_output_usd_per_1m,
            @official_cache_read_usd_per_1m, @official_cache_write_usd_per_1m, @official_request_usd,
            @upstream_input_usd_per_1m, @upstream_output_usd_per_1m,
            @upstream_cache_read_usd_per_1m, @upstream_cache_write_usd_per_1m, @upstream_request_usd,
            @pricing_version, @source, @raw_payload, @now
          )
        `).run({
          siteId,
          model_name: item.model_name || '',
          vendor: item.vendor || '',
          vendor_id: item.vendor_id ?? null,
          tags: item.tags || '',
          quota_type: Number(item.quota_type || 0),
          model_ratio: item.model_ratio ?? null,
          model_price: item.model_price ?? null,
          completion_ratio: item.completion_ratio ?? null,
          cache_ratio: item.cache_ratio ?? null,
          create_cache_ratio: item.create_cache_ratio ?? null,
          image_ratio: item.image_ratio ?? null,
          audio_ratio: item.audio_ratio ?? null,
          audio_completion_ratio: item.audio_completion_ratio ?? null,
          billing_mode: item.billing_mode || '',
          billing_expr: item.billing_expr || '',
          enable_groups: safeJson(item.enable_groups || []),
          supported_endpoint_types: safeJson(item.supported_endpoint_types || []),
          ...priceFields,
          pricing_version: item.pricing_version || result.pricing?.pricing_version || '',
          source: item.source || result.pricing?.source || 'pricing',
          raw_payload: safeJson(item.raw || {}),
          now
        });
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

  db.prepare(`
    DELETE FROM model_pricing_snapshots
    WHERE upstream_site_id = ?
      AND id NOT IN (
        SELECT id FROM model_pricing_snapshots
        WHERE upstream_site_id = ?
        ORDER BY captured_at DESC, id DESC
        LIMIT ?
      )
  `).run(siteId, siteId, Math.max(config.maxRateSnapshots, 5000));
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

function listModelPricing(siteId, limit = 300) {
  const rows = db.prepare(`
    SELECT *
    FROM model_pricing_snapshots
    WHERE upstream_site_id = ?
    ORDER BY captured_at DESC, id DESC
  `).all(siteId);
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (seen.has(row.model_name)) continue;
    seen.add(row.model_name);
    out.push(row);
    if (out.length >= limit) break;
  }
  if (out.length > 0) return out;

  const site = getSite(siteId);
  if (!site || site.upstream_type !== 'sub2api') return out;
  const generated = buildSub2APISiteModelPricing(listAllModelPricing(5000), listLatestRatesForBoard(5000)).get(siteId) || [];
  const deduped = [];
  const generatedSeen = new Set();
  for (const row of generated) {
    if (generatedSeen.has(row.model_name)) continue;
    generatedSeen.add(row.model_name);
    deduped.push(row);
    if (deduped.length >= limit) break;
  }
  return deduped;
}

function getDetailPricingSummary(siteId) {
  const snapshot = getSnapshot(siteId);
  let summary = {};
  try {
    summary = JSON.parse(snapshot?.pricing_summary || '{}');
  } catch {
    summary = {};
  }
  if (summary?.enabled) return summary;

  const site = getSite(siteId);
  if (!site || site.upstream_type !== 'sub2api') return summary;
  const items = buildSub2APISiteModelPricing(listAllModelPricing(5000), listLatestRatesForBoard(5000)).get(siteId) || [];
  if (!items.length) return summary;

  const families = new Set(items.map((item) => item.vendor).filter(Boolean));
  const ratios = items.map((item) => Number(item.effective_group_ratio)).filter(Number.isFinite);
  return {
    enabled: true,
    source: 'sub2api-rate',
    model_count: items.length,
    vendor_count: families.size,
    min_model_rate: ratios.length ? Math.min(...ratios) : null,
    max_model_rate: ratios.length ? Math.max(...ratios) : null,
    codex_model_count: 0,
    codex_min_rate: null,
    pricing_version: ''
  };
}

function listAllModelPricing(limit = 1000) {
  const rows = db.prepare(`
    SELECT p.*, s.name AS upstream_name, s.base_url
    FROM model_pricing_snapshots p
    JOIN upstream_sites s ON s.id = p.upstream_site_id
    ORDER BY p.captured_at DESC, p.id DESC
  `).all();
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = `${row.upstream_site_id}:${row.model_name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

function listLatestRatesForBoard(limit = 1000) {
  const rows = db.prepare(`
    SELECT r.*, s.name AS upstream_name, s.base_url, s.upstream_type
    FROM group_rate_snapshots r
    JOIN upstream_sites s ON s.id = r.upstream_site_id
    ORDER BY r.captured_at DESC, r.id DESC
  `).all();
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = `${row.upstream_site_id}:${row.group_id}:${row.group_name}:${row.scope}:${row.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

function getModelPricingBoard() {
  return groupModelPricingBoard(listAllModelPricing(5000), listLatestRatesForBoard(5000));
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
  const site = getSite(siteId);
  let subscriptionSummary = {};
  try {
    subscriptionSummary = JSON.parse(snapshot?.subscription_summary || '{}');
  } catch {
    subscriptionSummary = {};
  }
  let pricingSummary = {};
  try {
    pricingSummary = JSON.parse(snapshot?.pricing_summary || '{}');
  } catch {
    pricingSummary = {};
  }
  const rates = listRates(siteId, 1);
  const logs = listSyncLogs(siteId, 20);
  const latestLog = logs[0];
  const keySnapshots = listKeySnapshots(siteId, 1);
  const canManageKeys = site && site.auth_mode !== 'api_key' && site.upstream_type !== 'new-api';
  return {
    login: latestLog?.status === 'success' || Boolean(snapshot),
    balance: snapshot?.balance !== null && snapshot?.balance !== undefined,
    usage: Boolean(snapshot && (snapshot.total_tokens || snapshot.total_requests || snapshot.today_tokens || snapshot.today_requests)),
    rates: rates.length > 0 || Number(snapshot?.group_count || 0) > 0,
    keys: Number(snapshot?.key_count || 0) > 0 || keySnapshots.length > 0,
    keys_read: canManageKeys || Number(snapshot?.key_count || 0) > 0,
    keys_create: canManageKeys,
    keys_update: canManageKeys,
    keys_delete: canManageKeys,
    channels: Number(snapshot?.channel_count || 0) > 0,
    payment: Boolean(snapshot && Number(snapshot.payment_enabled) && !Number(snapshot.balance_recharge_disabled)),
    subscription: Boolean(subscriptionSummary?.enabled && subscriptionSummary?.active_count),
    pricing: Boolean(pricingSummary?.enabled && pricingSummary?.model_count),
    errors: latestLog?.status === 'failed' ? [latestLog.error_message] : []
  };
}

function saveKeySnapshots(siteId, keys, capturedAt = nowIso()) {
  db.prepare('DELETE FROM upstream_api_key_snapshots WHERE upstream_site_id = ?').run(siteId);
  const insert = db.prepare(`
    INSERT INTO upstream_api_key_snapshots (
      upstream_site_id, upstream_key_id, name, key_masked, group_id, group_name, platform,
      status, quota, quota_used, expires_at, last_used_at, captured_at
    ) VALUES (
      @upstream_site_id, @upstream_key_id, @name, @key_masked, @group_id, @group_name, @platform,
      @status, @quota, @quota_used, @expires_at, @last_used_at, @captured_at
    )
  `);
  for (const key of keys) {
    insert.run({
      upstream_site_id: siteId,
      upstream_key_id: String(key.id ?? ''),
      name: key.name || '',
      key_masked: key.key_masked || '',
      group_id: String(key.group_id ?? ''),
      group_name: key.group_name || '',
      platform: key.platform || '',
      status: key.status || '',
      quota: key.quota ?? null,
      quota_used: key.quota_used ?? null,
      expires_at: key.expires_at || null,
      last_used_at: key.last_used_at || null,
      captured_at: capturedAt
    });
  }
}

function listKeySnapshots(siteId, limit = 200) {
  return db.prepare(`
    SELECT k.*, s.name AS upstream_name, s.base_url
    FROM upstream_api_key_snapshots k
    JOIN upstream_sites s ON s.id = k.upstream_site_id
    WHERE k.upstream_site_id = ?
    ORDER BY k.captured_at DESC, k.id DESC
    LIMIT ?
  `).all(siteId, limit);
}

function listAllKeySnapshots({ upstreamSiteId = null, platform = '', status = '', search = '' } = {}, limit = 500) {
  const clauses = ['1=1'];
  const params = [];
  if (upstreamSiteId) {
    clauses.push('k.upstream_site_id = ?');
    params.push(upstreamSiteId);
  }
  if (platform) {
    clauses.push('LOWER(k.platform) = ?');
    params.push(String(platform).toLowerCase());
  }
  if (status) {
    clauses.push('k.status = ?');
    params.push(status);
  }
  if (search) {
    clauses.push('(k.name LIKE ? OR k.group_name LIKE ? OR k.key_masked LIKE ?)');
    const q = `%${search}%`;
    params.push(q, q, q);
  }
  params.push(limit);
  return db.prepare(`
    SELECT k.*, s.name AS upstream_name, s.base_url
    FROM upstream_api_key_snapshots k
    JOIN upstream_sites s ON s.id = k.upstream_site_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY k.captured_at DESC, k.id DESC
    LIMIT ?
  `).all(...params);
}

function saveKeyCreateLog(siteId, key) {
  const now = nowIso();
  const result = db.prepare(`
    INSERT INTO upstream_key_create_logs (
      upstream_site_id, upstream_key_id, name, group_id, group_name, platform, encrypted_key, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    siteId,
    String(key.id ?? ''),
    key.name || '',
    String(key.group_id ?? ''),
    key.group_name || '',
    key.platform || '',
    encryptSecret(key.key_full || ''),
    now
  );
  return db.prepare('SELECT * FROM upstream_key_create_logs WHERE id = ?').get(result.lastInsertRowid);
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
  getDetailPricingSummary,
  listModelPricing,
  listAllModelPricing,
  getModelPricingBoard,
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
  pruneTelemetry,
  saveKeySnapshots,
  listKeySnapshots,
  listAllKeySnapshots,
  saveKeyCreateLog
};
