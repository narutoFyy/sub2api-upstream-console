const VIEW_META = {
  overview: { title: '总览', search: '搜索上游或 Key' },
  monitoring: { title: '上游监控', search: '搜索上游或 Key' },
  keys: { title: 'Key 管理', search: '搜索 Key、分组或上游' },
  'own-sites': { title: '自己站观测', search: '搜索自己站账号或路由' },
  pricing: { title: '模型价格', search: '搜索模型或上游' },
  usage: { title: '使用明细', search: '搜索模型、Key 或分组' },
  alerts: { title: '告警事件', search: '搜索告警或上游' },
  logs: { title: '同步记录', search: '搜索日志或上游' },
  settings: { title: '设置', search: '搜索上游或 Key' }
};

const state = {
  activeView: localStorage.getItem('upstream-control-view') || 'monitoring',
  monitoring: { totals: {}, items: [], pushplus: { configured: false }, open_alerts: 0 },
  alerts: [],
  logs: [],
  rateChanges: [],
  pricing: { openai: [], claude: [] },
  ownSites: [],
  ownRoutes: [],
  expandedSites: new Set(),
  expandedKeySites: new Set(),
  monitorStatus: 'all',
  monitorSort: 'balance-asc',
  search: '',
  keyFilters: { upstream: '', platform: '', health: '' },
  alertStatus: '',
  runtimeSettings: { settings: null, effective: null, locks: {}, source: 'defaults', warning: '' },
  systemUpdate: { enabled: false, operation: { phase: 'idle' }, commits: [] },
  settingsTab: 'notifications',
  createdKey: '',
  usage: { items: [], total: 0, page: 1, pageSize: 20, pages: 1, loading: false, error: '', upstreamId: '', startDate: '', endDate: '' }
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
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text || `HTTP ${response.status}` }; }
  if (response.status === 401) {
    showLogin();
    throw new Error(data.error || '请先登录控制台');
  }
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
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
  return Number.isFinite(Number(value)) ? money.format(Number(value)) : fallback;
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

function isLowBalance(site) {
  return Number.isFinite(Number(site.balance)) && Number(site.balance) < Number(site.low_balance_threshold || 10);
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
    if (state.monitorSort === 'abnormal-desc') return Number(b.key_abnormal_count || 0) - Number(a.key_abnormal_count || 0);
    if (state.monitorSort === 'name-asc') return String(a.name).localeCompare(String(b.name), 'zh-CN');
    return Number(a.balance ?? Infinity) - Number(b.balance ?? Infinity);
  });
}

