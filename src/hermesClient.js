const crypto = require('node:crypto');
const { isAllowedHermesUrl } = require('./requestErrorSettings');

class HermesError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'HermesError';
    this.status = status;
  }
}

function signBody(secret, timestamp, body) {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

function receiptUrl(webhookUrl) {
  const url = new URL(webhookUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/receipt`;
  return url.toString();
}

function healthUrl(webhookUrl) {
  const url = new URL(webhookUrl);
  const prefix = url.pathname.replace(/\/(?:p\/[^/]+\/)?webhooks\/[^/]+\/?$/, '');
  url.pathname = `${prefix}/health`;
  url.search = '';
  return url.toString();
}

function assertHermesConfig(settings) {
  if (!settings.hermes_secret) throw new HermesError('Hermes HMAC 密钥未配置', 422);
  if (!isAllowedHermesUrl(settings.hermes_webhook_url)) {
    throw new HermesError('Hermes Webhook 地址无效：只允许服务器回环 http 地址或 https 地址', 422);
  }
}

async function signedPost(url, payload, settings, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || fetch;
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor((dependencies.now || Date.now()) / 1000));
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-webhook-timestamp': timestamp,
        'x-webhook-signature-v2': signBody(settings.hermes_secret, timestamp, body),
        'x-event-type': payload.event_type || 'sub2api.request_error'
      },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(settings.request_timeout_ms || 15000)
    });
  } catch (error) {
    const reason = error.name === 'TimeoutError' ? '请求超时' : (error.cause?.code || error.message);
    throw new HermesError(`Hermes 通道不可达（${reason}），请检查服务器到本机的反向通道`, 503);
  }
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 200) }; }
  return { status: response.status, ok: response.ok, data };
}

async function submitHermesEvent(payload, settings, dependencies = {}) {
  assertHermesConfig(settings);
  const result = await signedPost(settings.hermes_webhook_url, payload, settings, dependencies);
  if (result.status === 202 || (result.ok && ['accepted', 'duplicate'].includes(result.data?.status))) {
    return { status: result.data?.status || 'accepted', delivery_id: result.data?.delivery_id || payload.delivery_id };
  }
  const detail = String(result.data?.error || result.data?.message || result.data?.raw || '').slice(0, 200);
  throw new HermesError(`Hermes 拒绝事件（HTTP ${result.status}）${detail ? `：${detail}` : ''}`, result.status);
}

async function fetchHermesReceipt(deliveryId, settings, dependencies = {}) {
  assertHermesConfig(settings);
  const result = await signedPost(receiptUrl(settings.hermes_webhook_url), { delivery_id: deliveryId }, settings, dependencies);
  if (result.status === 404) return null;
  if (!result.ok) {
    const detail = String(result.data?.error || '').slice(0, 200);
    throw new HermesError(`Hermes 回执查询失败（HTTP ${result.status}）${detail ? `：${detail}` : ''}`, result.status);
  }
  return {
    processing: String(result.data?.processing || ''),
    delivery: String(result.data?.delivery || ''),
    result: String(result.data?.result || ''),
    updated_at: Number(result.data?.updated_at) || null
  };
}

async function checkHermesHealth(settings, dependencies = {}) {
  if (!isAllowedHermesUrl(settings.hermes_webhook_url)) {
    throw new HermesError('Hermes Webhook 地址无效', 422);
  }
  const fetchImpl = dependencies.fetchImpl || fetch;
  const url = healthUrl(settings.hermes_webhook_url);
  try {
    const response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(settings.request_timeout_ms || 15000) });
    return { ok: response.ok, status: response.status, url };
  } catch (error) {
    const reason = error.name === 'TimeoutError' ? '请求超时' : (error.cause?.code || error.message);
    throw new HermesError(`Hermes 通道不可达（${reason}）`, 503);
  }
}

module.exports = {
  HermesError,
  signBody,
  receiptUrl,
  healthUrl,
  submitHermesEvent,
  fetchHermesReceipt,
  checkHermesHealth
};
