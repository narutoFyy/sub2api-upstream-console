function nowIso() {
  return new Date().toISOString();
}

function normalizeBaseUrl(value) {
  const url = new URL(String(value).trim());
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Base URL must use http or https');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pickFirstNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function safeJson(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

module.exports = {
  nowIso,
  normalizeBaseUrl,
  toNumber,
  pickFirstNumber,
  safeJson
};

