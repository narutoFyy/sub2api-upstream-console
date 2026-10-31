const VIEW_META = {
  overview: { title: '总览', search: '搜索上游或 Key' },
  monitoring: { title: '上游监控', search: '搜索上游或 Key' },
  keys: { title: 'Key 管理', search: '搜索 Key、分组或上游' },
  'own-sites': { title: '自己站观测', search: '搜索自己站账号或路由' },
  pricing: { title: '模型价格', search: '搜索模型或上游' },
  usage: { title: '使用明细', search: '搜索模型、Key 或分组' },
  alerts: { title: '告警事件', search: '搜索告警或上游' },
  'request-errors': { title: '用户报错', search: '搜索错误消息、错误码或事件 ID' },
  logs: { title: '同步记录', search: '搜索日志或上游' },
  settings: { title: '设置', search: '搜索上游或 Key' }
};

const state = {
  activeView: localStorage.getItem('upstream-control-view') || 'monitoring',
  monitoring: { totals: {}, items: [], pushplus: { configured: false }, open_alerts: 0 },
  consumption: { period: '24h', items: [], total_consumption: 0, selectedSiteId: null, loading: false, error: '', showTable: false },
  alerts: [],
  logs: [],
  rateChanges: [],
  pricing: { openai: [], claude: [] },
  groupRates: [],
  ownSites: [],
  ownRoutes: [],
  expandedSites: new Set(),
  expandedKeySites: new Set(),
  expandedRateSites: new Set(),
  monitorStatus: 'all',
  monitorSort: 'balance-asc',
  search: '',
  keyFilters: { upstream: '', platform: '', health: '' },
  alertStatus: '',
  runtimeSettings: { settings: null, effective: null, locks: {}, source: 'defaults', warning: '' },
  systemUpdate: { enabled: false, operation: { phase: 'idle' }, commits: [] },
  settingsTab: 'notifications',
  createdKey: '',
  usage: { items: [], total: 0, page: 1, pageSize: 20, pages: 1, loading: false, error: '', upstreamId: '', startDate: '', endDate: '' },
  requestErrors: { items: [], total: 0, summary: {}, sites: [], settings: null, siteId: '', route: '', offset: 0, pageSize: 50, loaded: false }
};