function renderMonitoring() {
  document.querySelector('#monitoringMetrics').innerHTML = metricMarkup(monitoringMetrics());
  const totals = state.monitoring.totals || {};
  document.querySelector('#segmentAllCount').textContent = totals.upstreams || 0;
  document.querySelector('#segmentHealthyCount').textContent = totals.healthy || 0;
  document.querySelector('#segmentLowCount').textContent = totals.low_balance || 0;
  document.querySelector('#segmentKeyErrorCount').textContent = totals.key_abnormal || 0;
  document.querySelectorAll('[data-monitor-status]').forEach((button) => button.classList.toggle('active', button.dataset.monitorStatus === state.monitorStatus));

  const rows = filteredMonitoringSites().map((site) => {
    const expanded = state.expandedSites.has(Number(site.id));
    const health = siteHealth(site);
    const balanceClass = isLowBalance(site) ? 'low' : '';
    const syncError = syncErrorPresentation(site.last_sync_error);
    return `
      <tr class="data-row">
        <td><div class="upstream-name-cell"><button class="row-chevron ${expanded ? 'expanded' : ''}" type="button" data-toggle-site="${site.id}" aria-label="展开 ${escapeHtml(site.name)}"><i data-lucide="chevron-right"></i></button><div class="upstream-identity"><strong>${escapeHtml(site.name)}</strong><small>${escapeHtml(site.base_url)}</small></div></div></td>
        <td><strong class="balance-value ${balanceClass}">${site.balance == null ? '-' : `$${numberText(site.balance)}`}</strong><span class="balance-meta ${site.balance_stale ? 'warning-text' : ''}">${site.balance_stale ? '数据已过期 · ' : ''}${ageText(site.balance_age_ms)}</span></td>
        <td><span class="status-label"><span class="status-dot ${health.dot}"></span><span>${escapeHtml(health.label)}</span></span></td>
        <td><span class="numeric">${site.key_count || 0} 个 Key</span></td>
        <td class="numeric ${site.key_abnormal_count ? 'danger-text' : ''}">${site.key_abnormal_count || 0}</td>
        <td><div class="cell-stack sync-cell"><span>${timeText(site.last_sync_at)}</span>${syncError.full ? `<small class="danger-text sync-error" title="${escapeHtml(syncError.full)}">${escapeHtml(syncError.summary)}</small>` : ''}</div></td>
        <td class="align-right"><div class="row-actions"><button class="icon-btn" type="button" data-sync-site="${site.id}" title="同步"><i data-lucide="refresh-cw"></i></button><button class="icon-btn" type="button" data-detail-site="${site.id}" title="详情"><i data-lucide="ellipsis-vertical"></i></button></div></td>
      </tr>
      ${expanded ? renderExpandedKeys(site) : ''}
    `;
  }).join('');
  document.querySelector('#monitoringRows').innerHTML = rows || '<tr><td colspan="7"><div class="empty-state">没有匹配的上游</div></td></tr>';
}

