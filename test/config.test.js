const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');

function readSessionMaxAge(envValue) {
  const output = execFileSync(process.execPath, ['-e', 'process.stdout.write(String(require("./src/config").sessionMaxAgeSeconds))'], {
    cwd: rootDir,
    env: { ...process.env, SESSION_MAX_AGE_SECONDS: envValue }
  });
  return Number(output.toString().trim().split(/\s+/).pop());
}

test('session cookie max age defaults to 30 days', () => {
  assert.equal(readSessionMaxAge(''), 30 * 24 * 60 * 60);
});

test('session cookie max age accepts a positive integer override', () => {
  assert.equal(readSessionMaxAge('86400.9'), 86400);
});

test('session cookie max age rejects invalid or non-positive overrides', () => {
  assert.equal(readSessionMaxAge('0'), 30 * 24 * 60 * 60);
  assert.equal(readSessionMaxAge('-1'), 30 * 24 * 60 * 60);
  assert.equal(readSessionMaxAge('not-a-number'), 30 * 24 * 60 * 60);
});