const money = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const integers = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function syncErrorPresentation(value) {
  const clean = String(value ?? '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
  return {
    full: clean,
    summary: clean.length > 120 ? `${clean.slice(0, 119).trimEnd()}…` : clean
  };
}

function apiErrorMessage(value, status) {
  const raw = String(value ?? '');
  const presentation = syncErrorPresentation(raw);
  const hasHtml = /<\s*\/?[a-z][^>]*>/i.test(raw);
  const isGatewayError = /cloudflare|error code\s*5\d\d|bad gateway|gateway timeout/i.test(presentation.full);
  const prefix = `请求失败（HTTP ${status}）`;
  if (hasHtml && (isGatewayError || status >= 500)) return `${prefix}：网关暂时不可用，请稍后重试`;
  if (hasHtml) return `${prefix}：服务返回了异常页面，请稍后重试`;
  return presentation.summary || prefix;
}

function refreshIcons() {
  if (window.lucide?.createIcons) window.lucide.createIcons({ attrs: { 'aria-hidden': 'true' } });
}

function setBusy(active) {
  document.querySelector('#loadingOverlay').hidden = !active;
}

function toast(message, tone = '') {
  const region = document.querySelector('#toastRegion');
  const item = document.createElement('div');
  item.className = `toast ${tone}`.trim();
  item.innerHTML = `<i data-lucide="${tone === 'error' ? 'circle-alert' : tone === 'success' ? 'circle-check' : 'info'}"></i><span>${escapeHtml(message)}</span><button type="button" aria-label="关闭">×</button>`;
  item.querySelector('button').addEventListener('click', () => item.remove());
  region.appendChild(item);
  refreshIcons();
  window.setTimeout(() => item.remove(), 5200);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const text = await response.text();
  let data = null;
  let parseFailed = false;
  try { data = text ? JSON.parse(text) : {}; } catch { parseFailed = true; data = {}; }
  const errorMessage = !response.ok
    ? apiErrorMessage(parseFailed ? text : (data?.error || data?.message || text), response.status)
    : '';
  if (response.status === 401) {
    const consoleAuthError = path === '/api/login' || path === '/api/session' || data?.error === '请先登录控制台' || data?.error === '控制台密码错误';
    if (consoleAuthError) showLogin();
    throw new Error(errorMessage || '请先登录控制台');
  }
  if (!response.ok) throw new Error(errorMessage || `HTTP ${response.status}`);
  return data;
}

function timeText(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  const delta = Date.now() - date.getTime();
  if (delta >= 0 && delta < 60_000) return `${Math.max(1, Math.floor(delta / 1000))} 秒前`;
  if (delta >= 0 && delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta >= 0 && delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function ageText(ms) {
  if (ms == null) return '尚未同步';
  if (ms < 60_000) return `${Math.max(1, Math.floor(ms / 1000))} 秒前`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} 分钟前`;
  return `${Math.floor(ms / 3_600_000)} 小时前`;
}

function numberText(value, fallback = '-') {
  const number = finiteNumberOrNull(value);
  return number === null ? fallback : money.format(number);
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function tokenText(value) {
  const count = Number(value || 0);
  if (count >= 1_000_000_000) return `${money.format(count / 1_000_000_000)}B`;
  if (count >= 1_000_000) return `${money.format(count / 1_000_000)}M`;
  if (count >= 1_000) return `${money.format(count / 1_000)}K`;
  return integers.format(count);
}

function rateText(value) {
  return Number.isFinite(Number(value)) ? `${Number(value).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}x` : '-';
}

function closeDialog(id) {
  const dialog = document.querySelector(`#${id}`);
  if (dialog?.open) dialog.close();
}

function showLogin() {
  document.querySelector('#appShell').hidden = true;
  document.querySelector('#loginScreen').hidden = false;
  refreshIcons();
}

function showApp() {
  document.querySelector('#loginScreen').hidden = true;
  document.querySelector('#appShell').hidden = false;
  setActiveView(state.activeView);
}

function setActiveView(view) {
  if (!VIEW_META[view]) view = 'monitoring';
  state.activeView = view;
  localStorage.setItem('upstream-control-view', view);
  document.querySelectorAll('.view').forEach((section) => { section.hidden = section.dataset.view !== view; });
  document.querySelectorAll('.nav-link[data-view-target]').forEach((button) => button.classList.toggle('active', button.dataset.viewTarget === view));
  document.querySelector('#pageTitle').textContent = VIEW_META[view].title;
  document.querySelector('#globalSearchInput').placeholder = VIEW_META[view].search;
  document.querySelector('#sidebar').classList.remove('open');
  renderCurrentView();
  refreshIcons();
  if (view === 'usage' && state.monitoring.items.length && !state.usage.loading) {
    window.queueMicrotask(loadUsage);
  }
  if (view === 'request-errors') window.queueMicrotask(() => loadRequestErrors().catch((error) => toast(error.message, 'error')));
}

function metricMarkup(items) {
  return items.map((item) => `<div class="metric-item"><span class="metric-label">${escapeHtml(item.label)}</span><strong class="metric-value ${item.tone || ''}">${escapeHtml(item.value)}</strong></div>`).join('');
}

function monitoringMetrics() {
  const totals = state.monitoring.totals || {};
  return [
    { label: '上游', value: totals.upstreams || 0 },
    { label: '总余额', value: `$${money.format(Number(totals.balance || 0))}` },
    { label: 'Key', value: totals.keys || 0 },
    { label: '异常', value: totals.abnormal || 0, tone: Number(totals.abnormal || 0) ? 'danger' : '' }
  ];
}

function consumptionPeriodLabel(period = state.consumption.period) {
  return { '24h': '过去 24 小时', '7d': '过去 7 天', '30d': '过去 30 天' }[period] || '过去 24 小时';
}

function consumptionForSite(siteId) {
  return (state.consumption.items || []).find((item) => Number(item.id) === Number(siteId)) || null;
}

function consumptionAmountText(item) {
  if (!item) return '-';
  return `${item.estimated ? '约 ' : ''}$${numberText(item.consumption, '0')}`;
}

function consumptionSpeedText(item) {
  if (!item?.enough_data || item.average_per_hour == null) return '数据不足';
  if (state.consumption.period === '24h') return `$${numberText(item.average_per_hour, '0')} / 小时`;
  return `$${numberText(item.average_per_day, '0')} / 天`;
}

const RECENT_TREND_RATIO = 1.25;

function recentTrend(item) {
  const average = finiteNumberOrNull(item?.average_per_hour);
  const recent = finiteNumberOrNull(item?.recent_per_hour);
  if (!item?.enough_data || !average || recent === null) return null;
  const ratio = recent / average;
  if (ratio >= RECENT_TREND_RATIO) return { direction: 'up', ratio, recent };
  if (ratio <= 1 / RECENT_TREND_RATIO) return { direction: 'down', ratio, recent };
  return null;
}

function recentSpeedText(item) {
  const trend = recentTrend(item);
  if (!trend) return '与窗口均速持平';
  return `近期 $${numberText(trend.recent, '0')} / 小时 ${trend.direction === 'up' ? '↑' : '↓'} ${numberText(trend.ratio, '0')}×`;
}

function consumptionCoverageText(item) {
  const hours = Number(item?.coverage_ms || 0) / 3_600_000;
  if (!hours) return '尚无历史';
  if (hours < 24) return `覆盖 ${numberText(hours, '0')} 小时`;
  return `覆盖 ${numberText(hours / 24, '0')} 天`;
}

function runwayText(item) {
  const hours = finiteNumberOrNull(item?.runway_hours);
  if (!item?.enough_data) return '数据不足';
  if (hours === null) return Number(item?.consumption || 0) === 0 ? '暂无消耗' : '-';
  if (hours < 24) return `约 ${numberText(hours, '0')} 小时`;
  return `约 ${numberText(hours / 24, '0')} 天`;
}

function chartTimeLabel(value, period) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return period === '24h'
    ? date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
    : date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function axisMoneyText(value, step) {
  const number = finiteNumberOrNull(value);
  if (number === null) return '';
  const stepSize = finiteNumberOrNull(step);
  let digits;
  if (stepSize !== null && stepSize > 0) {
    digits = Math.min(4, Math.max(0, -Math.floor(Math.log10(stepSize) + 1e-9)));
    if (!Number.isInteger(stepSize) && digits === 0) digits = 1;
  } else {
    const absolute = Math.abs(number);
    digits = absolute >= 1000 ? 0 : absolute >= 10 ? 0 : absolute >= 1 ? 1 : 2;
  }
  const rounded = Number(number.toFixed(digits));
  return `$${rounded.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function ticksForStep(min, max, step) {
  const ticks = [];
  const start = Math.ceil(min / step) * step;
  for (let value = start; value <= max + step * 1e-9; value += step) ticks.push(Number(value.toPrecision(12)));
  return ticks;
}

function niceAxisTicks(min, max, count = 4) {
  const span = max - min;
  if (!(span > 0)) return [max];
  const magnitude = 10 ** Math.floor(Math.log10(span));
  const steps = [];
  for (const scale of [magnitude / 100, magnitude / 10, magnitude, magnitude * 10]) {
    for (const factor of [1, 2, 2.5, 5]) steps.push(factor * scale);
  }
  steps.sort((left, right) => left - right);
  const fallback = [];
  for (const step of steps) {
    if (!(step > 0)) continue;
    const ticks = ticksForStep(min, max, step);
    if (ticks.length > count + 1) continue;
    if (ticks.length >= 3) return ticks;
    if (ticks.length > fallback.length) fallback.splice(0, fallback.length, ...ticks);
  }
  return fallback.length ? fallback : [max];
}

function balanceSegments(buckets) {
  const segments = [];
  let current = [];
  buckets.forEach((bucket, index) => {
    const balance = finiteNumberOrNull(bucket.balance);
    if (balance === null || bucket.observed === false) {
      if (current.length) segments.push(current);
      current = [];
      if (balance !== null) current.push({ index, balance, carried: true });
      return;
    }
    current.push({ index, balance, carried: false });
  });
  if (current.length) segments.push(current);
  return segments.filter((segment) => segment.some((point) => !point.carried));
}

function consumptionChartMarkup(item) {
  const buckets = item?.buckets || [];
  if (!buckets.length || !item.sample_count) return '<div class="empty-state compact-empty">该周期还没有趋势数据</div>';
  const width = 660;
  const height = 250;
  const left = 54;
  const right = 16;
  const top = 18;
  const axisBand = 26;
  const plotBottom = height - axisBand;
  const plotWidth = width - left - right;
  const plotHeight = plotBottom - top;
  const barZone = plotHeight * 0.34;
  const lineBottom = plotBottom - barZone - 10;
  const step = plotWidth / buckets.length;
  const centerOf = (index) => left + index * step + step / 2;
  const consumptionMax = Math.max(0, ...buckets.map((bucket) => Number(bucket.consumption || 0)));
  const balances = buckets.filter((bucket) => bucket.observed !== false).map((bucket) => finiteNumberOrNull(bucket.balance)).filter((value) => value !== null);
  const rawMin = balances.length ? Math.min(...balances) : 0;
  const rawMax = balances.length ? Math.max(...balances) : 0;
  const padding = Math.max((rawMax - rawMin) * 0.12, Math.abs(rawMax || 1) * 0.015, 0.01);
  const balanceMin = rawMin - padding;
  const balanceMax = rawMax + padding;
  const balanceRange = balanceMax - balanceMin;
  const yOf = (balance) => top + ((balanceMax - balance) / balanceRange) * (lineBottom - top);
  const ticks = niceAxisTicks(balanceMin, balanceMax).filter((tick) => tick >= rawMin - padding && tick <= rawMax + padding);
  const tickStep = ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : null;
  const grid = ticks.map((tick) => `<line class="chart-gridline" x1="${left}" y1="${yOf(tick).toFixed(2)}" x2="${width - right}" y2="${yOf(tick).toFixed(2)}"></line><text class="chart-axis-label chart-y-label" x="${left - 8}" y="${(yOf(tick) + 3.5).toFixed(2)}">${escapeHtml(axisMoneyText(tick, tickStep))}</text>`).join('');
  const barWidth = Math.min(24, Math.max(2, step - 2));
  const bars = buckets.map((bucket, index) => {
    const value = Number(bucket.consumption || 0);
    const barHeight = consumptionMax > 0 ? value / consumptionMax * barZone : 0;
    if (!(barHeight > 0)) return '';
    const radius = Math.min(4, barWidth / 2, barHeight);
    const x = centerOf(index) - barWidth / 2;
    const y = plotBottom - barHeight;
    return `<path class="consumption-bar" d="M${x.toFixed(2)} ${plotBottom} L${x.toFixed(2)} ${(y + radius).toFixed(2)} Q${x.toFixed(2)} ${y.toFixed(2)} ${(x + radius).toFixed(2)} ${y.toFixed(2)} L${(x + barWidth - radius).toFixed(2)} ${y.toFixed(2)} Q${(x + barWidth).toFixed(2)} ${y.toFixed(2)} ${(x + barWidth).toFixed(2)} ${(y + radius).toFixed(2)} L${(x + barWidth).toFixed(2)} ${plotBottom} Z"></path>`;
  }).join('');
  const segments = balanceSegments(buckets);
  const lines = segments.map((segment) => {
    const points = segment.map((point) => `${centerOf(point.index).toFixed(2)},${yOf(point.balance).toFixed(2)}`).join(' ');
    return segment.length === 1
      ? `<circle class="balance-point" cx="${centerOf(segment[0].index).toFixed(2)}" cy="${yOf(segment[0].balance).toFixed(2)}" r="3"></circle>`
      : `<polyline class="balance-line" points="${points}"></polyline>`;
  }).join('');
  const lastSegment = segments.at(-1);
  const lastPoint = lastSegment?.at(-1);
  const endMarker = lastPoint ? `<circle class="balance-end-ring" cx="${centerOf(lastPoint.index).toFixed(2)}" cy="${yOf(lastPoint.balance).toFixed(2)}" r="6"></circle><circle class="balance-end-dot" cx="${centerOf(lastPoint.index).toFixed(2)}" cy="${yOf(lastPoint.balance).toFixed(2)}" r="4"></circle>` : '';
  const rechargeMarks = buckets.map((bucket, index) => Number(bucket.recharge || 0) > 0
    ? `<line class="recharge-mark" x1="${centerOf(index).toFixed(2)}" y1="${top}" x2="${centerOf(index).toFixed(2)}" y2="${plotBottom}"></line>`
    : '').join('');
  const tickCount = Math.min(4, buckets.length);
  const timeTicks = Array.from({ length: tickCount }, (_, index) => Math.round(index * (buckets.length - 1) / Math.max(1, tickCount - 1)));
  const timeLabels = [...new Set(timeTicks)].map((index) => `<text class="chart-axis-label chart-time-label" x="${centerOf(index).toFixed(2)}" y="${plotBottom + 18}">${escapeHtml(chartTimeLabel(buckets[index].started_at, item.period))}</text>`).join('');
  const hitAreas = buckets.map((bucket, index) => `<rect class="chart-hit" x="${(left + index * step).toFixed(2)}" y="${top}" width="${step.toFixed(2)}" height="${(plotBottom - top).toFixed(2)}" data-bucket-index="${index}" tabindex="0" role="button" aria-label="${escapeHtml(bucketReadout(bucket, item).aria)}"></rect>`).join('');
  const bucketUnit = item.period === '24h' ? '每小时' : item.period === '7d' ? '每 6 小时' : '每天';
  return `<div class="consumption-chart-wrap" data-chart-site="${item.id}">
    <div class="chart-legend-row">
      <span class="chart-key balance-key"><i></i>余额</span>
      <span class="chart-key consumption-key"><i></i>${escapeHtml(bucketUnit)}消耗</span>
      ${Number(item.recharge || 0) > 0 ? '<span class="chart-key recharge-key"><i></i>充值</span>' : ''}
      <span class="chart-peak">峰值 ${escapeHtml(axisMoneyText(consumptionMax))}</span>
    </div>
    <div class="chart-plot">
      <svg class="consumption-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(item.name)} 余额趋势与${bucketUnit}消耗">
        ${grid}
        ${rechargeMarks}
        ${bars}
        ${lines}
        ${endMarker}
        ${timeLabels}
        ${hitAreas}
      </svg>
      <div class="chart-tooltip" hidden></div>
    </div>
  </div>`;
}

function bucketReadout(bucket, item) {
  const time = chartTimeLabel(bucket.started_at, item.period);
  const balance = finiteNumberOrNull(bucket.balance);
  const consumption = Number(bucket.consumption || 0);
  const recharge = Number(bucket.recharge || 0);
  const rows = [
    { label: '消耗', value: `$${numberText(consumption, '0')}`, key: 'consumption' },
    { label: '余额', value: bucket.observed === false || balance === null ? '无快照' : `$${numberText(balance)}`, key: 'balance' }
  ];
  if (recharge > 0) rows.push({ label: '充值', value: `$${numberText(recharge)}`, key: 'recharge' });
  return { time, rows, aria: `${time} 消耗 ${rows[0].value}，余额 ${rows[1].value}${recharge > 0 ? `，充值 $${numberText(recharge)}` : ''}` };
}

function filteredConsumptionItems() {
  const visibleIds = new Set(filteredMonitoringSites().map((site) => Number(site.id)));
  return (state.consumption.items || []).filter((item) => visibleIds.has(Number(item.id)));
}

function renderConsumptionDashboard() {
  document.querySelectorAll('[data-consumption-period]').forEach((button) => button.classList.toggle('active', button.dataset.consumptionPeriod === state.consumption.period));
  const ranking = document.querySelector('#consumptionRanking');
  const detail = document.querySelector('#consumptionDetail');
  const summary = document.querySelector('#consumptionBoardSummary');
  if (state.consumption.loading) {
    summary.textContent = `${consumptionPeriodLabel()} · 正在更新`;
    ranking.innerHTML = '<div class="empty-state compact-empty">正在读取消耗数据...</div>';
    detail.innerHTML = '<div class="empty-state compact-empty">正在生成趋势...</div>';
    return;
  }
  if (state.consumption.error) {
    summary.textContent = `${consumptionPeriodLabel()} · 读取失败`;
    ranking.innerHTML = `<div class="empty-state compact-empty danger-text">${escapeHtml(state.consumption.error)}</div>`;
    detail.innerHTML = '<div class="empty-state compact-empty">趋势暂不可用</div>';
    return;
  }
  const visible = filteredConsumptionItems();
  summary.textContent = `${consumptionPeriodLabel()} · 总消耗 $${numberText(visible.reduce((total, item) => total + Number(item.consumption || 0), 0), '0')}`;
  if (!visible.length) {
    ranking.innerHTML = '<div class="empty-state compact-empty">没有匹配的上游</div>';
    detail.innerHTML = '<div class="empty-state compact-empty">没有可展示的趋势</div>';
    return;
  }
  if (!visible.some((item) => Number(item.id) === Number(state.consumption.selectedSiteId))) state.consumption.selectedSiteId = visible[0].id;
  const top = visible.slice(0, 10);
  const max = Math.max(0, ...top.map((item) => Number(item.consumption || 0)));
  ranking.innerHTML = top.map((item) => `<button class="consumption-rank-row ${Number(item.id) === Number(state.consumption.selectedSiteId) ? 'active' : ''}" type="button" data-consumption-site="${item.id}">
    <span class="consumption-rank-name">${escapeHtml(item.name)}</span><span class="consumption-track"><i style="width:${max > 0 ? Math.max(3, Number(item.consumption || 0) / max * 100) : 0}%"></i></span><strong>${escapeHtml(consumptionAmountText(item))}</strong><small>${escapeHtml(consumptionSpeedText(item))}</small>
  </button>`).join('');
  const selected = visible.find((item) => Number(item.id) === Number(state.consumption.selectedSiteId)) || visible[0];
  const stats = [
    { label: '当前余额', value: selected.current_balance == null ? '-' : `$${numberText(selected.current_balance)}`, hero: true },
    { label: '周期消耗', value: consumptionAmountText(selected) },
    { label: '消耗速度', value: consumptionSpeedText(selected), note: recentSpeedText(selected) },
    { label: '预计可用', value: runwayText(selected), tone: runwayTone(selected), note: runwayBasisText(selected) }
  ];
  detail.innerHTML = `<div class="consumption-detail-head">
      <div><h3>${escapeHtml(selected.name)}</h3><span class="muted">${escapeHtml(consumptionCoverageText(selected))} · ${selected.estimated ? '余额估算' : '实际成本'}${Number(selected.recharge || 0) > 0 ? ` · 期间充值 $${numberText(selected.recharge)}` : ''}</span></div>
      <button class="chart-table-toggle" type="button" data-consumption-table="${selected.id}">${state.consumption.showTable ? '看图表' : '看数据'}</button>
    </div>
    <div class="consumption-stat-row">${stats.map((stat) => `<div class="consumption-stat${stat.hero ? ' hero' : ''}"><span>${escapeHtml(stat.label)}</span><strong class="${stat.tone || ''}">${escapeHtml(stat.value)}</strong>${stat.note ? `<small class="consumption-stat-note">${escapeHtml(stat.note)}</small>` : ''}</div>`).join('')}</div>
    ${state.consumption.showTable ? consumptionTableMarkup(selected) : consumptionChartMarkup(selected)}`;
  bindConsumptionChart(detail);
}

function runwayBasisText(item) {
  if (!item?.enough_data || finiteNumberOrNull(item?.runway_hours) === null) return '';
  const trend = recentTrend(item);
  if (!trend) return '按加权近期速度';
  return trend.direction === 'up' ? '按加权近期速度 · 正在加速' : '按加权近期速度 · 正在放缓';
}

function runwayTone(item) {
  const hours = finiteNumberOrNull(item?.runway_hours);
  if (!item?.enough_data || hours === null) return '';
  if (hours < 12) return 'danger';
  if (hours < 48) return 'warning';
  return '';
}

function consumptionTableMarkup(item) {
  const rows = (item.buckets || []).filter((bucket) => Number(bucket.consumption || 0) > 0 || bucket.observed !== false);
  if (!rows.length) return '<div class="empty-state compact-empty">该周期还没有趋势数据</div>';
  return `<div class="chart-table-wrap"><table class="chart-table">
    <thead><tr><th scope="col">时间</th><th scope="col">消耗</th><th scope="col">余额</th><th scope="col">充值</th></tr></thead>
    <tbody>${rows.map((bucket) => {
      const balance = finiteNumberOrNull(bucket.balance);
      const recharge = Number(bucket.recharge || 0);
      return `<tr><th scope="row">${escapeHtml(chartTimeLabel(bucket.started_at, item.period))}</th><td>$${escapeHtml(numberText(bucket.consumption, '0'))}</td><td>${bucket.observed === false || balance === null ? '<span class="muted">无快照</span>' : `$${escapeHtml(numberText(balance))}`}</td><td>${recharge > 0 ? `$${escapeHtml(numberText(recharge))}` : '<span class="muted">-</span>'}</td></tr>`;
    }).join('')}</tbody>
  </table></div>`;
}

function bindConsumptionChart(root) {
  const wrap = root.querySelector('.consumption-chart-wrap');
  if (!wrap) return;
  const item = consumptionForSite(wrap.dataset.chartSite);
  const tooltip = wrap.querySelector('.chart-tooltip');
  const plot = wrap.querySelector('.chart-plot');
  const hide = () => { tooltip.hidden = true; wrap.querySelectorAll('.chart-hit.active').forEach((hit) => hit.classList.remove('active')); };
  const show = (hit) => {
    const bucket = item?.buckets?.[Number(hit.dataset.bucketIndex)];
    if (!bucket) return;
    const readout = bucketReadout(bucket, item);
    tooltip.replaceChildren();
    const time = document.createElement('div');
    time.className = 'chart-tooltip-time';
    time.textContent = readout.time;
    tooltip.append(time);
    readout.rows.forEach((row) => {
      const line = document.createElement('div');
      line.className = `chart-tooltip-row ${row.key}`;
      const value = document.createElement('strong');
      value.textContent = row.value;
      const label = document.createElement('span');
      label.textContent = row.label;
      line.append(value, label);
      tooltip.append(line);
    });
    wrap.querySelectorAll('.chart-hit.active').forEach((other) => other.classList.remove('active'));
    hit.classList.add('active');
    tooltip.hidden = false;
    const bounds = plot.getBoundingClientRect();
    const anchor = hit.getBoundingClientRect();
    const center = anchor.left + anchor.width / 2 - bounds.left;
    tooltip.style.left = `${Math.min(Math.max(center, tooltip.offsetWidth / 2 + 4), bounds.width - tooltip.offsetWidth / 2 - 4)}px`;
  };
  wrap.querySelectorAll('.chart-hit').forEach((hit) => {
    hit.addEventListener('pointerenter', () => show(hit));
    hit.addEventListener('focus', () => show(hit));
    hit.addEventListener('blur', hide);
  });
  plot.addEventListener('pointerleave', hide);
}

async function loadConsumption({ quiet = false } = {}) {
  state.consumption.loading = true;
  state.consumption.error = '';
  if (!quiet) renderConsumptionDashboard();
  try {
    const result = await api(`/api/monitoring/consumption?period=${encodeURIComponent(state.consumption.period)}`);
    state.consumption = { ...state.consumption, ...result, loading: false, error: '' };
  } catch (error) {
    state.consumption.items = [];
    state.consumption.loading = false;
    state.consumption.error = error.message;
  }
  renderConsumptionDashboard();
}

function isLowBalance(site) {
  const balance = finiteNumberOrNull(site.balance);
  return balance !== null && balance < Number(site.low_balance_threshold || 10);
}

function siteHealth(site) {
  if (site.status === 'disabled') return { label: '已停用', tone: 'neutral', dot: 'neutral' };
  if (site.status === 'sync_failed') return { label: '同步失败', tone: 'danger', dot: 'danger' };
  if (site.balance_stale) return { label: '数据过期', tone: 'warning', dot: 'warning' };
  if (Number(site.key_abnormal_count || 0) > 0) return { label: 'Key 异常', tone: 'danger', dot: 'danger' };
  if (isLowBalance(site)) return { label: '余额偏低', tone: 'warning', dot: 'warning' };
  return { label: '正常', tone: 'healthy', dot: 'healthy' };
}

function connectivityMeta(key) {
  const status = key.connectivity_status || 'untested';
  const map = {
    connected: { label: `联通${key.latency_ms != null ? ` ${key.latency_ms}ms` : ''}`, tone: 'healthy', dot: 'healthy' },
    timeout: { label: '超时', tone: 'danger', dot: 'danger' },
    auth_failed: { label: '鉴权失败', tone: 'danger', dot: 'danger' },
    quota_exhausted: { label: '额度不足', tone: 'danger', dot: 'danger' },
    upstream_error: { label: key.connectivity_error_code === 'rate_limited' ? '上游限流' : key.connectivity_error_code === 'ip_blocked' ? '出口 IP 被拒绝' : '上游错误', tone: 'danger', dot: 'danger' },
    unavailable: { label: key.connectivity_error_code === 'full_key_missing' ? '无完整 Key' : '无法检测', tone: 'warning', dot: 'warning' },
    unconfigured: { label: '未配置模型', tone: 'warning', dot: 'warning' },
    untested: { label: '未检测', tone: 'warning', dot: 'warning' }
  };
  return map[status] || map.untested;
}

function keyProbeModelSelect(site, key) {
  const selected = String(key.selected_probe_model || '');
  const options = [...new Set((key.probe_model_options || []).map(String).filter(Boolean))];
  if (selected && !options.includes(selected)) options.unshift(selected);
  const inherited = key.group_probe_model || (
    String(key.platform || '').toLowerCase().includes('anthropic')
      ? site.anthropic_probe_model
      : site.openai_probe_model
  ) || '';
  const followLabel = inherited ? `跟随分组 · ${inherited}` : '跟随分组';
  return `<select class="key-model-select" data-key-probe-model="${escapeHtml(key.upstream_key_id)}" data-site-id="${site.id}" data-previous-model="${escapeHtml(selected)}" aria-label="${escapeHtml(key.name || key.key_masked || 'Key')} 检测模型" title="当前生效：${escapeHtml(key.effective_probe_model || '未配置')}"><option value="">${escapeHtml(followLabel)}</option>${options.map((model) => `<option value="${escapeHtml(model)}" ${model === selected ? 'selected' : ''}>${escapeHtml(model)}${model === selected && !(key.probe_model_options || []).includes(model) ? ' · 已不在最新候选' : ''}</option>`).join('')}</select>`;
}

function keyProbeScheduleToggle(key) {
  const selected = String(key.selected_probe_model || '').trim();
  const enabled = Number(key.periodic_probe_enabled ?? 0) === 1;
  return `<label class="toggle-field compact-toggle key-probe-schedule" title="${selected ? '定时联通测试' : '请先选择专用检测模型'}"><input type="checkbox" data-key-probe-schedule="${escapeHtml(key.upstream_key_id)}" data-site-id="${key.upstream_site_id}" ${enabled ? 'checked' : ''} ${selected ? '' : 'disabled'} aria-label="${escapeHtml(key.name || key.key_masked || 'Key')} 定时联通测试" /><span class="toggle-control"></span></label>`;
}

function filteredMonitoringSites() {
  const keyword = state.search.trim().toLowerCase();
  const items = (state.monitoring.items || []).filter((site) => {
    const keyText = (site.keys || []).map((key) => `${key.name} ${key.key_masked} ${key.group_name}`).join(' ');
    if (keyword && !`${site.name} ${site.base_url} ${keyText}`.toLowerCase().includes(keyword)) return false;
    if (state.monitorStatus === 'healthy') return siteHealth(site).tone === 'healthy';
    if (state.monitorStatus === 'low') return isLowBalance(site);
    if (state.monitorStatus === 'key-error') return Number(site.key_abnormal_count || 0) > 0;
    return true;
  });
  return items.sort((a, b) => {
    if (state.monitorSort === 'balance-desc') return Number(b.balance ?? -Infinity) - Number(a.balance ?? -Infinity);
    if (state.monitorSort === 'consumption-desc') return Number(consumptionForSite(b.id)?.consumption || 0) - Number(consumptionForSite(a.id)?.consumption || 0);
    if (state.monitorSort === 'abnormal-desc') return Number(b.key_abnormal_count || 0) - Number(a.key_abnormal_count || 0);
    if (state.monitorSort === 'name-asc') return String(a.name).localeCompare(String(b.name), 'zh-CN');
    return Number(a.balance ?? Infinity) - Number(b.balance ?? Infinity);
  });
}

function upstreamIdentityMarkup(site) {
  const name = escapeHtml(site.name);
  const url = escapeHtml(site.base_url);
  return `<button class="upstream-name-link" type="button" data-detail-site="${site.id}" title="查看 ${name} 详情">${name}</button><a class="upstream-url-link" href="${url}" target="_blank" rel="noopener noreferrer" title="在新标签打开 ${url}"><span>${url}</span><i data-lucide="external-link"></i></a>`;
}

function renderUpstreamActions(site) {
  const name = escapeHtml(site.name);
  return `<div class="row-actions upstream-row-actions"><button class="icon-btn" type="button" data-sync-site="${site.id}" title="同步余额和 Key" aria-label="${name} 同步余额和 Key"><i data-lucide="refresh-cw"></i></button><button class="icon-btn" type="button" data-sync-site-models="${site.id}" title="同步支持模型" aria-label="${name} 同步支持模型"><i data-lucide="boxes"></i></button><button class="icon-btn" type="button" data-detail-site="${site.id}" title="查看详情" aria-label="查看 ${name} 详情"><i data-lucide="panel-right-open"></i></button><button class="icon-btn danger-text" type="button" data-delete-upstream="${site.id}" data-upstream-name="${name}" title="永久删除" aria-label="永久删除 ${name}"><i data-lucide="trash-2"></i></button></div>`;
}

function renderMonitoring() {
  document.querySelector('#monitoringMetrics').innerHTML = metricMarkup(monitoringMetrics());
  const totals = state.monitoring.totals || {};
  document.querySelector('#segmentAllCount').textContent = totals.upstreams || 0;
  document.querySelector('#segmentHealthyCount').textContent = totals.healthy || 0;
  document.querySelector('#segmentLowCount').textContent = totals.low_balance || 0;
  document.querySelector('#segmentKeyErrorCount').textContent = totals.key_abnormal || 0;
  document.querySelectorAll('[data-monitor-status]').forEach((button) => button.classList.toggle('active', button.dataset.monitorStatus === state.monitorStatus));
  renderConsumptionDashboard();

  const rows = filteredMonitoringSites().map((site) => {
    const expanded = state.expandedSites.has(Number(site.id));
    const health = siteHealth(site);
    const balanceClass = isLowBalance(site) ? 'low' : '';
    const syncError = syncErrorPresentation(site.last_sync_error);
    const consumption = consumptionForSite(site.id);
    return `
      <tr class="data-row">
        <td><div class="upstream-name-cell"><button class="row-chevron ${expanded ? 'expanded' : ''}" type="button" data-toggle-site="${site.id}" aria-label="展开 ${escapeHtml(site.name)}"><i data-lucide="chevron-right"></i></button><div class="upstream-identity">${upstreamIdentityMarkup(site)}</div></div></td>
        <td><strong class="balance-value ${balanceClass}">${site.balance == null ? '-' : `$${numberText(site.balance)}`}</strong><span class="balance-meta ${site.balance_stale ? 'warning-text' : ''}">${site.balance_stale ? '数据已过期 · ' : ''}${ageText(site.balance_age_ms)}</span></td>
        <td><div class="cell-stack consumption-cell"><strong>${escapeHtml(consumptionAmountText(consumption))}</strong><small>${escapeHtml(consumptionCoverageText(consumption))}</small></div></td>
        <td><div class="cell-stack consumption-cell"><strong>${escapeHtml(consumptionSpeedText(consumption))}</strong><small>${consumption?.estimated ? '余额变化估算' : consumption ? '实际成本' : '-'}</small></div></td>
        <td><strong class="numeric">${escapeHtml(runwayText(consumption))}</strong></td>
        <td><span class="status-label"><span class="status-dot ${health.dot}"></span><span>${escapeHtml(health.label)}</span></span></td>
        <td><span class="numeric">${site.key_count || 0} 个 Key</span></td>
        <td class="numeric ${site.key_abnormal_count ? 'danger-text' : ''}">${site.key_abnormal_count || 0}</td>
        <td><div class="cell-stack sync-cell"><span>${timeText(site.last_sync_at)}</span>${syncError.full ? `<small class="danger-text sync-error" title="${escapeHtml(syncError.full)}">${escapeHtml(syncError.summary)}</small>` : ''}</div></td>
        <td class="align-right">${renderUpstreamActions(site)}</td>
      </tr>
      ${expanded ? renderExpandedKeys(site) : ''}
    `;
  }).join('');
  document.querySelector('#monitoringRows').innerHTML = rows || '<tr><td colspan="10"><div class="empty-state">没有匹配的上游</div></td></tr>';
}

function renderExpandedKeys(site) {
  const keys = (site.keys || []).filter((key) => key.import_state !== 'missing');
  const modelSync = site.model_sync || {};
  const modelSyncText = modelSync.status === 'never'
    ? '模型尚未同步'
    : `${timeText(modelSync.synced_at)}同步 · ${modelSync.model_count || 0} 个模型 · ${modelSync.group_count || 0} 个分组${['partial', 'failed', 'stale'].includes(modelSync.status) ? ' · 有异常' : ''}`;
  const body = keys.map((key) => {
    const connectivity = connectivityMeta(key);
    const failed = connectivity.tone === 'danger';
    return `<tr class="${failed ? 'failure-row' : ''}">
      <td class="key-name">${escapeHtml(key.name || '未命名 Key')}</td>
      <td><span class="key-code"><code>${escapeHtml(key.key_masked || '-')}</code><button class="icon-btn copy-mini" type="button" data-copy-text="${escapeHtml(key.key_masked || '')}" title="复制"><i data-lucide="copy"></i></button></span></td>
      <td>${escapeHtml(key.group_name || '-')}</td><td>${escapeHtml(platformLabel(key.platform))}</td><td class="numeric">${rateText(key.group_rate)}</td><td>${keyProbeModelSelect(site, key)}</td>
      <td><span class="status-label ${connectivity.tone}-text"><span class="status-dot ${connectivity.dot}"></span>${escapeHtml(connectivity.label)}</span></td>
      <td>${timeText(key.last_checked_at)}</td>
      <td class="align-right"><button class="icon-btn" type="button" data-check-key="${escapeHtml(key.upstream_key_id)}" data-site-id="${site.id}" title="立即检测"><i data-lucide="activity"></i></button></td>
    </tr>`;
  }).join('');
  return `<tr class="expanded-row"><td colspan="10"><div class="expanded-panel">
    <div class="expanded-header"><div class="expanded-title"><strong>${escapeHtml(site.name)} · Key 明细</strong><small class="${['partial', 'failed', 'stale'].includes(modelSync.status) ? 'warning-text' : ''}">${escapeHtml(modelSyncText)}</small></div><div class="expanded-actions"><button class="btn secondary" type="button" data-sync-site-models="${site.id}"><i data-lucide="refresh-cw"></i>同步模型</button><button class="btn secondary" type="button" data-import-keys="${site.id}"><i data-lucide="download"></i>导入全部 Key</button><button class="btn primary" type="button" data-check-site-keys="${site.id}"><i data-lucide="activity"></i>立即检测</button></div></div>
    <div class="key-inner-wrap"><table class="data-table key-inner-table"><thead><tr><th>Key 名称</th><th>Key</th><th>所属分组</th><th>平台</th><th>倍率</th><th>检测模型</th><th>联通性</th><th>最近检测</th><th class="align-right">操作</th></tr></thead><tbody>${body || '<tr><td colspan="9"><div class="empty-state">还没有导入 Key</div></td></tr>'}</tbody></table></div>
  </div></td></tr>`;
}

function platformLabel(value) {
  const platform = String(value || '').toLowerCase();
  if (platform.includes('anthropic') || platform.includes('claude')) return 'Anthropic';
  if (platform.includes('openai') || platform.includes('codex') || platform.includes('gpt')) return 'OpenAI';
  return value || '-';
}

function allKeys() {
  return (state.monitoring.items || []).flatMap((site) => (site.keys || [])
    .filter((key) => key.import_state !== 'missing')
    .map((key) => ({ ...key, upstream_name: site.name, upstream_site_id: site.id })));
}

function renderGlobalKeys() {
  const siteFilter = document.querySelector('#keyUpstreamFilter');
  const current = state.keyFilters.upstream;
  siteFilter.innerHTML = '<option value="">全部上游</option>' + (state.monitoring.items || []).map((site) => `<option value="${site.id}">${escapeHtml(site.name)}</option>`).join('');
  siteFilter.value = current;
  const keyword = state.search.toLowerCase();
  const sites = (state.monitoring.items || []).map((site) => {
    const keys = (site.keys || []).filter((key) => {
      if (key.import_state === 'missing') return false;
      if (keyword && !`${site.name} ${site.base_url} ${key.name} ${key.key_masked} ${key.group_name}`.toLowerCase().includes(keyword)) return false;
      if (state.keyFilters.platform && platformLabel(key.platform).toLowerCase() !== state.keyFilters.platform) return false;
      const failed = ['timeout', 'auth_failed', 'quota_exhausted', 'upstream_error'].includes(key.connectivity_status);
      if (state.keyFilters.health === 'connected' && key.connectivity_status !== 'connected') return false;
      if (state.keyFilters.health === 'failed' && !failed) return false;
      if (state.keyFilters.health === 'untested' && (key.connectivity_status && !['untested', 'unconfigured', 'unavailable'].includes(key.connectivity_status))) return false;
      return true;
    });
    return { ...site, filteredKeys: keys };
  }).filter((site) => {
    if (state.keyFilters.upstream && String(site.id) !== state.keyFilters.upstream) return false;
    const siteMatches = keyword && `${site.name} ${site.base_url}`.toLowerCase().includes(keyword);
    return siteMatches || site.filteredKeys.length > 0 || (!keyword && !state.keyFilters.platform && !state.keyFilters.health);
  });

  document.querySelector('#globalKeyRows').innerHTML = sites.map((site) => {
    const expanded = state.expandedKeySites.has(Number(site.id));
    const keys = site.filteredKeys;
    const active = keys.filter((key) => key.status === 'active').length;
    const inactive = keys.filter((key) => key.status !== 'active').length;
    const failed = keys.filter((key) => ['timeout', 'auth_failed', 'quota_exhausted', 'upstream_error'].includes(key.connectivity_status)).length;
    return `<tr class="data-row"><td><div class="upstream-name-cell"><button class="row-chevron ${expanded ? 'expanded' : ''}" type="button" data-toggle-key-site="${site.id}" aria-label="展开 ${escapeHtml(site.name)}"><i data-lucide="chevron-right"></i></button><div class="upstream-identity">${upstreamIdentityMarkup(site)}</div></div></td><td>${keys.length}</td><td class="healthy-text">${active}</td><td>${inactive}</td><td class="${failed ? 'danger-text' : ''}">${failed}</td><td>${timeText(site.last_sync_at)}</td><td class="align-right"><div class="row-actions"><button class="icon-btn" type="button" data-import-keys="${site.id}" title="导入全部 Key"><i data-lucide="download"></i></button><button class="icon-btn" type="button" data-check-site-keys="${site.id}" title="检测全部 Key"><i data-lucide="activity"></i></button></div></td></tr>${expanded ? renderManagedKeyRows(site, keys) : ''}`;
  }).join('') || '<tr><td colspan="7"><div class="empty-state">没有匹配的上游或 Key</div></td></tr>';
}

function renderManagedKeyRows(site, keys) {
  const body = keys.map((key) => {
    const failed = ['timeout', 'auth_failed', 'quota_exhausted', 'upstream_error'].includes(key.connectivity_status);
    const connectivity = connectivityMeta(key);
    return `<tr class="${failed ? 'failure-row' : ''}"><td>${escapeHtml(key.name || '-')}</td><td><code>${escapeHtml(key.key_masked || '-')}</code></td><td>${escapeHtml(key.group_name || '-')}</td><td>${escapeHtml(platformLabel(key.platform))}</td><td class="numeric">${rateText(key.group_rate)}</td><td><div class="key-probe-controls">${keyProbeModelSelect(site, key)}${keyProbeScheduleToggle(key)}</div></td><td><span class="status-label ${connectivity.tone}-text"><span class="status-dot ${connectivity.dot}"></span>${escapeHtml(connectivity.label)}</span></td><td>${timeText(key.last_checked_at)}</td><td class="align-right"><div class="row-actions"><button class="icon-btn" type="button" data-check-key="${escapeHtml(key.upstream_key_id)}" data-site-id="${site.id}" title="检测"><i data-lucide="activity"></i></button><button class="icon-btn" type="button" data-toggle-key="${escapeHtml(key.upstream_key_id)}" data-site-id="${site.id}" data-next-status="${key.status === 'active' ? 'inactive' : 'active'}" title="${key.status === 'active' ? '暂停' : '启用'}"><i data-lucide="${key.status === 'active' ? 'pause' : 'play'}"></i></button><button class="icon-btn danger-text" type="button" data-delete-key="${escapeHtml(key.upstream_key_id)}" data-site-id="${site.id}" title="删除"><i data-lucide="trash-2"></i></button></div></td></tr>`;
  }).join('');
  return `<tr class="expanded-row"><td colspan="7"><div class="expanded-panel"><div class="expanded-header"><strong>${escapeHtml(site.name)} · Key 明细</strong><span class="muted">${keys.length} 个</span></div><div class="key-inner-wrap"><table class="data-table key-inner-table"><thead><tr><th>Key 名称</th><th>Key</th><th>所属分组</th><th>平台</th><th>倍率</th><th>检测模型</th><th>联通性</th><th>最近检测</th><th class="align-right">操作</th></tr></thead><tbody>${body || '<tr><td colspan="9"><div class="empty-state">没有匹配的 Key</div></td></tr>'}</tbody></table></div></div></td></tr>`;
}

function renderOverview() {
  document.querySelector('#overviewMetrics').innerHTML = metricMarkup(monitoringMetrics());
  const alerts = state.alerts.filter((item) => item.status === 'open').slice(0, 6);
  document.querySelector('#overviewAlerts').innerHTML = alerts.map((item) => `<div class="event-item"><div class="event-main"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.message).replaceAll('\n', ' · ')}</small></div><span class="status-pill ${item.severity === 'critical' ? 'danger' : 'warning'}">${item.severity === 'critical' ? '严重' : '警告'}</span></div>`).join('') || '<div class="empty-state">当前没有告警</div>';
  const low = (state.monitoring.items || []).filter(isLowBalance).sort((a, b) => Number(a.balance) - Number(b.balance));
  document.querySelector('#overviewBalances').innerHTML = low.map((site) => `<div class="event-item"><div class="event-main"><strong>${escapeHtml(site.name)}</strong><small>阈值 $${numberText(site.low_balance_threshold)} · ${timeText(site.last_sync_at)}</small></div><strong class="balance-value low">$${numberText(site.balance)}</strong></div>`).join('') || '<div class="empty-state">当前没有余额预警</div>';
}

function renderOwnSites() {
  const keyword = state.search.toLowerCase();
  document.querySelector('#ownSiteRows').innerHTML = state.ownSites.filter((site) => !keyword || `${site.name} ${site.base_url}`.toLowerCase().includes(keyword)).map((site) => `<tr class="data-row"><td><div class="upstream-identity"><strong>${escapeHtml(site.name)}</strong><small>${escapeHtml(site.base_url)}</small></div></td><td><span class="status-pill ${site.status === 'active' ? 'healthy' : 'danger'}">${site.status === 'active' ? '正常' : '同步失败'}</span></td><td>${site.route_count || 0}</td><td>${site.matched_count || 0}</td><td class="${site.unmatched_count ? 'danger-text' : ''}">${site.unmatched_count || 0}</td><td>${timeText(site.last_sync_at)}</td><td class="align-right"><div class="row-actions"><button class="icon-btn" data-sync-own-site="${site.id}" title="同步"><i data-lucide="refresh-cw"></i></button><button class="icon-btn" data-edit-own-site="${site.id}" title="编辑"><i data-lucide="pencil"></i></button><button class="icon-btn danger-text" data-delete-own-site="${site.id}" title="删除"><i data-lucide="trash-2"></i></button></div></td></tr>`).join('') || '<tr><td colspan="7"><div class="empty-state">还没有自己站</div></td></tr>';

  document.querySelector('#ownRouteRows').innerHTML = state.ownRoutes.filter((route) => !keyword || `${route.route_name} ${route.upstream_api_url} ${route.matched_upstream_name}`.toLowerCase().includes(keyword)).map((route) => {
    const buy = Number(route.upstream_buy_rate);
    const sell = Number(route.matched_group_rate);
    const diff = Number.isFinite(buy) && Number.isFinite(sell) ? sell - buy : null;
    const inverted = diff != null && diff < 0;
    const status = inverted ? '倒挂' : route.match_status === 'matched' ? '已对账' : '需绑定';
    return `<tr class="data-row"><td><strong>${escapeHtml(route.own_site_name)} · ${escapeHtml(route.route_name || route.route_id)}</strong></td><td><span class="muted">${escapeHtml(route.upstream_api_url || '-')}</span></td><td>${escapeHtml(route.matched_upstream_name || '未匹配')}</td><td><code>${escapeHtml(route.upstream_key_masked || route.matched_upstream_key_id || '-')}</code></td><td>${rateText(route.upstream_buy_rate)}</td><td>${escapeHtml(route.matched_group_name || '-')}</td><td>${rateText(route.matched_group_rate)}</td><td class="numeric ${inverted ? 'danger-text' : ''}">${diff == null ? '-' : `${diff >= 0 ? '+' : ''}${diff.toFixed(4)}x`}</td><td><span class="status-pill ${inverted ? 'danger' : route.match_status === 'matched' ? 'healthy' : 'warning'}">${status}</span></td><td class="align-right"><button class="btn secondary" data-bind-route="${escapeHtml(route.route_id)}" data-own-site-id="${route.own_site_id}">绑定 Key</button></td></tr>`;
  }).join('') || '<tr><td colspan="10"><div class="empty-state">还没有路由数据</div></td></tr>';
}

function rateBadgeTone(rate) {
  if (rate === null || rate === undefined) return 'muted';
  if (rate <= 0.05) return 'good';
  if (rate <= 0.3) return 'normal';
  return 'high';
}

function renderRateRows(group) {
  const rates = group.rates || [];
  if (!rates.length) return '<div class="rate-empty">暂无倍率数据</div>';
  return `<div class="rate-detail-list">${rates.map((item) => {
    const label = item.model ? `${item.scope || '通用'} · ${escapeHtml(item.model)}` : (item.scope ? escapeHtml(item.scope) : '通用');
    return `<div class="rate-detail-line"><span class="muted">${label}</span><strong>×${numberText(item.rate)}</strong></div>`;
  }).join('')}</div>`;
}

function renderRateGroups(site) {
  const groups = site.groups || [];
  if (!groups.length) return '<div class="expanded-panel"><div class="rate-empty">该上游暂无分组倍率，请先同步</div></div>';
  return `<div class="expanded-panel"><div class="rate-group-grid">${groups.map((group) => {
    const span = group.min_rate === group.max_rate ? `×${numberText(group.min_rate)}` : `×${numberText(group.min_rate)} ~ ×${numberText(group.max_rate)}`;
    return `<div class="rate-group-card"><div class="rate-group-head"><span class="rate-group-name">${escapeHtml(group.group_name)}</span><span class="rate-badge ${rateBadgeTone(group.min_rate)}">${span}</span></div>${renderRateRows(group)}</div>`;
  }).join('')}</div></div>`;
}

function renderPricing() {
  const keyword = state.search.toLowerCase();
  const sites = (state.groupRates || []).filter((site) => {
    if (!keyword) return true;
    const haystack = `${site.upstream_name} ${site.base_url} ${(site.groups || []).map((group) => group.group_name).join(' ')}`.toLowerCase();
    return haystack.includes(keyword);
  });
  const board = document.querySelector('#pricingBoard');
  if (!board) return;
  const totalGroups = sites.reduce((sum, site) => sum + (site.group_count || 0), 0);
  const rows = sites.map((site) => {
    const expanded = state.expandedRateSites.has(site.upstream_site_id);
    const span = site.min_rate === null ? '<span class="muted">无倍率</span>'
      : `<span class="rate-badge ${rateBadgeTone(site.min_rate)}">×${numberText(site.min_rate)}${site.min_rate === site.max_rate ? '' : ` ~ ×${numberText(site.max_rate)}`}</span>`;
    const link = site.base_url
      ? `<a class="rate-site-link" href="${escapeHtml(site.base_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(site.upstream_name)}</a>`
      : `<span class="rate-site-link plain">${escapeHtml(site.upstream_name)}</span>`;
    return `<div class="rate-site ${expanded ? 'expanded' : ''}">
      <div class="rate-site-head">
        <button class="rate-site-toggle" type="button" data-toggle-rate-site="${site.upstream_site_id}" aria-expanded="${expanded}" aria-label="展开 ${escapeHtml(site.upstream_name)} 的分组倍率">
          <span class="row-chevron ${expanded ? 'expanded' : ''}"><i data-lucide="chevron-right"></i></span>
        </button>
        <span class="rate-site-main">${link}<small class="muted">${site.group_count || 0} 个分组</small></span>
        ${span}
      </div>
      ${expanded ? renderRateGroups(site) : ''}
    </div>`;
  }).join('');
  board.innerHTML = `<div class="rate-board-summary"><span>${sites.length} 个上游 · ${totalGroups} 个分组</span></div>${rows || '<div class="empty-state">暂无上游分组倍率</div>'}`;
}


