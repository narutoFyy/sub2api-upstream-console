const errorRepo = require('./requestErrorRepository');
const client = require('./requestErrorClient');
const { effectiveRequestErrorSettings } = require('./requestErrorSettings');
const { submitHermesEvent, fetchHermesReceipt } = require('./hermesClient');
const { pushPlusStatus, sendPushPlus } = require('./pushPlusClient');
const { emailStatus, sendEmail } = require('./emailClient');
const { formatBeijingTime } = require('./alertService');

const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
const MAX_TRANSIENT_BACKOFF_MS = 30 * 60 * 1000;
const RECEIPT_SETTLE_SECONDS = 120;
const MAX_BODY_CHARS = 4000;

function redact(value, maxLength = MAX_BODY_CHARS) {
  const text = String(value ?? '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|ak|rk)-[A-Za-z0-9_-]{8,}\b/g, '[redacted-key]')
    .replace(/(["']?(?:x-api-key|api[_-]?key|authorization|password|passwd|secret|token|access_token|refresh_token|cookie|proxy[_-]?password)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}&]+)/gi, '$1[redacted]')
    .replace(/\b(https?|socks5h?):\/\/[^\s:@/]+:[^\s@/]+@/gi, '$1://[redacted]@');
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function parseJsonValue(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try { return JSON.parse(value); } catch { return null; }
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

// Collects structured code-like fields (code/type/reason/...) from an upstream JSON body.
function structuredCodes(value, depth = 0, out = new Set()) {
  if (!value || typeof value !== 'object' || depth > 3) return out;
  for (const [key, item] of Object.entries(value)) {
    if (['code', 'type', 'error_code', 'reason', 'status'].includes(key)
      && (typeof item === 'string' || typeof item === 'number')
      && String(item).trim() && String(item).length <= 80) {
      out.add(String(item).trim().toLowerCase());
    } else if (item && typeof item === 'object') {
      structuredCodes(item, depth + 1, out);
    }
  }
  return out;
}

function compact(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== '' && value !== null));
}

function normalizeUpstreamAttempt(raw) {
  return compact({
    at: raw?.at_unix_ms ? new Date(Number(raw.at_unix_ms)).toISOString() : '',
    platform: String(raw?.platform || ''),
    account_name: String(raw?.account_name || ''),
    upstream_status_code: numberOrNull(raw?.upstream_status_code),
    kind: String(raw?.kind || ''),
    stage: String(raw?.stage || ''),
    reason: String(raw?.reason || ''),
    message: redact(raw?.message || '', 1000),
    detail: redact(raw?.detail || '', MAX_BODY_CHARS),
    upstream_url: redact(raw?.upstream_url || '', 300),
    upstream_response_body: redact(raw?.upstream_response_body || '', MAX_BODY_CHARS)
  });
}

function normalizeRelatedError(raw) {
  return compact({
    id: String(raw?.id ?? ''),
    created_at: String(raw?.created_at || ''),
    phase: String(raw?.phase || ''),
    type: String(raw?.type || ''),
    status_code: numberOrNull(raw?.status_code),
    upstream_status_code: numberOrNull(raw?.upstream_status_code),
    account_name: String(raw?.account_name || ''),
    message: redact(raw?.message || '', 1000),
    upstream_error_message: redact(raw?.upstream_error_message || '', 1000),
    upstream_error_detail: redact(raw?.upstream_error_detail || '', MAX_BODY_CHARS),
    error_body: redact(raw?.error_body || '', MAX_BODY_CHARS)
  });
}

function listItemToEvent(ownSiteId, item) {
  const errorId = String(item.id);
  return {
    error_id: errorId,
    delivery_id: `sub2api-${ownSiteId}-${errorId}`,
    group_id: item.group_id == null ? '' : String(item.group_id),
    group_name: String(item.group_name || ''),
    occurred_at: item.created_at ? new Date(item.created_at).toISOString() : new Date().toISOString(),
    status_code: numberOrNull(item.status_code),
    phase: String(item.phase || ''),
    error_type: String(item.type || ''),
    error_owner: String(item.error_owner || ''),
    error_source: String(item.error_source || ''),
    message: redact(item.message || '', 2000),
    platform: String(item.platform || ''),
    model: String(item.requested_model || item.model || ''),
    request_id: String(item.request_id || item.client_request_id || '')
  };
}

// Ordered most specific first: upstream structured codes, then statuses, then local classification.
function extractErrorCodes(event) {
  const upstream = upstreamCodes(event);
  const codes = new Set(upstream);
  const add = (value) => {
    const text = String(value ?? '').trim().toLowerCase();
    if (text && text.length <= 120) codes.add(text);
  };
  structuredCodes(parseJsonValue(event.error_body)).forEach(add);
  [event.error_type, event.status_code, event.phase, event.error_owner, event.error_source].forEach(add);
  codes.delete('0');
  return [...codes];
}

function upstreamCodes(event) {
  const codes = new Set();
  const add = (value) => {
    const text = String(value ?? '').trim().toLowerCase();
    if (text && text !== '0' && text.length <= 120) codes.add(text);
  };
  for (const body of [event.upstream_error_detail, event.upstream_error_message]) {
    structuredCodes(parseJsonValue(body)).forEach(add);
  }
  for (const attempt of event.upstream_errors || []) {
    structuredCodes(parseJsonValue(attempt.upstream_response_body)).forEach(add);
    structuredCodes(parseJsonValue(attempt.detail)).forEach(add);
  }
  for (const related of event.related_upstream_errors || []) {
    structuredCodes(parseJsonValue(related.error_body)).forEach(add);
    structuredCodes(parseJsonValue(related.upstream_error_detail)).forEach(add);
  }
  add(event.upstream_status_code);
  for (const attempt of event.upstream_errors || []) {
    [attempt.upstream_status_code, attempt.kind, attempt.reason, attempt.stage].forEach(add);
  }
  for (const related of event.related_upstream_errors || []) {
    [related.type, related.upstream_status_code].forEach(add);
  }
  return [...codes];
}

function upstreamTexts(event) {
  const texts = [event.upstream_error_message, event.upstream_error_detail];
  for (const attempt of event.upstream_errors || []) texts.push(attempt.message, attempt.detail, attempt.upstream_response_body);
  for (const related of event.related_upstream_errors || []) {
    texts.push(related.upstream_error_message, related.upstream_error_detail, related.error_body);
  }
  return texts.map((text) => String(text || '').trim().toLowerCase()).filter(Boolean);
}

// Codes are matched exactly; free text (error messages and bodies) only by * patterns.
function matchCandidates(event) {
  const upstream = upstreamCodes(event);
  const localTexts = [event.message, event.error_body].map((text) => String(text || '').trim().toLowerCase()).filter(Boolean);
  return {
    codes: extractErrorCodes(event),
    upstream_codes: upstream,
    texts: [...upstreamTexts(event), ...localTexts],
    upstream_texts: upstreamTexts(event)
  };
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 's');
}

function codeMatches(pattern, code) {
  if (pattern === code) return true;
  const wildcard = /^([1-5])xx$/.exec(pattern);
  if (wildcard) return /^\d{3}$/.test(code) && code[0] === wildcard[1];
  return pattern.includes('*') && globToRegExp(pattern).test(code);
}

function patternMatches(rawPattern, candidates) {
  const scoped = rawPattern.startsWith('upstream:');
  const pattern = scoped ? rawPattern.slice('upstream:'.length) : rawPattern;
  if (!pattern) return false;
  if (pattern === '*') return !scoped || candidates.upstream_codes.length > 0;
  const codes = scoped ? candidates.upstream_codes : candidates.codes;
  if (codes.some((code) => codeMatches(pattern, code))) return true;
  if (!pattern.includes('*')) return false;
  const texts = scoped ? candidates.upstream_texts : candidates.texts;
  return texts.some((text) => codeMatches(pattern, text));
}

// manual_codes win when an error matches both lists.
function classifyRoute(input, settings) {
  const candidates = Array.isArray(input)
    ? { codes: input, upstream_codes: input, texts: [], upstream_texts: [] }
    : input;
  const matchList = (patterns) => patterns.filter((pattern) => patternMatches(pattern, candidates));
  const manual = matchList(settings.manual_codes || []);
  if (manual.length) return { route: 'manual', matched: manual };
  const hermes = matchList(settings.hermes_codes || []);
  if (hermes.length) return { route: 'hermes', matched: hermes };
  return { route: 'none', matched: [] };
}

// Shows the actual error codes when the route matched only wildcard patterns.
function displayCodes(event) {
  const exact = (event.matched_codes || []).filter((code) => !code.includes('*'));
  const codes = exact.length ? exact : (event.error_codes || []).slice(0, 3);
  return codes.filter(Boolean).join(', ') || event.error_type || event.phase || '-';
}

function upstreamSummary(event) {
  const parts = [];
  if (event.upstream_status_code) parts.push(`上游状态码：${event.upstream_status_code}`);
  if (event.upstream_error_message) parts.push(`上游错误：${redact(event.upstream_error_message, 500)}`);
  const lastAttempt = (event.upstream_errors || []).at(-1);
  if (lastAttempt?.upstream_response_body) parts.push(`最后一次上游响应：${redact(lastAttempt.upstream_response_body, 500)}`);
  return parts.join('\n') || '未记录上游报错';
}

function baseLines(event, site) {
  return [
    `事件 ID：${event.delivery_id}`,
    `站点：${site.name}（${site.base_url}）`,
    `分组：${event.group_name || '-'}${event.group_id ? `（ID ${event.group_id}）` : ''}`,
    `错误码：${displayCodes(event)}`,
    `用户状态码：${event.status_code ?? '-'}`,
    `上游状态码：${event.upstream_status_code ?? '-'}`,
    `时间：${formatBeijingTime(event.occurred_at)}`,
    `Sub2API 错误记录 ID：${event.error_id}`
  ];
}

function buildNotification(event, site, { hermesActive }) {
  if (event.route === 'hermes') {
    const head = hermesActive
      ? '用户请求报错已产生，并已移交 Hermes 处理。'
      : '用户请求报错命中 Hermes 错误码，但 Hermes 未启用或未配置，请人工处理。';
    return {
      title: `[用户报错] ${hermesActive ? '已移交 Hermes' : '需人工处理'} · ${site.name} · ${displayCodes(event)}`,
      content: [head, '', ...baseLines(event, site)].join('\n')
    };
  }
  return {
    title: `[用户报错] 需人工处理 · ${site.name} · ${displayCodes(event)}`,
    content: [
      '用户请求报错命中人工处理错误码，未调用 Hermes。',
      '',
      ...baseLines(event, site),
      event.detail_status === 'partial' ? `详情状态：部分详情（${event.detail_error || '详情取数失败'}）` : '',
      '',
      `本地报错：${[event.phase, event.error_type, event.error_owner, event.error_source].filter(Boolean).join(' / ') || '-'}`,
      `本地消息：${redact(event.message, 500) || '-'}`,
      upstreamSummary(event)
    ].filter((line, index, lines) => line !== '' || lines[index - 1] !== '').join('\n')
  };
}

function buildErrorReport(event, site) {
  const lines = [
    '## Sub2API 用户请求错误',
    ...baseLines(event, site),
    `平台 / 模型：${event.platform || '-'} / ${event.model || '-'}`,
    `请求 ID：${event.request_id || '-'}`,
    `详情完整性：${event.detail_status === 'complete' ? '完整（Sub2API 已记录并脱敏、截断后的内容）' : `部分详情：${event.detail_error || '详情取数失败'}`}`,
    '',
    '### 本地报错',
    `phase=${event.phase || '-'} type=${event.error_type || '-'} owner=${event.error_owner || '-'} source=${event.error_source || '-'}`,
    `消息：${event.message || '-'}`,
    `用户收到的错误响应：${event.error_body || '-'}`,
    '',
    '### 上游报错',
    `上游状态码：${event.upstream_status_code ?? '-'}`,
    `上游错误消息：${event.upstream_error_message || '-'}`,
    `上游错误详情：${event.upstream_error_detail || '-'}`
  ];
  const attempts = event.upstream_errors || [];
  lines.push('', `### 上游尝试记录（upstream_errors，共 ${attempts.length} 条）`);
  if (attempts.length) lines.push('```json', JSON.stringify(attempts, null, 2), '```');
  const related = event.related_upstream_errors || [];
  if (related.length) {
    lines.push('', `### 关联上游错误日志（共 ${related.length} 条）`, '```json', JSON.stringify(related, null, 2), '```');
  }
  return lines.join('\n');
}

function buildHermesPayload(event, site, settings) {
  const report = buildErrorReport(event, site);
  const intro = String(settings.hermes_prompt || '').trim().replaceAll('{codes}', displayCodes(event));
  const prompt = [intro, report].filter(Boolean).join('\n\n');
  return {
    delivery_id: event.delivery_id,
    event_type: 'sub2api.request_error',
    report_target: settings.hermes_report_target || '',
    prompt,
    event: {
      event_id: event.delivery_id,
      site: { id: site.own_site_id ?? event.own_site_id, name: site.name, base_url: site.base_url },
      group: { id: event.group_id, name: event.group_name },
      error_id: event.error_id,
      occurred_at: event.occurred_at,
      status_code: event.status_code,
      upstream_status_code: event.upstream_status_code,
      phase: event.phase,
      type: event.error_type,
      error_owner: event.error_owner,
      error_source: event.error_source,
      message: event.message,
      error_body: event.error_body,
      platform: event.platform,
      model: event.model,
      request_id: event.request_id,
      upstream_error_message: event.upstream_error_message,
      upstream_error_detail: event.upstream_error_detail,
      upstream_errors: event.upstream_errors,
      related_upstream_errors: event.related_upstream_errors,
      matched_codes: event.matched_codes,
      error_codes: event.error_codes,
      detail_status: event.detail_status,
      detail_error: event.detail_error
    }
  };
}

function hermesActive(settings) {
  return Boolean(settings.hermes_enabled && settings.hermes_secret && settings.hermes_webhook_url);
}

function notificationChannels(dependencies = {}) {
  return {
    pushplus: (dependencies.pushPlusStatus || pushPlusStatus)().configured,
    email: Boolean((dependencies.emailStatus || emailStatus)().enabled)
  };
}

function planDeliveries(route, settings, dependencies = {}) {
  if (route === 'none') return [];
  const available = notificationChannels(dependencies);
  const plan = ['pushplus', 'email'].map((channel) => (available[channel]
    ? { channel }
    : { channel, status: 'skipped', reason: channel === 'pushplus' ? 'PushPlus 未配置' : '邮箱提醒未配置或未启用' }));
  if (route === 'hermes') {
    plan.push(hermesActive(settings)
      ? { channel: 'hermes' }
      : { channel: 'hermes', status: 'skipped', reason: 'Hermes 未启用或缺少 HMAC 密钥' });
  }
  return plan;
}

async function pollSite(site, settings, dependencies = {}) {
  const repository = dependencies.errorRepo || errorRepo;
  const api = dependencies.client || client;
  const now = dependencies.now || Date.now();
  const apiKey = repository.getMonitorAdminApiKey(site.own_site_id);
  if (!apiKey) {
    repository.recordMonitorPoll(site.own_site_id, { error: '缺少管理员 API Key' });
    return { found: 0, error: '缺少管理员 API Key' };
  }
  const window = {
    baseUrl: site.base_url,
    apiKey,
    startTime: new Date(now - settings.lookback_minutes * 60 * 1000).toISOString(),
    endTime: new Date(now).toISOString(),
    timeoutMs: settings.request_timeout_ms
  };
  try {
    const groups = site.group_ids.length ? site.group_ids : [''];
    const items = [];
    for (const groupId of groups) items.push(...await api.listRequestErrors({ ...window, groupId }));
    const unique = [...new Map(items.filter((item) => item?.id != null).map((item) => [String(item.id), item])).values()];
    const known = repository.knownErrorIds(site.own_site_id, unique.map((item) => String(item.id)));
    let found = 0;
    for (const item of unique) {
      if (known.has(String(item.id))) continue;
      if (repository.insertPendingEvent(site.own_site_id, listItemToEvent(site.own_site_id, item))) found += 1;
    }
    repository.recordMonitorPoll(site.own_site_id, { found });
    return { found, error: '' };
  } catch (error) {
    repository.recordMonitorPoll(site.own_site_id, { error: error.message });
    return { found: 0, error: error.message };
  }
}

function backoffDelay(settings, attempts, cap = MAX_BACKOFF_MS) {
  return Math.min(cap, settings.retry_backoff_seconds * 1000 * 2 ** Math.max(0, attempts - 1));
}

async function fetchEventDetail(event, site, apiKey, settings, api) {
  const options = { baseUrl: site.base_url, apiKey, errorId: event.error_id, timeoutMs: settings.request_timeout_ms };
  const errors = [];
  let detail = null;
  let related = [];
  try {
    detail = await api.getRequestErrorDetail(options);
  } catch (error) {
    errors.push(`详情接口失败：${error.message}`);
  }
  try {
    related = await api.listRelatedUpstreamErrors(options);
  } catch (error) {
    errors.push(`上游错误接口失败：${error.message}`);
  }
  return { detail, related, errors };
}

function mergeDetail(event, detail, related) {
  const source = detail || {};
  const attempts = parseJsonValue(source.upstream_errors);
  return {
    group_id: source.group_id == null ? event.group_id : String(source.group_id),
    group_name: String(source.group_name || event.group_name || ''),
    status_code: numberOrNull(source.status_code) ?? event.status_code,
    phase: String(source.phase || event.phase || ''),
    error_type: String(source.type || event.error_type || ''),
    error_owner: String(source.error_owner || event.error_owner || ''),
    error_source: String(source.error_source || event.error_source || ''),
    message: redact(source.message || event.message || '', 2000),
    platform: String(source.platform || event.platform || ''),
    model: String(source.requested_model || source.model || event.model || ''),
    request_id: String(source.request_id || source.client_request_id || event.request_id || ''),
    upstream_status_code: numberOrNull(source.upstream_status_code),
    upstream_error_message: redact(source.upstream_error_message || '', 2000),
    upstream_error_detail: redact(source.upstream_error_detail || '', MAX_BODY_CHARS),
    error_body: redact(source.error_body || '', MAX_BODY_CHARS),
    upstream_errors: Array.isArray(attempts) ? attempts.map(normalizeUpstreamAttempt) : [],
    related_upstream_errors: (related || []).map(normalizeRelatedError)
  };
}

async function processPendingDetails(settings, dependencies = {}) {
  const repository = dependencies.errorRepo || errorRepo;
  const api = dependencies.client || client;
  const now = dependencies.now || Date.now();
  const pending = repository.listPendingDetailEvents(settings.max_details_per_poll, new Date(now).toISOString());
  const sites = new Map();
  const results = [];
  for (const event of pending) {
    if (!sites.has(event.own_site_id)) {
      sites.set(event.own_site_id, {
        site: repository.getMonitorSite(event.own_site_id),
        apiKey: repository.getMonitorAdminApiKey(event.own_site_id)
      });
    }
    const { site, apiKey } = sites.get(event.own_site_id);
    let fetched;
    if (!site || !apiKey) {
      fetched = { detail: null, related: [], errors: ['缺少管理员 API Key，无法读取详情'], final: true };
    } else {
      fetched = await fetchEventDetail(event, site, apiKey, settings, api);
    }
    if (fetched.errors.length && !fetched.final && event.detail_attempts < settings.max_retries) {
      const nextAttempt = new Date(now + backoffDelay(settings, event.detail_attempts + 1)).toISOString();
      repository.countDetailAttempt(event.id, fetched.errors.join('；'), nextAttempt);
      results.push({ id: event.id, status: 'retry' });
      continue;
    }
    const merged = mergeDetail(event, fetched.detail, fetched.related);
    const errorCodes = extractErrorCodes(merged);
    const { route, matched } = classifyRoute(matchCandidates(merged), settings);
    const detail = {
      ...merged,
      error_codes: errorCodes,
      detail_status: fetched.errors.length ? 'partial' : 'complete',
      detail_error: fetched.errors.join('；'),
      route,
      matched_codes: matched
    };
    repository.completeEventDetail(event.id, detail, planDeliveries(route, settings, dependencies));
    results.push({ id: event.id, status: detail.detail_status, route });
  }
  return results;
}

function isTransient(error) {
  const status = Number(error?.status);
  return !Number.isFinite(status) || status >= 500 || status === 429 || status === 408;
}

async function deliverReceipt(event, delivery, settings, dependencies) {
  const now = dependencies.now || Date.now();
  const repository = dependencies.errorRepo || errorRepo;
  const hermesDelivery = event.deliveries.find((item) => item.channel === 'hermes');
  const submittedAt = Date.parse(hermesDelivery?.delivered_at || '') || now;
  const timedOut = now - submittedAt > settings.hermes_receipt_timeout_minutes * 60 * 1000;
  const next = new Date(now + Math.max(30, settings.retry_backoff_seconds) * 1000).toISOString();
  let receipt;
  try {
    receipt = await (dependencies.fetchHermesReceipt || fetchHermesReceipt)(event.delivery_id, settings);
  } catch (error) {
    return repository.updateDelivery(event.id, 'weixin', timedOut
      ? { status: 'failed', attempts: delivery.attempts + 1, last_error: `回执超时：${error.message}` }
      : { status: 'pending', attempts: delivery.attempts + 1, next_attempt_at: next, last_error: error.message });
  }
  if (receipt) repository.updateHermesReceipt(event.id, receipt);
  if (receipt?.delivery === 'delivered') {
    return repository.updateDelivery(event.id, 'weixin', { status: 'sent', attempts: delivery.attempts + 1, delivered: true });
  }
  if (receipt?.delivery === 'failed') {
    return repository.updateDelivery(event.id, 'weixin', {
      status: 'failed', attempts: delivery.attempts + 1, last_error: 'Hermes 报告微信投递失败'
    });
  }
  const finished = ['completed', 'failed', 'cancelled'].includes(receipt?.processing);
  const settledAt = receipt?.updated_at ? receipt.updated_at * 1000 : now;
  if (finished && now - settledAt > RECEIPT_SETTLE_SECONDS * 1000) {
    return repository.updateDelivery(event.id, 'weixin', {
      status: 'failed',
      attempts: delivery.attempts + 1,
      last_error: `Hermes 处理结束（${receipt.processing}），但未记录微信汇报投递`
    });
  }
  const waiting = receipt ? `Hermes 处理状态：${receipt.processing || '未知'}` : 'Hermes 尚无此事件的回执';
  return repository.updateDelivery(event.id, 'weixin', timedOut
    ? { status: 'failed', attempts: delivery.attempts + 1, last_error: `回执超时（${waiting}）` }
    : { status: 'pending', attempts: delivery.attempts + 1, next_attempt_at: next, last_error: waiting });
}

async function deliverOne(event, site, delivery, settings, dependencies = {}) {
  const repository = dependencies.errorRepo || errorRepo;
  const now = dependencies.now || Date.now();
  if (delivery.channel === 'weixin') return deliverReceipt(event, delivery, settings, dependencies);
  const attempts = delivery.attempts + 1;
  try {
    if (delivery.channel === 'hermes') {
      if (!hermesActive(settings)) throw Object.assign(new Error('Hermes 未启用或缺少 HMAC 密钥'), { status: 422 });
      await (dependencies.submitHermesEvent || submitHermesEvent)(buildHermesPayload(event, site, settings), settings);
      repository.updateDelivery(event.id, 'hermes', { status: 'sent', attempts, delivered: true });
      repository.ensureDelivery(event.id, 'weixin', settings.hermes_receipt_enabled ? 'pending' : 'skipped',
        settings.hermes_receipt_enabled ? '' : '未启用 Hermes 回执查询');
      return true;
    }
    const message = buildNotification(event, site, {
      hermesActive: event.deliveries.find((item) => item.channel === 'hermes')?.status !== 'skipped' && hermesActive(settings)
    });
    const send = delivery.channel === 'pushplus'
      ? (dependencies.sendPushPlus || sendPushPlus)
      : (dependencies.sendEmail || sendEmail);
    await send(message, dependencies.notifierDependencies || {});
    return repository.updateDelivery(event.id, delivery.channel, { status: 'sent', attempts, delivered: true });
  } catch (error) {
    const hermesTransient = delivery.channel === 'hermes' && isTransient(error);
    const occurredAt = Date.parse(event.captured_at || event.occurred_at) || now;
    const withinWindow = now - occurredAt < settings.hermes_receipt_timeout_minutes * 60 * 1000;
    const exhausted = hermesTransient ? !withinWindow : attempts > settings.max_retries;
    return repository.updateDelivery(event.id, delivery.channel, exhausted
      ? { status: 'failed', attempts, last_error: error.message }
      : {
        status: 'pending',
        attempts,
        next_attempt_at: new Date(now + backoffDelay(settings, attempts, hermesTransient ? MAX_TRANSIENT_BACKOFF_MS : MAX_BACKOFF_MS)).toISOString(),
        last_error: error.message
      });
  }
}

async function dispatchDueDeliveries(settings, dependencies = {}) {
  const repository = dependencies.errorRepo || errorRepo;
  const now = dependencies.now || Date.now();
  const due = repository.listDueDeliveries(new Date(now).toISOString(), 50);
  const sites = new Map();
  let processed = 0;
  for (const delivery of due) {
    const event = repository.getEvent(delivery.event_id);
    if (!event) continue;
    if (!sites.has(event.own_site_id)) sites.set(event.own_site_id, repository.getMonitorSite(event.own_site_id));
    const site = sites.get(event.own_site_id) || { name: event.own_site_name, base_url: event.own_site_base_url };
    await deliverOne(event, site, delivery, settings, dependencies);
    processed += 1;
  }
  return processed;
}

async function pollAllSites(settings, dependencies = {}) {
  const repository = dependencies.errorRepo || errorRepo;
  const sites = repository.listMonitorSites().filter((site) => site.enabled && site.own_site_status !== 'disabled');
  const results = [];
  for (const site of sites) results.push({ own_site_id: site.own_site_id, ...await pollSite(site, settings, dependencies) });
  return results;
}

function createRequestErrorState() {
  return { lastPollAt: 0, running: false };
}

// Called on every runtime-scheduler tick. Polling follows poll_interval_seconds;
// detail fetching and retries run whenever their own next_attempt_at is due.
async function runRequestErrorMonitor(state, dependencies = {}) {
  const settings = dependencies.settings || effectiveRequestErrorSettings();
  if (state.running) return { skipped: true };
  const now = dependencies.now || Date.now();
  state.running = true;
  try {
    let polled = [];
    if (settings.enabled && (!state.lastPollAt || now - state.lastPollAt >= settings.poll_interval_seconds * 1000)) {
      state.lastPollAt = now;
      polled = await pollAllSites(settings, dependencies);
    }
    const details = settings.enabled ? await processPendingDetails(settings, dependencies) : [];
    const delivered = await dispatchDueDeliveries(settings, dependencies);
    return { polled, details, delivered };
  } finally {
    state.running = false;
  }
}

async function pollSiteNow(ownSiteId, dependencies = {}) {
  const repository = dependencies.errorRepo || errorRepo;
  const settings = dependencies.settings || effectiveRequestErrorSettings();
  const site = repository.getMonitorSite(ownSiteId);
  if (!site) throw Object.assign(new Error('Not found'), { status: 404 });
  const poll = await pollSite(site, settings, dependencies);
  const details = await processPendingDetails(settings, dependencies);
  const delivered = await dispatchDueDeliveries(settings, dependencies);
  return { ...poll, details: details.length, delivered };
}

module.exports = {
  redact,
  extractErrorCodes,
  classifyRoute,
  codeMatches,
  matchCandidates,
  listItemToEvent,
  mergeDetail,
  buildNotification,
  buildErrorReport,
  buildHermesPayload,
  planDeliveries,
  pollSite,
  pollAllSites,
  processPendingDetails,
  dispatchDueDeliveries,
  deliverOne,
  createRequestErrorState,
  runRequestErrorMonitor,
  pollSiteNow
};
