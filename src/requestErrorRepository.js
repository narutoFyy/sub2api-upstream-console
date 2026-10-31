const db = require('./db');
const { encryptSecret, decryptSecret, maskSecret } = require('./crypto');
const { nowIso } = require('./utils');

const CHANNELS = ['pushplus', 'email', 'hermes', 'weixin'];
const JSON_FIELDS = ['upstream_errors', 'related_upstream_errors', 'error_codes', 'matched_codes'];

function parseJson(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function rowToMonitorSite(row) {
  if (!row) return null;
  const apiKey = decryptSecret(row.encrypted_admin_api_key);
  return {
    own_site_id: row.own_site_id,
    name: row.name,
    base_url: row.base_url,
    own_site_status: row.own_site_status,
    enabled: Boolean(row.enabled),
    group_ids: parseJson(row.group_ids, []).map(String),
    groups: parseJson(row.groups_cache, []),
    has_admin_api_key: Boolean(apiKey),
    admin_api_key_masked: maskSecret(apiKey),
    last_poll_at: row.last_poll_at || null,
    last_poll_error: row.last_poll_error || '',
    last_poll_found: row.last_poll_found || 0
  };
}

const monitorSiteSelect = `
  SELECT s.id AS own_site_id, s.name, s.base_url, s.status AS own_site_status,
         COALESCE(m.enabled, 0) AS enabled,
         COALESCE(m.encrypted_admin_api_key, '') AS encrypted_admin_api_key,
         COALESCE(m.group_ids, '[]') AS group_ids,
         COALESCE(m.groups_cache, '[]') AS groups_cache,
         m.last_poll_at, COALESCE(m.last_poll_error, '') AS last_poll_error,
         COALESCE(m.last_poll_found, 0) AS last_poll_found
  FROM own_sites s
  LEFT JOIN request_error_monitor_sites m ON m.own_site_id = s.id
`;

function listMonitorSites() {
  return db.prepare(`${monitorSiteSelect} ORDER BY s.id`).all().map(rowToMonitorSite);
}

function getMonitorSite(ownSiteId) {
  return rowToMonitorSite(db.prepare(`${monitorSiteSelect} WHERE s.id = ?`).get(ownSiteId));
}

function getMonitorAdminApiKey(ownSiteId) {
  const row = db.prepare('SELECT encrypted_admin_api_key FROM request_error_monitor_sites WHERE own_site_id = ?').get(ownSiteId);
  return row ? decryptSecret(row.encrypted_admin_api_key) : '';
}

function ensureMonitorRow(ownSiteId) {
  db.prepare(`
    INSERT INTO request_error_monitor_sites (own_site_id, created_at, updated_at)
    VALUES (?, ?, ?) ON CONFLICT(own_site_id) DO NOTHING
  `).run(ownSiteId, nowIso(), nowIso());
}

function saveMonitorSite(ownSiteId, { enabled, admin_api_key: apiKey, group_ids: groupIds, clear_admin_api_key: clearKey } = {}) {
  ensureMonitorRow(ownSiteId);
  const current = db.prepare('SELECT * FROM request_error_monitor_sites WHERE own_site_id = ?').get(ownSiteId);
  const nextKey = clearKey ? '' : (apiKey ? encryptSecret(apiKey) : current.encrypted_admin_api_key);
  db.prepare(`
    UPDATE request_error_monitor_sites
    SET enabled = ?, encrypted_admin_api_key = ?, group_ids = ?, updated_at = ?
    WHERE own_site_id = ?
  `).run(
    enabled === undefined ? current.enabled : (enabled ? 1 : 0),
    nextKey,
    groupIds === undefined ? current.group_ids : JSON.stringify([...new Set(groupIds.map(String))]),
    nowIso(),
    ownSiteId
  );
  return getMonitorSite(ownSiteId);
}

function saveMonitorGroupsCache(ownSiteId, groups) {
  ensureMonitorRow(ownSiteId);
  db.prepare('UPDATE request_error_monitor_sites SET groups_cache = ?, updated_at = ? WHERE own_site_id = ?')
    .run(JSON.stringify(groups || []), nowIso(), ownSiteId);
}

function recordMonitorPoll(ownSiteId, { error = '', found = 0, at = nowIso() } = {}) {
  ensureMonitorRow(ownSiteId);
  db.prepare(`
    UPDATE request_error_monitor_sites
    SET last_poll_at = ?, last_poll_error = ?, last_poll_found = ?, updated_at = ?
    WHERE own_site_id = ?
  `).run(at, String(error || '').slice(0, 500), found, at, ownSiteId);
}

function rowToEvent(row) {
  if (!row) return null;
  const event = { ...row };
  for (const field of JSON_FIELDS) event[field] = parseJson(row[field], []);
  return event;
}

function knownErrorIds(ownSiteId, errorIds) {
  if (!errorIds.length) return new Set();
  const placeholders = errorIds.map(() => '?').join(', ');
  return new Set(db.prepare(`
    SELECT error_id FROM request_error_events WHERE own_site_id = ? AND error_id IN (${placeholders})
  `).all(ownSiteId, ...errorIds.map(String)).map((row) => row.error_id));
}

// Inserts a newly discovered error with list-level data only. Dedupes on (own_site_id, error_id).
function insertPendingEvent(ownSiteId, item) {
  const now = nowIso();
  const result = db.prepare(`
    INSERT INTO request_error_events (
      own_site_id, error_id, delivery_id, group_id, group_name, occurred_at, status_code, phase, error_type,
      error_owner, error_source, message, platform, model, request_id, detail_status, captured_at, updated_at
    ) VALUES (
      @own_site_id, @error_id, @delivery_id, @group_id, @group_name, @occurred_at, @status_code, @phase, @error_type,
      @error_owner, @error_source, @message, @platform, @model, @request_id, 'pending', @now, @now
    ) ON CONFLICT(own_site_id, error_id) DO NOTHING
  `).run({ ...item, own_site_id: ownSiteId, now });
  return result.changes > 0;
}

function listPendingDetailEvents(limit, now = nowIso()) {
  return db.prepare(`
    SELECT e.*, COALESCE(d.attempts, 0) AS detail_attempts
    FROM request_error_events e
    LEFT JOIN request_error_deliveries d ON d.event_id = e.id AND d.channel = 'detail'
    WHERE e.detail_status = 'pending' AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)
    ORDER BY e.occurred_at ASC, e.id ASC LIMIT ?
  `).all(now, limit).map(rowToEvent);
}

function countDetailAttempt(eventId, error, nextAttemptAt) {
  const now = nowIso();
  db.prepare('UPDATE request_error_events SET detail_error = ?, updated_at = ? WHERE id = ?')
    .run(String(error || '').slice(0, 1000), now, eventId);
  return db.prepare(`
    INSERT INTO request_error_deliveries (event_id, channel, status, attempts, next_attempt_at, last_error, updated_at)
    VALUES (?, 'detail', 'pending', 1, ?, ?, ?)
    ON CONFLICT(event_id, channel) DO UPDATE SET
      attempts = attempts + 1, next_attempt_at = excluded.next_attempt_at,
      last_error = excluded.last_error, updated_at = excluded.updated_at
    RETURNING attempts
  `).get(eventId, nextAttemptAt, String(error || '').slice(0, 500), now).attempts;
}

// Stores fetched details, routing decision, and the delivery plan in one transaction.
function completeEventDetail(eventId, detail, channels) {
  const now = nowIso();
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE request_error_events SET
        group_id = @group_id, group_name = @group_name, status_code = @status_code, phase = @phase,
        error_type = @error_type, error_owner = @error_owner, error_source = @error_source, message = @message,
        platform = @platform, model = @model, request_id = @request_id, error_body = @error_body,
        upstream_status_code = @upstream_status_code, upstream_error_message = @upstream_error_message,
        upstream_error_detail = @upstream_error_detail, upstream_errors = @upstream_errors,
        related_upstream_errors = @related_upstream_errors, error_codes = @error_codes,
        detail_status = @detail_status, detail_error = @detail_error, route = @route,
        matched_codes = @matched_codes, updated_at = @now
      WHERE id = @id
    `).run({
      ...detail,
      id: eventId,
      upstream_errors: JSON.stringify(detail.upstream_errors || []),
      related_upstream_errors: JSON.stringify(detail.related_upstream_errors || []),
      error_codes: JSON.stringify(detail.error_codes || []),
      matched_codes: JSON.stringify(detail.matched_codes || []),
      now
    });
    db.prepare("DELETE FROM request_error_deliveries WHERE event_id = ? AND channel = 'detail'").run(eventId);
    const insert = db.prepare(`
      INSERT INTO request_error_deliveries (event_id, channel, status, attempts, next_attempt_at, last_error, updated_at)
      VALUES (?, ?, ?, 0, ?, ?, ?) ON CONFLICT(event_id, channel) DO NOTHING
    `);
    for (const channel of channels) {
      insert.run(eventId, channel.channel, channel.status || 'pending', null, channel.reason || '', now);
    }
  });
  tx();
  return getEvent(eventId);
}

function getEvent(id) {
  const event = rowToEvent(db.prepare(`
    SELECT e.*, s.name AS own_site_name, s.base_url AS own_site_base_url
    FROM request_error_events e JOIN own_sites s ON s.id = e.own_site_id
    WHERE e.id = ?
  `).get(id));
  if (!event) return null;
  event.deliveries = listEventDeliveries(id);
  return event;
}

function listEventDeliveries(eventId) {
  return db.prepare(`
    SELECT channel, status, attempts, next_attempt_at, last_error, delivered_at, updated_at
    FROM request_error_deliveries WHERE event_id = ? AND channel != 'detail'
  `).all(eventId).sort((a, b) => CHANNELS.indexOf(a.channel) - CHANNELS.indexOf(b.channel));
}

function listEvents({ ownSiteId = null, route = '', search = '', limit = 200, offset = 0 } = {}) {
  const where = [];
  const params = {};
  if (ownSiteId) { where.push('e.own_site_id = @ownSiteId'); params.ownSiteId = ownSiteId; }
  if (route) { where.push('e.route = @route'); params.route = route; }
  if (search) {
    where.push(`(e.message LIKE @search OR e.upstream_error_message LIKE @search OR e.error_codes LIKE @search
      OR e.group_name LIKE @search OR e.delivery_id LIKE @search OR e.error_id = @exact)`);
    params.search = `%${search}%`;
    params.exact = search;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS count FROM request_error_events e ${clause}`).get(params).count;
  const rows = db.prepare(`
    SELECT e.id, e.own_site_id, s.name AS own_site_name, e.error_id, e.delivery_id, e.group_id, e.group_name,
           e.occurred_at, e.status_code, e.phase, e.error_type, e.message, e.model, e.upstream_status_code,
           e.upstream_error_message, e.error_codes, e.matched_codes, e.detail_status, e.route,
           e.hermes_processing, e.hermes_delivery
    FROM request_error_events e JOIN own_sites s ON s.id = e.own_site_id
    ${clause}
    ORDER BY e.occurred_at DESC, e.id DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit, offset }).map(rowToEvent);
  const deliveries = rows.length ? db.prepare(`
    SELECT event_id, channel, status, attempts, last_error FROM request_error_deliveries
    WHERE channel != 'detail' AND event_id IN (${rows.map((row) => row.id).join(', ')})
  `).all() : [];
  for (const row of rows) {
    row.deliveries = deliveries.filter((item) => item.event_id === row.id)
      .sort((a, b) => CHANNELS.indexOf(a.channel) - CHANNELS.indexOf(b.channel));
  }
  return { items: rows, total };
}

function listDueDeliveries(now = nowIso(), limit = 50) {
  return db.prepare(`
    SELECT d.event_id, d.channel, d.attempts, d.status
    FROM request_error_deliveries d
    WHERE d.status = 'pending' AND d.channel != 'detail' AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= ?)
    ORDER BY d.next_attempt_at ASC
    LIMIT ?
  `).all(now, limit);
}

function updateDelivery(eventId, channel, { status, attempts, next_attempt_at: nextAttemptAt = null, last_error: lastError = '', delivered = false }) {
  const now = nowIso();
  return db.prepare(`
    UPDATE request_error_deliveries
    SET status = ?, attempts = COALESCE(?, attempts), next_attempt_at = ?, last_error = ?,
        delivered_at = CASE WHEN ? THEN ? ELSE delivered_at END, updated_at = ?
    WHERE event_id = ? AND channel = ?
  `).run(status, attempts ?? null, nextAttemptAt, String(lastError || '').slice(0, 1000), delivered ? 1 : 0, now, now, eventId, channel).changes > 0;
}

function ensureDelivery(eventId, channel, status = 'pending', reason = '') {
  const now = nowIso();
  db.prepare(`
    INSERT INTO request_error_deliveries (event_id, channel, status, attempts, next_attempt_at, last_error, updated_at)
    VALUES (?, ?, ?, 0, NULL, ?, ?) ON CONFLICT(event_id, channel) DO NOTHING
  `).run(eventId, channel, status, reason, now);
}

// Manual retry: reset failed channels to pending without touching delivered ones.
function retryFailedDeliveries(eventId) {
  return db.prepare(`
    UPDATE request_error_deliveries SET status = 'pending', attempts = 0, next_attempt_at = NULL, updated_at = ?
    WHERE event_id = ? AND status = 'failed'
  `).run(nowIso(), eventId).changes;
}

function updateHermesReceipt(eventId, { processing, delivery, result }) {
  db.prepare(`
    UPDATE request_error_events SET hermes_processing = ?, hermes_delivery = ?, hermes_result = ?, updated_at = ?
    WHERE id = ?
  `).run(processing || '', delivery || '', String(result || '').slice(0, 20000), nowIso(), eventId);
}

function summarizeEvents() {
  const routes = db.prepare('SELECT route, COUNT(*) AS count FROM request_error_events GROUP BY route').all();
  const pending = db.prepare("SELECT COUNT(*) AS count FROM request_error_deliveries WHERE status = 'pending' AND channel != 'detail'").get().count;
  const failed = db.prepare("SELECT COUNT(*) AS count FROM request_error_deliveries WHERE status = 'failed'").get().count;
  return {
    by_route: Object.fromEntries(routes.map((row) => [row.route, row.count])),
    pending_deliveries: pending,
    failed_deliveries: failed
  };
}

module.exports = {
  CHANNELS,
  listMonitorSites,
  getMonitorSite,
  getMonitorAdminApiKey,
  saveMonitorSite,
  saveMonitorGroupsCache,
  recordMonitorPoll,
  knownErrorIds,
  insertPendingEvent,
  listPendingDetailEvents,
  countDetailAttempt,
  completeEventDetail,
  getEvent,
  listEvents,
  listDueDeliveries,
  updateDelivery,
  ensureDelivery,
  retryFailedDeliveries,
  updateHermesReceipt,
  summarizeEvents
};