function alertStage(item) {
  if (item.status === 'resolved') return 'resolved';
  if (item.acknowledged_at) return 'acknowledged';
  return 'pending';
}

function filteredAlerts() {
  const keyword = state.search.toLowerCase();
  return state.alerts.filter((item) => {
    const stage = alertStage(item);
    return (!state.alertStatus || stage === state.alertStatus)
      && (!keyword || `${item.title} ${item.message} ${item.upstream_name}`.toLowerCase().includes(keyword));
  });
}

function renderAlerts() {
  document.querySelector('#alertStatusFilter').value = state.alertStatus;
  const visible = filteredAlerts();
  const pending = visible.filter((item) => alertStage(item) === 'pending');
  const bulk = document.querySelector('#acknowledgeVisibleAlertsBtn');
  bulk.disabled = !pending.length;
  bulk.innerHTML = `<i data-lucide="check-check"></i>${pending.length ? `全部标记已处理 (${pending.length})` : '全部标记已处理'}`;
  document.querySelector('#alertRows').innerHTML = visible.map((item) => {
    const stage = alertStage(item);
    const meta = {
      pending: { label: '待处理', tone: 'danger' },
      acknowledged: { label: '已处理', tone: 'warning' },
      resolved: { label: '已恢复', tone: 'healthy' }
    }[stage];
    const notified = item.notified_at
      ? `已推送${Number(item.notification_count || 0) > 1 ? ` ${item.notification_count} 次` : ''} · ${timeText(item.last_notified_at || item.notified_at)}`
      : '未推送';
    return `<tr class="data-row"><td><span class="status-pill ${meta.tone}">${meta.label}</span></td><td><div class="cell-stack"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.message).replaceAll('\n', ' · ')}</small></div></td><td>${escapeHtml(item.upstream_name || '-')}</td><td><code>${escapeHtml(item.upstream_key_id || '-')}</code></td><td>${item.severity === 'critical' ? '严重' : '警告'}</td><td>${timeText(item.opened_at)}</td><td>${notified}</td><td class="align-right">${stage === 'pending' ? `<button class="btn secondary" type="button" data-ack-alert="${item.id}"><i data-lucide="check"></i>标记已处理</button>` : '-'}</td></tr>`;
  }).join('') || '<tr><td colspan="8"><div class="empty-state">没有匹配的告警</div></td></tr>';
}

