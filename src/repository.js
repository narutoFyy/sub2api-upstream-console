const db = require('./db');
const { encryptSecret, decryptSecret, maskSecret } = require('./crypto');
const config = require('./config');
const { normalizeBaseUrl, nowIso, safeJson } = require('./utils');
const { buildSub2APISiteModelPricing, calculatePricingFields, groupModelPricingBoard, isSub2APIPricingSite, resolveOfficialPricingRows, summarizePlatformRates } = require('./modelPricing');
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

function latestRatesForSite(siteId, limit = 500) {
  const rows = db.prepare(`
    SELECT group_id, group_name, scope, model, rate
    FROM group_rate_snapshots
    WHERE upstream_site_id = ?
    ORDER BY captured_at DESC, id DESC
  `).all(siteId);
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const key = `${row.group_id}:${row.group_name}:${row.scope}:${row.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

function attachPlatformRates(site) {
  if (!site) return site;
  if (site.openai_rate != null || site.anthropic_rate != null) return site;
  const platformRates = summarizePlatformRates(latestRatesForSite(site.id));
  return {
    ...site,
    openai_rate: platformRates.openai_rate,
    anthropic_rate: platformRates.anthropic_rate
  };
}

function listSites() {
  return db.prepare(`
    SELECT s.*, c.captured_at, c.balance, c.balance_currency, c.today_tokens, c.today_cost,
           c.today_requests, c.week_tokens, c.week_cost, c.month_tokens, c.month_cost,
           c.total_requests, c.total_tokens, c.total_cost,
           c.codex_rate, c.openai_rate, c.anthropic_rate, c.min_rate, c.max_rate,
           c.payment_enabled, c.balance_recharge_disabled, c.balance_recharge_multiplier,
           c.recharge_fee_rate, c.payment_plan_count, c.payment_methods,
           c.subscription_summary, c.pricing_summary,
           c.group_count, c.key_count, c.channel_count
    FROM upstream_sites s
    LEFT JOIN upstream_current_snapshots c ON c.upstream_site_id = s.id
    ORDER BY s.id DESC
  `).all().map(rowToSite).map(attachPlatformRates);
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
      name, base_url, upstream_type, auth_mode, status, tags, notes,
      low_balance_threshold, rate_change_threshold_percent, sync_interval_seconds,
      key_check_interval_seconds, openai_probe_model, anthropic_probe_model, created_at, updated_at
    )
    VALUES (
      @name, @base_url, @upstream_type, @auth_mode, 'active', @tags, @notes,
      @low_balance_threshold, @rate_change_threshold_percent, @sync_interval_seconds,
      @key_check_interval_seconds, @openai_probe_model, @anthropic_probe_model, @now, @now
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
      low_balance_threshold: input.low_balance_threshold ?? 10,
      rate_change_threshold_percent: input.rate_change_threshold_percent ?? 20,
      sync_interval_seconds: input.sync_interval_seconds || 180,
      key_check_interval_seconds: input.key_check_interval_seconds || 300,
      openai_probe_model: input.openai_probe_model || '',
      anthropic_probe_model: input.anthropic_probe_model || '',
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
    low_balance_threshold: input.low_balance_threshold ?? site.low_balance_threshold ?? 10,
    rate_change_threshold_percent: input.rate_change_threshold_percent ?? site.rate_change_threshold_percent ?? 20,
    sync_interval_seconds: input.sync_interval_seconds ?? site.sync_interval_seconds,
    key_check_interval_seconds: input.key_check_interval_seconds ?? site.key_check_interval_seconds ?? 300,
    openai_probe_model: input.openai_probe_model ?? site.openai_probe_model ?? '',
    anthropic_probe_model: input.anthropic_probe_model ?? site.anthropic_probe_model ?? '',
    id,
    now
  };
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE upstream_sites
      SET name=@name, base_url=@base_url, upstream_type=@upstream_type, auth_mode=@auth_mode, status=@status, tags=@tags,
          notes=@notes, low_balance_threshold=@low_balance_threshold,
          rate_change_threshold_percent=@rate_change_threshold_percent,
          sync_interval_seconds=@sync_interval_seconds,
          key_check_interval_seconds=@key_check_interval_seconds,
          openai_probe_model=@openai_probe_model,
          anthropic_probe_model=@anthropic_probe_model,
          updated_at=@now
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

function rowToOwnSite(row) {
  return row || null;
}

function listOwnSites() {
  return db.prepare(`
    SELECT s.*,
           COUNT(r.id) AS route_count,
           SUM(CASE WHEN r.match_status = 'matched' THEN 1 ELSE 0 END) AS matched_count,
           SUM(CASE WHEN r.match_status != 'matched' THEN 1 ELSE 0 END) AS unmatched_count
    FROM own_sites s
    LEFT JOIN own_site_route_snapshots r ON r.own_site_id = s.id
    GROUP BY s.id
    ORDER BY s.id DESC
  `).all().map(rowToOwnSite);
}

function getOwnSite(id) {
  return rowToOwnSite(db.prepare('SELECT * FROM own_sites WHERE id = ?').get(id));
}

function getOwnSiteCredentials(id) {
  const row = db.prepare('SELECT * FROM own_site_credentials WHERE own_site_id = ?').get(id);
  if (!row) return {};
  return {
    email: decryptSecret(row.encrypted_email),
    password: decryptSecret(row.encrypted_password),
    token: decryptSecret(row.encrypted_token)
  };
}

function getSecretSetting(key) {
  const row = db.prepare('SELECT encrypted_value FROM console_settings WHERE key = ?').get(String(key));
  return row ? decryptSecret(row.encrypted_value) : '';
}

function getMaskedSecretSetting(key) {
  return maskSecret(getSecretSetting(key));
}

function setSecretSetting(key, value) {
  const settingKey = String(key || '').trim();
  if (!settingKey) throw new Error('Setting key is required');
  const secret = String(value || '').trim();
  if (!secret) {
    deleteSetting(settingKey);
    return null;
  }
  const now = nowIso();
  db.prepare(`
    INSERT INTO console_settings (key, encrypted_value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      encrypted_value=excluded.encrypted_value,
      updated_at=excluded.updated_at
  `).run(settingKey, encryptSecret(secret), now);
  return { key: settingKey, masked_value: maskSecret(secret), updated_at: now };
}

function deleteSetting(key) {
  return db.prepare('DELETE FROM console_settings WHERE key = ?').run(String(key)).changes > 0;
}

function replaceUpstreamProbeModels(siteId, groups, syncedAt = nowIso()) {
  const normalizedGroups = Array.isArray(groups) ? groups : [];
  const replace = db.transaction(() => {
    const groupIds = normalizedGroups.map((group) => String(group.group_id ?? ''));
    if (groupIds.length) {
      const placeholders = groupIds.map(() => '?').join(', ');
      db.prepare(`
        DELETE FROM upstream_group_probe_settings
        WHERE upstream_site_id = ? AND group_id NOT IN (${placeholders})
      `).run(siteId, ...groupIds);
    } else {
      db.prepare('DELETE FROM upstream_group_probe_settings WHERE upstream_site_id = ?').run(siteId);
    }

    const upsertGroup = db.prepare(`
      INSERT INTO upstream_group_probe_settings (
        upstream_site_id, group_id, group_name, platform, selected_model,
        discovery_status, discovery_error, synced_at, updated_at
      ) VALUES (
        @upstream_site_id, @group_id, @group_name, @platform, '',
        @discovery_status, @discovery_error, @synced_at, @updated_at
      )
      ON CONFLICT(upstream_site_id, group_id) DO UPDATE SET
        group_name=excluded.group_name,
        platform=excluded.platform,
        discovery_status=excluded.discovery_status,
        discovery_error=excluded.discovery_error,
        synced_at=excluded.synced_at,
        updated_at=excluded.updated_at
    `);
    const insertModel = db.prepare(`
      INSERT INTO upstream_probe_model_catalog (
        upstream_site_id, group_id, model, platform, source, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const group of normalizedGroups) {
      const groupId = String(group.group_id ?? '');
      upsertGroup.run({
        upstream_site_id: siteId,
        group_id: groupId,
        group_name: group.group_name || '',
        platform: group.platform || '',
        discovery_status: group.discovery_status || 'success',
        discovery_error: group.discovery_error || '',
        synced_at: syncedAt,
        updated_at: syncedAt
      });
      db.prepare(`
        DELETE FROM upstream_probe_model_catalog
        WHERE upstream_site_id = ? AND group_id = ?
      `).run(siteId, groupId);
      const seen = new Set();
      for (const item of group.models || []) {
        const model = String(typeof item === 'string' ? item : item?.model || '').trim();
        if (!model || seen.has(model)) continue;
        seen.add(model);
        insertModel.run(
          siteId,
          groupId,
          model,
          group.platform || '',
          typeof item === 'string' ? (group.source || '') : (item.source || group.source || ''),
          syncedAt
        );
      }
    }
  });
  replace();
  return listUpstreamProbeModels(siteId);
}

