const config = require('./config');
const repo = require('./repository');

function seedFromEnv() {
  if (!config.seed.email || !config.seed.password) return null;
  const normalized = config.seed.baseUrl.replace(/\/$/, '');
  const existing = repo.listSites().find((site) => site.base_url === normalized);
  if (existing) return existing;
  return repo.createSite({
    name: config.seed.name,
    base_url: config.seed.baseUrl,
    auth_mode: 'password',
    email: config.seed.email,
    password: config.seed.password,
    tags: ['seed', 'sub2api'],
    notes: 'Seeded from environment for local testing.',
    sync_interval_seconds: 180
  });
}

module.exports = { seedFromEnv };