function renderUpstreamPolicies() {
  const rows = document.querySelector('#runtimeUpstreamRows');
  rows.innerHTML = (state.monitoring.items || []).map((site) => `<tr class="data-row" data-policy-site="${site.id}"><td><div class="cell-stack"><strong>${escapeHtml(site.name)}</strong><small>${escapeHtml(site.base_url)}</small></div></td><td><div class="policy-control"><label class="toggle-field compact-toggle"><input type="checkbox" data-policy-field="sync_enabled" ${Number(site.sync_enabled ?? 1) ? 'checked' : ''} aria-label="${escapeHtml(site.name)} 自动同步" /><span class="toggle-control"></span></label><input type="number" min="30" max="86400" value="${Number(site.sync_interval_seconds || 180)}" data-policy-field="sync_interval_seconds" aria-label="${escapeHtml(site.name)} 同步周期" /></div></td><td><div class="policy-control"><label class="toggle-field compact-toggle"><input type="checkbox" data-policy-field="key_check_enabled" ${Number(site.key_check_enabled ?? 1) ? 'checked' : ''} aria-label="${escapeHtml(site.name)} Key 探测" /><span class="toggle-control"></span></label><input type="number" min="60" max="86400" value="${Number(site.key_check_interval_seconds || 300)}" data-policy-field="key_check_interval_seconds" aria-label="${escapeHtml(site.name)} Key 探测周期" /></div></td><td><label class="toggle-field compact-toggle"><input type="checkbox" data-policy-field="alert_notifications_enabled" ${Number(site.alert_notifications_enabled ?? 1) ? 'checked' : ''} aria-label="${escapeHtml(site.name)} 告警通知" /><span class="toggle-control"></span></label></td><td><div class="policy-control"><label class="toggle-field compact-toggle"><input type="checkbox" data-policy-field="low_balance_alert_enabled" ${Number(site.low_balance_alert_enabled ?? 1) ? 'checked' : ''} aria-label="${escapeHtml(site.name)} 余额预警" /><span class="toggle-control"></span></label><input type="number" min="0" step="0.0001" value="${Number(site.low_balance_threshold ?? 10)}" data-policy-field="low_balance_threshold" aria-label="${escapeHtml(site.name)} 余额阈值" /></div></td><td><input class="policy-number" type="number" min="0" value="${Number(site.rate_change_threshold_percent ?? 20)}" data-policy-field="rate_change_threshold_percent" aria-label="${escapeHtml(site.name)} 倍率变化阈值" /></td><td class="align-right"><button class="icon-btn" type="button" data-save-upstream-policy="${site.id}" title="保存上游策略"><i data-lucide="save"></i></button></td></tr>`).join('') || '<tr><td colspan="7"><div class="empty-state">还没有上游</div></td></tr>';
}

function setSettingsTab(tab) {
  state.settingsTab = tab;
  document.querySelectorAll('[data-settings-tab]').forEach((button) => button.classList.toggle('active', button.dataset.settingsTab === tab));
  document.querySelectorAll('[data-settings-panel]').forEach((panel) => { panel.hidden = panel.dataset.settingsPanel !== tab; });
  refreshIcons();
}

function renderSettings() {
  renderEmailSettings();
  const status = state.runtimeSettings || {};
  const settings = status.settings;
  if (!settings) return;
  document.querySelectorAll('[data-runtime-setting]').forEach((input) => {
    const value = settings[input.dataset.runtimeSetting];
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = value ?? '';
  });
  const source = status.source === 'database' ? '控制台配置，保存后热生效' : '当前使用环境默认值';
  document.querySelector('#runtimeSettingsStatus').textContent = status.warning || source;
  const syncLocked = Boolean(status.locks?.sync_scheduler);
  const keyLocked = Boolean(status.locks?.key_check_scheduler);
  document.querySelector('#syncSchedulerLockText').textContent = syncLocked ? '已被环境变量强制停用' : '仅扫描到期上游，保存不会立即同步';
  document.querySelector('#keySchedulerLockText').textContent = keyLocked ? '已被环境变量强制停用' : '真实请求会产生极低但非零的消耗';
  document.querySelector('[data-runtime-setting="sync_enabled"]').disabled = syncLocked;
  document.querySelector('[data-runtime-setting="key_check_enabled"]').disabled = keyLocked;
  renderUpstreamPolicies();
  renderSystemUpdate();
  setSettingsTab(state.settingsTab);
}

function renderEmailSettings(force = false) {
  if (!state.monitoring.email) return;
  const settings = state.monitoring.email || {};
  document.querySelector('#emailSettingStatus').textContent = settings.configured
    ? `${settings.enabled ? '已启用' : '已停用'} · ${settings.host}:${settings.port} · ${settings.to.length} 个收件人`
    : '未配置';
  document.querySelector('#emailTestBtn').disabled = !settings.configured;
  document.querySelector('#emailClearBtn').disabled = !settings.configured;
  const form = document.querySelector('#emailForm');
  if (form.dataset.loaded && !force) return;
  form.reset();
  if (settings.configured) {
    for (const field of ['host', 'port', 'security', 'user', 'from', 'timeout_ms']) form.elements[field].value = settings[field];
    form.elements.to.value = settings.to.join(', ');
    form.elements.enabled.checked = settings.enabled;
  }
  form.elements.password.placeholder = settings.has_password ? '已保存，留空保留原值' : '首次配置请填写';
  form.dataset.loaded = 'true';
}

function setEmailFeedback(message, tone = '') {
  const element = document.querySelector('#emailFeedback');
  element.hidden = !message;
  element.textContent = message;
  element.className = `pushplus-test-feedback ${tone}`;
}

function renderSystemUpdate() {
  const update = state.systemUpdate || {};
  const operation = update.operation || {};
  const activePhases = new Set(['queued', 'checking', 'backup', 'code', 'testing', 'rollback', 'restarting']);
  const phaseLabels = {
    idle: '待检查', queued: '等待执行', checking: '检查中', backup: '备份中', code: '安装中',
    testing: '测试中', rollback: '回退中', restarting: '重启中', completed: '已完成', failed: '失败'
  };
  document.querySelector('#currentVersionText').textContent = update.current_version ? `v${update.current_version}` : '-';
  document.querySelector('#currentCommitText').textContent = update.current_commit || '-';
  document.querySelector('#latestVersionText').textContent = update.latest_version ? `v${update.latest_version}` : '-';
  document.querySelector('#latestCommitText').textContent = update.remote_commit || '-';
  document.querySelector('#systemUpdateMessage').textContent = operation.message || update.message || '版本状态不可用';
  document.querySelector('#updateStateText').textContent = phaseLabels[operation.phase] || (update.available ? '可更新' : '已是最新');
  document.querySelector('#updateTimeText').textContent = operation.updated_at ? timeText(operation.updated_at) : '';
  const error = document.querySelector('#updateErrorText');
  error.hidden = !operation.error;
  error.textContent = operation.error || '';
  const commits = document.querySelector('#updateCommitList');
  commits.hidden = !(update.commits || []).length;
  commits.innerHTML = (update.commits || []).map((item) => `<div class="update-commit-item"><code>${escapeHtml(item.commit)}</code><span>${escapeHtml(item.subject)}</span></div>`).join('');
  const applyButton = document.querySelector('#applySystemUpdateBtn');
  applyButton.disabled = !update.enabled || !update.available || activePhases.has(operation.phase);
  applyButton.innerHTML = activePhases.has(operation.phase)
    ? '<i data-lucide="loader-circle"></i>更新进行中'
    : '<i data-lucide="download"></i>安装更新';
}

function collectRuntimeSettings() {
  return Object.fromEntries([...document.querySelectorAll('[data-runtime-setting]')].map((input) => {
    const value = input.type === 'checkbox' ? input.checked : input.type === 'number' ? Number(input.value) : input.value;
    return [input.dataset.runtimeSetting, value];
  }));
}

function collectUpstreamPolicy(row) {
  return Object.fromEntries([...row.querySelectorAll('[data-policy-field]')].map((input) => {
    const value = input.type === 'checkbox' ? input.checked : Number(input.value);
    return [input.dataset.policyField, value];
  }));
}

function renderLogs() {
  const keyword = state.search.toLowerCase();
  document.querySelector('#syncLogList').innerHTML = state.logs.filter((item) => !keyword || `${item.upstream_name} ${item.summary} ${item.error_message}`.toLowerCase().includes(keyword)).map((item) => `<div class="event-item"><div class="event-main"><strong>${escapeHtml(item.upstream_name)} · ${item.status === 'success' ? '成功' : '失败'}</strong><small>${escapeHtml(item.summary || item.error_message || '无摘要')} · ${item.duration_ms || 0}ms · ${timeText(item.started_at)}</small></div><span class="status-dot ${item.status === 'success' ? 'healthy' : 'danger'}"></span></div>`).join('') || '<div class="empty-state">暂无同步日志</div>';
  document.querySelector('#rateChangeList').innerHTML = state.rateChanges.map((item) => `<div class="event-item"><div class="event-main"><strong>${escapeHtml(item.upstream_name)} · ${escapeHtml(item.group_name || item.group_id)}</strong><small>${rateText(item.old_rate)} → ${rateText(item.new_rate)} · ${timeText(item.detected_at)}</small></div>${item.acknowledged_at ? '<span class="status-pill healthy">已确认</span>' : `<button class="btn secondary" data-ack-rate="${item.id}">确认</button>`}</div>`).join('') || '<div class="empty-state">暂无倍率变化</div>';
}

function renderPushPlus() {
  const pushplus = state.monitoring.pushplus || {};
  const configured = Boolean(pushplus.configured);
  const source = pushplus.source;
  const badge = document.querySelector('#pushPlusBadge');
  badge.innerHTML = `<span class="status-dot ${configured ? 'healthy' : 'neutral'}"></span><span>PushPlus ${configured ? '已连接' : '未配置'}</span>`;
  const statusText = !configured
    ? '未配置'
    : source === 'database'
      ? `控制台配置 · ${Number(pushplus.target_count || 0)} 个目标`
      : '环境变量配置';
  document.querySelector('#pushPlusSettingStatus').textContent = statusText;
  const targets = pushplus.targets || [];
  const enabledCount = targets.filter((target) => target.enabled).length;
  const summary = document.querySelector('#pushPlusTargetSummary');
  summary.className = `status-pill ${enabledCount ? 'healthy' : 'neutral'}`;
  summary.innerHTML = `<span class="status-dot ${enabledCount ? 'healthy' : 'neutral'}"></span>${enabledCount ? `已启用 ${enabledCount} / ${targets.length} 个目标` : '暂无启用目标'}`;
  document.querySelector('#pushPlusEndpointText').textContent = pushplus.endpoint_host ? `接口：${pushplus.endpoint_host}` : '';
  const rows = document.querySelector('#pushPlusTargetRows');
  rows.innerHTML = targets.length
    ? targets.map((target) => {
      const managed = target.editable !== false;
      const detail = target.legacy
        ? '旧单 Token 配置，首次编辑会迁移到目标列表'
        : managed ? '接收全部告警' : '环境变量兜底；在部署配置中修改';
      const actions = managed
        ? `<button class="icon-btn" type="button" data-pushplus-test="${escapeHtml(target.id)}" title="测试此目标" aria-label="测试 ${escapeHtml(target.name)}"><i data-lucide="send"></i></button><button class="icon-btn" type="button" data-pushplus-edit="${escapeHtml(target.id)}" title="编辑目标" aria-label="编辑 ${escapeHtml(target.name)}"><i data-lucide="pencil"></i></button><button class="icon-btn" type="button" data-pushplus-toggle="${escapeHtml(target.id)}" data-next-enabled="${target.enabled ? 'false' : 'true'}" title="${target.enabled ? '停用' : '启用'}" aria-label="${target.enabled ? '停用' : '启用'} ${escapeHtml(target.name)}"><i data-lucide="${target.enabled ? 'pause' : 'play'}"></i></button><button class="icon-btn danger" type="button" data-pushplus-delete="${escapeHtml(target.id)}" title="删除目标" aria-label="删除 ${escapeHtml(target.name)}"><i data-lucide="trash-2"></i></button>`
        : '<span class="muted">环境变量</span>';
      return `<tr class="${target.enabled ? '' : 'is-disabled'}"><td><div class="cell-stack"><strong>${escapeHtml(target.name)}</strong><small>${detail}</small></div></td><td><code class="pushplus-token-mask">${escapeHtml(target.token_masked)}</code></td><td><span class="status-pill ${target.enabled ? 'healthy' : 'neutral'}"><span class="status-dot ${target.enabled ? 'healthy' : 'neutral'}"></span>${target.enabled ? '已启用' : '已停用'}</span></td><td class="align-right"><div class="row-actions">${actions}</div></td></tr>`;
    }).join('')
    : '<tr><td colspan="4"><div class="empty-state">还没有通知目标</div></td></tr>';
  const count = Number(state.monitoring.open_alerts || 0);
  const countEl = document.querySelector('#sidebarAlertCount');
  countEl.hidden = !count;
  countEl.textContent = count > 99 ? '99+' : count;
}

function setPushPlusFeedback(message = '', tone = '') {
  const feedback = document.querySelector('#pushPlusTestFeedback');
  feedback.hidden = !message;
  feedback.className = `pushplus-test-feedback ${tone}`.trim();
  feedback.textContent = message;
}

function setPushPlusSubmitButton(icon, label) {
  const submit = document.querySelector('#pushPlusForm button[type="submit"]');
  submit.innerHTML = `<i data-lucide="${icon}"></i><span>${label}</span>`;
}

function resetPushPlusEditor() {
  const form = document.querySelector('#pushPlusForm');
  form.reset();
  document.querySelector('#pushPlusTargetIdInput').value = '';
  document.querySelector('#pushPlusEnabledInput').checked = true;
  document.querySelector('#pushPlusEditorTitle').textContent = '添加通知目标';
  document.querySelector('#pushPlusEditorHint').textContent = '保存后，所有启用目标都会收到同一批告警。';
  document.querySelector('#pushPlusTokenLabel').textContent = 'PushPlus Token';
  document.querySelector('#pushPlusTokenInput').placeholder = '输入 PushPlus Token';
  setPushPlusSubmitButton('plus', '添加目标');
  document.querySelector('#pushPlusCancelEdit').hidden = true;
  setPushPlusFeedback();
  refreshIcons();
}

function openPushPlusEditor(id) {
  const target = (state.monitoring.pushplus?.targets || []).find((item) => item.id === id);
  if (!target) return;
  document.querySelector('#pushPlusTargetIdInput').value = target.id;
  document.querySelector('#pushPlusNameInput').value = target.name;
  document.querySelector('#pushPlusTokenInput').value = '';
  document.querySelector('#pushPlusEnabledInput').checked = Boolean(target.enabled);
  document.querySelector('#pushPlusEditorTitle').textContent = `编辑：${target.name}`;
  document.querySelector('#pushPlusEditorHint').textContent = 'Token 留空时会保留当前值。';
  document.querySelector('#pushPlusTokenLabel').textContent = '新的 PushPlus Token（可选）';
  document.querySelector('#pushPlusTokenInput').placeholder = '留空则不修改当前 Token';
  setPushPlusSubmitButton('save', '保存修改');
  document.querySelector('#pushPlusCancelEdit').hidden = false;
  setPushPlusFeedback();
  refreshIcons();
  document.querySelector('#pushPlusNameInput').focus();
}

function pushPlusDeliverySummary(result, targetName = '') {
  const failed = (result.results || []).filter((item) => !item.ok);
  if (!failed.length) return { message: targetName ? `${targetName} 测试推送已发送` : `已向 ${result.sent || 0} 个目标发送测试推送`, tone: 'success' };
  const details = failed.map((item) => `${item.name}：${item.error}`).join('；');
  return { message: `已发送 ${result.sent || 0} 个目标，${failed.length} 个失败。${details}`, tone: 'error' };
}

function renderCurrentView() {
  if (state.activeView === 'overview') renderOverview();
  if (state.activeView === 'monitoring') renderMonitoring();
  if (state.activeView === 'keys') renderGlobalKeys();
  if (state.activeView === 'own-sites') renderOwnSites();
  if (state.activeView === 'pricing') renderPricing();
  if (state.activeView === 'usage') renderUsage();
  if (state.activeView === 'alerts') renderAlerts();
  if (state.activeView === 'request-errors') renderRequestErrors();
  if (state.activeView === 'logs') renderLogs();
  if (state.activeView === 'settings') renderSettings();
  renderPushPlus();
  refreshIcons();
}