function listUpstreamProbeModels(siteId) {
  const groups = db.prepare(`
    SELECT * FROM upstream_group_probe_settings
    WHERE upstream_site_id = ?
    ORDER BY group_name COLLATE NOCASE, group_id
  `).all(siteId);
  const models = db.prepare(`
    SELECT group_id, model, platform, source, last_seen_at
    FROM upstream_probe_model_catalog
    WHERE upstream_site_id = ?
    ORDER BY group_id, model COLLATE NOCASE
  `).all(siteId);
  const byGroup = new Map();
  for (const item of models) {
    if (!byGroup.has(item.group_id)) byGroup.set(item.group_id, []);
    byGroup.get(item.group_id).push(item);
  }
  return groups.map((group) => ({ ...group, models: byGroup.get(group.group_id) || [] }));
}

function setGroupProbeModel(siteId, groupId, input) {
  const now = nowIso();
  db.prepare(`
    INSERT INTO upstream_group_probe_settings (
      upstream_site_id, group_id, group_name, platform, selected_model,
      discovery_status, discovery_error, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'manual', '', ?)
    ON CONFLICT(upstream_site_id, group_id) DO UPDATE SET
      group_name=CASE WHEN excluded.group_name != '' THEN excluded.group_name ELSE group_name END,
      platform=CASE WHEN excluded.platform != '' THEN excluded.platform ELSE platform END,
      selected_model=excluded.selected_model,
      updated_at=excluded.updated_at
  `).run(
    siteId,
    String(groupId ?? ''),
    input.group_name || '',
    input.platform || '',
    String(input.selected_model || '').trim(),
    now
  );
  return db.prepare(`
    SELECT * FROM upstream_group_probe_settings
    WHERE upstream_site_id = ? AND group_id = ?
  `).get(siteId, String(groupId ?? ''));
}

