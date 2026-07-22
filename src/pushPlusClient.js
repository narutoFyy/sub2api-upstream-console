const config = require('./config');
const repo = require('./repository');
const crypto = require('node:crypto');

const PUSHPLUS_TARGETS_KEY = 'pushplus_targets';

class PushPlusError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'PushPlusError';
    this.status = status;
  }
}

function resolvePushPlusToken(dependencies = {}) {
  const target = resolvePushPlusTargets(dependencies)[0];
  return target ? { token: target.token, source: target.source } : { token: '', source: 'none' };
}

function parseStoredTargets(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item.token === 'string' && item.token.trim())
      .map((item, index) => ({
        id: String(item.id || `pushplus-${index + 1}`),
        name: String(item.name || `目标 ${index + 1}`).trim(),
        token: item.token.trim(),
        enabled: item.enabled !== false,
        source: 'database'
      }));
  } catch {
    return [];
  }
}

function readPushPlusTargets(repository = repo) {
  return parseStoredTargets(repository.getSecretSetting(PUSHPLUS_TARGETS_KEY));
}

function savePushPlusTargets(targets, repository = repo) {
  const normalized = (Array.isArray(targets) ? targets : [])
    .filter((target) => target && String(target.token || '').trim())
    .map((target, index) => ({
      id: String(target.id || crypto.randomUUID()),
      name: String(target.name || `目标 ${index + 1}`).trim().slice(0, 100),
      token: String(target.token).trim(),
      enabled: target.enabled !== false
    }));
  repository.setSecretSetting(PUSHPLUS_TARGETS_KEY, JSON.stringify(normalized));
  return normalized;
}

function resolvePushPlusTargets(dependencies = {}) {
  if (dependencies.tokens !== undefined) {
    return (Array.isArray(dependencies.tokens) ? dependencies.tokens : [])
      .filter(Boolean)
      .map((token, index) => (typeof token === 'string'
        ? { id: `override-${index + 1}`, name: `目标 ${index + 1}`, token, enabled: true, source: 'override' }
        : { id: String(token.id || `override-${index + 1}`), name: String(token.name || `目标 ${index + 1}`), token: String(token.token || ''), enabled: token.enabled !== false, source: 'override' }))
      .filter((target) => target.token.trim() && target.enabled);
  }
  if (dependencies.token !== undefined) {
    return dependencies.token ? [{ id: 'override-1', name: '目标 1', token: String(dependencies.token).trim(), enabled: true, source: 'override' }] : [];
  }
  const repository = dependencies.repo || repo;
  const storedTargets = readPushPlusTargets(repository);
  if (storedTargets.length) return storedTargets.filter((target) => target.enabled);
  const legacyToken = repository.getSecretSetting('pushplus_token');
  if (legacyToken) return [{ id: 'legacy', name: '默认目标', token: legacyToken, enabled: true, source: 'database', legacy: true }];
  if (config.pushPlusToken) return [{ id: 'environment', name: '环境变量', token: config.pushPlusToken, enabled: true, source: 'environment' }];
  return [];
}

function pushPlusStatus(dependencies = {}) {
  const repository = dependencies.repo || repo;
  const targets = resolvePushPlusTargets(dependencies);
  const storedTargets = parseStoredTargets(repository.getSecretSetting(PUSHPLUS_TARGETS_KEY));
  const displayTargets = storedTargets.length
    ? storedTargets
    : targets;
  const first = displayTargets[0];
  return {
    configured: targets.length > 0,
    source: first?.source || 'none',
    token_masked: first?.source === 'database'
      ? (first.legacy ? repository.getMaskedSecretSetting('pushplus_token') : first.token.replace(/^(...).*(...)$/, '$1...$2'))
      : (first?.token ? '环境变量已设置' : ''),
    target_count: displayTargets.length,
    targets: displayTargets.map((target) => ({
      id: target.id,
      name: target.name,
      enabled: target.enabled !== false,
      token_masked: target.source === 'environment' ? '环境变量已设置' : target.token.replace(/^(...).*(...)$/, '$1...$2'),
      legacy: Boolean(target.legacy)
    })),
    base_url: config.pushPlusBaseUrl
  };
}

async function sendPushPlus({ title, content }, dependencies = {}) {
  const targets = resolvePushPlusTargets(dependencies);
  const baseUrl = dependencies.baseUrl ?? config.pushPlusBaseUrl;
  const fetchImpl = dependencies.fetchImpl || fetch;
  if (!targets.length) throw new PushPlusError('PushPlus Token 未配置', 422);
  const results = [];
  for (const target of targets) {
    try {
      const response = await fetchImpl(baseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ token: target.token, title, content, template: 'txt' }),
        signal: AbortSignal.timeout(Number(dependencies.timeoutMs || config.pushPlusTimeoutMs || 10000))
      });
      const text = await response.text();
      let data = null;
      try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
      const code = Number(data?.code);
      if (!response.ok || (Number.isFinite(code) && ![0, 200].includes(code))) {
        throw new PushPlusError(`PushPlus 推送失败：${data?.msg || data?.message || response.status}`, response.status || 502);
      }
      results.push({ id: target.id, name: target.name, ok: true, code: Number.isFinite(code) ? code : null, message: data?.msg || data?.message || '已发送' });
    } catch (error) {
      results.push({ id: target.id, name: target.name, ok: false, error: error.message });
    }
  }
  const sent = results.filter((item) => item.ok).length;
  const failed = results.length - sent;
  if (!sent) throw new PushPlusError(results[0]?.error || 'PushPlus 推送失败', 502);
  return { ok: true, sent, failed, results };
}

module.exports = {
  PushPlusError,
  PUSHPLUS_TARGETS_KEY,
  resolvePushPlusToken,
  resolvePushPlusTargets,
  readPushPlusTargets,
  savePushPlusTargets,
  pushPlusStatus,
  sendPushPlus
};
