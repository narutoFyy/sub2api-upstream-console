function nowIso() {
  return new Date().toISOString();
}

function normalizeBaseUrl(value) {
  const url = assertSafeUpstreamUrl(value);
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

function isPrivateHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (['localhost', 'metadata.google.internal'].includes(host)) return true;
  if (host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '169.254.169.254') return true;

  if (host === '::1' || host === '[::1]') return true;
  const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!ipv4) return false;
  const parts = ipv4.slice(1).map(Number);
  if (parts.some((part) => part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function assertSafeUpstreamUrl(value) {
  const url = new URL(String(value).trim());
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Base URL must use http or https');
  }
  if (isPrivateHostname(url.hostname)) {
    throw new Error('Base URL cannot point to localhost, private network, or metadata addresses');
  }
  return url;
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
  isPrivateHostname,
  assertSafeUpstreamUrl,
  safeJson
};