function getGroupProbeModel(siteId, groupId) {
  return db.prepare(`
    SELECT selected_model FROM upstream_group_probe_settings
    WHERE upstream_site_id = ? AND group_id = ?
  `).get(siteId, String(groupId ?? ''))?.selected_model || '';
}

function getMaskedOwnSiteCredentials(id) {
  const creds = getOwnSiteCredentials(id);
  return {
    email: creds.email,
    password_masked: maskSecret(creds.password),
    token_masked: maskSecret(creds.token)
  };
}

function createOwnSite(input) {
  const baseUrl = normalizeBaseUrl(input.base_url);
  const now = nowIso();
  const tx = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO own_sites (name, base_url, own_site_type, auth_mode, status, notes, created_at, updated_at)
      VALUES (@name, @base_url, @own_site_type, @auth_mode, 'active', @notes, @now, @now)
    `).run({
      name: input.name,
      base_url: baseUrl,
      own_site_type: input.own_site_type || 'auto',
      auth_mode: input.auth_mode || 'token',
      notes: input.notes || '',
      now
    });
    db.prepare(`
      INSERT INTO own_site_credentials (own_site_id, encrypted_email, encrypted_password, encrypted_token, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(result.lastInsertRowid, encryptSecret(input.email || ''), encryptSecret(input.password || ''), encryptSecret(input.token || ''), now, now);
    return getOwnSite(result.lastInsertRowid);
  });
  return tx();
}

function updateOwnSite(id, input) {
  const site = getOwnSite(id);
  if (!site) return null;
  const now = nowIso();
  const next = {
    id,
    name: input.name ?? site.name,
    base_url: input.base_url ? normalizeBaseUrl(input.base_url) : site.base_url,
    own_site_type: input.own_site_type ?? site.own_site_type ?? 'auto',
    auth_mode: input.auth_mode ?? site.auth_mode ?? 'token',
    status: input.status ?? site.status,
    notes: input.notes ?? site.notes,
    now
  };
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE own_sites
      SET name=@name, base_url=@base_url, own_site_type=@own_site_type, auth_mode=@auth_mode,
          status=@status, notes=@notes, updated_at=@now
      WHERE id=@id
    `).run(next);
    const currentCreds = getOwnSiteCredentials(id);
    db.prepare(`
      INSERT INTO own_site_credentials (own_site_id, encrypted_email, encrypted_password, encrypted_token, created_at, updated_at)
      VALUES (@id, @email, @password, @token, @now, @now)
      ON CONFLICT(own_site_id) DO UPDATE SET
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
    return getOwnSite(id);
  });
  return tx();
}