function localDateValue(date) {
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

function ensureUsageDates() {
  if (!state.usage.endDate) state.usage.endDate = localDateValue(new Date());
  if (!state.usage.startDate) {
    const start = new Date();
    start.setDate(start.getDate() - 7);
    state.usage.startDate = localDateValue(start);
  }
}

function usageSite() {
  return (state.monitoring.items || []).find((site) => String(site.id) === String(state.usage.upstreamId));
}

function renderUsageFilters() {
  ensureUsageDates();
  const sites = (state.monitoring.items || []).filter((site) => site.status !== 'disabled');
  if (!state.usage.upstreamId && sites.length) state.usage.upstreamId = String(sites[0].id);
  const upstream = document.querySelector('#usageUpstreamFilter');
  upstream.innerHTML = sites.map((site) => `<option value="${site.id}">${escapeHtml(site.name)}</option>`).join('') || '<option value="">没有可用上游</option>';
  upstream.value = state.usage.upstreamId;
  document.querySelector('#usageStartDate').value = state.usage.startDate;
  document.querySelector('#usageEndDate').value = state.usage.endDate;
  const site = usageSite();
  const keys = (site?.keys || []).filter((key) => key.import_state !== 'missing');
  const keyValue = document.querySelector('#usageKeyFilter').value;
  document.querySelector('#usageKeyFilter').innerHTML = '<option value="">全部 Key</option>' + keys.map((key) => `<option value="${escapeHtml(key.upstream_key_id)}">${escapeHtml(key.name || key.key_masked || key.upstream_key_id)}</option>`).join('');
  document.querySelector('#usageKeyFilter').value = keyValue;
  const groups = [...new Map(keys.filter((key) => key.group_id != null).map((key) => [String(key.group_id), key])).values()];
  const groupValue = document.querySelector('#usageGroupFilter').value;
  document.querySelector('#usageGroupFilter').innerHTML = '<option value="">全部分组</option>' + groups.map((key) => `<option value="${escapeHtml(key.group_id)}">${escapeHtml(key.group_name || key.group_id)}</option>`).join('');
  document.querySelector('#usageGroupFilter').value = groupValue;
}

function renderUsage() {
  renderUsageFilters();
  const keyword = state.search.toLowerCase();
  const rows = state.usage.items.filter((item) => !keyword || `${item.key_name} ${item.key_masked} ${item.group_name} ${item.model} ${item.inbound_endpoint}`.toLowerCase().includes(keyword));
  const body = state.usage.loading
    ? '<tr><td colspan="8"><div class="empty-state">正在读取上游使用记录...</div></td></tr>'
    : state.usage.error
      ? `<tr><td colspan="8"><div class="empty-state danger-text">${escapeHtml(state.usage.error)}</div></td></tr>`
      : rows.map((item) => `<tr class="data-row"><td><div class="cell-stack"><span>${timeText(item.created_at)}</span><small>${escapeHtml(item.request_type || (item.stream ? 'stream' : 'sync'))}</small></div></td><td><div class="cell-stack"><strong>${escapeHtml(item.key_name || item.key_masked || '-')}</strong><small>${escapeHtml(item.group_name || '-')}</small></div></td><td><div class="cell-stack"><strong>${escapeHtml(item.model || '-')}</strong><small>${escapeHtml(item.inbound_endpoint || '-')}</small></div></td><td><div class="usage-token-cell"><span>入 ${tokenText(item.input_tokens)}</span><small>出 ${tokenText(item.output_tokens)} · 缓存 ${tokenText(item.cache_read_tokens)}</small></div></td><td class="numeric">$${numberText(item.actual_cost, '0')}</td><td class="numeric">${rateText(item.rate_multiplier)}</td><td class="numeric">${item.duration_ms == null ? '-' : `${numberText(item.duration_ms)} ms`}</td><td class="align-right"><button class="icon-btn" type="button" data-usage-detail="${escapeHtml(item.id)}" title="查看请求详情"><i data-lucide="panel-right-open"></i></button></td></tr>`).join('') || '<tr><td colspan="8"><div class="empty-state">该条件下没有使用记录</div></td></tr>';
  document.querySelector('#usageRows').innerHTML = body;
  document.querySelector('#usagePageSummary').textContent = `第 ${state.usage.page} / ${Math.max(1, state.usage.pages)} 页 · 共 ${integers.format(state.usage.total)} 条`;
  document.querySelector('#usagePrevBtn').disabled = state.usage.loading || state.usage.page <= 1;
  document.querySelector('#usageNextBtn').disabled = state.usage.loading || state.usage.page >= state.usage.pages;
}

function usageQueryString() {
  const params = new URLSearchParams({ page: String(state.usage.page), page_size: String(state.usage.pageSize) });
  const fields = {
    start_date: document.querySelector('#usageStartDate').value,
    end_date: document.querySelector('#usageEndDate').value,
    api_key_id: document.querySelector('#usageKeyFilter').value,
    group_id: document.querySelector('#usageGroupFilter').value,
    model: document.querySelector('#usageModelFilter').value.trim(),
    request_type: document.querySelector('#usageTypeFilter').value
  };
  Object.entries(fields).forEach(([key, value]) => { if (value) params.set(key, value); });
  return params.toString();
}

async function loadUsage() {
  if (!state.usage.upstreamId) return renderUsage();
  state.usage.loading = true;
  state.usage.error = '';
  renderUsage();
  try {
    const result = await api(`/api/upstreams/${state.usage.upstreamId}/usage?${usageQueryString()}`);
    state.usage.items = result.items || [];
    state.usage.total = Number(result.total || 0);
    state.usage.page = Number(result.page || state.usage.page);
    state.usage.pages = Number(result.pages || 1);
  } catch (error) {
    state.usage.items = [];
    state.usage.total = 0;
    state.usage.pages = 1;
    state.usage.error = error.message;
  } finally {
    state.usage.loading = false;
    renderUsage();
    refreshIcons();
  }
}

function showUsageDetail(item, upstreamName = '') {
  document.querySelector('#usageDetailSubtitle').textContent = `${upstreamName} · ${item.created_at ? new Date(item.created_at).toLocaleString('zh-CN', { hour12: false }) : ''}`;
  document.querySelector('#usageDetailContent').innerHTML = `<div class="detail-block"><h3>请求</h3><div class="detail-list"><div class="detail-line"><span>请求 ID</span><strong>${escapeHtml(item.request_id || '-')}</strong></div><div class="detail-line"><span>模型</span><strong>${escapeHtml(item.model || '-')}</strong></div><div class="detail-line"><span>入口</span><strong>${escapeHtml(item.inbound_endpoint || '-')}</strong></div><div class="detail-line"><span>类型</span><strong>${escapeHtml(item.request_type || (item.stream ? 'stream' : 'sync'))}</strong></div><div class="detail-line"><span>Key</span><strong>${escapeHtml(item.key_name || item.key_masked || '-')}</strong></div><div class="detail-line"><span>分组</span><strong>${escapeHtml(item.group_name || '-')}</strong></div></div></div><div class="detail-block"><h3>计费与性能</h3><div class="detail-list"><div class="detail-line"><span>输入 / 输出 Token</span><strong>${tokenText(item.input_tokens)} / ${tokenText(item.output_tokens)}</strong></div><div class="detail-line"><span>缓存读取 / 创建</span><strong>${tokenText(item.cache_read_tokens)} / ${tokenText(item.cache_creation_tokens)}</strong></div><div class="detail-line"><span>实际费用</span><strong>$${numberText(item.actual_cost, '0')}</strong></div><div class="detail-line"><span>倍率</span><strong>${rateText(item.rate_multiplier)}</strong></div><div class="detail-line"><span>总耗时 / 首 Token</span><strong>${numberText(item.duration_ms)} ms / ${numberText(item.first_token_ms)} ms</strong></div></div></div><div class="detail-block"><h3>客户端</h3><div class="detail-list"><div class="detail-line"><span>IP</span><strong>${escapeHtml(item.ip_address || '-')}</strong></div><div class="detail-line"><span>User-Agent</span><strong>${escapeHtml(item.user_agent || '-')}</strong></div></div></div>`;
  if (!document.querySelector('#usageDetailDialog').open) document.querySelector('#usageDetailDialog').showModal();
  refreshIcons();
}

async function openUsageDetail(usageId) {
  const cached = state.usage.items.find((item) => String(item.id) === String(usageId));
  if (cached) return showUsageDetail(cached, usageSite()?.name || '');
  setBusy(true);
  try {
    const result = await api(`/api/upstreams/${state.usage.upstreamId}/usage/${encodeURIComponent(usageId)}`);
    showUsageDetail(result.item || {}, result.upstream?.name || '');
  } finally { setBusy(false); }
}

async function refreshAll({ quiet = false } = {}) {
  if (!quiet) setBusy(true);
  try {
    const [monitoring, consumption, alerts, logs, rateChanges, pricing, groupRates, ownSites, ownRoutes, runtimeSettings, systemUpdate] = await Promise.all([
      api('/api/monitoring/upstreams'),
      api(`/api/monitoring/consumption?period=${encodeURIComponent(state.consumption.period)}`).catch((error) => ({ items: [], total_consumption: 0, error: error.message })),
      api('/api/alerts'),
      api('/api/sync-logs'),
      api('/api/rate-changes'),
      api('/api/model-pricing/board').catch(() => ({ openai: [], claude: [] })),
      api('/api/group-rates/board').catch(() => ({ items: [] })),
      api('/api/own-sites').catch(() => ({ items: [] })),
      api('/api/own-site-routes').catch(() => ({ items: [] })),
      api('/api/settings/runtime'),
      api('/api/system/update').catch(() => ({ enabled: false, message: '版本状态读取失败', operation: { phase: 'failed' } }))
    ]);
    state.monitoring = monitoring;
    state.consumption = { ...state.consumption, ...consumption, loading: false, error: consumption.error || '' };
    state.alerts = alerts.items || [];
    state.logs = logs.items || [];
    state.rateChanges = rateChanges.items || [];
    state.pricing = pricing;
    state.groupRates = groupRates.items || [];
    state.ownSites = ownSites.items || [];
    state.ownRoutes = ownRoutes.items || [];
    state.runtimeSettings = runtimeSettings;
    state.systemUpdate = systemUpdate;
    renderOverview();
    renderMonitoring();
    renderGlobalKeys();
    renderOwnSites();
    renderPricing();
    renderAlerts();
    renderLogs();
    renderPushPlus();
    renderSettings();
    renderCurrentView();
    if (state.activeView === 'usage' && !state.usage.loading && !state.usage.items.length) {
      window.queueMicrotask(loadUsage);
    }
    loadRequestErrors().catch(() => {});
  } finally {
    setBusy(false);
  }
}

function upstreamPayload(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  return {
    ...data,
    low_balance_threshold: Number(data.low_balance_threshold || 10),
    rate_change_threshold_percent: Number(data.rate_change_threshold_percent || 20),
    sync_interval_seconds: Number(data.sync_interval_seconds || 180),
    key_check_interval_seconds: Number(data.key_check_interval_seconds || 300),
    tags: String(data.tags || '').split(',').map((item) => item.trim()).filter(Boolean)
  };
}

function fillUpstreamForm(detail = null) {
  const form = document.querySelector('#upstreamForm');
  form.reset();
  const site = detail?.site || {};
  const credentials = detail?.credentials || {};
  form.id.value = site.id || '';
  form.name.value = site.name || '';
  form.base_url.value = site.base_url || '';
  form.upstream_type.value = site.upstream_type || 'auto';
  form.auth_mode.value = site.auth_mode || 'password';
  form.email.value = credentials.email && !credentials.email.includes('*') ? credentials.email : '';
  form.password.value = '';
  form.token.value = '';
  if (form.refresh_token) form.refresh_token.value = '';
  form.low_balance_threshold.value = site.low_balance_threshold ?? 10;
  form.rate_change_threshold_percent.value = site.rate_change_threshold_percent ?? 20;
  form.sync_interval_seconds.value = site.sync_interval_seconds ?? 180;
  form.key_check_interval_seconds.value = site.key_check_interval_seconds ?? 300;
  form.openai_probe_model.value = site.openai_probe_model || '';
  form.anthropic_probe_model.value = site.anthropic_probe_model || '';
  form.tags.value = (site.tags || []).join(',');
  form.notes.value = site.notes || '';
  document.querySelector('#upstreamDialogTitle').textContent = site.id ? '编辑上游' : '新增上游';
  document.querySelector('#upstreamFormMessage').textContent = '';
  document.querySelector('#probeModelSection').hidden = !site.id;
  document.querySelector('#probeModelGroups').innerHTML = site.id ? '<div class="empty-state">加载中...</div>' : '';
}

function probeSourceText(item) {
  if (item.discovery_status === 'pricing') return '模型广场';
  if (item.discovery_status === 'live') return '模型接口';
  if (item.discovery_status === 'usage') return '近期使用记录';
  if (item.discovery_status === 'manual_only') return '手动配置';
  if (item.discovery_status === 'stale') return '保留上次缓存';
  return '未发现模型';
}

function renderProbeModels(items = []) {
  const container = document.querySelector('#probeModelGroups');
  container.innerHTML = items.map((item, index) => {
    const listId = `probe-model-options-${index}`;
    const options = (item.models || []).map((model) => `<option value="${escapeHtml(model.model)}"></option>`).join('');
    return `<div class="probe-model-row"><div class="probe-model-meta"><strong>${escapeHtml(item.group_name || item.group_id)}</strong><small>${escapeHtml(platformLabel(item.platform))}${item.discovery_error ? ` · ${escapeHtml(item.discovery_error)}` : ''}</small></div><div><input value="${escapeHtml(item.selected_model || '')}" list="${listId}" data-probe-model-group="${escapeHtml(item.group_id)}" data-group-name="${escapeHtml(item.group_name || '')}" data-platform="${escapeHtml(item.platform || '')}" placeholder="选择或输入检测模型" /><datalist id="${listId}">${options}</datalist></div><span class="probe-model-source">${probeSourceText(item)} · ${(item.models || []).length} 个</span></div>`;
  }).join('') || '<div class="empty-state">尚未同步分组模型</div>';
}

async function loadProbeModels(siteId) {
  if (!siteId) return;
  const result = await api(`/api/upstreams/${siteId}/models`);
  renderProbeModels(result.items || []);
}

async function openUpstreamDialog(siteId = null) {
  setBusy(true);
  try {
    const detail = siteId ? await api(`/api/upstreams/${siteId}`) : null;
    fillUpstreamForm(detail);
    if (siteId) await loadProbeModels(siteId);
    document.querySelector('#upstreamDialog').showModal();
    refreshIcons();
  } finally { setBusy(false); }
}

async function openDetail(siteId) {
  setBusy(true);
  try {
    const detail = await api(`/api/upstreams/${siteId}`);
    const site = detail.site;
    const snapshot = detail.snapshot || {};
    document.querySelector('#detailTitle').textContent = site.name;
    const username = typeof snapshot.username === 'string' ? snapshot.username.trim() : '';
    document.querySelector('#detailSubtitle').innerHTML = `<a class="detail-site-link" href="${escapeHtml(site.base_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(site.base_url)}<i data-lucide="external-link"></i></a>${username ? `<span class="detail-username"><i data-lucide="user"></i>${escapeHtml(username)}</span>` : ''}`;
    const methods = Array.isArray(snapshot.payment_methods) ? snapshot.payment_methods.filter((item) => item?.available !== false) : [];
    document.querySelector('#detailContent').innerHTML = `
      <div class="detail-metrics"><div class="detail-metric"><span>余额</span><strong>${finiteNumberOrNull(snapshot.balance) === null ? '-' : `$${numberText(snapshot.balance)}`}</strong></div><div class="detail-metric"><span>今日 Token</span><strong>${tokenText(snapshot.today_tokens)}</strong></div><div class="detail-metric"><span>今日成本</span><strong>$${numberText(snapshot.today_cost)}</strong></div><div class="detail-metric"><span>OpenAI 倍率</span><strong>${rateText(snapshot.openai_rate)}</strong></div><div class="detail-metric"><span>Anthropic 倍率</span><strong>${rateText(snapshot.anthropic_rate)}</strong></div><div class="detail-metric"><span>Key</span><strong>${snapshot.key_count || 0}</strong></div></div>
      <div class="detail-block"><div class="button-group"><button class="btn secondary" data-edit-from-detail="${site.id}"><i data-lucide="pencil"></i>编辑上游</button><button class="btn secondary" data-toggle-upstream="${site.id}" data-next-status="${site.status === 'disabled' ? 'active' : 'disabled'}"><i data-lucide="${site.status === 'disabled' ? 'play' : 'pause'}"></i>${site.status === 'disabled' ? '启用上游' : '停用上游'}</button><button class="btn secondary" data-import-keys="${site.id}"><i data-lucide="download"></i>导入 Key</button><button class="btn primary" data-check-site-keys="${site.id}"><i data-lucide="activity"></i>检测 Key</button></div></div>
      <div class="detail-block danger-zone"><h3>永久删除</h3><p class="muted">会删除该上游的本地凭据、快照、Key、倍率历史、同步日志和告警，不能从控制台撤销。</p><button class="btn danger-outline" data-delete-upstream="${site.id}" data-upstream-name="${escapeHtml(site.name)}"><i data-lucide="trash-2"></i>永久删除上游</button></div>
      <div class="detail-block"><h3>能力状态</h3><div class="detail-list">${Object.entries(detail.capabilities || {}).filter(([key]) => key !== 'errors').map(([key, value]) => `<div class="detail-line"><span>${escapeHtml(key)}</span><strong class="${value ? 'healthy-text' : 'muted'}">${value ? '可用' : '不可用'}</strong></div>`).join('')}</div></div>
      <div class="detail-block"><h3>分组倍率</h3><div class="detail-list">${(detail.rates || []).slice(0, 20).map((rate) => `<div class="detail-line"><span>${escapeHtml(rate.group_name || rate.group_id)}</span><strong>${rateText(rate.rate)}</strong></div>`).join('') || '<div class="empty-state">暂无倍率</div>'}</div></div>
      ${snapshot.payment_enabled && methods.length ? `<div class="detail-block"><h3>上游充值</h3><div class="form-grid"><label><span>充值金额</span><input id="detailRechargeAmount" type="number" min="1" value="10" /></label><label><span>支付方式</span><select id="detailRechargeMethod">${methods.map((item) => `<option value="${escapeHtml(item.type)}">${escapeHtml(item.name || item.type)}</option>`).join('')}</select></label></div><div class="modal-actions"><button class="btn primary" data-create-recharge="${site.id}">创建充值订单</button></div><div id="detailRechargeResult"></div></div>` : ''}
      <div class="detail-block"><h3>最近同步</h3><div class="event-list dense">${(detail.logs || []).slice(0, 12).map((log) => `<div class="event-item"><div class="event-main"><strong>${log.status === 'success' ? '成功' : '失败'}</strong><small>${escapeHtml(log.summary || log.error_message || '')} · ${timeText(log.started_at)}</small></div><span class="status-dot ${log.status === 'success' ? 'healthy' : 'danger'}"></span></div>`).join('')}</div></div>`;
    document.querySelector('#detailDialog').showModal();
    refreshIcons();
  } finally { setBusy(false); }
}

async function openCreateKey(preselectedSiteId = '') {
  const select = document.querySelector('#createKeyUpstream');
  select.innerHTML = (state.monitoring.items || []).filter((site) => site.status !== 'disabled').map((site) => `<option value="${site.id}">${escapeHtml(site.name)}</option>`).join('');
  if (preselectedSiteId) select.value = String(preselectedSiteId);
  document.querySelector('#createKeyForm').reset();
  if (preselectedSiteId) select.value = String(preselectedSiteId);
  await loadCreateKeyGroups();
  document.querySelector('#createKeyDialog').showModal();
  refreshIcons();
}

async function loadCreateKeyGroups() {
  const siteId = document.querySelector('#createKeyUpstream').value;
  const platform = document.querySelector('#createKeyPlatform').value;
  const groupSelect = document.querySelector('#createKeyGroup');
  if (!siteId) { groupSelect.innerHTML = '<option value="">请先选择上游</option>'; return; }
  groupSelect.innerHTML = '<option value="">加载中...</option>';
  try {
    const result = await api(`/api/upstreams/${siteId}/key-groups${platform ? `?platform=${encodeURIComponent(platform)}` : ''}`);
    groupSelect.innerHTML = (result.items || []).map((group) => `<option value="${group.id}">${escapeHtml(group.name)} · ${escapeHtml(platformLabel(group.platform))} · ${rateText(group.group_rate)}</option>`).join('') || '<option value="">没有可用分组</option>';
  } catch (error) {
    groupSelect.innerHTML = '<option value="">加载失败</option>';
    document.querySelector('#createKeyMessage').textContent = error.message;
  }
}

function fillOwnSiteForm(detail = null) {
  const form = document.querySelector('#ownSiteForm');
  form.reset();
  const site = detail?.site || {};
  const credentials = detail?.credentials || {};
  form.id.value = site.id || '';
  form.name.value = site.name || '';
  form.base_url.value = site.base_url || '';
  form.own_site_type.value = site.own_site_type || 'auto';
  form.auth_mode.value = site.auth_mode || 'token';
  form.email.value = credentials.email && !credentials.email.includes('*') ? credentials.email : '';
  form.password.value = '';
  form.token.value = '';
  form.notes.value = site.notes || '';
  document.querySelector('#ownSiteDialogTitle').textContent = site.id ? '编辑自己站' : '新增自己站';
}

async function openOwnSite(siteId = null) {
  setBusy(true);
  try {
    fillOwnSiteForm(siteId ? await api(`/api/own-sites/${siteId}`) : null);
    document.querySelector('#ownSiteDialog').showModal();
    refreshIcons();
  } finally { setBusy(false); }
}

function openRouteBinding(ownSiteId, routeId) {
  const form = document.querySelector('#bindRouteForm');
  form.own_site_id.value = ownSiteId;
  form.route_id.value = routeId;
  const options = allKeys().map((key) => `<option value="${key.upstream_site_id}::${escapeHtml(key.upstream_key_id)}">${escapeHtml(key.upstream_name)} · ${escapeHtml(key.name || key.key_masked)} · ${escapeHtml(key.group_name || '-')} · ${rateText(key.group_rate)}</option>`).join('');
  document.querySelector('#routeBindingSelect').innerHTML = options || '<option value="">请先导入上游 Key</option>';
  document.querySelector('#bindRouteDialog').showModal();
  refreshIcons();
}

async function runAction(button, busyLabel, task) {
  const original = button.innerHTML;
  button.disabled = true;
  button.textContent = busyLabel;
  try { await task(); } catch (error) { toast(error.message, 'error'); } finally { button.disabled = false; button.innerHTML = original; refreshIcons(); }
}

async function monitorSystemUpdate() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 2000));
    try {
      state.systemUpdate = await api('/api/system/update');
      renderSystemUpdate();
      refreshIcons();
      const phase = state.systemUpdate.operation?.phase;
      if (phase === 'completed') {
        window.location.reload();
        return;
      }
      if (phase === 'failed') {
        toast(state.systemUpdate.operation?.message || '更新失败', 'error');
        return;
      }
    } catch {
      // A short connection failure is expected while the process supervisor restarts the service.
    }
  }
  toast('等待服务重启超时，请检查服务器进程状态', 'error');
}

