require('dotenv').config();
require('../src/db');
const repo = require('../src/repository');
const { seedFromEnv } = require('../src/seed');
const { syncSite } = require('../src/syncService');

async function main() {
  if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify({ ok: true, message: 'dry-run loaded modules' }));
    return;
  }
  seedFromEnv();
  const site = repo.listSites()[0];
  if (!site) {
    throw new Error('No upstream site configured. Create one first or set SEED_UPSTREAM_EMAIL/SEED_UPSTREAM_PASSWORD.');
  }
  const result = await syncSite(site.id);
  console.log(JSON.stringify({
    ok: true,
    site: site.name,
    balance: result.snapshot.balance,
    today_tokens: result.snapshot.today_tokens,
    rates: result.rates.length,
    openai_rate: result.snapshot.openai_rate,
    anthropic_rate: result.snapshot.anthropic_rate
  }, null, 2));
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