function deleteOwnSite(id) {
  return db.prepare('DELETE FROM own_sites WHERE id = ?').run(id).changes > 0;
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
        codex_rate, openai_rate, anthropic_rate, min_rate, max_rate, payment_enabled, balance_recharge_disabled,
        balance_recharge_multiplier, recharge_fee_rate, payment_plan_count, payment_methods,
        subscription_summary, pricing_summary, group_count, key_count, channel_count, raw_payload, captured_at
      ) VALUES (
        @siteId, @balance, @balance_currency, @username, @email, @role,
        @total_requests, @today_requests, @total_tokens, @today_tokens, @total_cost, @today_cost,
        @week_requests, @week_tokens, @week_cost, @month_requests, @month_tokens, @month_cost,
        @codex_rate, @openai_rate, @anthropic_rate, @min_rate, @max_rate, @payment_enabled, @balance_recharge_disabled,
        @balance_recharge_multiplier, @recharge_fee_rate, @payment_plan_count, @payment_methods,
        @subscription_summary, @pricing_summary, @group_count, @key_count, @channel_count, @raw_payload, @now
      )
      ON CONFLICT(upstream_site_id) DO UPDATE SET
        balance=@balance, balance_currency=@balance_currency, username=@username, email=@email, role=@role,
        total_requests=@total_requests, today_requests=@today_requests, total_tokens=@total_tokens,
        today_tokens=@today_tokens, total_cost=@total_cost, today_cost=@today_cost, codex_rate=@codex_rate,
        openai_rate=@openai_rate, anthropic_rate=@anthropic_rate,
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
        total_tokens, today_tokens, total_cost, today_cost, codex_rate, openai_rate, anthropic_rate, min_rate,
        week_requests, week_tokens, week_cost, month_requests, month_tokens, month_cost,
        max_rate, payment_enabled, balance_recharge_disabled, balance_recharge_multiplier,
        recharge_fee_rate, payment_plan_count, payment_methods, group_count, key_count, channel_count, captured_at
      ) VALUES (
        @siteId, @balance, @balance_currency, @total_requests, @today_requests,
        @total_tokens, @today_tokens, @total_cost, @today_cost, @codex_rate, @openai_rate, @anthropic_rate, @min_rate,
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
      SET status='active', last_sync_at=?, last_sync_error='',
          sync_failure_count=0, sync_success_count=sync_success_count + 1, updated_at=?
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
      UPDATE upstream_sites
      SET status='sync_failed', last_sync_error=?, sync_failure_count=sync_failure_count + 1,
          sync_success_count=0, updated_at=?
      WHERE id=?
    `).run(error?.message || 'Sync failed', finishedAt, siteId);
  }
}

function getSnapshot(siteId) {
  const snapshot = db.prepare('SELECT * FROM upstream_current_snapshots WHERE upstream_site_id = ?').get(siteId) || null;
  if (!snapshot) return null;
  if (snapshot.openai_rate != null || snapshot.anthropic_rate != null) return snapshot;
  const platformRates = summarizePlatformRates(latestRatesForSite(siteId));
  return {
    ...snapshot,
    openai_rate: platformRates.openai_rate,
    anthropic_rate: platformRates.anthropic_rate
  };
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
  if (!isSub2APIPricingSite(site)) return out;
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
  if (!isSub2APIPricingSite(site)) return summary;
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
    openai_model_count: 0,
    openai_min_rate: null,
    anthropic_model_count: 0,
    anthropic_min_rate: null,
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
  return resolveOfficialPricingRows(out);
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

function keySnapshotInput(siteId, key, capturedAt) {
  const fallbackId = key.key_masked || key.name || '';
  return {
    upstream_site_id: siteId,
    upstream_key_id: String(key.id ?? key.upstream_key_id ?? fallbackId),
    name: key.name || '',
    key_masked: key.key_masked || '',
    group_id: String(key.group_id ?? ''),
    group_name: key.group_name || '',
    platform: key.platform || '',
    group_rate: key.group_rate ?? key.rate_multiplier ?? null,
    status: key.status || '',
    quota: key.quota ?? null,
    quota_used: key.quota_used ?? null,
    expires_at: key.expires_at || null,
    last_used_at: key.last_used_at || null,
    captured_at: capturedAt
  };
}

function keySnapshotChanged(previous, next) {
  const fields = [
    'name', 'key_masked', 'group_id', 'group_name', 'platform', 'group_rate',
    'status', 'quota', 'quota_used', 'expires_at', 'last_used_at'
  ];
  return fields.some((field) => String(previous?.[field] ?? '') !== String(next?.[field] ?? ''));
}

function reconcileKeySnapshots(siteId, keys, capturedAt = nowIso(), { markMissing = false } = {}) {
  const existingRows = db.prepare(`
    SELECT * FROM upstream_api_key_snapshots WHERE upstream_site_id = ?
  `).all(siteId);
  const existing = new Map(existingRows.map((row) => [String(row.upstream_key_id), row]));
  const seen = new Set();
  const summary = { total: 0, added: 0, updated: 0, unchanged: 0, missing: 0, group_changes: 0 };
  const upsert = db.prepare(`
    INSERT INTO upstream_api_key_snapshots (
      upstream_site_id, upstream_key_id, name, key_masked, group_id, group_name, platform, group_rate,
      status, quota, quota_used, expires_at, last_used_at, captured_at,
      first_seen_at, last_seen_at, missing_since, import_state
    ) VALUES (
      @upstream_site_id, @upstream_key_id, @name, @key_masked, @group_id, @group_name, @platform, @group_rate,
      @status, @quota, @quota_used, @expires_at, @last_used_at, @captured_at,
      @first_seen_at, @last_seen_at, NULL, 'present'
    )
    ON CONFLICT(upstream_site_id, upstream_key_id) DO UPDATE SET
      name=excluded.name, key_masked=excluded.key_masked, group_id=excluded.group_id,
      group_name=excluded.group_name, platform=excluded.platform, group_rate=excluded.group_rate,
      status=excluded.status, quota=excluded.quota, quota_used=excluded.quota_used,
      expires_at=excluded.expires_at, last_used_at=excluded.last_used_at,
      captured_at=excluded.captured_at, last_seen_at=excluded.last_seen_at,
      missing_since=NULL, import_state='present'
  `);
  const markMissingStmt = db.prepare(`
    UPDATE upstream_api_key_snapshots
    SET import_state='missing', missing_since=COALESCE(missing_since, ?)
    WHERE upstream_site_id=? AND upstream_key_id=?
  `);

  const tx = db.transaction(() => {
    for (const key of keys || []) {
      const next = keySnapshotInput(siteId, key, capturedAt);
      if (!next.upstream_key_id || seen.has(next.upstream_key_id)) continue;
      seen.add(next.upstream_key_id);
      summary.total += 1;
      const previous = existing.get(next.upstream_key_id);
      if (!previous) summary.added += 1;
      else if (keySnapshotChanged(previous, next) || previous.import_state === 'missing') {
        summary.updated += 1;
        if (String(previous.group_id || '') !== next.group_id || String(previous.group_rate ?? '') !== String(next.group_rate ?? '')) {
          summary.group_changes += 1;
        }
      } else {
        summary.unchanged += 1;
      }
      upsert.run({
        ...next,
        first_seen_at: previous?.first_seen_at || previous?.captured_at || capturedAt,
        last_seen_at: capturedAt
      });
    }

    if (markMissing) {
      for (const row of existingRows) {
        if (seen.has(String(row.upstream_key_id)) || row.import_state === 'missing') continue;
        markMissingStmt.run(capturedAt, siteId, row.upstream_key_id);
        summary.missing += 1;
      }
      db.prepare('UPDATE upstream_sites SET last_key_import_at=?, updated_at=? WHERE id=?')
        .run(capturedAt, capturedAt, siteId);
    }
  });
  tx();
  return summary;
}

function saveKeySnapshots(siteId, keys, capturedAt = nowIso()) {
  return reconcileKeySnapshots(siteId, keys, capturedAt, { markMissing: false });
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

function listKeySnapshotsWithHealth(siteId, { includeMissing = true } = {}, limit = 1000) {
  return db.prepare(`
    SELECT k.*, s.name AS upstream_name, s.base_url,
           h.status AS connectivity_status, h.probe_level, h.model AS probe_model,
           h.latency_ms, h.http_status AS connectivity_http_status,
           h.error_code AS connectivity_error_code, h.error_message AS connectivity_error_message,
           h.consecutive_failures, h.consecutive_successes,
           h.last_checked_at, h.last_success_at, h.last_failure_at
    FROM upstream_api_key_snapshots k
    JOIN upstream_sites s ON s.id = k.upstream_site_id
    LEFT JOIN upstream_key_connectivity_state h
      ON h.upstream_site_id = k.upstream_site_id AND h.upstream_key_id = k.upstream_key_id
    WHERE k.upstream_site_id = ? AND (? = 1 OR k.import_state != 'missing')
    ORDER BY CASE WHEN COALESCE(h.status, 'untested') IN ('connected', 'untested') THEN 1 ELSE 0 END,
             k.name COLLATE NOCASE, k.id
    LIMIT ?
  `).all(siteId, includeMissing ? 1 : 0, limit);
}

function startKeyImportRun(siteId, startedAt = nowIso()) {
  const result = db.prepare(`
    INSERT INTO upstream_key_import_runs (upstream_site_id, status, started_at)
    VALUES (?, 'running', ?)
  `).run(siteId, startedAt);
  return Number(result.lastInsertRowid);
}

function finishKeyImportRun(runId, result, finishedAt = nowIso()) {
  db.prepare(`
    UPDATE upstream_key_import_runs
    SET status=@status, pages=@pages, total=@total, added=@added, updated=@updated,
        missing=@missing, group_changes=@group_changes, full_key_count=@full_key_count,
        error_message=@error_message, finished_at=@finished_at
    WHERE id=@id
  `).run({
    id: runId,
    status: result.status || 'success',
    pages: result.pages || 0,
    total: result.total || 0,
    added: result.added || 0,
    updated: result.updated || 0,
    missing: result.missing || 0,
    group_changes: result.group_changes || 0,
    full_key_count: result.full_key_count || 0,
    error_message: result.error_message || '',
    finished_at: finishedAt
  });
  return db.prepare('SELECT * FROM upstream_key_import_runs WHERE id = ?').get(runId);
}

function listKeyImportRuns(siteId, limit = 20) {
  return db.prepare(`
    SELECT * FROM upstream_key_import_runs
    WHERE upstream_site_id = ?
    ORDER BY started_at DESC, id DESC
    LIMIT ?
  `).all(siteId, limit);
}

const CONNECTIVITY_FAILURES = new Set(['timeout', 'auth_failed', 'quota_exhausted', 'upstream_error']);

function recordKeyConnectivityCheck(siteId, keyId, check) {
  const checkedAt = check.checked_at || nowIso();
  const previous = db.prepare(`
    SELECT * FROM upstream_key_connectivity_state
    WHERE upstream_site_id = ? AND upstream_key_id = ?
  `).get(siteId, String(keyId)) || null;
  const connected = check.status === 'connected';
  const failed = CONNECTIVITY_FAILURES.has(check.status);
  const nextFailures = failed ? Number(previous?.consecutive_failures || 0) + 1 : 0;
  const nextSuccesses = connected ? Number(previous?.consecutive_successes || 0) + 1 : 0;
  const values = {
    upstream_site_id: siteId,
    upstream_key_id: String(keyId),
    status: check.status || 'untested',
    probe_level: check.probe_level || 'inference',
    platform: check.platform || '',
    model: check.model || '',
    latency_ms: check.latency_ms ?? null,
    http_status: check.http_status ?? null,
    error_code: check.error_code || '',
    error_message: check.error_message || '',
    consecutive_failures: nextFailures,
    consecutive_successes: nextSuccesses,
    last_checked_at: checkedAt,
    last_success_at: connected ? checkedAt : previous?.last_success_at || null,
    last_failure_at: failed ? checkedAt : previous?.last_failure_at || null,
    updated_at: checkedAt
  };
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO upstream_key_connectivity_checks (
        upstream_site_id, upstream_key_id, status, probe_level, platform, model,
        latency_ms, http_status, error_code, error_message, checked_at
      ) VALUES (
        @upstream_site_id, @upstream_key_id, @status, @probe_level, @platform, @model,
        @latency_ms, @http_status, @error_code, @error_message, @last_checked_at
      )
    `).run(values);
    db.prepare(`
      INSERT INTO upstream_key_connectivity_state (
        upstream_site_id, upstream_key_id, status, probe_level, platform, model,
        latency_ms, http_status, error_code, error_message,
        consecutive_failures, consecutive_successes, last_checked_at,
        last_success_at, last_failure_at, updated_at
      ) VALUES (
        @upstream_site_id, @upstream_key_id, @status, @probe_level, @platform, @model,
        @latency_ms, @http_status, @error_code, @error_message,
        @consecutive_failures, @consecutive_successes, @last_checked_at,
        @last_success_at, @last_failure_at, @updated_at
      )
      ON CONFLICT(upstream_site_id, upstream_key_id) DO UPDATE SET
        status=excluded.status, probe_level=excluded.probe_level, platform=excluded.platform,
        model=excluded.model, latency_ms=excluded.latency_ms, http_status=excluded.http_status,
        error_code=excluded.error_code, error_message=excluded.error_message,
        consecutive_failures=excluded.consecutive_failures,
        consecutive_successes=excluded.consecutive_successes,
        last_checked_at=excluded.last_checked_at, last_success_at=excluded.last_success_at,
        last_failure_at=excluded.last_failure_at, updated_at=excluded.updated_at
    `).run(values);
    db.prepare('UPDATE upstream_sites SET last_key_check_at=?, updated_at=? WHERE id=?')
      .run(checkedAt, checkedAt, siteId);
  });
  tx();
  return {
    previous,
    current: db.prepare(`
      SELECT * FROM upstream_key_connectivity_state
      WHERE upstream_site_id = ? AND upstream_key_id = ?
    `).get(siteId, String(keyId))
  };
}