document.querySelector('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = document.querySelector('#loginMessage');
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ password: event.currentTarget.password.value }) });
    message.textContent = '';
    showApp();
    await refreshAll();
  } catch (error) { message.textContent = error.message; message.className = 'form-message error'; }
});

document.querySelectorAll('[data-view-target]').forEach((button) => button.addEventListener('click', () => setActiveView(button.dataset.viewTarget)));
document.querySelectorAll('[data-view-link]').forEach((button) => button.addEventListener('click', () => setActiveView(button.dataset.viewLink)));
document.querySelector('#mobileMenuBtn').addEventListener('click', () => document.querySelector('#sidebar').classList.add('open'));
document.querySelector('#sidebarCloseBtn').addEventListener('click', () => document.querySelector('#sidebar').classList.remove('open'));
document.querySelector('#sidebarCollapseBtn').addEventListener('click', () => document.body.classList.toggle('sidebar-collapsed'));

document.querySelector('#globalSearchInput').addEventListener('input', (event) => { state.search = event.target.value; renderCurrentView(); });
document.querySelector('#monitorSortSelect').addEventListener('change', (event) => { state.monitorSort = event.target.value; renderMonitoring(); refreshIcons(); });
document.querySelector('#keyUpstreamFilter').addEventListener('change', (event) => { state.keyFilters.upstream = event.target.value; renderGlobalKeys(); refreshIcons(); });
document.querySelector('#keyPlatformFilter').addEventListener('change', (event) => { state.keyFilters.platform = event.target.value; renderGlobalKeys(); refreshIcons(); });
document.querySelector('#keyHealthFilter').addEventListener('change', (event) => { state.keyFilters.health = event.target.value; renderGlobalKeys(); refreshIcons(); });
document.querySelector('#usageUpstreamFilter').addEventListener('change', (event) => { state.usage.upstreamId = event.target.value; state.usage.page = 1; renderUsageFilters(); loadUsage(); });
document.querySelector('#usageApplyBtn').addEventListener('click', () => { state.usage.page = 1; state.usage.startDate = document.querySelector('#usageStartDate').value; state.usage.endDate = document.querySelector('#usageEndDate').value; loadUsage(); });
document.querySelector('#usageRefreshBtn').addEventListener('click', loadUsage);
document.querySelector('#usagePrevBtn').addEventListener('click', () => { if (state.usage.page > 1) { state.usage.page -= 1; loadUsage(); } });
document.querySelector('#usageNextBtn').addEventListener('click', () => { if (state.usage.page < state.usage.pages) { state.usage.page += 1; loadUsage(); } });
document.querySelector('#alertStatusFilter').addEventListener('change', (event) => { state.alertStatus = event.target.value; renderAlerts(); });
document.querySelectorAll('[data-settings-tab]').forEach((button) => button.addEventListener('click', () => setSettingsTab(button.dataset.settingsTab)));
document.querySelector('#createKeyUpstream').addEventListener('change', loadCreateKeyGroups);
document.querySelector('#createKeyPlatform').addEventListener('change', loadCreateKeyGroups);

document.querySelector('#refreshBtn').addEventListener('click', (event) => runAction(event.currentTarget, '刷新中', async () => { await refreshAll({ quiet: true }); toast('数据已刷新', 'success'); }));
document.querySelector('#syncAllBtn').addEventListener('click', (event) => runAction(event.currentTarget, '同步中', async () => { await api('/api/sync-all', { method: 'POST' }); await refreshAll({ quiet: true }); toast('全部上游同步完成', 'success'); }));
async function syncAllUpstreamModels(button) {
  const sites = state.monitoring.items || [];
  if (!sites.length) throw new Error('当前没有可同步的上游');
  let completed = 0;
  const failed = [];
  for (const site of sites) {
    button.textContent = `同步中 ${completed + 1}/${sites.length}`;
    try {
      await api(`/api/upstreams/${site.id}/models/sync`, { method: 'POST' });
    } catch (error) {
      failed.push(`${site.name}: ${error.message}`);
    }
    completed += 1;
  }
  await refreshAll({ quiet: true });
  if (failed.length) throw new Error(`已完成 ${sites.length - failed.length} 个上游，${failed.length} 个失败：${failed.join('；')}`);
  toast(`已同步 ${sites.length} 个上游的支持模型`, 'success');
}

for (const selector of ['#syncAllModelsBtn', '#syncAllModelsTopBtn']) {
  document.querySelector(selector).addEventListener('click', (event) => runAction(event.currentTarget, '同步中', () => syncAllUpstreamModels(event.currentTarget)));
}

document.querySelector('#consolePasswordForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.querySelector('#consolePasswordMessage');
  const currentPassword = form.current_password.value;
  const newPassword = form.new_password.value;
  const confirmPassword = form.confirm_password.value;
  message.className = 'form-message';
  if (newPassword !== confirmPassword) {
    message.textContent = '两次输入的新密码不一致';
    message.className = 'form-message error';
    return;
  }
  try {
    await api('/api/account/password', {
      method: 'POST',
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword })
    });
    form.reset();
    message.textContent = '密码已更新';
    message.className = 'form-message success';
    toast('控制台密码已更新', 'success');
  } catch (error) {
    message.textContent = error.message;
    message.className = 'form-message error';
    toast(error.message, 'error');
  }
});

document.querySelector('#runtimeSettingsSaveBtn').addEventListener('click', async (event) => {
  const next = collectRuntimeSettings();
  const current = state.runtimeSettings.settings || {};
  const increasesProbeActivity = next.key_check_enabled && (
    !current.key_check_enabled
    || Number(next.key_check_default_interval_seconds) < Number(current.key_check_default_interval_seconds)
    || Number(next.key_scheduler_scan_seconds) < Number(current.key_scheduler_scan_seconds)
    || Number(next.key_check_concurrency) > Number(current.key_check_concurrency)
  );
  if (increasesProbeActivity && !confirm('这些设置可能增加真实模型探测频率和消耗，确定保存？')) return;
  await runAction(event.currentTarget, '保存中', async () => {
    state.runtimeSettings = await api('/api/settings/runtime', { method: 'PUT', body: JSON.stringify(next) });
    renderSettings();
    toast('运行设置已保存，无需重启', 'success');
  });
});

document.querySelector('#acknowledgeVisibleAlertsBtn').addEventListener('click', async (event) => {
  const ids = filteredAlerts().filter((item) => alertStage(item) === 'pending').map((item) => item.id);
  if (!ids.length) return;
  if (!confirm(`确定将当前 ${ids.length} 条告警标记为已处理？`)) return;
  await runAction(event.currentTarget, '处理中', async () => {
    await api('/api/alerts/acknowledge-all', { method: 'POST', body: JSON.stringify({ ids }) });
    await refreshAll({ quiet: true });
    toast(`已处理 ${ids.length} 条告警`, 'success');
  });
  renderAlerts();
  refreshIcons();
});

document.querySelector('#emailForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = Object.fromEntries(new FormData(form));
  payload.enabled = form.elements.enabled.checked;
  payload.port = Number(payload.port);
  payload.timeout_ms = Number(payload.timeout_ms);
  payload.to = payload.to.split(/[,;，；\s]+/).map((value) => value.trim()).filter(Boolean);
  if (!payload.password) delete payload.password;
  await runAction(form.querySelector('button[type="submit"]'), '保存中', async () => {
    try {
      state.monitoring.email = await api('/api/notifications/email/settings', { method: 'PUT', body: JSON.stringify(payload) });
      renderEmailSettings(true);
      setEmailFeedback('邮箱配置已保存。点击“测试已保存配置”检查收件情况。', 'success');
    } catch (error) { setEmailFeedback(error.message, 'error'); throw error; }
  });
});

document.querySelector('#emailTestBtn').addEventListener('click', async (event) => {
  await runAction(event.currentTarget, '发送中', async () => {
    try {
      const result = await api('/api/notifications/email/test', { method: 'POST' });
      setEmailFeedback(result.message, 'success');
    } catch (error) { setEmailFeedback(error.message, 'error'); throw error; }
  });
});

document.querySelector('#emailClearBtn').addEventListener('click', async (event) => {
  if (!confirm('确定清空 SMTP 配置并停止邮箱提醒？')) return;
  await runAction(event.currentTarget, '清空中', async () => {
    state.monitoring.email = await api('/api/notifications/email/settings', { method: 'DELETE' });
    renderEmailSettings(true);
    setEmailFeedback('邮箱配置已清空');
  });
});

document.querySelector('#pushPlusForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const targetId = document.querySelector('#pushPlusTargetIdInput').value;
  const tokenInput = document.querySelector('#pushPlusTokenInput');
  const nameInput = document.querySelector('#pushPlusNameInput');
  const enabledInput = document.querySelector('#pushPlusEnabledInput');
  const token = tokenInput.value.trim();
  const name = nameInput.value.trim();
  if (!name) return toast('请输入目标名称', 'error');
  if (!targetId && !token) return toast('请输入 PushPlus Token', 'error');
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  await runAction(submit, '保存中', async () => {
    const payload = { name, enabled: enabledInput.checked };
    if (token) payload.token = token;
    await api(
      targetId ? `/api/notifications/pushplus/targets/${encodeURIComponent(targetId)}` : '/api/notifications/pushplus/targets',
      { method: targetId ? 'PATCH' : 'POST', body: JSON.stringify(payload) }
    );
    resetPushPlusEditor();
    await refreshAll({ quiet: true });
    toast(targetId ? '通知目标已更新' : '通知目标已添加', 'success');
  });
});

document.querySelector('#upstreamForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = upstreamPayload(form);
  const id = payload.id;
  delete payload.id;
  setBusy(true);
  try {
    await api(id ? `/api/upstreams/${id}` : '/api/upstreams', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    closeDialog('upstreamDialog');
    await refreshAll({ quiet: true });
    toast(id ? '上游已更新' : '上游已创建', 'success');
  } catch (error) { document.querySelector('#upstreamFormMessage').textContent = error.message; document.querySelector('#upstreamFormMessage').className = 'form-message error'; } finally { setBusy(false); }
});

document.querySelector('#testUpstreamBtn').addEventListener('click', async (event) => runAction(event.currentTarget, '测试中', async () => {
  const payload = upstreamPayload(document.querySelector('#upstreamForm'));
  delete payload.id;
  const result = await api('/api/upstreams/test', { method: 'POST', body: JSON.stringify(payload) });
  document.querySelector('#upstreamFormMessage').textContent = `连接成功 · 余额 ${numberText(result.snapshot?.balance)} · Key ${result.keys_count || 0}`;
  document.querySelector('#upstreamFormMessage').className = 'form-message success';
}));

document.querySelector('#syncProbeModelsBtn').addEventListener('click', async (event) => runAction(event.currentTarget, '同步中', async () => {
  const siteId = document.querySelector('#upstreamForm').elements.id.value;
  if (!siteId) throw new Error('请先保存上游');
  const result = await api(`/api/upstreams/${siteId}/models/sync`, { method: 'POST' });
  renderProbeModels(result.items || []);
  toast(`模型同步完成：模型广场 ${result.pricing_groups || 0}，接口 ${result.live_groups}，使用记录 ${result.fallback_groups}，保留缓存 ${result.stale_groups || 0}`, 'success');
}));

document.querySelector('#probeModelGroups').addEventListener('change', async (event) => {
  const input = event.target.closest('[data-probe-model-group]');
  if (!input) return;
  const siteId = document.querySelector('#upstreamForm').elements.id.value;
  try {
    await api(`/api/upstreams/${siteId}/models/groups/${encodeURIComponent(input.dataset.probeModelGroup)}`, {
      method: 'PUT',
      body: JSON.stringify({
        selected_model: input.value.trim(),
        group_name: input.dataset.groupName,
        platform: input.dataset.platform
      })
    });
    toast('分组检测模型已保存', 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
});

document.addEventListener('change', async (event) => {
  const schedule = event.target.closest('[data-key-probe-schedule]');
  if (schedule) {
    schedule.disabled = true;
    try {
      await api(`/api/upstreams/${schedule.dataset.siteId}/keys/${encodeURIComponent(schedule.dataset.keyProbeSchedule)}/probe-schedule`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: schedule.checked })
      });
      await refreshAll({ quiet: true });
      toast(schedule.checked ? '已开启该 Key 定时联通测试' : '已关闭该 Key 定时联通测试', 'success');
    } catch (error) {
      schedule.checked = !schedule.checked;
      schedule.disabled = false;
      toast(error.message, 'error');
    }
    return;
  }
  const select = event.target.closest('[data-key-probe-model]');
  if (!select) return;
  const previous = select.dataset.previousModel || '';
  select.disabled = true;
  try {
    await api(`/api/upstreams/${select.dataset.siteId}/keys/${encodeURIComponent(select.dataset.keyProbeModel)}/probe-model`, {
      method: 'PUT',
      body: JSON.stringify({ selected_model: select.value })
    });
    await refreshAll({ quiet: true });
    toast(select.value ? 'Key 检测模型已保存' : 'Key 已改为跟随分组', 'success');
  } catch (error) {
    select.value = previous;
    select.disabled = false;
    toast(error.message, 'error');
  }
});

document.querySelector('#createKeyForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget).entries());
  const siteId = data.upstream_site_id;
  const payload = { name: data.name, group_id: Number(data.group_id) };
  if (data.quota) payload.quota = Number(data.quota);
  if (data.expires_in_days) payload.expires_in_days = Number(data.expires_in_days);
  setBusy(true);
  try {
    const result = await api(`/api/upstreams/${siteId}/keys`, { method: 'POST', body: JSON.stringify(payload) });
    state.createdKey = result.key;
    document.querySelector('#createdKeyValue').textContent = result.key;
    document.querySelector('#createdKeyMeta').textContent = `${result.item?.upstream_name || ''} · ${result.item?.group_name || ''} · ${platformLabel(result.item?.platform)}`;
    closeDialog('createKeyDialog');
    document.querySelector('#createdKeyDialog').showModal();
    await refreshAll({ quiet: true });
    refreshIcons();
  } catch (error) { document.querySelector('#createKeyMessage').textContent = error.message; document.querySelector('#createKeyMessage').className = 'form-message error'; } finally { setBusy(false); }
});

document.querySelector('#ownSiteForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
  const id = payload.id;
  delete payload.id;
  setBusy(true);
  try {
    await api(id ? `/api/own-sites/${id}` : '/api/own-sites', { method: id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
    closeDialog('ownSiteDialog');
    await refreshAll({ quiet: true });
    toast(id ? '自己站已更新' : '自己站已创建', 'success');
  } catch (error) { document.querySelector('#ownSiteFormMessage').textContent = error.message; document.querySelector('#ownSiteFormMessage').className = 'form-message error'; } finally { setBusy(false); }
});

document.querySelector('#testOwnSiteBtn').addEventListener('click', async (event) => runAction(event.currentTarget, '测试中', async () => {
  const id = document.querySelector('#ownSiteForm').elements.id.value;
  if (!id) throw new Error('请先保存自己站再测试');
  const result = await api(`/api/own-sites/${id}/test`, { method: 'POST' });
  document.querySelector('#ownSiteFormMessage').textContent = `连接成功 · 路由 ${result.routes_count || 0}`;
  document.querySelector('#ownSiteFormMessage').className = 'form-message success';
}));

document.querySelector('#bindRouteForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const [siteId, keyId] = String(form.binding.value || '').split('::');
  if (!siteId || !keyId) return toast('请选择上游 Key', 'error');
  setBusy(true);
  try {
    await api(`/api/own-sites/${form.own_site_id.value}/routes/${encodeURIComponent(form.route_id.value)}/manual-bind`, { method: 'POST', body: JSON.stringify({ upstream_site_id: Number(siteId), upstream_key_id: keyId, notes: form.notes.value || '' }) });
    closeDialog('bindRouteDialog');
    await refreshAll({ quiet: true });
    toast('绑定已保存', 'success');
  } finally { setBusy(false); }
});

document.querySelector('#themeToggleBtn').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('upstream-control-theme', next);
});

document.querySelector('#importFileInput').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  setBusy(true);
  try {
    const data = JSON.parse(await file.text());
    const result = await api('/api/import', { method: 'POST', body: JSON.stringify(data) });
    await refreshAll({ quiet: true });
    toast(`已导入 ${result.imported || 0} 个上游`, 'success');
  } catch (error) { toast(error.message, 'error'); } finally { setBusy(false); event.target.value = ''; }
});

