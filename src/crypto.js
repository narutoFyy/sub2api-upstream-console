const crypto = require('node:crypto');
const config = require('./config');

const algorithm = 'aes-256-gcm';
const key = crypto.createHash('sha256').update(config.appSecret).digest();

function encryptSecret(value) {
  if (!value) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(algorithm, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

function decryptSecret(payload) {
  if (!payload) return '';
  const raw = Buffer.from(payload, 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ciphertext = raw.subarray(28);
  const decipher = crypto.createDecipheriv(algorithm, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function maskSecret(value) {
  if (!value) return '';
  if (value.length <= 6) return '******';
  return `${value.slice(0, 3)}...${value.slice(-3)}`;
}

module.exports = {
  encryptSecret,
  decryptSecret,
  maskSecret
};