function listKeyConnectivityChecks(siteId, keyId = null, limit = 100) {
  if (keyId != null) {
    return db.prepare(`
      SELECT * FROM upstream_key_connectivity_checks
      WHERE upstream_site_id = ? AND upstream_key_id = ?
      ORDER BY checked_at DESC, id DESC LIMIT ?
    `).all(siteId, String(keyId), limit);
  }
  return db.prepare(`
    SELECT * FROM upstream_key_connectivity_checks
    WHERE upstream_site_id = ?
    ORDER BY checked_at DESC, id DESC LIMIT ?
  `).all(siteId, limit);
}

function pruneKeyConnectivityChecks(siteId) {
  db.prepare(`
    DELETE FROM upstream_key_connectivity_checks
    WHERE upstream_site_id = ? AND id NOT IN (
      SELECT id FROM upstream_key_connectivity_checks
      WHERE upstream_site_id = ?
      ORDER BY checked_at DESC, id DESC
      LIMIT ?
    )
  `).run(siteId, siteId, config.maxKeyCheckLogs);
}

function findOpenAlert(fingerprint) {
  return db.prepare(`
    SELECT * FROM alert_events
    WHERE fingerprint = ? AND status = 'open'
    ORDER BY id DESC LIMIT 1
  `).get(fingerprint) || null;
}

