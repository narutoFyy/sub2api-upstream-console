const crypto = require('node:crypto');
const config = require('./config');

const ADMIN_PASSWORD_HASH_KEY = 'admin_password_hash';
const MIN_PASSWORD_LENGTH = 8;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1 };

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 32, SCRYPT_OPTIONS);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyHashedPassword(password, stored) {
  const parts = String(stored || '').split(':');
  if (parts[0] !== 'scrypt' || parts.length !== 3) return false;
  try {
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    if (!salt.length || !expected.length) return false;
    const actual = crypto.scryptSync(String(password), salt, expected.length, SCRYPT_OPTIONS);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function getConsoleAuth(repository, environment = config) {
  const hash = repository?.getSecretSetting?.(ADMIN_PASSWORD_HASH_KEY) || '';
  if (hash) return { enabled: true, source: 'database', hash };
  if (environment.adminPassword) {
    return { enabled: true, source: 'env', hash: '', plaintext: environment.adminPassword };
  }
  return { enabled: false, source: 'none', hash: '' };
}

function verifyConsolePassword(password, repository, environment = config) {
  const auth = getConsoleAuth(repository, environment);
  if (!auth.enabled) return true;
  if (auth.hash) return verifyHashedPassword(password, auth.hash);
  return safeEqual(password, auth.plaintext);
}

function changeConsolePassword({ currentPassword, newPassword }, repository, environment = config) {
  const auth = getConsoleAuth(repository, environment);
  if (!auth.enabled) {
    const error = new Error('控制台未启用登录密码');
    error.status = 400;
    throw error;
  }
  if (!verifyConsolePassword(currentPassword, repository, environment)) {
    const error = new Error('当前密码不正确');
    error.status = 403;
    throw error;
  }
  const next = String(newPassword || '');
  if (next.length < MIN_PASSWORD_LENGTH) {
    const error = new Error(`新密码至少 ${MIN_PASSWORD_LENGTH} 位`);
    error.status = 400;
    throw error;
  }
  if (next === String(currentPassword || '')) {
    const error = new Error('新密码不能与当前密码相同');
    error.status = 400;
    throw error;
  }
  repository.setSecretSetting(ADMIN_PASSWORD_HASH_KEY, hashPassword(next));
  return { ok: true, source: 'database' };
}

function toClientErrorStatus(err) {
  const raw = Number(err?.status || err?.statusCode || 400);
  if (raw === 401) return 422;
  if (Number.isFinite(raw) && raw >= 100 && raw < 600) return raw;
  return 500;
}

module.exports = {
  ADMIN_PASSWORD_HASH_KEY,
  MIN_PASSWORD_LENGTH,
  hashPassword,
  verifyHashedPassword,
  getConsoleAuth,
  verifyConsolePassword,
  changeConsolePassword,
  toClientErrorStatus
};