document.addEventListener('click', async (event) => {
  const target = event.target.closest('button');
  if (!target) return;
  if (target.dataset.closeDialog) return closeDialog(target.dataset.closeDialog);
  if (target.dataset.viewLink) return setActiveView(target.dataset.viewLink);
  if (target.dataset.action === 'open-upstream-dialog') return openUpstreamDialog();
  if (target.dataset.action === 'open-create-key') return openCreateKey();
  if (target.dataset.action === 'open-own-site') return openOwnSite();
  if (target.dataset.action === 'copy-created-key') { await navigator.clipboard.writeText(state.createdKey); return toast('Key 已复制', 'success'); }
  if (target.dataset.copyText) { await navigator.clipboard.writeText(target.dataset.copyText); return toast('已复制', 'success'); }
  if (target.dataset.monitorStatus) { state.monitorStatus = target.dataset.monitorStatus; renderMonitoring(); refreshIcons(); return; }
  if (target.dataset.consumptionPeriod) { state.consumption.period = target.dataset.consumptionPeriod; await loadConsumption(); return; }
  if (target.dataset.consumptionSite) { state.consumption.selectedSiteId = Number(target.dataset.consumptionSite); renderConsumptionDashboard(); return; }
  if (target.dataset.consumptionTable) { state.consumption.showTable = !state.consumption.showTable; renderConsumptionDashboard(); return; }
  if (target.dataset.toggleSite) { const id = Number(target.dataset.toggleSite); state.expandedSites.has(id) ? state.expandedSites.delete(id) : state.expandedSites.add(id); renderMonitoring(); refreshIcons(); return; }
  if (target.dataset.toggleKeySite) { const id = Number(target.dataset.toggleKeySite); state.expandedKeySites.has(id) ? state.expandedKeySites.delete(id) : state.expandedKeySites.add(id); renderGlobalKeys(); refreshIcons(); return; }
  if (target.dataset.toggleRateSite) { const id = Number(target.dataset.toggleRateSite); state.expandedRateSites.has(id) ? state.expandedRateSites.delete(id) : state.expandedRateSites.add(id); renderPricing(); refreshIcons(); return; }
  if (target.dataset.detailSite) return openDetail(Number(target.dataset.detailSite));
  if (target.dataset.usageDetail) return openUsageDetail(target.dataset.usageDetail);
  if (target.dataset.editFromDetail) { closeDialog('detailDialog'); return openUpstreamDialog(Number(target.dataset.editFromDetail)); }
  if (target.dataset.toggleUpstream) return runAction(target, '处理中', async () => {
    const nextStatus = target.dataset.nextStatus;
    await api(`/api/upstreams/${target.dataset.toggleUpstream}/status`, { method: 'POST', body: JSON.stringify({ status: nextStatus }) });
    closeDialog('detailDialog');
    await refreshAll({ quiet: true });
    toast(nextStatus === 'disabled' ? '上游已停用' : '上游已启用', 'success');
  });
  if (target.dataset.deleteUpstream) {
    const id = target.dataset.deleteUpstream;
    const name = target.dataset.upstreamName || '该上游';
    if (!confirm(`确定永久删除“${name}”？这会清除本地凭据、快照、Key、日志和告警。`)) return;
    if (!confirm(`再次确认永久删除“${name}”？此操作无法在控制台撤销。`)) return;
    return runAction(target, '删除中', async () => {
      await api(`/api/upstreams/${id}`, { method: 'DELETE' });
      closeDialog('detailDialog');
      state.expandedSites.delete(Number(id));
      if (String(state.usage.upstreamId) === String(id)) state.usage.upstreamId = '';
      await refreshAll({ quiet: true });
      toast('上游已永久删除', 'success');
    });
  }
  if (target.dataset.syncSite) return runAction(target, '同步中', async () => { await api(`/api/upstreams/${target.dataset.syncSite}/sync`, { method: 'POST' }); await refreshAll({ quiet: true }); toast('上游同步完成', 'success'); });
  if (target.dataset.syncSiteModels) return runAction(target, '同步中', async () => {
    const result = await api(`/api/upstreams/${target.dataset.syncSiteModels}/models/sync`, { method: 'POST' });
    await refreshAll({ quiet: true });
    toast(`模型同步完成：${result.groups || 0} 个分组，${(result.items || []).reduce((total, group) => total + (group.models || []).length, 0)} 个候选`, 'success');
  });
  if (target.dataset.importKeys) return runAction(target, '导入中', async () => { const result = await api(`/api/upstreams/${target.dataset.importKeys}/keys/import`, { method: 'POST' }); await refreshAll({ quiet: true }); toast(result.message, 'success'); });
  if (target.dataset.checkSiteKeys) return runAction(target, '检测中', async () => { const result = await api(`/api/upstreams/${target.dataset.checkSiteKeys}/keys/check`, { method: 'POST' }); await refreshAll({ quiet: true }); toast(`检测 ${result.checked} 个 Key，联通 ${result.connected}，异常 ${result.failed}`, result.failed ? 'error' : 'success'); });
  if (target.dataset.checkKey) return runAction(target, '检测中', async () => { await api(`/api/upstreams/${target.dataset.siteId}/keys/${encodeURIComponent(target.dataset.checkKey)}/check`, { method: 'POST' }); await refreshAll({ quiet: true }); toast('Key 检测完成', 'success'); });
  if (target.dataset.toggleKey) return runAction(target, '处理中', async () => { await api(`/api/upstreams/${target.dataset.siteId}/keys/${encodeURIComponent(target.dataset.toggleKey)}`, { method: 'PUT', body: JSON.stringify({ status: target.dataset.nextStatus }) }); await refreshAll({ quiet: true }); toast(target.dataset.nextStatus === 'active' ? 'Key 已启用' : 'Key 已暂停', 'success'); });
  if (target.dataset.deleteKey) { if (!confirm('确定删除这个 Key？')) return; return runAction(target, '删除中', async () => { await api(`/api/upstreams/${target.dataset.siteId}/keys/${encodeURIComponent(target.dataset.deleteKey)}`, { method: 'DELETE' }); await refreshAll({ quiet: true }); toast('Key 已删除', 'success'); }); }
  if (target.dataset.syncOwnSite) return runAction(target, '同步中', async () => { await api(`/api/own-sites/${target.dataset.syncOwnSite}/sync`, { method: 'POST' }); await refreshAll({ quiet: true }); });
  if (target.dataset.editOwnSite) return openOwnSite(Number(target.dataset.editOwnSite));
  if (target.dataset.deleteOwnSite) { if (!confirm('确定删除这个自己站？')) return; await api(`/api/own-sites/${target.dataset.deleteOwnSite}`, { method: 'DELETE' }); await refreshAll({ quiet: true }); return; }
  if (target.dataset.bindRoute) return openRouteBinding(Number(target.dataset.ownSiteId), target.dataset.bindRoute);
  if (target.dataset.ackRate) { await api(`/api/rate-changes/${target.dataset.ackRate}/ack`, { method: 'POST' }); await refreshAll({ quiet: true }); return; }
  if (target.dataset.ackAlert) return runAction(target, '处理中', async () => { await api(`/api/alerts/${target.dataset.ackAlert}/acknowledge`, { method: 'POST' }); await refreshAll({ quiet: true }); toast('告警已标记为已处理', 'success'); });
  if (target.dataset.saveUpstreamPolicy) {
    const row = target.closest('[data-policy-site]');
    return runAction(target, '保存中', async () => {
      await api(`/api/upstreams/${target.dataset.saveUpstreamPolicy}`, { method: 'PUT', body: JSON.stringify(collectUpstreamPolicy(row)) });
      await refreshAll({ quiet: true });
      toast('上游策略已保存', 'success');
    });
  }
  if (target.dataset.createRecharge) return runAction(target, '创建中', async () => { const result = await api(`/api/upstreams/${target.dataset.createRecharge}/recharge-orders`, { method: 'POST', body: JSON.stringify({ amount: Number(document.querySelector('#detailRechargeAmount').value), payment_type: document.querySelector('#detailRechargeMethod').value, order_type: 'balance' }) }); document.querySelector('#detailRechargeResult').innerHTML = `<div class="detail-block"><div class="detail-line"><span>订单状态</span><strong>${escapeHtml(result.order?.status || 'PENDING')}</strong></div>${result.order?.pay_url ? `<a class="btn primary" href="${escapeHtml(result.order.pay_url)}" target="_blank" rel="noreferrer">打开收银台</a>` : ''}</div>`; });
  if (target.dataset.action === 'pushplus-test') return runAction(target, '发送中', async () => {
    const result = await api('/api/notifications/pushplus/test', { method: 'POST' });
    const summary = pushPlusDeliverySummary(result);
    setPushPlusFeedback(summary.message, summary.tone);
    toast(summary.message, summary.tone);
  });
  if (target.dataset.pushplusTest) return runAction(target, '发送中', async () => {
    const targetInfo = (state.monitoring.pushplus?.targets || []).find((item) => item.id === target.dataset.pushplusTest);
    const result = await api('/api/notifications/pushplus/test', { method: 'POST', body: JSON.stringify({ target_id: target.dataset.pushplusTest }) });
    const summary = pushPlusDeliverySummary(result, targetInfo?.name || '该目标');
    setPushPlusFeedback(summary.message, summary.tone);
    toast(summary.message, summary.tone);
  });
  if (target.dataset.pushplusEdit) return openPushPlusEditor(target.dataset.pushplusEdit);
  if (target.dataset.action === 'pushplus-cancel-edit') return resetPushPlusEditor();
  if (target.dataset.pushplusToggle) return runAction(target, '保存中', async () => { await api(`/api/notifications/pushplus/targets/${encodeURIComponent(target.dataset.pushplusToggle)}`, { method: 'PATCH', body: JSON.stringify({ enabled: target.dataset.nextEnabled === 'true' }) }); await refreshAll({ quiet: true }); toast(target.dataset.nextEnabled === 'true' ? '目标已启用' : '目标已停用', 'success'); });
  if (target.dataset.pushplusDelete) { if (!confirm('确定删除这个 PushPlus 目标？')) return; return runAction(target, '删除中', async () => { await api(`/api/notifications/pushplus/targets/${encodeURIComponent(target.dataset.pushplusDelete)}`, { method: 'DELETE' }); if (document.querySelector('#pushPlusTargetIdInput').value === target.dataset.pushplusDelete) resetPushPlusEditor(); await refreshAll({ quiet: true }); toast('目标已删除', 'success'); }); }
  if (target.dataset.action === 'pushplus-clear') {
    if (!confirm('确定清空所有控制台中的 PushPlus 通知目标？')) return;
    return runAction(target, '清空中', async () => {
      await api('/api/notifications/pushplus/settings', { method: 'DELETE' });
      resetPushPlusEditor();
      await refreshAll({ quiet: true });
      toast('PushPlus 通知目标已清空', 'success');
    });
  }
  if (target.dataset.action === 'check-system-update') return runAction(target, '检查中', async () => {
    state.systemUpdate = await api('/api/system/update/check', { method: 'POST' });
    renderSystemUpdate();
    refreshIcons();
    toast(state.systemUpdate.message || '版本检查完成', state.systemUpdate.available ? 'success' : '');
  });
  if (target.dataset.action === 'apply-system-update') {
    const count = Number(state.systemUpdate.behind || 0);
    if (!confirm(`确定安装${count ? `这 ${count} 个提交` : '当前更新'}？系统会先备份数据库并在完成后重启。`)) return;
    try {
      const result = await api('/api/system/update/apply', { method: 'POST' });
      state.systemUpdate = { ...state.systemUpdate, ...result, operation: result.operation };
      renderSystemUpdate();
      refreshIcons();
      toast('更新任务已开始');
      monitorSystemUpdate();
    } catch (error) {
      toast(error.message, 'error');
    }
    return;
  }
  if (target.dataset.action === 'export-config') { const data = await api('/api/export'); const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `sub2api-upstreams-${Date.now()}.json`; link.click(); URL.revokeObjectURL(url); return; }
  if (target.dataset.action === 'import-config') return document.querySelector('#importFileInput').click();
  if (target.dataset.action === 'backup-database') { window.location.href = '/api/backup/database'; return; }
  if (target.dataset.action === 'logout') { await api('/api/logout', { method: 'POST' }); return showLogin(); }
});

const REQUEST_ERROR_ROUTES = {
  hermes: { label: '移交 Hermes', tone: 'warning' },
  manual: { label: '人工处理', tone: 'danger' },
  none: { label: '仅记录', tone: 'neutral' }
};
const REQUEST_ERROR_CHANNELS = { pushplus: 'PushPlus', email: '邮箱', hermes: 'Hermes', weixin: '微信汇报' };
const REQUEST_ERROR_DELIVERY = {
  sent: { label: '已投递', tone: 'healthy' },
  pending: { label: '待投递', tone: 'warning' },
  failed: { label: '失败', tone: 'danger' },
  skipped: { label: '未启用', tone: 'neutral' }
};

function requestErrorQuery() {
  const params = new URLSearchParams({ limit: String(state.requestErrors.pageSize), offset: String(state.requestErrors.offset) });
  if (state.requestErrors.siteId) params.set('own_site_id', state.requestErrors.siteId);
  if (state.requestErrors.route) params.set('route', state.requestErrors.route);
  if (state.search.trim()) params.set('search', state.search.trim());
  return params.toString();
}

async function loadRequestErrors() {
  const [events, sites, settings] = await Promise.all([
    api(`/api/request-errors/events?${requestErrorQuery()}`),
    api('/api/request-errors/sites'),
    api('/api/request-errors/settings')
  ]);
  Object.assign(state.requestErrors, { items: events.items || [], total: events.total || 0, summary: events.summary || {}, sites: sites.items || [], settings, loaded: true });
  renderRequestErrorBadge();
  if (state.activeView === 'request-errors') renderRequestErrors();
}

function renderRequestErrorBadge() {
  const failed = Number(state.requestErrors.summary.failed_deliveries || 0);
  const badge = document.querySelector('#sidebarRequestErrorCount');
  badge.hidden = !failed;
  badge.textContent = String(failed);
}

function deliveryPills(deliveries = []) {
  if (!deliveries.length) return '<span class="muted">不投递</span>';
  return `<div class="delivery-pills">${deliveries.map((item) => {
    const meta = REQUEST_ERROR_DELIVERY[item.status] || REQUEST_ERROR_DELIVERY.pending;
    const title = item.last_error ? ` title="${escapeHtml(item.last_error)}"` : '';
    return `<span class="status-pill ${meta.tone}"${title}>${REQUEST_ERROR_CHANNELS[item.channel] || item.channel} · ${meta.label}</span>`;
  }).join('')}</div>`;
}

function requestErrorCodes(item) {
  const matched = item.matched_codes || [];
  const codes = matched.length ? matched : (item.error_codes || []).slice(0, 3);
  return codes.length ? codes.map((code) => `<code>${escapeHtml(code)}</code>`).join(' ') : '<span class="muted">-</span>';
}

function renderRequestErrorRows() {
  const { items, total, offset, pageSize } = state.requestErrors;
  document.querySelector('#requestErrorRows').innerHTML = items.map((item) => {
    const route = REQUEST_ERROR_ROUTES[item.route] || REQUEST_ERROR_ROUTES.none;
    const detail = item.detail_status === 'pending'
      ? '<span class="status-pill neutral">读取详情中</span>'
      : `<span class="status-pill ${route.tone}">${route.label}</span>${item.detail_status === 'partial' ? '<small class="danger-text">部分详情</small>' : ''}`;
    const failed = (item.deliveries || []).some((delivery) => delivery.status === 'failed');
    return `<tr class="data-row"><td>${timeText(item.occurred_at)}</td><td><div class="cell-stack"><strong>${escapeHtml(item.own_site_name)}</strong><small>${escapeHtml(item.group_name || (item.group_id ? `分组 ${item.group_id}` : '-'))}</small></div></td><td>${requestErrorCodes(item)}</td><td class="numeric">${item.status_code ?? '-'} / ${item.upstream_status_code ?? '-'}</td><td><div class="cell-stack request-error-message"><strong>${escapeHtml(item.message || item.error_type || '-')}</strong><small>${escapeHtml(item.upstream_error_message || '')}</small></div></td><td><div class="cell-stack">${detail}</div></td><td>${deliveryPills(item.deliveries)}</td><td class="align-right"><div class="row-actions">${failed ? `<button class="icon-btn" type="button" data-retry-request-error="${item.id}" title="重试失败投递"><i data-lucide="rotate-ccw"></i></button>` : ''}<button class="icon-btn" type="button" data-open-request-error="${item.id}" title="详情"><i data-lucide="panel-right-open"></i></button></div></td></tr>`;
  }).join('') || '<tr><td colspan="8"><div class="empty-state">还没有记录到用户请求报错</div></td></tr>';
  const page = Math.floor(offset / pageSize) + 1;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  document.querySelector('#requestErrorPageSummary').textContent = `${total} 条记录 · 第 ${page}/${pages} 页`;
  document.querySelector('#requestErrorPrevBtn').disabled = offset <= 0;
  document.querySelector('#requestErrorNextBtn').disabled = offset + pageSize >= total;
}

function renderRequestErrorSites() {
  const siteFilter = document.querySelector('#requestErrorSiteFilter');
  siteFilter.innerHTML = `<option value="">全部站点</option>${state.requestErrors.sites.map((site) => `<option value="${site.own_site_id}">${escapeHtml(site.name)}</option>`).join('')}`;
  siteFilter.value = state.requestErrors.siteId;
  document.querySelector('#requestErrorRouteFilter').value = state.requestErrors.route;
  document.querySelector('#requestErrorSiteRows').innerHTML = state.requestErrors.sites.map((site) => {
    const selected = new Set(site.group_ids);
    const groups = site.groups.length
      ? `<div class="group-check-list">${site.groups.map((group) => `<label class="group-check"><input type="checkbox" data-monitor-group="${escapeHtml(group.id)}" ${selected.has(group.id) ? 'checked' : ''} /><span>${escapeHtml(group.name)}</span><small>${group.is_exclusive ? '专属' : '公共'}${group.platform ? ` · ${escapeHtml(group.platform)}` : ''}</small></label>`).join('')}</div>`
      : `<span class="muted">${site.group_ids.length ? `已选 ${site.group_ids.length} 个分组` : '全部分组'}（保存 Key 后可读取分组）</span>`;
    const poll = site.last_poll_error
      ? `<span class="danger-text" title="${escapeHtml(site.last_poll_error)}">失败 · ${timeText(site.last_poll_at)}</span>`
      : site.last_poll_at ? `${timeText(site.last_poll_at)} · 新增 ${site.last_poll_found}` : '尚未轮询';
    return `<tr class="data-row" data-monitor-site="${site.own_site_id}"><td><div class="cell-stack"><strong>${escapeHtml(site.name)}</strong><small>${escapeHtml(site.base_url)}</small></div></td><td><label class="toggle-field compact-toggle"><input type="checkbox" data-monitor-field="enabled" ${site.enabled ? 'checked' : ''} aria-label="${escapeHtml(site.name)} 错误监控" /><span class="toggle-control"></span></label></td><td><input type="password" autocomplete="new-password" data-monitor-field="admin_api_key" placeholder="${site.has_admin_api_key ? `已保存 ${escapeHtml(site.admin_api_key_masked)}，留空保留` : '填写管理员 API Key'}" aria-label="${escapeHtml(site.name)} 管理员 API Key" /></td><td>${groups}</td><td>${poll}</td><td class="align-right"><div class="row-actions"><button class="icon-btn" type="button" data-refresh-monitor-groups="${site.own_site_id}" title="读取分组"><i data-lucide="list-restart"></i></button><button class="icon-btn" type="button" data-poll-monitor-site="${site.own_site_id}" title="立即轮询"><i data-lucide="radar"></i></button><button class="icon-btn" type="button" data-save-monitor-site="${site.own_site_id}" title="保存"><i data-lucide="save"></i></button></div></td></tr>`;
  }).join('') || '<tr><td colspan="6"><div class="empty-state">请先在「自己站观测」添加自有 Sub2API 站点</div></td></tr>';
}

