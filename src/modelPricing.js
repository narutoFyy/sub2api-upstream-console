const OPENAI_HINTS = ['openai', 'gpt-', 'o1', 'o3', 'o4', 'chatgpt'];
const CLAUDE_HINTS = ['claude', 'anthropic'];

// 模型价格广场仅展示需要重点监控的模型，避免 GPT-4/o 系列等干扰对比。
const BOARD_WATCH_PATTERNS = {
  openai: ['gpt-5.4', 'gpt-5.5'],
  claude: [
    'claude-opus-4-6',
    'claude-opus-4-7',
    'claude-opus-4-8',
    'claude-sonnet-4-6',
    'claude-fable-5'
  ]
};

const BOARD_MODEL_ORDER = {
  openai: ['gpt-5.5', 'gpt-5.4'],
  claude: [
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-fable-5'
  ]
};

// 无 new-api /pricing 快照时，用内置官方基准价叠加上游分组倍率。
const BUILTIN_OFFICIAL_MODELS = [
  { model_name: 'gpt-5.5', vendor: 'OpenAI', quota_type: 0, official_input_usd_per_1m: 5, official_output_usd_per_1m: 15, source: 'builtin' },
  { model_name: 'gpt-5.4', vendor: 'OpenAI', quota_type: 0, official_input_usd_per_1m: 4, official_output_usd_per_1m: 12, source: 'builtin' },
  { model_name: 'claude-opus-4-8', vendor: 'Anthropic', quota_type: 0, official_input_usd_per_1m: 15, official_output_usd_per_1m: 75, source: 'builtin' },
  { model_name: 'claude-opus-4-7', vendor: 'Anthropic', quota_type: 0, official_input_usd_per_1m: 15, official_output_usd_per_1m: 75, source: 'builtin' },
  { model_name: 'claude-opus-4-6', vendor: 'Anthropic', quota_type: 0, official_input_usd_per_1m: 15, official_output_usd_per_1m: 75, source: 'builtin' },
  { model_name: 'claude-sonnet-4-6', vendor: 'Anthropic', quota_type: 0, official_input_usd_per_1m: 3, official_output_usd_per_1m: 15, source: 'builtin' },
  { model_name: 'claude-fable-5', vendor: 'Anthropic', quota_type: 0, official_input_usd_per_1m: 2, official_output_usd_per_1m: 10, source: 'builtin' }
];

function isSub2APIPricingUpstreamType(upstreamType) {
  const type = String(upstreamType || 'auto').toLowerCase();
  return type === 'sub2api' || type === 'auto';
}

function isSub2APIPricingSite(site) {
  if (!site) return false;
  return isSub2APIPricingUpstreamType(site.upstream_type);
}

function getBuiltinOfficialModels() {
  return BUILTIN_OFFICIAL_MODELS.map((item) => ({ ...item }));
}

function resolveOfficialPricingRows(rows = []) {
  const byModel = new Map();
  for (const row of getBuiltinOfficialModels()) {
    byModel.set(row.model_name, row);
  }
  for (const row of rows) {
    if (row?.model_name) byModel.set(row.model_name, row);
  }
  return [...byModel.values()];
}

function finiteNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function pickEffectiveGroup(enableGroups = [], groupRatio = {}) {
  const groups = Array.isArray(enableGroups) ? enableGroups : [];
  let best = { group: groups[0] || 'default', ratio: 1 };
  let found = false;

  for (const group of groups) {
    const ratio = finiteNumber(groupRatio[group]);
    if (ratio === null) continue;
    if (!found || ratio < best.ratio) {
      best = { group, ratio };
      found = true;
    }
  }

  return best;
}

function calculateTokenPrices(model, groupRatio = 1) {
  const modelRatio = finiteNumber(model.model_ratio);
  const completionRatio = finiteNumber(model.completion_ratio, 1);
  if (modelRatio === null) {
    return {
      input_usd_per_1m: null,
      output_usd_per_1m: null,
      cache_read_usd_per_1m: null,
      cache_write_usd_per_1m: null
    };
  }

  const base = modelRatio * 2 * groupRatio;
  const cacheRatio = finiteNumber(model.cache_ratio);
  const createCacheRatio = finiteNumber(model.create_cache_ratio);
  return {
    input_usd_per_1m: base,
    output_usd_per_1m: base * completionRatio,
    cache_read_usd_per_1m: cacheRatio === null ? null : base * cacheRatio,
    cache_write_usd_per_1m: createCacheRatio === null ? null : base * createCacheRatio
  };
}

