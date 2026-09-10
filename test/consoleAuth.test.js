require('./testEnv');

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  hashPassword,
  verifyHashedPassword,
  getConsoleAuth,
  verifyConsolePassword,
  changeConsolePassword,
  toClientErrorStatus,
  ADMIN_PASSWORD_HASH_KEY
} = require('../src/consoleAuth');

function memoryRepo(initial = {}) {
  const store = { ...initial };
  return {
    store,
    getSecretSetting: (key) => store[key] || '',
    setSecretSetting: (key, value) => { store[key] = value; return { key, masked_value: '***' }; }
  };
}

test('hashed console passwords verify and reject mismatches', () => {
  const stored = hashPassword('correct-horse');
  assert.equal(verifyHashedPassword('correct-horse', stored), true);
  assert.equal(verifyHashedPassword('wrong-horse', stored), false);
  assert.equal(verifyHashedPassword('correct-horse', 'not-a-hash'), false);
});

test('console auth prefers a stored hash over ADMIN_PASSWORD', () => {
  const repository = memoryRepo({ [ADMIN_PASSWORD_HASH_KEY]: hashPassword('database-secret') });
  const environment = { adminPassword: 'env-secret' };
  assert.equal(getConsoleAuth(repository, environment).source, 'database');
  assert.equal(verifyConsolePassword('database-secret', repository, environment), true);
  assert.equal(verifyConsolePassword('env-secret', repository, environment), false);
});

test('changing the console password requires the current one and stores a hash', () => {
  const repository = memoryRepo();
  const environment = { adminPassword: 'old-password' };
  assert.throws(
    () => changeConsolePassword({ currentPassword: 'nope', newPassword: 'new-password' }, repository, environment),
    (error) => error.status === 403
  );
  const result = changeConsolePassword({
    currentPassword: 'old-password',
    newPassword: 'new-password'
  }, repository, environment);
  assert.equal(result.ok, true);
  assert.equal(verifyConsolePassword('new-password', repository, environment), true);
  assert.equal(verifyConsolePassword('old-password', repository, environment), false);
  assert.match(repository.store[ADMIN_PASSWORD_HASH_KEY], /^scrypt:/);
});

test('upstream 401 must not be forwarded as a console logout status', () => {
  assert.equal(toClientErrorStatus({ status: 401, message: 'invalid refresh token' }), 422);
  assert.equal(toClientErrorStatus({ status: 409 }), 409);
  assert.equal(toClientErrorStatus({ status: 500 }), 500);
  assert.equal(toClientErrorStatus({}), 400);
});