function fillRequestErrorSettings() {
  const status = state.requestErrors.settings;
  if (!status) return;
  const form = document.querySelector('#requestErrorSettingsForm');
  const settings = status.settings;
  for (const element of form.elements) {
    if (!element.name || element.name === 'hermes_secret') continue;
    const value = settings[element.name];
    if (element.type === 'checkbox') element.checked = Boolean(value);
    else if (Array.isArray(value)) element.value = value.join('\n');
    else element.value = value ?? '';
  }
  form.elements.hermes_secret.value = '';
  renderCodePickers();
  form.elements.enabled.disabled = Boolean(status.locks?.monitor);
  form.elements.hermes_webhook_url.disabled = Boolean(status.locks?.hermes_webhook_url);
  form.elements.hermes_secret.disabled = Boolean(status.locks?.hermes_secret);
}

function renderRequestErrorStatus() {
  const status = state.requestErrors.settings;
  if (!status) return;
  const summary = state.requestErrors.summary || {};
  const byRoute = summary.by_route || {};
  document.querySelector('#requestErrorSummary').textContent = `移交 Hermes ${byRoute.hermes || 0} · 人工处理 ${byRoute.manual || 0} · 仅记录 ${byRoute.none || 0} · 待投递 ${summary.pending_deliveries || 0} · 投递失败 ${summary.failed_deliveries || 0}`;
  const effective = status.effective || {};
  document.querySelector('#requestErrorSettingsStatus').textContent = status.locks?.monitor
    ? '已被环境变量 REQUEST_ERROR_MONITOR_ENABLED=false 强制停用'
    : `${effective.enabled ? '运行中' : '未启用'} · ${status.warning || (status.source === 'database' ? '控制台配置，保存后热生效' : '默认值')}`;
  const secret = status.hermes_secret || {};
  document.querySelector('#requestErrorHermesStatus').textContent = [
    effective.hermes_enabled ? '已启用' : '未启用',
    secret.configured ? `HMAC 密钥 ${secret.source === 'environment' ? '来自环境变量' : secret.masked}` : 'HMAC 密钥未配置',
    status.locks?.hermes_webhook_url ? `地址来自环境变量：${effective.hermes_webhook_url}` : ''
  ].filter(Boolean).join(' · ');
}

function renderRequestErrors() {
  if (!state.requestErrors.loaded) return;
  renderRequestErrorRows();
  renderRequestErrorSites();
  renderRequestErrorStatus();
  if (!state.requestErrors.settingsFilled) {
    fillRequestErrorSettings();
    state.requestErrors.settingsFilled = true;
  }
  refreshIcons();
}

function parseCodeList(value) {
  return String(value || '').split(/[\s,，;；]+/).map((item) => item.trim()).filter(Boolean);
}

const CODE_PICKER_NAMES = ['hermes_codes', 'manual_codes'];
const codeCatalog = new Map((window.REQUEST_ERROR_CODE_GROUPS || []).flatMap((group) => group.sections.flatMap((section) => section.items.map((item) => [item.value, { ...item, group }]))));

function codePickerField(name) {
  return document.querySelector(`#requestErrorSettingsForm input[name="${name}"]`);
}

function codePickerValues(name) {
  return [...new Set(parseCodeList(codePickerField(name).value).map((code) => code.toLowerCase()))];
}

function setCodePickerValues(name, values) {
  codePickerField(name).value = values.join('\n');
  renderCodePickers();
}

function codeChipText(value) {
  const item = codeCatalog.get(value);
  if (item) return `${item.group.short} · ${item.code} ${item.label}`;
  return /^(upstream|local):/.test(value) ? value : `${value}（不分上游 / 本地）`;
}

function renderCodePicker(picker) {
  const name = picker.dataset.codePicker;
  const selected = new Set(codePickerValues(name));
  const other = new Set(codePickerValues(CODE_PICKER_NAMES.find((item) => item !== name)));
  const query = picker.querySelector('.code-picker-search').value.trim().toLowerCase();
  const matches = (item) => !query || `${item.value} ${item.label}`.toLowerCase().includes(query);
  picker.querySelector('.code-picker-options').innerHTML = (window.REQUEST_ERROR_CODE_GROUPS || []).map((group) => {
    const sections = group.sections.map((section) => {
      const items = section.items.filter(matches);
      if (!items.length) return '';
      return `<div class="code-picker-section"><div class="code-picker-section-title">${escapeHtml(section.title)}</div>${items.map((item) => `<label class="code-option"><input type="checkbox" data-code-value="${escapeHtml(item.value)}" ${selected.has(item.value) ? 'checked' : ''} /><code>${escapeHtml(item.code)}</code><span>${escapeHtml(item.label)}</span>${other.has(item.value) ? '<em>另一组已选</em>' : ''}</label>`).join('')}</div>`;
    }).join('');
    return sections ? `<div class="code-picker-group"><div class="code-picker-group-title"><strong>${escapeHtml(group.title)}</strong><small>${escapeHtml(group.hint)}</small></div>${sections}</div>` : '';
  }).join('') || '<div class="empty-state">没有匹配的错误码，可在下方自定义添加</div>';
  picker.querySelector('.code-picker-summary').textContent = selected.size ? `已选 ${selected.size} 项` : '点击选择错误码';
  picker.querySelector('.code-picker-chips').innerHTML = [...selected].map((value) => `<span class="code-chip${other.has(value) ? ' overlap' : ''}" title="${escapeHtml(value)}">${escapeHtml(codeChipText(value))}<button type="button" data-remove-code="${escapeHtml(value)}" aria-label="移除 ${escapeHtml(value)}">×</button></span>`).join('');
}

function renderCodePickers() {
  document.querySelectorAll('[data-code-picker]').forEach(renderCodePicker);
}

function toggleCodePicker(picker, open) {
  document.querySelectorAll('[data-code-picker]').forEach((item) => {
    const show = item === picker && open;
    item.querySelector('.code-picker-panel').hidden = !show;
    item.querySelector('.code-picker-toggle').setAttribute('aria-expanded', String(show));
  });
  if (open) picker.querySelector('.code-picker-search').focus();
}

document.querySelectorAll('[data-code-picker]').forEach((picker) => {
  const name = picker.dataset.codePicker;
  const customInput = picker.querySelector('.code-picker-custom input');
  const addCustom = () => {
    const added = parseCodeList(customInput.value).map((code) => code.toLowerCase());
    if (!added.length) return;
    setCodePickerValues(name, [...new Set([...codePickerValues(name), ...added])]);
    customInput.value = '';
  };
  picker.querySelector('.code-picker-toggle').addEventListener('click', () => toggleCodePicker(picker, picker.querySelector('.code-picker-panel').hidden));
  picker.querySelector('.code-picker-search').addEventListener('input', () => renderCodePicker(picker));
  picker.querySelector('.code-picker-options').addEventListener('change', (event) => {
    const value = event.target.dataset.codeValue;
    if (!value) return;
    const values = codePickerValues(name).filter((code) => code !== value);
    setCodePickerValues(name, event.target.checked ? [...values, value] : values);
  });
  picker.querySelector('.code-picker-chips').addEventListener('click', (event) => {
    const value = event.target.dataset.removeCode;
    if (value) setCodePickerValues(name, codePickerValues(name).filter((code) => code !== value));
  });
  picker.querySelector('.code-picker-custom button').addEventListener('click', addCustom);
  customInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addCustom();
  });
});

document.addEventListener('click', (event) => {
  // composedPath still holds nodes a re-render detached during this click.
  if (!event.composedPath().some((node) => node.dataset?.codePicker)) toggleCodePicker(null, false);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') toggleCodePicker(null, false);
});

function collectRequestErrorSettings(form) {
  const payload = {};
  for (const element of form.elements) {
    if (!element.name || element.disabled) continue;
    if (element.type === 'checkbox') payload[element.name] = element.checked;
    else if (element.type === 'number') payload[element.name] = Number(element.value);
    else if (['hermes_codes', 'manual_codes'].includes(element.name)) payload[element.name] = parseCodeList(element.value);
    else if (element.name === 'hermes_secret') { if (element.value.trim()) payload.hermes_secret = element.value.trim(); }
    else payload[element.name] = element.value;
  }
  return payload;
}

function requestErrorDetailLines(rows) {
  return `<div class="detail-list">${rows.map(([label, value]) => `<div class="detail-line"><span>${label}</span><strong>${escapeHtml(value ?? '-') || '-'}</strong></div>`).join('')}</div>`;
}

function requestErrorJsonBlock(title, value) {
  if (!value || (Array.isArray(value) && !value.length)) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return `<div class="detail-block"><h3>${title}</h3><pre class="code-block">${escapeHtml(text)}</pre></div>`;
}

function showRequestErrorDetail(event) {
  const route = REQUEST_ERROR_ROUTES[event.route] || REQUEST_ERROR_ROUTES.none;
  document.querySelector('#requestErrorDialogSubtitle').textContent = `${event.delivery_id} · ${new Date(event.occurred_at).toLocaleString('zh-CN', { hour12: false })}`;
  const deliveries = (event.deliveries || []).map((item) => {
    const meta = REQUEST_ERROR_DELIVERY[item.status] || REQUEST_ERROR_DELIVERY.pending;
    return `<div class="detail-line"><span>${REQUEST_ERROR_CHANNELS[item.channel] || item.channel}</span><strong><span class="status-pill ${meta.tone}">${meta.label}</span> ${item.attempts ? `尝试 ${item.attempts} 次` : ''}${item.delivered_at ? ` · ${timeText(item.delivered_at)}` : ''}${item.last_error ? `<br><small class="muted">${escapeHtml(item.last_error)}</small>` : ''}</strong></div>`;
  }).join('') || '<div class="detail-line"><span>投递</span><strong>未命中错误码，只记录</strong></div>';
  const hermes = event.route === 'hermes'
    ? `<div class="detail-block"><h3>Hermes 回执</h3>${requestErrorDetailLines([
      ['处理状态', event.hermes_processing || '尚未回执'],
      ['微信投递', event.hermes_delivery || '-']
    ])}${event.hermes_result ? `<pre class="code-block">${escapeHtml(event.hermes_result)}</pre>` : ''}<p class="muted">Hermes 已受理不代表问题已解决，以回执中的处理结果为准。</p></div>`
    : '';
  document.querySelector('#requestErrorDialogContent').innerHTML = `
    <div class="detail-block"><h3>分流</h3>${requestErrorDetailLines([
      ['结果', route.label],
      ['命中错误码', (event.matched_codes || []).join(', ') || '-'],
      ['全部错误码', (event.error_codes || []).join(', ') || '-'],
      ['详情完整性', event.detail_status === 'complete' ? '完整' : event.detail_status === 'pending' ? '读取中' : `部分详情：${event.detail_error || '取数失败'}`]
    ])}</div>
    <div class="detail-block"><h3>投递状态</h3><div class="detail-list">${deliveries}</div></div>
    ${hermes}
    <div class="detail-block"><h3>请求</h3>${requestErrorDetailLines([
      ['站点', `${event.own_site_name} (${event.own_site_base_url})`],
      ['分组', `${event.group_name || '-'}${event.group_id ? ` · ID ${event.group_id}` : ''}`],
      ['Sub2API 错误 ID', event.error_id],
      ['请求 ID', event.request_id],
      ['平台 / 模型', `${event.platform || '-'} / ${event.model || '-'}`],
      ['用户状态码', event.status_code],
      ['本地分类', [event.phase, event.error_type, event.error_owner, event.error_source].filter(Boolean).join(' / ')],
      ['本地消息', event.message]
    ])}</div>
    <div class="detail-block"><h3>上游</h3>${requestErrorDetailLines([
      ['上游状态码', event.upstream_status_code],
      ['上游错误消息', event.upstream_error_message]
    ])}</div>
    ${requestErrorJsonBlock('用户收到的错误响应', event.error_body)}
    ${requestErrorJsonBlock('上游错误详情', event.upstream_error_detail)}
    ${requestErrorJsonBlock(`上游尝试记录（${(event.upstream_errors || []).length}）`, event.upstream_errors)}
    ${requestErrorJsonBlock(`关联上游错误日志（${(event.related_upstream_errors || []).length}）`, event.related_upstream_errors)}`;
  if (!document.querySelector('#requestErrorDialog').open) document.querySelector('#requestErrorDialog').showModal();
  refreshIcons();
}

function collectMonitorSite(row) {
  const payload = { enabled: row.querySelector('[data-monitor-field="enabled"]').checked };
  const key = row.querySelector('[data-monitor-field="admin_api_key"]').value.trim();
  if (key) payload.admin_api_key = key;
  const groupInputs = [...row.querySelectorAll('[data-monitor-group]')];
  if (groupInputs.length) payload.group_ids = groupInputs.filter((input) => input.checked).map((input) => input.dataset.monitorGroup);
  return payload;
}

async function reloadRequestErrorEvents() {
  const events = await api(`/api/request-errors/events?${requestErrorQuery()}`);
  Object.assign(state.requestErrors, { items: events.items || [], total: events.total || 0, summary: events.summary || {} });
  renderRequestErrorBadge();
  renderRequestErrors();
}

document.querySelector('#requestErrorSiteFilter').addEventListener('change', (event) => { state.requestErrors.siteId = event.target.value; state.requestErrors.offset = 0; reloadRequestErrorEvents().catch((error) => toast(error.message, 'error')); });
document.querySelector('#requestErrorRouteFilter').addEventListener('change', (event) => { state.requestErrors.route = event.target.value; state.requestErrors.offset = 0; reloadRequestErrorEvents().catch((error) => toast(error.message, 'error')); });
document.querySelector('#requestErrorRefreshBtn').addEventListener('click', (event) => runAction(event.currentTarget, '刷新中', loadRequestErrors));
document.querySelector('#requestErrorPrevBtn').addEventListener('click', () => { state.requestErrors.offset = Math.max(0, state.requestErrors.offset - state.requestErrors.pageSize); reloadRequestErrorEvents().catch((error) => toast(error.message, 'error')); });
document.querySelector('#requestErrorNextBtn').addEventListener('click', () => { state.requestErrors.offset += state.requestErrors.pageSize; reloadRequestErrorEvents().catch((error) => toast(error.message, 'error')); });
document.querySelector('#globalSearchInput').addEventListener('input', () => {
  if (state.activeView !== 'request-errors') return;
  window.clearTimeout(state.requestErrors.searchTimer);
  state.requestErrors.searchTimer = window.setTimeout(() => { state.requestErrors.offset = 0; reloadRequestErrorEvents().catch(() => {}); }, 300);
});

document.querySelector('#requestErrorSettingsForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  await runAction(form.querySelector('button[type="submit"]'), '保存中', async () => {
    const result = await api('/api/request-errors/settings', { method: 'PUT', body: JSON.stringify(collectRequestErrorSettings(form)) });
    state.requestErrors.settings = result;
    fillRequestErrorSettings();
    renderRequestErrorStatus();
    toast(result.overlap_codes?.length ? `已保存；${result.overlap_codes.join(', ')} 同时在两组中，将按人工处理` : '错误监控设置已保存', 'success');
  });
});

document.querySelector('#requestErrorHermesHealthBtn').addEventListener('click', (event) => runAction(event.currentTarget, '检测中', async () => {
  const result = await api('/api/request-errors/hermes/health', { method: 'POST' });
  toast(result.ok ? `Hermes 通道可达（${result.url}）` : `Hermes 返回 HTTP ${result.status}`, result.ok ? 'success' : 'error');
}));

document.querySelector('#requestErrorClearSecretBtn').addEventListener('click', (event) => {
  if (!window.confirm('清除后 Hermes 投递会暂停，确定清除 HMAC 密钥？')) return;
  runAction(event.currentTarget, '清除中', async () => {
    state.requestErrors.settings = await api('/api/request-errors/settings/hermes-secret', { method: 'DELETE' });
    renderRequestErrorStatus();
    toast('HMAC 密钥已清除', 'success');
  });
});

document.querySelector('[data-view="request-errors"]').addEventListener('click', async (event) => {
  const target = event.target.closest('button');
  if (!target) return;
  if (target.dataset.openRequestError) {
    const result = await api(`/api/request-errors/events/${target.dataset.openRequestError}`).catch((error) => toast(error.message, 'error'));
    if (result?.event) showRequestErrorDetail(result.event);
    return;
  }
  if (target.dataset.retryRequestError) {
    return runAction(target, '重试中', async () => {
      const result = await api(`/api/request-errors/events/${target.dataset.retryRequestError}/retry`, { method: 'POST' });
      toast(`已重新投递 ${result.reset} 个渠道`, 'success');
      await reloadRequestErrorEvents();
    });
  }
  const siteId = target.dataset.saveMonitorSite || target.dataset.refreshMonitorGroups || target.dataset.pollMonitorSite;
  if (!siteId) return;
  const row = target.closest('[data-monitor-site]');
  if (target.dataset.saveMonitorSite) {
    return runAction(target, '', async () => {
      await api(`/api/request-errors/sites/${siteId}`, { method: 'PUT', body: JSON.stringify(collectMonitorSite(row)) });
      await loadRequestErrors();
      toast('监控站点已保存', 'success');
    });
  }
  if (target.dataset.refreshMonitorGroups) {
    return runAction(target, '', async () => {
      const key = row.querySelector('[data-monitor-field="admin_api_key"]').value.trim();
      if (key) await api(`/api/request-errors/sites/${siteId}`, { method: 'PUT', body: JSON.stringify({ admin_api_key: key }) });
      const result = await api(`/api/request-errors/sites/${siteId}/groups/refresh`, { method: 'POST' });
      await loadRequestErrors();
      toast(`已读取 ${result.site.groups.length} 个分组`, 'success');
    });
  }
  return runAction(target, '', async () => {
    const result = await api(`/api/request-errors/sites/${siteId}/poll`, { method: 'POST' });
    await loadRequestErrors();
    toast(result.error ? `轮询失败：${result.error}` : `轮询完成，新增 ${result.found} 条`, result.error ? 'error' : 'success');
  });
});

async function boot() {
  const theme = localStorage.getItem('upstream-control-theme');
  if (theme) document.documentElement.dataset.theme = theme;
  refreshIcons();
  try {
    const session = await api('/api/session');
    if (session.auth_enabled && !session.authenticated) return showLogin();
    showApp();
    await refreshAll();
  } catch (error) {
    toast(error.message, 'error');
  }
}

boot();