function calculatePricingFields(model, groupRatioMap = {}) {
  const enableGroups = Array.isArray(model.enable_groups) ? model.enable_groups : parseJsonArray(model.enable_groups);
  const effective = pickEffectiveGroup(enableGroups, groupRatioMap);
  const isRequest = Number(model.quota_type || 0) === 1;
  const modelPrice = finiteNumber(model.model_price);

  if (isRequest) {
    return {
      effective_group: effective.group,
      effective_group_ratio: effective.ratio,
      official_input_usd_per_1m: null,
      official_output_usd_per_1m: null,
      official_cache_read_usd_per_1m: null,
      official_cache_write_usd_per_1m: null,
      official_request_usd: modelPrice,
      upstream_input_usd_per_1m: null,
      upstream_output_usd_per_1m: null,
      upstream_cache_read_usd_per_1m: null,
      upstream_cache_write_usd_per_1m: null,
      upstream_request_usd: modelPrice === null ? null : modelPrice * effective.ratio
    };
  }

  const official = calculateTokenPrices(model, 1);
  const upstream = calculateTokenPrices(model, effective.ratio);
  return {
    effective_group: effective.group,
    effective_group_ratio: effective.ratio,
    official_input_usd_per_1m: official.input_usd_per_1m,
    official_output_usd_per_1m: official.output_usd_per_1m,
    official_cache_read_usd_per_1m: official.cache_read_usd_per_1m,
    official_cache_write_usd_per_1m: official.cache_write_usd_per_1m,
    official_request_usd: null,
    upstream_input_usd_per_1m: upstream.input_usd_per_1m,
    upstream_output_usd_per_1m: upstream.output_usd_per_1m,
    upstream_cache_read_usd_per_1m: upstream.cache_read_usd_per_1m,
    upstream_cache_write_usd_per_1m: upstream.cache_write_usd_per_1m,
    upstream_request_usd: null
  };
}