function openOrTouchAlert(input) {
  const now = input.now || nowIso();
  const existing = findOpenAlert(input.fingerprint);
  if (existing) {
    db.prepare(`
      UPDATE alert_events SET last_seen_at=?, title=?, message=?, severity=? WHERE id=?
    `).run(now, input.title || existing.title, input.message || existing.message, input.severity || existing.severity, existing.id);
    return db.prepare('SELECT * FROM alert_events WHERE id = ?').get(existing.id);
  }
  const result = db.prepare(`
    INSERT INTO alert_events (
      fingerprint, event_type, severity, status, upstream_site_id, upstream_key_id,
      title, message, opened_at, last_seen_at
    ) VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)
  `).run(
    input.fingerprint,
    input.event_type,
    input.severity || 'warning',
    input.upstream_site_id ?? null,
    input.upstream_key_id || '',
    input.title || '',
    input.message || '',
    now,
    now
  );
  return db.prepare('SELECT * FROM alert_events WHERE id = ?').get(result.lastInsertRowid);
}

function markAlertNotified(id, at = nowIso()) {
  db.prepare('UPDATE alert_events SET notified_at=? WHERE id=?').run(at, id);
  return db.prepare('SELECT * FROM alert_events WHERE id=?').get(id) || null;
}

function resolveAlert(fingerprint, at = nowIso()) {
  const alert = findOpenAlert(fingerprint);
  if (!alert) return null;
  db.prepare(`UPDATE alert_events SET status='resolved', resolved_at=?, last_seen_at=? WHERE id=?`)
    .run(at, at, alert.id);
  return db.prepare('SELECT * FROM alert_events WHERE id=?').get(alert.id) || null;
}

function markRecoveryNotified(id, at = nowIso()) {
  db.prepare('UPDATE alert_events SET recovery_notified_at=? WHERE id=?').run(at, id);
  return db.prepare('SELECT * FROM alert_events WHERE id=?').get(id) || null;
}