function renderExpandedKeys(site) {
  const keys = (site.keys || []).filter((key) => key.import_state !== 'missing');
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
  return `<tr class="expanded-row"><td colspan="7"><div class="expanded-panel">
    <div class="expanded-header"><strong>${escapeHtml(site.name)} · Key 明细</strong><div class="expanded-actions"><button class="btn secondary" type="button" data-import-keys="${site.id}"><i data-lucide="download"></i>导入全部 Key</button><button class="btn primary" type="button" data-check-site-keys="${site.id}"><i data-lucide="activity"></i>立即检测</button></div></div>
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
    return `<tr class="data-row"><td><div class="upstream-name-cell"><button class="row-chevron ${expanded ? 'expanded' : ''}" type="button" data-toggle-key-site="${site.id}" aria-label="展开 ${escapeHtml(site.name)}"><i data-lucide="chevron-right"></i></button><div class="upstream-identity"><strong>${escapeHtml(site.name)}</strong><small>${escapeHtml(site.base_url)}</small></div></div></td><td>${keys.length}</td><td class="healthy-text">${active}</td><td>${inactive}</td><td class="${failed ? 'danger-text' : ''}">${failed}</td><td>${timeText(site.last_sync_at)}</td><td class="align-right"><div class="row-actions"><button class="icon-btn" type="button" data-import-keys="${site.id}" title="导入全部 Key"><i data-lucide="download"></i></button><button class="icon-btn" type="button" data-check-site-keys="${site.id}" title="检测全部 Key"><i data-lucide="activity"></i></button></div></td></tr>${expanded ? renderManagedKeyRows(site, keys) : ''}`;
  }).join('') || '<tr><td colspan="7"><div class="empty-state">没有匹配的上游或 Key</div></td></tr>';
}

function renderManagedKeyRows(site, keys) {
  const body = keys.map((key) => {
    const failed = ['timeout', 'auth_failed', 'quota_exhausted', 'upstream_error'].includes(key.connectivity_status);
    const connectivity = connectivityMeta(key);
    return `<tr class="${failed ? 'failure-row' : ''}"><td>${escapeHtml(key.name || '-')}</td><td><code>${escapeHtml(key.key_masked || '-')}</code></td><td>${escapeHtml(key.group_name || '-')}</td><td>${escapeHtml(platformLabel(key.platform))}</td><td class="numeric">${rateText(key.group_rate)}</td><td>${keyProbeModelSelect(site, key)}</td><td><span class="status-label ${connectivity.tone}-text"><span class="status-dot ${connectivity.dot}"></span>${escapeHtml(connectivity.label)}</span></td><td>${timeText(key.last_checked_at)}</td><td class="align-right"><div class="row-actions"><button class="icon-btn" type="button" data-check-key="${escapeHtml(key.upstream_key_id)}" data-site-id="${site.id}" title="检测"><i data-lucide="activity"></i></button><button class="icon-btn" type="button" data-toggle-key="${escapeHtml(key.upstream_key_id)}" data-site-id="${site.id}" data-next-status="${key.status === 'active' ? 'inactive' : 'active'}" title="${key.status === 'active' ? '暂停' : '启用'}"><i data-lucide="${key.status === 'active' ? 'pause' : 'play'}"></i></button><button class="icon-btn danger-text" type="button" data-delete-key="${escapeHtml(key.upstream_key_id)}" data-site-id="${site.id}" title="删除"><i data-lucide="trash-2"></i></button></div></td></tr>`;
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

function renderPricing() {
  const keyword = state.search.toLowerCase();
  const sections = [['OpenAI', state.pricing.openai || []], ['Claude', state.pricing.claude || []]];
  document.querySelector('#pricingBoard').innerHTML = sections.map(([title, models]) => `<section class="pricing-section"><h3>${title}</h3>${models.filter((model) => !keyword || `${model.model_name} ${model.vendor}`.toLowerCase().includes(keyword)).map((model) => {
    const official = Number(model.official_request_usd) ? `$${numberText(model.official_request_usd)} / 次` : `输入 $${numberText(model.official_input_usd_per_1m)} · 输出 $${numberText(model.official_output_usd_per_1m)}`;
    return `<div class="model-row"><div class="model-row-head"><strong>${escapeHtml(model.model_name)}</strong><span class="muted">${official}</span></div><div class="model-price-list">${(model.upstreams || []).map((upstream) => `<div class="model-price-line"><span>${escapeHtml(upstream.upstream_name)}</span><strong>${upstream.upstream_request_usd != null ? `$${numberText(upstream.upstream_request_usd)} / 次` : `$${numberText(upstream.upstream_input_usd_per_1m)} / $${numberText(upstream.upstream_output_usd_per_1m)}`}</strong></div>`).join('') || '<span class="muted">暂无上游价格</span>'}</div></div>`;
  }).join('') || '<div class="empty-state">暂无模型价格</div>'}</section>`).join('');
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
  rows.innerHTML = (state.monitoring.items || []).map((site) => `<tr class="data-row" data-policy-site="${site.id}"><td><div class="cell-stack"><strong>${escapeHtml(site.name)}</strong><small>${escapeHtml(site.base_url)}</small></div></td><td><div class="policy-control"><label class="toggle-field compact-toggle"><input type="checkbox" data-policy-field="sync_enabled" ${Number(site.sync_enabled ?? 1) ? 'checked' : ''} aria-label="${escapeHtml(site.name)} 自动同步" /><span class="toggle-control"></span></label><input type="number" min="30" max="86400" value="${Number(site.sync_interval_seconds || 180)}" data-policy-field="sync_interval_seconds" aria-label="${escapeHtml(site.name)} 同步周期" /></div></td><td><div class="policy-control"><label class="toggle-field compact-toggle"><input type="checkbox" data-policy-field="key_check_enabled" ${Number(site.key_check_enabled ?? 1) ? 'checked' : ''} aria-label="${escapeHtml(site.name)} Key 探测" /><span class="toggle-control"></span></label><input type="number" min="60" max="86400" value="${Number(site.key_check_interval_seconds || 300)}" data-policy-field="key_check_interval_seconds" aria-label="${escapeHtml(site.name)} Key 探测周期" /></div></td><td><label class="toggle-field compact-toggle"><input type="checkbox" data-policy-field="alert_notifications_enabled" ${Number(site.alert_notifications_enabled ?? 1) ? 'checked' : ''} aria-label="${escapeHtml(site.name)} 微信通知" /><span class="toggle-control"></span></label></td><td><div class="policy-control"><label class="toggle-field compact-toggle"><input type="checkbox" data-policy-field="low_balance_alert_enabled" ${Number(site.low_balance_alert_enabled ?? 1) ? 'checked' : ''} aria-label="${escapeHtml(site.name)} 余额预警" /><span class="toggle-control"></span></label><input type="number" min="0" step="0.0001" value="${Number(site.low_balance_threshold ?? 10)}" data-policy-field="low_balance_threshold" aria-label="${escapeHtml(site.name)} 余额阈值" /></div></td><td><input class="policy-number" type="number" min="0" value="${Number(site.rate_change_threshold_percent ?? 20)}" data-policy-field="rate_change_threshold_percent" aria-label="${escapeHtml(site.name)} 倍率变化阈值" /></td><td class="align-right"><button class="icon-btn" type="button" data-save-upstream-policy="${site.id}" title="保存上游策略"><i data-lucide="save"></i></button></td></tr>`).join('') || '<tr><td colspan="7"><div class="empty-state">还没有上游</div></td></tr>';
}

function setSettingsTab(tab) {
  state.settingsTab = tab;
  document.querySelectorAll('[data-settings-tab]').forEach((button) => button.classList.toggle('active', button.dataset.settingsTab === tab));
  document.querySelectorAll('[data-settings-panel]').forEach((panel) => { panel.hidden = panel.dataset.settingsPanel !== tab; });
  refreshIcons();
}

function renderSettings() {
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
  const configured = Boolean(state.monitoring.pushplus?.configured);
  const source = state.monitoring.pushplus?.source;
  const badge = document.querySelector('#pushPlusBadge');
  badge.innerHTML = `<span class="status-dot ${configured ? 'healthy' : 'neutral'}"></span><span>PushPlus ${configured ? '已连接' : '未配置'}</span>`;
  const statusText = !configured
    ? '未配置'
    : source === 'database'
      ? `控制台配置 · ${state.monitoring.pushplus.token_masked || '已加密保存'}`
      : '环境变量配置';
  document.querySelector('#pushPlusSettingStatus').textContent = statusText;
  const count = Number(state.monitoring.open_alerts || 0);
  const countEl = document.querySelector('#sidebarAlertCount');
  countEl.hidden = !count;
  countEl.textContent = count > 99 ? '99+' : count;
}

function renderCurrentView() {
  if (state.activeView === 'overview') renderOverview();
  if (state.activeView === 'monitoring') renderMonitoring();
  if (state.activeView === 'keys') renderGlobalKeys();
  if (state.activeView === 'own-sites') renderOwnSites();
  if (state.activeView === 'pricing') renderPricing();
  if (state.activeView === 'usage') renderUsage();
  if (state.activeView === 'alerts') renderAlerts();
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
    const [monitoring, alerts, logs, rateChanges, pricing, ownSites, ownRoutes, runtimeSettings, systemUpdate] = await Promise.all([
      api('/api/monitoring/upstreams'),
      api('/api/alerts'),
      api('/api/sync-logs'),
      api('/api/rate-changes'),
      api('/api/model-pricing/board').catch(() => ({ openai: [], claude: [] })),
      api('/api/own-sites').catch(() => ({ items: [] })),
      api('/api/own-site-routes').catch(() => ({ items: [] })),
      api('/api/settings/runtime'),
      api('/api/system/update').catch(() => ({ enabled: false, message: '版本状态读取失败', operation: { phase: 'failed' } }))
    ]);
    state.monitoring = monitoring;
    state.alerts = alerts.items || [];
    state.logs = logs.items || [];
    state.rateChanges = rateChanges.items || [];
    state.pricing = pricing;
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
    document.querySelector('#detailSubtitle').textContent = site.base_url;
    const methods = Array.isArray(snapshot.payment_methods) ? snapshot.payment_methods.filter((item) => item?.available !== false) : [];
    document.querySelector('#detailContent').innerHTML = `
      <div class="detail-metrics"><div class="detail-metric"><span>余额</span><strong>$${numberText(snapshot.balance)}</strong></div><div class="detail-metric"><span>今日 Token</span><strong>${tokenText(snapshot.today_tokens)}</strong></div><div class="detail-metric"><span>今日成本</span><strong>$${numberText(snapshot.today_cost)}</strong></div><div class="detail-metric"><span>OpenAI 倍率</span><strong>${rateText(snapshot.openai_rate)}</strong></div><div class="detail-metric"><span>Anthropic 倍率</span><strong>${rateText(snapshot.anthropic_rate)}</strong></div><div class="detail-metric"><span>Key</span><strong>${snapshot.key_count || 0}</strong></div></div>
      <div class="detail-block"><div class="button-group"><button class="btn secondary" data-edit-from-detail="${site.id}"><i data-lucide="pencil"></i>编辑上游</button><button class="btn secondary" data-import-keys="${site.id}"><i data-lucide="download"></i>导入 Key</button><button class="btn primary" data-check-site-keys="${site.id}"><i data-lucide="activity"></i>检测 Key</button></div></div>
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

document.querySelector('#pushPlusForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const tokenInput = document.querySelector('#pushPlusTokenInput');
  const token = tokenInput.value.trim();
  if (!token) return toast('请输入 PushPlus Token', 'error');
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  await runAction(submit, '保存中', async () => {
    await api('/api/notifications/pushplus/settings', { method: 'PUT', body: JSON.stringify({ token }) });
    tokenInput.value = '';
    await refreshAll({ quiet: true });
    toast('PushPlus 配置已保存', 'success');
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
  toast(`模型同步完成：接口 ${result.live_groups}，使用记录 ${result.fallback_groups}，保留缓存 ${result.stale_groups || 0}`, 'success');
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
  if (target.dataset.toggleSite) { const id = Number(target.dataset.toggleSite); state.expandedSites.has(id) ? state.expandedSites.delete(id) : state.expandedSites.add(id); renderMonitoring(); refreshIcons(); return; }
  if (target.dataset.toggleKeySite) { const id = Number(target.dataset.toggleKeySite); state.expandedKeySites.has(id) ? state.expandedKeySites.delete(id) : state.expandedKeySites.add(id); renderGlobalKeys(); refreshIcons(); return; }
  if (target.dataset.detailSite) return openDetail(Number(target.dataset.detailSite));
  if (target.dataset.usageDetail) return openUsageDetail(target.dataset.usageDetail);
  if (target.dataset.editFromDetail) { closeDialog('detailDialog'); return openUpstreamDialog(Number(target.dataset.editFromDetail)); }
  if (target.dataset.syncSite) return runAction(target, '同步中', async () => { await api(`/api/upstreams/${target.dataset.syncSite}/sync`, { method: 'POST' }); await refreshAll({ quiet: true }); toast('上游同步完成', 'success'); });
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
  if (target.dataset.action === 'pushplus-test') return runAction(target, '发送中', async () => { await api('/api/notifications/pushplus/test', { method: 'POST' }); toast('测试推送已发送', 'success'); });
  if (target.dataset.action === 'pushplus-clear') {
    if (!confirm('确定清空控制台中的 PushPlus Token？')) return;
    return runAction(target, '清空中', async () => {
      await api('/api/notifications/pushplus/settings', { method: 'DELETE' });
      document.querySelector('#pushPlusTokenInput').value = '';
      await refreshAll({ quiet: true });
      toast('PushPlus 控制台配置已清空', 'success');
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
