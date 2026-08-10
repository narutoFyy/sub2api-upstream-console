const defaultRepository = require('./repository');

function buildUpstreamDetail(siteId, { repository = defaultRepository, full = false } = {}) {
  const site = repository.getSite(siteId);
  if (!site) return null;

  const storedSnapshot = repository.getSnapshot(siteId);
  const snapshot = storedSnapshot ? { ...storedSnapshot } : null;
  if (snapshot && full) {
    snapshot.pricing_summary = repository.getDetailPricingSummary(siteId);
  }

  const detail = {
    site,
    credentials: repository.getMaskedCredentials(siteId),
    snapshot,
    rates: repository.listRates(siteId, full ? 300 : 20),
    logs: repository.listSyncLogs(siteId, full ? 100 : 12),
    capabilities: repository.capabilityMatrix(siteId)
  };

  if (full) {
    detail.model_pricing = repository.listModelPricing(siteId, 300);
    detail.recharge_orders = repository.listRechargeOrders(siteId, 20);
    detail.history = repository.listSnapshotHistory(siteId, 120);
  }

  return detail;
}

module.exports = { buildUpstreamDetail };
