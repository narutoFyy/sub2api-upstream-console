const config = require('./config');
const repo = require('./repository');

class PushPlusError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'PushPlusError';
    this.status = status;
  }
}

function resolvePushPlusToken(dependencies = {}) {
  if (dependencies.token !== undefined) {
    return { token: dependencies.token, source: dependencies.token ? 'override' : 'none' };
  }
  const repository = dependencies.repo || repo;
  const databaseToken = repository.getSecretSetting('pushplus_token');
  if (databaseToken) return { token: databaseToken, source: 'database' };
  if (config.pushPlusToken) return { token: config.pushPlusToken, source: 'environment' };
  return { token: '', source: 'none' };
}

function pushPlusStatus(dependencies = {}) {
  const resolved = resolvePushPlusToken(dependencies);
  const repository = dependencies.repo || repo;
  return {
    configured: Boolean(resolved.token),
    source: resolved.source,
    token_masked: resolved.source === 'database'
      ? repository.getMaskedSecretSetting('pushplus_token')
      : (resolved.token ? '环境变量已设置' : ''),
    base_url: config.pushPlusBaseUrl
  };
}

async function sendPushPlus({ title, content }, dependencies = {}) {
  const { token } = resolvePushPlusToken(dependencies);
  const baseUrl = dependencies.baseUrl ?? config.pushPlusBaseUrl;
  const fetchImpl = dependencies.fetchImpl || fetch;
  if (!token) throw new PushPlusError('PushPlus Token 未配置', 422);

  const response = await fetchImpl(baseUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ token, title, content, template: 'txt' }),
    signal: AbortSignal.timeout(Number(dependencies.timeoutMs || config.pushPlusTimeoutMs || 10000))
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }
  const code = Number(data?.code);
  if (!response.ok || (Number.isFinite(code) && ![0, 200].includes(code))) {
    throw new PushPlusError(`PushPlus 推送失败：${data?.msg || data?.message || response.status}`, response.status || 502);
  }
  return { ok: true, code: Number.isFinite(code) ? code : null, message: data?.msg || data?.message || '已发送' };
}

module.exports = {
  PushPlusError,
  resolvePushPlusToken,
  pushPlusStatus,
  sendPushPlus
};
