require('./testEnv');

const test = require('node:test');
const assert = require('node:assert/strict');
const { isCompleteApiKey, normalizeSub2APIKey } = require('../src/upstreamKeys');

test('masked upstream values are never treated as complete Keys', () => {
  assert.equal(isCompleteApiKey('sk-1234...abcd'), false);
  assert.equal(isCompleteApiKey('sk-1234****abcd'), false);
  assert.equal(isCompleteApiKey('sk-complete-secret-value-123456'), true);

  const masked = normalizeSub2APIKey({ id: 1, key: 'sk-1234...abcd' });
  assert.equal(masked.key_masked, 'sk-1234...abcd');
  assert.equal(masked.key_full, null);

  const complete = normalizeSub2APIKey({ id: 2, key: 'sk-complete-secret-value-123456' });
  assert.equal(complete.key_masked, 'sk-comp...3456');
  assert.equal(complete.key_full, 'sk-complete-secret-value-123456');
});