function normalizeModelNameForMatch(name) {
  return String(name || '').toLowerCase().replace(/^[^/]+\//, '');
}

function isWatchedBoardModel(family, modelName) {
  const patterns = BOARD_WATCH_PATTERNS[family];
  if (!patterns?.length) return true;
  const normalized = normalizeModelNameForMatch(modelName);
  return patterns.some((pattern) => normalized.includes(pattern));
}

function boardModelSortKey(family, modelName) {
  const normalized = normalizeModelNameForMatch(modelName);
  const order = BOARD_MODEL_ORDER[family] || [];
  for (let i = 0; i < order.length; i += 1) {
    if (normalized.includes(order[i])) return i;
  }
  return order.length;
}

function modelFamily(model) {
  const text = `${model.model_name || ''} ${model.vendor || ''} ${model.tags || ''}`.toLowerCase();
  if (CLAUDE_HINTS.some((hint) => text.includes(hint))) return 'claude';
  if (OPENAI_HINTS.some((hint) => text.includes(hint))) return 'openai';
  return 'other';
}

function rateFamily(rate) {
  const text = `${rate.scope || ''} ${rate.group_name || ''} ${rate.model || ''}`.toLowerCase();
  if (CLAUDE_HINTS.some((hint) => text.includes(hint))) return 'claude';
  if (OPENAI_HINTS.some((hint) => text.includes(hint))) return 'openai';
  return 'other';
}

function scaleOfficialPriceRow(official, rateRow) {
  const ratio = finiteNumber(rateRow.rate);
  if (ratio === null) return null;
  return {
    upstream_site_id: rateRow.upstream_site_id,
    upstream_name: rateRow.upstream_name,
    base_url: rateRow.base_url || '',
    model_name: official.model_name,
    vendor: official.vendor || '',
    tags: official.tags || '',
    quota_type: Number(official.quota_type || 0),
    effective_group: rateRow.group_name || rateRow.group_id || 'default',
    effective_group_ratio: ratio,
    official_input_usd_per_1m: finiteNumber(official.official_input_usd_per_1m),
    official_output_usd_per_1m: finiteNumber(official.official_output_usd_per_1m),
    official_cache_read_usd_per_1m: finiteNumber(official.official_cache_read_usd_per_1m),
    official_cache_write_usd_per_1m: finiteNumber(official.official_cache_write_usd_per_1m),
    official_request_usd: finiteNumber(official.official_request_usd),
    upstream_input_usd_per_1m: finiteNumber(official.official_input_usd_per_1m) === null ? null : finiteNumber(official.official_input_usd_per_1m) * ratio,
    upstream_output_usd_per_1m: finiteNumber(official.official_output_usd_per_1m) === null ? null : finiteNumber(official.official_output_usd_per_1m) * ratio,
    upstream_cache_read_usd_per_1m: finiteNumber(official.official_cache_read_usd_per_1m) === null ? null : finiteNumber(official.official_cache_read_usd_per_1m) * ratio,
    upstream_cache_write_usd_per_1m: finiteNumber(official.official_cache_write_usd_per_1m) === null ? null : finiteNumber(official.official_cache_write_usd_per_1m) * ratio,
    upstream_request_usd: finiteNumber(official.official_request_usd) === null ? null : finiteNumber(official.official_request_usd) * ratio,
    source: 'sub2api-rate'
  };
}

function mergeSub2APIRows(rows = [], rateRows = []) {
  const officialRows = resolveOfficialPricingRows(rows);
  const officialByModel = new Map();
  for (const row of officialRows) {
    const family = modelFamily(row);
    if (family === 'other') continue;
    const modelName = row.model_name || '';
    if (!modelName || officialByModel.has(modelName)) continue;
    officialByModel.set(modelName, row);
  }

  const extraRows = [];
  for (const rateRow of rateRows) {
    if (!isSub2APIPricingUpstreamType(rateRow.upstream_type)) continue;
    const family = rateFamily(rateRow);
    if (family === 'other') continue;
    for (const official of officialByModel.values()) {
      if (modelFamily(official) !== family) continue;
      extraRows.push(scaleOfficialPriceRow(official, rateRow));
    }
  }

  return rows.concat(extraRows.filter(Boolean));
}

function buildSub2APISiteModelPricing(rows = [], rateRows = []) {
  const mergedRows = mergeSub2APIRows(rows, rateRows);
  const siteIds = new Set(rateRows.map((row) => row.upstream_site_id));
  const result = new Map();

  for (const siteId of siteIds) {
    const items = mergedRows
      .filter((row) => row.upstream_site_id === siteId)
      .sort((a, b) => String(a.model_name || '').localeCompare(String(b.model_name || '')));
    result.set(siteId, items);
  }

  return result;
}

function groupModelPricingBoard(rows = [], rateRows = []) {
  const mergedRows = mergeSub2APIRows(rows, rateRows);
  const groups = { openai: new Map(), claude: new Map() };
  for (const row of mergedRows) {
    const family = modelFamily(row);
    if (!groups[family]) continue;
    const modelName = row.model_name || '';
    if (!modelName || !isWatchedBoardModel(family, modelName)) continue;
    if (!groups[family].has(modelName)) {
      groups[family].set(modelName, {
        model_name: modelName,
        vendor: row.vendor || '',
        tags: row.tags || '',
        quota_type: Number(row.quota_type || 0),
        official_input_usd_per_1m: finiteNumber(row.official_input_usd_per_1m),
        official_output_usd_per_1m: finiteNumber(row.official_output_usd_per_1m),
        official_cache_read_usd_per_1m: finiteNumber(row.official_cache_read_usd_per_1m),
        official_cache_write_usd_per_1m: finiteNumber(row.official_cache_write_usd_per_1m),
        official_request_usd: finiteNumber(row.official_request_usd),
        upstreams: []
      });
    }
    groups[family].get(modelName).upstreams.push(row);
  }

  const sortUpstreams = (items) => items.sort((a, b) => {
    const av = finiteNumber(a.upstream_input_usd_per_1m, finiteNumber(a.upstream_request_usd, Infinity));
    const bv = finiteNumber(b.upstream_input_usd_per_1m, finiteNumber(b.upstream_request_usd, Infinity));
    return av - bv;
  });

  const toArray = (map, family) => [...map.values()]
    .map((item) => ({ ...item, upstreams: sortUpstreams(item.upstreams) }))
    .sort((a, b) => {
      const orderDiff = boardModelSortKey(family, a.model_name) - boardModelSortKey(family, b.model_name);
      if (orderDiff !== 0) return orderDiff;
      return a.model_name.localeCompare(b.model_name);
    });

  return {
    openai: toArray(groups.openai, 'openai'),
    claude: toArray(groups.claude, 'claude')
  };
}

module.exports = {
  BOARD_WATCH_PATTERNS,
  buildSub2APISiteModelPricing,
  calculatePricingFields,
  getBuiltinOfficialModels,
  groupModelPricingBoard,
  isSub2APIPricingSite,
  isSub2APIPricingUpstreamType,
  isWatchedBoardModel,
  modelFamily,
  parseJsonArray,
  parseJsonObject,
  resolveOfficialPricingRows
};