function listAlerts({ status = '', siteId = null } = {}, limit = 200) {
  const clauses = ['1=1'];
  const params = [];
  if (status) {
    clauses.push('a.status = ?');
    params.push(status);
  }
  if (siteId) {
    clauses.push('a.upstream_site_id = ?');
    params.push(siteId);
  }
  params.push(limit);
  return db.prepare(`
    SELECT a.*, s.name AS upstream_name
    FROM alert_events a
    LEFT JOIN upstream_sites s ON s.id = a.upstream_site_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY CASE WHEN a.status = 'open' THEN 0 ELSE 1 END, a.opened_at DESC, a.id DESC
    LIMIT ?
  `).all(...params);
}

function normalizeUrlForMatch(value) {
  try {
    return normalizeBaseUrl(value);
  } catch {
    return String(value || '').trim().replace(/\/+$/, '');
  }
}

function keysLookAlike(left, right) {
  const a = String(left || '').trim();
  const b = String(right || '').trim();
  if (!a || !b) return false;
  if (a === b) return true;
  const [aPrefix, aSuffix] = a.replace(/\*/g, '').split('...');
  const [bPrefix, bSuffix] = b.replace(/\*/g, '').split('...');
  return Boolean(aPrefix && aSuffix && b.startsWith(aPrefix) && b.endsWith(aSuffix))
    || Boolean(bPrefix && bSuffix && a.startsWith(bPrefix) && a.endsWith(bSuffix));
}

function listOwnSiteRoutes(ownSiteId = null, { matchStatus = '', search = '' } = {}, limit = 500) {
  const clauses = ['1=1'];
  const params = [];
  if (ownSiteId) {
    clauses.push('r.own_site_id = ?');
    params.push(ownSiteId);
  }
  if (matchStatus) {
    clauses.push('r.match_status = ?');
    params.push(matchStatus);
  }
  if (search) {
    clauses.push('(r.route_name LIKE ? OR r.model_pattern LIKE ? OR r.upstream_api_url LIKE ? OR us.name LIKE ? OR r.upstream_key_masked LIKE ?)');
    const q = `%${search}%`;
    params.push(q, q, q, q, q);
  }
  params.push(limit);
  return db.prepare(`
    SELECT r.*, os.name AS own_site_name, os.base_url AS own_site_base_url,
           us.name AS matched_upstream_name, us.base_url AS matched_upstream_base_url
    FROM own_site_route_snapshots r
    JOIN own_sites os ON os.id = r.own_site_id
    LEFT JOIN upstream_sites us ON us.id = r.matched_upstream_site_id
    WHERE ${clauses.join(' AND ')}
    ORDER BY r.captured_at DESC, r.id DESC
    LIMIT ?
  `).all(...params);
}

function manualBindingForRoute(ownSiteId, routeId) {
  return db.prepare(`
    SELECT * FROM own_site_route_manual_bindings
    WHERE own_site_id = ? AND route_id = ?
  `).get(ownSiteId, String(routeId || '')) || null;
}

function resolveOwnRouteMatch(ownSiteId, route) {
  const binding = manualBindingForRoute(ownSiteId, route.route_id);
  const upstreams = listSites();
  const routeUrl = normalizeUrlForMatch(route.upstream_api_url);
  let upstream = null;
  if (binding?.upstream_site_id) {
    upstream = getSite(binding.upstream_site_id);
  }
  if (!upstream && routeUrl) {
    upstream = upstreams.find((site) => normalizeUrlForMatch(site.base_url) === routeUrl)
      || upstreams.find((site) => {
        try {
          return new URL(site.base_url).hostname === new URL(routeUrl).hostname;
        } catch {
          return false;
        }
      });
  }

  let key = null;
  const keyCandidates = upstream
    ? listKeySnapshots(upstream.id, 1000)
    : listAllKeySnapshots({}, 2000);
  if (binding?.upstream_key_id) {
    key = listAllKeySnapshots({}, 5000).find((item) => (
      String(item.upstream_site_id) === String(binding.upstream_site_id || item.upstream_site_id)
      && String(item.upstream_key_id || '') === String(binding.upstream_key_id)
    ));
    if (key && !upstream) upstream = getSite(key.upstream_site_id);
  }
  if (!key && route.upstream_key_id) {
    key = keyCandidates.find((item) => String(item.upstream_key_id || '') === String(route.upstream_key_id));
  }
  if (!key && route.upstream_key_masked) {
    key = keyCandidates.find((item) => keysLookAlike(item.key_masked, route.upstream_key_masked));
  }

  const matched = Boolean(upstream && key);
  let reason = '已匹配上游和 Key';
  if (!upstream && !route.upstream_api_url) reason = '自己站接口未返回上游 API 地址';
  else if (!upstream) reason = '未匹配到本地上游站点';
  else if (!key && !route.upstream_key_masked && !route.upstream_key_id) reason = '自己站接口未返回上游 Key';
  else if (!key) reason = '未匹配到本地上游 Key';

  return {
    matched_upstream_site_id: upstream?.id ?? null,
    matched_upstream_key_id: key?.upstream_key_id || '',
    matched_group_id: route.group_id || key?.group_id || '',
    matched_group_name: route.group_name || key?.group_name || '',
    matched_platform: route.platform || key?.platform || '',
    matched_group_rate: route.group_rate ?? key?.group_rate ?? null,
    upstream_buy_rate: key?.group_rate ?? route.upstream_buy_rate ?? null,
    match_status: upstream && (key || route.group_id || route.group_name) ? 'matched' : 'unmatched',
      match_reason: binding ? `手动绑定：${reason}` : (upstream && !key && (route.group_id || route.group_name) ? '已匹配上游，分组来自账号管理接口' : reason)
  };
}

function saveOwnSiteRoutes(ownSiteId, routes, capturedAt = nowIso()) {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM own_site_route_snapshots WHERE own_site_id = ?').run(ownSiteId);
    const insert = db.prepare(`
      INSERT INTO own_site_route_snapshots (
        own_site_id, route_id, route_name, model_pattern, upstream_api_url,
        matched_upstream_site_id, upstream_key_masked, upstream_key_id, upstream_buy_rate, matched_upstream_key_id,
        matched_group_id, matched_group_name, matched_platform, matched_group_rate,
        route_status, match_status, match_reason, raw_payload, captured_at
      ) VALUES (
        @own_site_id, @route_id, @route_name, @model_pattern, @upstream_api_url,
        @matched_upstream_site_id, @upstream_key_masked, @upstream_key_id, @upstream_buy_rate, @matched_upstream_key_id,
        @matched_group_id, @matched_group_name, @matched_platform, @matched_group_rate,
        @route_status, @match_status, @match_reason, @raw_payload, @captured_at
      )
    `);
    for (const route of routes) {
      const match = resolveOwnRouteMatch(ownSiteId, route);
      insert.run({
        own_site_id: ownSiteId,
        route_id: String(route.route_id || ''),
        route_name: route.route_name || '',
        model_pattern: route.model_pattern || '',
        upstream_api_url: route.upstream_api_url || '',
        upstream_key_masked: route.upstream_key_masked || '',
        upstream_key_id: route.upstream_key_id || '',
        group_id: route.group_id || '',
        group_name: route.group_name || '',
        platform: route.platform || '',
        group_rate: route.group_rate ?? null,
        route_status: route.route_status || '',
        raw_payload: safeJson(route.raw_payload || {}),
        captured_at: capturedAt,
        ...match,
        upstream_buy_rate: match.upstream_buy_rate ?? route.upstream_buy_rate ?? null
      });
    }
    db.prepare(`
      UPDATE own_sites
      SET last_sync_at = ?, last_sync_error = '', updated_at = ?
      WHERE id = ?
    `).run(capturedAt, capturedAt, ownSiteId);
  });
  tx();
  return listOwnSiteRoutes(ownSiteId);
}

function markOwnSiteSyncFailed(ownSiteId, message) {
  const now = nowIso();
  db.prepare(`
    UPDATE own_sites
    SET status = 'sync_failed', last_sync_error = ?, updated_at = ?
    WHERE id = ?
  `).run(String(message || ''), now, ownSiteId);
}

function saveOwnRouteManualBinding(ownSiteId, routeId, input) {
  const now = nowIso();
  db.prepare(`
    INSERT INTO own_site_route_manual_bindings (
      own_site_id, route_id, upstream_site_id, upstream_key_id, notes, created_at, updated_at
    ) VALUES (
      @own_site_id, @route_id, @upstream_site_id, @upstream_key_id, @notes, @now, @now
    )
    ON CONFLICT(own_site_id, route_id) DO UPDATE SET
      upstream_site_id=@upstream_site_id,
      upstream_key_id=@upstream_key_id,
      notes=@notes,
      updated_at=@now
  `).run({
    own_site_id: ownSiteId,
    route_id: String(routeId || ''),
    upstream_site_id: input.upstream_site_id || null,
    upstream_key_id: input.upstream_key_id || '',
    notes: input.notes || '',
    now
  });
  const routes = listOwnSiteRoutes(ownSiteId).map((route) => ({
    route_id: route.route_id,
    route_name: route.route_name,
    model_pattern: route.model_pattern,
    upstream_api_url: route.upstream_api_url,
    upstream_key_masked: route.upstream_key_masked,
    upstream_key_id: route.upstream_key_id,
    route_status: route.route_status,
    raw_payload: {}
  }));
  saveOwnSiteRoutes(ownSiteId, routes, nowIso());
  return manualBindingForRoute(ownSiteId, routeId);
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
  getSecretSetting,
  getMaskedSecretSetting,
  setSecretSetting,
  deleteSetting,
  replaceUpstreamProbeModels,
  listUpstreamProbeModels,
  setGroupProbeModel,
  getGroupProbeModel,
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
  reconcileKeySnapshots,
  listKeySnapshots,
  listAllKeySnapshots,
  listKeySnapshotsWithHealth,
  startKeyImportRun,
  finishKeyImportRun,
  listKeyImportRuns,
  recordKeyConnectivityCheck,
  listKeyConnectivityChecks,
  pruneKeyConnectivityChecks,
  findOpenAlert,
  openOrTouchAlert,
  markAlertNotified,
  resolveAlert,
  markRecoveryNotified,
  listAlerts,
  saveKeyCreateLog,
  listOwnSites,
  getOwnSite,
  getOwnSiteCredentials,
  getMaskedOwnSiteCredentials,
  createOwnSite,
  updateOwnSite,
  deleteOwnSite,
  saveOwnSiteRoutes,
  listOwnSiteRoutes,
  markOwnSiteSyncFailed,
  saveOwnRouteManualBinding
};
