const state = {
  dashboard: null,
  modelPricingBoard: { openai: [], claude: [] },
  upstreamKeys: [],
  upstreamKeyErrors: [],
  keyGroupsCache: new Map(),
  ownSites: [],
  ownRoutes: [],
  logs: [],
  details: new Map(),
  authEnabled: false,
  selectedDetailId: null,
  filters: {
    search: '',
    tag: '',
    status: '',
    sort: 'id_desc',
    rateSearch: '',
    rateScope: ''
  },
  keyFilters: {
    upstreamSiteId: '',
    platform: '',
    status: '',
    search: ''
  },
  ownRouteFilters: {
    matchStatus: '',
    search: ''
  }
};

const fmt = new Intl.NumberFormat('zh-CN');
const money = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 });

function tokenText(value) {
  const n = Number(value || 0);
  if (n >= 1_000_000) return `${money.format(n / 1_000_000)}M`;
  if (n >= 1_000) return `${money.format(n / 1_000)}K`;
  return fmt.format(n);
}

function rateText(value) {
  if (value === null || value === undefined || value === '') return '不可用';
  return `${money.format(Number(value))}x`;
}

function usdText(value, suffix = '/ 100万 token') {
  const n = Number(value);
  if (!Number.isFinite(n)) return '不可用';
  return `$${money.format(n)} ${suffix}`;
}

function rechargeText(site) {
  const multiplier = Number(site?.balance_recharge_multiplier);
  if (!Number.isFinite(multiplier)) return '不可用';
  if (Number(site?.balance_recharge_disabled)) return '已关闭';
  return `1 RMB = ${money.format(multiplier)} 余额`;
}

function rechargeMetaText(site) {
  const parts = [];
  if (Number.isFinite(Number(site?.recharge_fee_rate)) && Number(site.recharge_fee_rate) > 0) {
    parts.push(`手续费 ${money.format(site.recharge_fee_rate)}%`);
  }
  if (Number(site?.payment_plan_count || 0) > 0) {
    parts.push(`${Number(site.payment_plan_count)} 个套餐`);
  }
  if (!Number(site?.payment_enabled) && !Number.isFinite(Number(site?.balance_recharge_multiplier))) {
    parts.push('上游未开放支付接口');
  }
  return parts.join(' · ');
}

function parsePaymentMethods(site) {
  const raw = site?.payment_methods;
  if (Array.isArray(raw)) return raw.filter((item) => item?.type && item?.available !== false);
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw || '[]');
      return Array.isArray(parsed) ? parsed.filter((item) => item?.type && item?.available !== false) : [];
    } catch {
      return [];
    }
  }
  return [];
}

function paymentMethodLabel(type) {
  return {
    alipay: '支付宝',
    wxpay: '微信支付',
    alipay_direct: '支付宝直连',
    wxpay_direct: '微信直连',
    stripe: 'Stripe',
    easypay: '易支付',
    airwallex: 'Airwallex'
  }[type] || type;
}

function timeText(value) {
  if (!value) return '从未同步';
  return new Date(value).toLocaleString('zh-CN');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function parseList(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {})
    }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const details = data.details
      ? (typeof data.details === 'string' ? data.details : JSON.stringify(data.details))
      : '';
    throw new Error([data.error || `Request failed: ${res.status}`, details].filter(Boolean).join('；'));
  }
  return data;
}

function downloadText(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function renderImportResults(results = []) {
  document.querySelector('#importResults').innerHTML = results.length ? results.map((item) => `
    <div class="list-item">
      <strong>${escapeHtml(item.action === 'updated' ? '已更新' : '已新建')} · ${escapeHtml(item.name)}</strong>
      <small>${escapeHtml(item.base_url)} · ID ${escapeHtml(item.id)}</small>
    </div>
  `).join('') : '<p class="empty">没有导入任何上游。</p>';
}

async function importConfigFile(file) {
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.json') && file.type !== 'application/json') {
    throw new Error('请选择 JSON 配置文件。');
  }
  const text = await file.text();
  if (!text.trim()) throw new Error('导入文件为空。');
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    throw new Error('导入文件不是有效的 JSON。');
  }
  if (!Array.isArray(payload?.sites)) {
    throw new Error('导入文件格式不正确：需要包含 sites 数组。');
  }
  const result = await api('/api/import', { method: 'POST', body: JSON.stringify({ sites: payload.sites }) });
  document.querySelector('#importPanel').hidden = false;
  document.querySelector('#importSummary').textContent = `已导入 ${result.imported} 个上游：按 Base URL 自动更新或新建。`;
  renderImportResults(result.results || []);
  await refresh();
  document.querySelector('#importPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function getFormPayload() {
  const form = document.querySelector('#upstreamForm');
  const payload = Object.fromEntries(new FormData(form).entries());
  payload.tags = parseList(payload.tags);
  payload.low_balance_threshold = Number(payload.low_balance_threshold || 10);
  payload.rate_change_threshold_percent = Number(payload.rate_change_threshold_percent || 20);
  payload.sync_interval_seconds = Number(payload.sync_interval_seconds || 180);
  return payload;
}

function setForm(site = null, credentials = {}) {
  const form = document.querySelector('#upstreamForm');
  form.id.value = site?.id || '';
  form.name.value = site?.name || 'Stone API';
  form.base_url.value = site?.base_url || 'https://www.shitoutk.com';
  form.upstream_type.value = site?.upstream_type || 'auto';
  form.auth_mode.value = site?.auth_mode || 'password';
  form.email.value = credentials.email && !credentials.email.includes('*') ? credentials.email : '';
  form.password.value = '';
  form.token.value = '';
  form.tags.value = (site?.tags || []).join(',');
  form.low_balance_threshold.value = site?.low_balance_threshold ?? 10;
  form.rate_change_threshold_percent.value = site?.rate_change_threshold_percent ?? 20;
  form.sync_interval_seconds.value = site?.sync_interval_seconds ?? 180;
  form.notes.value = site?.notes || '';
  document.querySelector('#formTitle').textContent = site ? `编辑上游：${site.name}` : '新增上游';
  document.querySelector('#formMessage').textContent = site
    ? '正在编辑已有上游。密码或 Token 留空时会保留原凭证。'
    : '站点标签只是给你自己分类；OpenAI / Anthropic 倍率会按 Sub2API 分组平台自动识别。';
}

function showMessage(text, tone = '') {
  const el = document.querySelector('#formMessage');
  el.textContent = text;
  el.className = `notice ${tone}`.trim();
}

function renderCards(totals) {
  const cards = [
    ['上游总数', totals.upstreams],
    ['正常上游', totals.active],
    ['同步失败', totals.failed],
    ['今日 Token', tokenText(totals.today_tokens)],
    ['今日成本', money.format(totals.today_cost)],
    ['余额不足', totals.low_balance],
    ['倍率提醒', totals.unacknowledged_changes ?? state.dashboard?.changes?.length ?? 0],
    ['后台同步', '已开启']
  ];
  document.querySelector('#summaryCards').innerHTML = cards.map(([label, value], index) => `
    <article class="card" style="animation-delay:${index * 35}ms">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </article>
  `).join('');
}

function renderRechargeAlerts(alerts = []) {
  const panel = document.querySelector('#rechargeAlertsPanel');
  const container = document.querySelector('#rechargeAlerts');
  if (!alerts.length) {
    panel.hidden = true;
    container.innerHTML = '';
    return;
  }
  panel.hidden = false;
  container.innerHTML = alerts.map((item) => {
    const methods = (item.payment_methods || []).map((method) => paymentMethodLabel(method.type)).join('、');
    return `
      <div class="list-item">
        <strong>${escapeHtml(item.name)} · 余额 ${money.format(item.balance)} / 阈值 ${money.format(item.threshold)}</strong>
        <small>建议至少充值 RMB ${money.format(item.suggested_amount)} · ${item.payment_supported ? `官方可用：${escapeHtml(methods)}` : '该上游不支持在线充值'}</small>
        <button class="ghost" data-detail-id="${item.id}">查看详情</button>
      </div>
    `;
  }).join('');
}

function statusText(status) {
  return {
    active: '正常',
    sync_failed: '同步失败',
    login_failed: '登录失败',
    disabled: '已停用'
  }[status] || status || '未知';
}

function siteWarnings(site) {
  const warnings = [];
  const balance = Number(site.balance);
  const threshold = Number(site.low_balance_threshold || 10);
  if (Number.isFinite(balance) && balance > 0 && balance < threshold) warnings.push(`余额低于 ${threshold}`);
  if (site.last_sync_error) warnings.push(site.last_sync_error);
  if (!site.last_sync_at) warnings.push('尚未同步');
  if (isStaleSite(site)) warnings.push('长期未同步');
  return warnings;
}

function isLowBalanceSite(site) {
  const balance = Number(site.balance);
  const threshold = Number(site.low_balance_threshold || 10);
  return Number.isFinite(balance) && balance < threshold;
}

function isStaleSite(site) {
  if (!site.last_sync_at) return false;
  const intervalSeconds = Number(site.sync_interval_seconds || 180);
  const staleAfterMs = Math.max(intervalSeconds * 3, 3600) * 1000;
  return Date.now() - new Date(site.last_sync_at).getTime() > staleAfterMs;
}

function siteHasRateChange(site) {
  return Boolean(site.has_unacknowledged_rate_change)
    || (state.dashboard?.changes || []).some((item) => Number(item.upstream_site_id) === Number(site.id) && !item.acknowledged_at);
}

function filteredSites() {
  const sites = [...(state.dashboard?.sites || [])];
  const keyword = state.filters.search.toLowerCase();
  const tagKeyword = state.filters.tag.toLowerCase();
  const filtered = sites.filter((site) => {
    const text = `${site.name} ${site.base_url} ${(site.tags || []).join(' ')}`.toLowerCase();
    if (keyword && !text.includes(keyword)) return false;
    const tagText = (site.tags || []).join(' ').toLowerCase();
    if (tagKeyword && !tagText.includes(tagKeyword)) return false;
    if (state.filters.status === 'low_balance' && !isLowBalanceSite(site)) return false;
    if (state.filters.status === 'stale' && !isStaleSite(site)) return false;
    if (state.filters.status === 'rate_changed' && !siteHasRateChange(site)) return false;
    if (state.filters.status && !['low_balance', 'stale', 'rate_changed'].includes(state.filters.status) && site.status !== state.filters.status) return false;
    return true;
  });
  filtered.sort((a, b) => {
    if (state.filters.sort === 'balance_asc') return Number(a.balance ?? Infinity) - Number(b.balance ?? Infinity);
    if (state.filters.sort === 'tokens_desc') return Number(b.today_tokens || 0) - Number(a.today_tokens || 0);
    if (state.filters.sort === 'sync_desc') return new Date(b.last_sync_at || 0) - new Date(a.last_sync_at || 0);
    if (state.filters.sort === 'rate_asc') return Number(a.min_rate ?? Infinity) - Number(b.min_rate ?? Infinity);
    return Number(b.id || 0) - Number(a.id || 0);
  });
  return filtered;
}

function renderRows() {
  const rows = filteredSites().map((site) => {
    const warnings = siteWarnings(site);
    return `
      <tr>
        <td>
          <strong>${escapeHtml(site.name)}</strong>
          <span class="url">${escapeHtml(site.base_url)}</span>
          <small>type: ${escapeHtml(site.upstream_type || 'auto')}</small>
          <small>${escapeHtml((site.tags || []).join(' · '))}</small>
        </td>
        <td><span class="status ${escapeHtml(site.status)}">${escapeHtml(statusText(site.status))}</span></td>
        <td class="${isLowBalanceSite(site) ? 'danger-text' : ''}">
          ${site.balance ?? '不可用'} <small>${escapeHtml(site.balance_currency || '')}</small>
        </td>
        <td>
          <strong class="compact-value">${escapeHtml(rechargeText(site))}</strong>
          ${rechargeMetaText(site) ? `<small>${escapeHtml(rechargeMetaText(site))}</small>` : ''}
        </td>
        <td>${tokenText(site.today_tokens)}</td>
        <td>${money.format(site.today_cost || 0)}</td>
        <td>${escapeHtml(subscriptionCountText(site))}</td>
        <td>${rateText(site.openai_rate)}</td>
        <td>${rateText(site.anthropic_rate)}</td>
        <td>${rateText(site.min_rate)} - ${rateText(site.max_rate)}</td>
        <td>
          <div>${timeText(site.last_sync_at)}</div>
          ${warnings.length ? `<small class="danger-text">${escapeHtml(warnings.join('；'))}</small>` : ''}
        </td>
        <td class="actions">
          <button class="ghost" data-detail-id="${site.id}">详情</button>
          <button class="ghost" data-copy-url="${escapeHtml(site.base_url)}">复制</button>
          <button class="ghost" data-sync-id="${site.id}">同步</button>
          <button class="ghost" data-edit-id="${site.id}">编辑</button>
          <button class="ghost" data-status-id="${site.id}" data-next-status="${site.status === 'disabled' ? 'active' : 'disabled'}">${site.status === 'disabled' ? '启用' : '停用'}</button>
          <button class="ghost danger" data-delete-id="${site.id}">删除</button>
        </td>
      </tr>
    `;
  }).join('');
  document.querySelector('#upstreamRows').innerHTML = rows || '<tr><td colspan="12" class="empty">还没有匹配的上游。</td></tr>';
}

function renderRateChanges(changes) {
  document.querySelector('#rateChanges').innerHTML = changes.length ? changes.map((item) => {
    const percent = item.change_percent === null || item.change_percent === undefined ? '' : ` · ${money.format(item.change_percent)}%`;
    return `
        <div class="list-item">
          <strong>${escapeHtml(item.upstream_name)} · ${escapeHtml(item.group_name || item.group_id)}</strong>
        <small>${rateText(item.old_rate)} -> ${rateText(item.new_rate)}${percent} · ${timeText(item.detected_at)}${item.acknowledged_at ? ` · 已确认 ${timeText(item.acknowledged_at)}` : ''}</small>
        ${item.acknowledged_at ? '' : `<button class="ghost" data-ack-rate-change="${item.id}">确认</button>`}
      </div>
    `;
  }).join('') : '<p class="empty">暂时没有倍率变化。首次同步会建立基线。</p>';
}

function renderLogs(logs) {
  document.querySelector('#syncLogs').innerHTML = logs.length ? logs.map((item) => `
    <div class="list-item">
      <strong>${escapeHtml(item.upstream_name)} · ${escapeHtml(item.status)}</strong>
      <small>${escapeHtml(item.summary || item.error_message || '无摘要')} · ${item.duration_ms}ms · ${timeText(item.started_at)}</small>
    </div>
  `).join('') : '<p class="empty">暂无同步日志。</p>';
}

function rateMatchesFilter(rate, detail) {
  const text = `${rate.group_name} ${rate.group_id} ${rate.scope} ${rate.model} ${detail.site.name}`.toLowerCase();
  if (state.filters.rateSearch && !text.includes(state.filters.rateSearch.toLowerCase())) return false;
  if (!state.filters.rateScope) return true;
  return text.includes(state.filters.rateScope.toLowerCase());
}

function renderRates() {
  const latest = [];
  for (const detail of state.details.values()) {
    const seen = new Set();
    for (const rate of detail.rates || []) {
      const key = `${detail.site.id}:${rate.group_id}:${rate.group_name}:${rate.scope}:${rate.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!rateMatchesFilter(rate, detail)) continue;
      latest.push({ upstream: detail.site.name, ...rate });
    }
  }
  document.querySelector('#rateGrid').innerHTML = latest.length ? latest.slice(0, 48).map((rate) => `
    <article class="rate-pill">
      <small class="upstream-name">${escapeHtml(rate.upstream)}</small>
      <strong>${escapeHtml(rate.group_name || rate.group_id || '未命名分组')}</strong>
      <span>${rateText(rate.rate)}</span>
      <small>${rate.model ? `${escapeHtml(rate.model)} · ` : ''}${escapeHtml(rate.scope || '未标注平台')}</small>
    </article>
  `).join('') : '<p class="empty">没有匹配的倍率。可以换个筛选条件，或先同步上游。</p>';
}

function renderUpstreamPriceRow(item) {
  const isRequest = Number(item.quota_type || 0) === 1;
  const priceText = isRequest
    ? usdText(item.upstream_request_usd, '/ 次')
    : `输入 ${usdText(item.upstream_input_usd_per_1m)} · 输出 ${usdText(item.upstream_output_usd_per_1m)}`;
  const cacheText = !isRequest && Number.isFinite(Number(item.upstream_cache_read_usd_per_1m))
    ? `缓存读 ${usdText(item.upstream_cache_read_usd_per_1m)}`
    : '';
  return `
    <div class="upstream-price-row">
      <strong>${escapeHtml(item.upstream_name || `上游 #${item.upstream_site_id}`)}</strong>
      <span>${escapeHtml(priceText)}</span>
      <small>分组 ${escapeHtml(item.effective_group || 'default')} · 分组倍率 ${rateText(item.effective_group_ratio || 1)}${cacheText ? ` · ${escapeHtml(cacheText)}` : ''}</small>
    </div>
  `;
}

function renderModelPriceCard(model) {
  const isRequest = Number(model.quota_type || 0) === 1;
  const officialText = isRequest
    ? usdText(model.official_request_usd, '/ 次')
    : `输入 ${usdText(model.official_input_usd_per_1m)} · 输出 ${usdText(model.official_output_usd_per_1m)}`;
  return `
    <article class="model-board-card">
      <div class="model-board-head">
        <div>
          <strong>${escapeHtml(model.model_name)}</strong>
          <small>${escapeHtml(model.vendor || '')}${model.tags ? ` · ${escapeHtml(model.tags)}` : ''}</small>
        </div>
        <span><em>官方原价</em>${escapeHtml(officialText)}</span>
      </div>
      <div class="upstream-price-list">
        ${(model.upstreams || []).map(renderUpstreamPriceRow).join('') || '<p class="empty">暂无上游价格。</p>'}
      </div>
    </article>
  `;
}

function platformLabel(value) {
  const map = {
    openai: 'OpenAI',
    anthropic: 'Anthropic',
    gemini: 'Gemini',
    antigravity: 'Antigravity'
  };
  return map[String(value || '').toLowerCase()] || value || '-';
}

function keyStatusLabel(status) {
  return {
    active: '启用',
    inactive: '停用',
    quota_exhausted: '配额用尽',
    expired: '已过期'
  }[status] || status || '-';
}

function keyQuotaText(item) {
  const quota = Number(item?.quota);
  const used = Number(item?.quota_used);
  if (!Number.isFinite(quota) || quota <= 0) return '不限';
  return `${money.format(used || 0)} / ${money.format(quota)}`;
}

async function loadUpstreamKeys() {
  const params = new URLSearchParams({ live: 'true' });
  if (state.keyFilters.upstreamSiteId) params.set('upstream_site_id', state.keyFilters.upstreamSiteId);
  if (state.keyFilters.platform) params.set('platform', state.keyFilters.platform);
  if (state.keyFilters.status) params.set('status', state.keyFilters.status);
  if (state.keyFilters.search) params.set('search', state.keyFilters.search);
  const result = await api(`/api/upstream-keys?${params.toString()}`).catch(() => ({ items: [], errors: [] }));
  state.upstreamKeys = result.items || [];
  state.upstreamKeyErrors = result.errors || [];
  renderUpstreamKeyRows();
  renderUpstreamKeyErrors();
}

function populateKeyUpstreamFilters() {
  const sites = state.dashboard?.sites || [];
  const upstreamSelect = document.querySelector('#keyUpstreamFilter');
  const createSelect = document.querySelector('#createKeyUpstreamSelect');
  if (!upstreamSelect || !createSelect) return;
  const current = state.keyFilters.upstreamSiteId;
  upstreamSelect.innerHTML = '<option value="">全部上游</option>' + sites.map((site) => `
    <option value="${site.id}" ${String(site.id) === String(current) ? 'selected' : ''}>${escapeHtml(site.name)}</option>
  `).join('');
  createSelect.innerHTML = sites.map((site) => `
    <option value="${site.id}">${escapeHtml(site.name)}</option>
  `).join('');
}

function renderUpstreamKeyErrors() {
  const box = document.querySelector('#upstreamKeysErrors');
  if (!box) return;
  if (!state.upstreamKeyErrors.length) {
    box.hidden = true;
    box.textContent = '';
    return;
  }
  box.hidden = false;
  box.textContent = state.upstreamKeyErrors.map((item) => `${item.upstream_name}: ${item.error}`).join('；');
}

function keyGroupText(item) {
  if (item.group_name) return item.group_name;
  if (item.group_id !== undefined && item.group_id !== null && item.group_id !== '') return `分组 #${item.group_id}`;
  return '-';
}

function keyGroupRateText(item) {
  const rate = item.group_rate ?? item.rate_multiplier ?? item.user_rate_multiplier;
  const numeric = Number(rate);
  return Number.isFinite(numeric) ? `${money.format(numeric)}x` : '-';
}

function renderUpstreamKeyRows() {
  const tbody = document.querySelector('#upstreamKeyRows');
  if (!tbody) return;
  if (!state.upstreamKeys.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty">暂无 Key。可以先同步上游，或点击「创建 Key」。</td></tr>';
    return;
  }
  tbody.innerHTML = state.upstreamKeys.map((item) => `
    <tr>
      <td><strong>${escapeHtml(item.upstream_name || `#${item.upstream_site_id}`)}</strong></td>
      <td>${escapeHtml(item.name || '-')}</td>
      <td><code>${escapeHtml(item.key_masked || '-')}</code></td>
      <td>${escapeHtml(keyGroupText(item))}</td>
      <td><span class="key-platform-badge">${escapeHtml(platformLabel(item.platform))}</span></td>
      <td class="metric">${escapeHtml(keyGroupRateText(item))}</td>
      <td>${escapeHtml(keyStatusLabel(item.status))}</td>
      <td>${escapeHtml(keyQuotaText(item))}</td>
      <td>${escapeHtml(timeText(item.last_used_at))}</td>
      <td>
        <div class="key-actions">
          ${item.id ? `
            <button class="ghost" type="button" data-toggle-key-id="${item.id}" data-toggle-site-id="${item.upstream_site_id}" data-toggle-status="${item.status === 'active' ? 'inactive' : 'active'}">${item.status === 'active' ? '停用' : '启用'}</button>
            <button class="ghost" type="button" data-delete-key-id="${item.id}" data-delete-site-id="${item.upstream_site_id}">删除</button>
          ` : '<span class="empty">快照</span>'}
        </div>
      </td>
    </tr>
  `).join('');
}

function renderCreateKeyGroupOptions(groups) {
  const select = document.querySelector('#createKeyGroupSelect');
  if (!select) return;
  if (!groups.length) {
    select.innerHTML = '<option value="">该上游暂无可用分组</option>';
    select.disabled = true;
    return;
  }
  select.disabled = false;
  select.innerHTML = groups.map((group) => {
    const rateTextValue = keyGroupRateText(group);
    return `<option value="${group.id}">${escapeHtml(group.name)} · ${escapeHtml(platformLabel(group.platform))} · ${escapeHtml(rateTextValue)}</option>`;
  }).join('');
}

async function loadCreateKeyGroups(siteId, platform = '') {
  const select = document.querySelector('#createKeyGroupSelect');
  if (!siteId) {
    renderCreateKeyGroupOptions([]);
    return;
  }
  const cacheKey = `${siteId}:${platform}`;
  if (state.keyGroupsCache.has(cacheKey)) {
    renderCreateKeyGroupOptions(state.keyGroupsCache.get(cacheKey));
    return;
  }
  select.disabled = true;
  select.innerHTML = '<option value="">加载分组中...</option>';
  const params = platform ? `?platform=${encodeURIComponent(platform)}` : '';
  const result = await api(`/api/upstreams/${siteId}/key-groups${params}`).catch(() => ({ items: [] }));
  const groups = result.items || [];
  state.keyGroupsCache.set(cacheKey, groups);
  renderCreateKeyGroupOptions(groups);
}

function openCreateKeyDialog(preselectedSiteId = null) {
  populateKeyUpstreamFilters();
  const dialog = document.querySelector('#createKeyDialog');
  const form = document.querySelector('#createKeyForm');
  if (!dialog || !form) return;
  form.reset();
  document.querySelector('#createKeyMessage').textContent = '';
  if (preselectedSiteId) {
    document.querySelector('#createKeyUpstreamSelect').value = String(preselectedSiteId);
  }
  const siteId = document.querySelector('#createKeyUpstreamSelect').value;
  const platform = document.querySelector('#createKeyPlatformFilter').value;
  loadCreateKeyGroups(siteId, platform);
  dialog.showModal();
}

function showCreatedKeyDialog(key, item) {
  const dialog = document.querySelector('#createdKeyDialog');
  document.querySelector('#createdKeyValue').textContent = key || '';
  document.querySelector('#createdKeyMeta').textContent = item
    ? `${item.upstream_name || ''} · ${keyGroupText(item)} · ${platformLabel(item.platform)} · ${keyGroupRateText(item)}`
    : '';
  dialog.showModal();
}

function getOwnSitePayload() {
  const form = document.querySelector('#ownSiteForm');
  return Object.fromEntries(new FormData(form).entries());
}

function setOwnSiteForm(site = null, credentials = {}) {
  const form = document.querySelector('#ownSiteForm');
  if (!form) return;
  form.id.value = site?.id || '';
  form.name.value = site?.name || '';
  form.base_url.value = site?.base_url || '';
  form.own_site_type.value = site?.own_site_type || 'auto';
  form.auth_mode.value = site?.auth_mode || 'token';
  form.email.value = credentials.email && !credentials.email.includes('*') ? credentials.email : '';
  form.password.value = '';
  form.token.value = '';
  form.notes.value = site?.notes || '';
  document.querySelector('#ownSiteMessage').textContent = site
    ? `正在编辑自己站：${site.name}。密码或 Token 留空会保留原凭证。`
    : '第一版只做只读观测，不会修改你自己站的路由配置。';
}

function showOwnSiteMessage(text, tone = '') {
  const el = document.querySelector('#ownSiteMessage');
  if (!el) return;
  el.textContent = text;
  el.className = `notice ${tone}`.trim();
}

function ownRouteStatusText(status) {
  return {
    matched: '已匹配',
    unmatched: '未匹配'
  }[status] || status || '未知';
}

function rateDiffText(route) {
  const buy = Number(route.upstream_buy_rate);
  const sell = Number(route.matched_group_rate);
  if (!Number.isFinite(buy) || !Number.isFinite(sell)) return '-';
  const diff = sell - buy;
  const sign = diff > 0 ? '+' : '';
  return `${sign}${money.format(diff)}x`;
}

function buyRateText(route) {
  const rate = Number(route.upstream_buy_rate);
  return Number.isFinite(rate) ? rateText(rate) : '需绑定';
}

function renderOwnSites() {
  const box = document.querySelector('#ownSiteList');
  if (!box) return;
  box.innerHTML = state.ownSites.length ? state.ownSites.map((site) => `
    <div class="list-item">
      <strong>${escapeHtml(site.name)} · ${escapeHtml(statusText(site.status))}</strong>
      <small>${escapeHtml(site.base_url)} · 渠道 ${Number(site.route_count || 0)} · 已匹配 ${Number(site.matched_count || 0)} · 最近同步 ${escapeHtml(timeText(site.last_sync_at))}</small>
      ${site.last_sync_error ? `<small class="danger-text">${escapeHtml(site.last_sync_error)}</small>` : ''}
      <div class="key-actions">
        <button class="ghost" type="button" data-own-sync-id="${site.id}">同步</button>
        <button class="ghost" type="button" data-own-edit-id="${site.id}">编辑</button>
        <button class="ghost danger" type="button" data-own-delete-id="${site.id}">删除</button>
      </div>
    </div>
  `).join('') : '<p class="empty">还没有自己站。先在上方保存一个自己站，再同步渠道。</p>';
}

function renderOwnRoutes() {
  const tbody = document.querySelector('#ownRouteRows');
  if (!tbody) return;
  if (!state.ownRoutes.length) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty">暂无路由映射。保存自己站并同步后会显示。</td></tr>';
    return;
  }
  tbody.innerHTML = state.ownRoutes.map((route) => `
    <tr>
      <td>
        <strong>${escapeHtml(route.own_site_name || `自己站 #${route.own_site_id}`)}</strong>
        <small>${escapeHtml(route.route_name || route.route_id || '未命名渠道')}</small>
      </td>
      <td><span class="url">${escapeHtml(route.upstream_api_url || '-')}</span></td>
      <td>${route.matched_upstream_name ? `<strong>${escapeHtml(route.matched_upstream_name)}</strong>` : '<span class="empty">未匹配</span>'}</td>
      <td><code>${escapeHtml(route.upstream_key_masked || route.matched_upstream_key_id || '-')}</code></td>
      <td>${escapeHtml(route.matched_group_name || route.matched_group_id || '-')}</td>
      <td><span class="key-platform-badge">${escapeHtml(platformLabel(route.matched_platform))}</span></td>
      <td class="metric">${escapeHtml(buyRateText(route))}</td>
      <td class="metric">${escapeHtml(rateText(route.matched_group_rate))}</td>
      <td class="metric ${Number(route.matched_group_rate) >= Number(route.upstream_buy_rate) ? '' : 'danger-text'}">${escapeHtml(rateDiffText(route))}</td>
      <td>
        <span class="status ${escapeHtml(route.match_status || 'unmatched')}">${escapeHtml(ownRouteStatusText(route.match_status))}</span>
        <small>${escapeHtml(route.match_reason || '')}</small>
        <button class="ghost" type="button" data-bind-own-site-id="${route.own_site_id}" data-bind-route-id="${escapeHtml(route.route_id)}">绑定上游 Key</button>
      </td>
    </tr>
  `).join('');
}

function upstreamKeyBindingOptions() {
  return state.upstreamKeys.map((key) => {
    const value = `${key.upstream_site_id}::${key.id || key.upstream_key_id || ''}`;
    const label = `${key.upstream_name || `上游 #${key.upstream_site_id}`} · ${key.name || key.key_masked || '未命名 Key'} · ${key.key_masked || ''} · ${keyGroupText(key)} · ${keyGroupRateText(key)}`;
    return `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`;
  }).join('');
}

async function openBindOwnRouteDialog(ownSiteId, routeId) {
  if (!state.upstreamKeys.length) await loadUpstreamKeys();
  const dialog = document.querySelector('#bindOwnRouteDialog');
  const form = document.querySelector('#bindOwnRouteForm');
  const select = document.querySelector('#bindOwnRouteKeySelect');
  const message = document.querySelector('#bindOwnRouteMessage');
  if (!dialog || !form || !select) return;
  form.own_site_id.value = ownSiteId;
  form.route_id.value = routeId;
  select.innerHTML = upstreamKeyBindingOptions() || '<option value="">请先同步上游 Key 列表</option>';
  message.textContent = state.upstreamKeys.length ? '请选择这条自己站账号实际使用的上游 Key。' : '没有可绑定的上游 Key，请先在 API Key 管理里刷新。';
  dialog.showModal();
}

async function loadOwnSitesAndRoutes() {
  const params = new URLSearchParams();
  if (state.ownRouteFilters.matchStatus) params.set('match_status', state.ownRouteFilters.matchStatus);
  if (state.ownRouteFilters.search) params.set('search', state.ownRouteFilters.search);
  const [sitesResult, routesResult] = await Promise.all([
    api('/api/own-sites').catch(() => ({ items: [] })),
    api(`/api/own-site-routes?${params.toString()}`).catch(() => ({ items: [] }))
  ]);
  state.ownSites = sitesResult.items || [];
  state.ownRoutes = routesResult.items || [];
  renderOwnSites();
  renderOwnRoutes();
}

function renderModelPricingBoard() {
  const board = state.modelPricingBoard || { openai: [], claude: [] };
  const sections = [
    ['OpenAI 模型', board.openai || []],
    ['Claude 模型', board.claude || []]
  ];
  document.querySelector('#modelPricingBoard').innerHTML = sections.map(([title, models]) => `
    <section class="model-board-section">
      <div class="model-board-title">
        <h3>${escapeHtml(title)}</h3>
        <span>${models.length} 个模型</span>
      </div>
      <div class="model-board-grid">
        ${models.length ? models.map(renderModelPriceCard).join('') : '<p class="empty">暂无可对比的模型价格。请先同步支持 /api/pricing 的 new-api 上游。</p>'}
      </div>
    </section>
  `).join('');
}

function trendSvg(history) {
  const items = [...(history || [])].reverse().slice(-40);
  if (items.length < 2) return '<p class="empty">趋势数据还不够，至少同步两次后会显示折线。</p>';
  const width = 720;
  const height = 180;
  const fields = [
    ['balance', '余额', '#0d6b5f'],
    ['today_tokens', '今日 Token', '#dc7b2f']
  ];
  const lines = fields.map(([field, label, color]) => {
    const values = items.map((item) => Number(item[field] || 0));
    const max = Math.max(...values, 1);
    const points = values.map((value, index) => {
      const x = (index / Math.max(1, values.length - 1)) * width;
      const y = height - (value / max) * (height - 24) - 12;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return `<polyline fill="none" stroke="${color}" stroke-width="3" points="${points}" /><text x="8" y="${color === '#0d6b5f' ? 20 : 42}" fill="${color}" font-size="13">${label}</text>`;
  }).join('');
  return `<svg class="trend" viewBox="0 0 ${width} ${height}" role="img" aria-label="趋势图">${lines}</svg>`;
}

function renderCapabilities(capabilities = {}) {
  const items = [
    ['login', '登录'],
    ['balance', '余额'],
    ['usage', '用量'],
    ['rates', '倍率'],
    ['pricing', '模型广场'],
    ['keys_read', 'Key 查看'],
    ['keys_create', 'Key 创建'],
    ['keys', 'Key 数量'],
    ['channels', '渠道'],
    ['subscription', '订阅'],
    ['payment', '充值']
  ];
  return items.map(([key, label]) => `
    <span class="capability ${capabilities[key] ? 'ok' : 'missing'}">${label}：${capabilities[key] ? '支持' : '不可用'}</span>
  `).join('');
}

function renderRechargePanel(detail) {
  const snapshot = detail.snapshot || {};
  const methods = parsePaymentMethods(snapshot);
  const supported = Number(snapshot.payment_enabled) && !Number(snapshot.balance_recharge_disabled) && methods.length > 0;
  if (!supported) {
    return `
      <h3>在线充值</h3>
      <p class="empty">该上游不支持在线充值，或已关闭余额充值。</p>
    `;
  }
  const latestOrder = (detail.recharge_orders || [])[0];
  return `
    <h3>在线充值</h3>
    <div class="recharge-box">
      <div class="recharge-form">
        <label>充值金额 RMB<input data-recharge-amount="${detail.site.id}" type="number" min="1" step="0.01" value="10" /></label>
        <label>支付方式
          <select data-recharge-method="${detail.site.id}">
            ${methods.map((method) => `<option value="${escapeHtml(method.type)}">${escapeHtml(paymentMethodLabel(method.type))}</option>`).join('')}
          </select>
        </label>
        <button class="secondary" data-create-recharge="${detail.site.id}">创建充值订单</button>
      </div>
      <p class="detail-note">只调用上游官方订单接口。支付确认仍由支付宝、微信或上游收银台完成。</p>
      <div id="rechargeOrderBox-${detail.site.id}">
        ${latestOrder ? renderRechargeOrder(latestOrder) : '<p class="empty">暂无充值订单。</p>'}
      </div>
    </div>
  `;
}

function renderRechargeOrder(order) {
  const qr = order.qr_code || '';
  const payUrl = order.pay_url || '';
  const qrImage = qr.startsWith('http') || qr.startsWith('data:image')
    ? `<img class="payment-qr" src="${escapeHtml(qr)}" alt="支付二维码" />`
    : '';
  const qrText = qr && !qrImage ? `<code class="qr-text">${escapeHtml(qr)}</code>` : '';
  return `
    <div class="payment-order">
      <strong>订单 #${escapeHtml(order.upstream_order_id || order.id)} · ${escapeHtml(order.status || 'PENDING')}</strong>
      <small>支付 ${money.format(order.pay_amount || order.amount || 0)} · ${escapeHtml(order.payment_type || '')} · ${timeText(order.created_at)}</small>
      ${qrImage}
      ${qrText}
      <div class="form-actions">
        ${payUrl ? `<a class="button-link" href="${escapeHtml(payUrl)}" target="_blank" rel="noreferrer">打开收银台</a>` : ''}
        <button class="ghost" data-refresh-recharge="${order.id}">刷新订单状态</button>
      </div>
    </div>
  `;
}

function parseSubscriptionSummary(snapshot) {
  const raw = snapshot?.subscription_summary;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

function subscriptionCountText(snapshot) {
  const summary = parseSubscriptionSummary(snapshot);
  if (!summary.enabled) return '-';
  const active = Number(summary.active_count || 0);
  const total = Number(summary.total_count || active);
  return `${active} / ${total}`;
}

function parsePricingSummary(snapshot) {
  const raw = snapshot?.pricing_summary;
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
}

function modelPricingValue(item) {
  if (Number(item?.quota_type) === 1 && Number.isFinite(Number(item?.upstream_request_usd))) {
    return `${money.format(Number(item.upstream_request_usd))} / 次`;
  }
  if (Number.isFinite(Number(item?.upstream_input_usd_per_1m)) || Number.isFinite(Number(item?.upstream_output_usd_per_1m))) {
    const input = Number.isFinite(Number(item?.upstream_input_usd_per_1m)) ? money.format(Number(item.upstream_input_usd_per_1m)) : 'n/a';
    const output = Number.isFinite(Number(item?.upstream_output_usd_per_1m)) ? money.format(Number(item.upstream_output_usd_per_1m)) : 'n/a';
    return `输入 ${input} · 输出 ${output}`;
  }
  if (Number(item?.quota_type) === 1 && Number.isFinite(Number(item?.model_price))) {
    return `${money.format(Number(item.model_price))} 固定价格`;
  }
  if (Number.isFinite(Number(item?.model_ratio))) {
    return `${money.format(Number(item.model_ratio))}x`;
  }
  return 'n/a';
}

function detailPricingMeta(item) {
  const parts = [item.vendor || '未知供应商'];
  if (item.effective_group) parts.push(`分组 ${item.effective_group}`);
  if (Number.isFinite(Number(item.effective_group_ratio))) {
    parts.push(`倍率 ${money.format(Number(item.effective_group_ratio))}x`);
  }
  return parts.join(' · ');
}

function dateTimeFromSeconds(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return 'n/a';
  return new Date(n * 1000).toLocaleString();
}

function renderSubscriptionPanel(snapshot) {
  const summary = parseSubscriptionSummary(snapshot);
  if (!summary.enabled || !summary.primary) {
    return `
      <h3>订阅套餐</h3>
      <p class="empty">暂无活跃订阅套餐。</p>
    `;
  }
  const sub = summary.primary;
  const planName = sub.plan_title || `套餐 #${sub.plan_id || 'n/a'}`;
  const used = Number(sub.amount_used || 0);
  const total = Number(sub.amount_total || 0);
  const remaining = Number(sub.amount_remaining || 0);
  const percent = Number.isFinite(Number(sub.usage_percent)) ? Number(sub.usage_percent) : 0;
  const activeCount = Number(summary.active_count || 0);
  const totalCount = Number(summary.total_count || activeCount);
  return `
    <h3>订阅套餐</h3>
    <div class="detail-grid">
      <article class="metric"><span>活跃 / 全部</span><strong>${activeCount} / ${totalCount}</strong></article>
      <article class="metric"><span>套餐</span><strong>${escapeHtml(planName)}</strong></article>
      <article class="metric"><span>订阅 ID</span><strong>#${escapeHtml(sub.id || 'n/a')}</strong></article>
      <article class="metric"><span>状态</span><strong>${escapeHtml(sub.status || '未知')}</strong></article>
      <article class="metric"><span>扣费策略</span><strong>${escapeHtml(summary.billing_preference || '未知')}</strong></article>
      <article class="metric"><span>剩余天数</span><strong>${sub.days_remaining ?? 'n/a'}</strong></article>
      <article class="metric"><span>到期时间</span><strong>${escapeHtml(dateTimeFromSeconds(sub.end_time))}</strong></article>
      <article class="metric"><span>下次重置</span><strong>${escapeHtml(dateTimeFromSeconds(sub.next_reset_time))}</strong></article>
      <article class="metric"><span>总额度</span><strong>${money.format(total)}</strong></article>
      <article class="metric"><span>已用额度</span><strong>${money.format(used)}</strong></article>
      <article class="metric"><span>剩余额度</span><strong>${money.format(remaining)}</strong></article>
      <article class="metric"><span>使用比例</span><strong>${money.format(percent)}%</strong></article>
    </div>
  `;
}

function renderModelPricingPanel(detail) {
  const snapshot = detail.snapshot || {};
  const summary = parsePricingSummary(snapshot);
  const items = detail.model_pricing || [];
  if (!summary.enabled || !items.length) {
    return `
      <h3 id="modelPricingSection">模型广场价格</h3>
      <p class="empty">该上游暂未生成可展示的模型价格。可能是还没有同步，或暂时无法按倍率换算。</p>
    `;
  }
  const quickItems = items.slice(0, 30);
  const rangeText = Number.isFinite(Number(summary.min_model_rate)) && Number.isFinite(Number(summary.max_model_rate))
    ? `${rateText(summary.min_model_rate)} - ${rateText(summary.max_model_rate)}`
    : '按分组换算';
  const openaiMinText = Number.isFinite(Number(summary.openai_min_rate))
    ? rateText(summary.openai_min_rate)
    : '-';
  const anthropicMinText = Number.isFinite(Number(summary.anthropic_min_rate))
    ? rateText(summary.anthropic_min_rate)
    : '-';
  return `
    <h3 id="modelPricingSection">模型广场价格</h3>
    <div class="detail-grid">
      <article class="metric"><span>模型数量</span><strong>${Number(summary.model_count || items.length)}</strong></article>
      <article class="metric"><span>供应商数量</span><strong>${Number(summary.vendor_count || 0)}</strong></article>
      <article class="metric"><span>倍率范围</span><strong>${escapeHtml(rangeText)}</strong></article>
      <article class="metric"><span>OpenAI 最低</span><strong>${escapeHtml(openaiMinText)}</strong></article>
      <article class="metric"><span>Anthropic 最低</span><strong>${escapeHtml(anthropicMinText)}</strong></article>
      <article class="metric"><span>数据来源</span><strong>${escapeHtml(summary.source || 'pricing')}</strong></article>
    </div>
    ${summary.pricing_version ? `<p class="detail-note">模型广场版本：${escapeHtml(summary.pricing_version)}</p>` : ''}
    <div class="model-pricing-grid">
      ${quickItems.map((item) => `
        <article class="model-price-card">
          <strong>${escapeHtml(item.model_name)}</strong>
          <span>${escapeHtml(modelPricingValue(item))}</span>
          <small>${escapeHtml(detailPricingMeta(item))}</small>
        </article>
      `).join('')}
    </div>
  `;
}

function renderDetail(detail) {
  const snapshot = detail.snapshot || {};
  document.querySelector('#detailTitle').textContent = `上游详情：${detail.site.name}`;
  document.querySelector('#detailSubtitle').textContent = `${detail.site.base_url} · ${timeText(detail.site.last_sync_at)}`;
  document.querySelector('#detailContent').innerHTML = `
    <div class="detail-grid">
      <article class="metric"><span>余额</span><strong>${snapshot.balance ?? '不可用'}</strong></article>
      <article class="metric"><span>充值比例</span><strong>${escapeHtml(rechargeText(snapshot))}</strong></article>
      <article class="metric"><span>支付套餐</span><strong>${Number(snapshot.payment_plan_count || 0)}</strong></article>
      <article class="metric"><span>总 Token</span><strong>${tokenText(snapshot.total_tokens)}</strong></article>
      <article class="metric"><span>今日 Token</span><strong>${tokenText(snapshot.today_tokens)}</strong></article>
      <article class="metric"><span>近 7 天 Token</span><strong>${tokenText(snapshot.week_tokens)}</strong></article>
      <article class="metric"><span>近 30 天 Token</span><strong>${tokenText(snapshot.month_tokens)}</strong></article>
      <article class="metric"><span>总成本</span><strong>${money.format(snapshot.total_cost || 0)}</strong></article>
      <article class="metric"><span>近 7 天成本</span><strong>${money.format(snapshot.week_cost || 0)}</strong></article>
      <article class="metric"><span>近 30 天成本</span><strong>${money.format(snapshot.month_cost || 0)}</strong></article>
      <article class="metric"><span>Key 数量</span><strong>${snapshot.key_count || 0}</strong></article>
      <article class="metric"><span>渠道数量</span><strong>${snapshot.channel_count || 0}</strong></article>
      <article class="metric"><span>倍率范围</span><strong>${rateText(snapshot.min_rate)} - ${rateText(snapshot.max_rate)}</strong></article>
      <article class="metric"><span>OpenAI 倍率</span><strong>${rateText(snapshot.openai_rate)}</strong></article>
      <article class="metric"><span>Anthropic 倍率</span><strong>${rateText(snapshot.anthropic_rate)}</strong></article>
      <article class="metric"><span>模型广场</span><strong>${Number(parsePricingSummary(snapshot).model_count || 0)}</strong></article>
    </div>
    ${rechargeMetaText(snapshot) ? `<p class="detail-note">${escapeHtml(rechargeMetaText(snapshot))}</p>` : ''}
    <h3>接口能力矩阵</h3>
    <div class="capabilities">${renderCapabilities(detail.capabilities)}</div>
    <div class="detail-jump-actions">
      <button class="secondary" data-scroll-target="modelPricingSection">查看模型广场倍率</button>
      <button class="secondary" type="button" data-open-create-key="${detail.site.id}">在此上游创建 Key</button>
    </div>
    ${renderSubscriptionPanel(snapshot)}
    ${renderModelPricingPanel(detail)}
    ${renderRechargePanel(detail)}
    <h3>余额 / 用量趋势</h3>
    ${trendSvg(detail.history || [])}
    <h3>最近倍率</h3>
    <div class="rate-grid compact">
      ${(detail.rates || []).slice(0, 12).map((rate) => `
        <article class="rate-pill">
          <strong>${escapeHtml(rate.group_name || rate.group_id)}</strong>
          <span>${rateText(rate.rate)}</span>
          <small>${escapeHtml(rate.scope || 'unknown')} · ${timeText(rate.captured_at)}</small>
        </article>
      `).join('') || '<p class="empty">暂无倍率数据。</p>'}
    </div>
    <h3>最近同步记录</h3>
    <div class="list">
      ${(detail.logs || []).slice(0, 8).map((log) => `
        <div class="list-item">
          <strong>${escapeHtml(log.status)} · ${timeText(log.started_at)}</strong>
          <small>${escapeHtml(log.summary || log.error_message || '无摘要')}</small>
        </div>
      `).join('') || '<p class="empty">暂无同步记录。</p>'}
    </div>
  `;
  document.querySelector('#detailPanel').hidden = false;
  document.querySelector('#detailPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadDetails(sites) {
  const details = await Promise.all((sites || []).map((site) => api(`/api/upstreams/${site.id}`).catch(() => null)));
  state.details.clear();
  for (const detail of details) {
    if (detail) state.details.set(Number(detail.site.id), detail);
  }
}

async function refresh() {
  const [dashboard, logs, modelPricingBoard] = await Promise.all([
    api('/api/dashboard'),
    api('/api/sync-logs'),
    api('/api/model-pricing/board').catch(() => ({ openai: [], claude: [] }))
  ]);
  state.dashboard = dashboard;
  state.logs = logs.items || [];
  state.modelPricingBoard = modelPricingBoard;
  await loadDetails(dashboard.sites || []);
  renderCards(dashboard.totals);
  renderRechargeAlerts(dashboard.recharge_alerts || []);
  renderRows();
  renderRateChanges(dashboard.changes || []);
  renderLogs(state.logs.slice(0, 20));
  renderRates();
  renderModelPricingBoard();
  populateKeyUpstreamFilters();
  await loadUpstreamKeys();
  await loadOwnSitesAndRoutes();
  if (state.selectedDetailId && state.details.has(state.selectedDetailId)) {
    renderDetail(state.details.get(state.selectedDetailId));
  }
  document.querySelector('#lastUpdated').textContent = `最后刷新：${new Date().toLocaleString('zh-CN')}`;
}

async function withButton(button, label, fn) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    await fn();
  } catch (err) {
    alert(err.message);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

async function bootstrapAuth() {
  const session = await api('/api/session');
  state.authEnabled = session.auth_enabled;
  document.querySelector('#logoutBtn').hidden = !session.auth_enabled;
  document.querySelector('#loginPanel').hidden = session.authenticated;
  document.querySelector('#consoleShell').hidden = !session.authenticated;
  if (session.authenticated) await refresh();
}

document.querySelector('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
  await api('/api/login', { method: 'POST', body: JSON.stringify(payload) });
  event.currentTarget.reset();
  await bootstrapAuth();
});

document.querySelector('#logoutBtn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  await bootstrapAuth();
});

document.querySelector('#themeBtn').addEventListener('click', () => {
  document.body.classList.toggle('dark');
  localStorage.setItem('sub2api-theme', document.body.classList.contains('dark') ? 'dark' : 'light');
});

document.querySelector('#exportBtn').addEventListener('click', async () => {
  const data = await api('/api/export');
  downloadText(`sub2api-upstreams-${Date.now()}.json`, JSON.stringify(data, null, 2));
});

document.querySelector('#importBtn').addEventListener('click', () => {
  document.querySelector('#importFileInput').click();
});

document.querySelector('#importFileInput').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  try {
    await importConfigFile(file);
  } catch (err) {
    document.querySelector('#importPanel').hidden = false;
    document.querySelector('#importSummary').textContent = `导入失败：${err.message}`;
    document.querySelector('#importResults').innerHTML = '';
    alert(err.message);
  } finally {
    event.target.value = '';
  }
});

document.querySelector('#closeImportBtn').addEventListener('click', () => {
  document.querySelector('#importPanel').hidden = true;
});

document.querySelector('#backupBtn').addEventListener('click', () => {
  window.location.href = '/api/backup/database';
});

document.querySelector('#upstreamForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = getFormPayload();
  const id = payload.id;
  delete payload.id;
  const method = id ? 'PUT' : 'POST';
  const url = id ? `/api/upstreams/${id}` : '/api/upstreams';
  if (!payload.password) delete payload.password;
  if (!payload.token) delete payload.token;
  await api(url, { method, body: JSON.stringify(payload) });
  showMessage(id ? '上游已更新。' : '上游已保存。', 'success');
  setForm();
  await refresh();
});

document.querySelector('#testConnectionBtn').addEventListener('click', async (event) => {
  await withButton(event.currentTarget, '测试中...', async () => {
    const payload = getFormPayload();
    delete payload.id;
    const result = await api('/api/upstreams/test', { method: 'POST', body: JSON.stringify(payload) });
    showMessage(`连接成功：余额 ${result.snapshot.balance ?? '不可用'}，充值 ${rechargeText(result.snapshot)}，倍率 ${result.rates_count} 个，Key ${result.keys_count} 个。`, 'success');
  });
});

document.querySelector('#resetFormBtn').addEventListener('click', () => {
  setForm();
});

document.querySelector('#ownSiteForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const payload = getOwnSitePayload();
  const id = payload.id;
  delete payload.id;
  if (!payload.password) delete payload.password;
  if (!payload.token) delete payload.token;
  const method = id ? 'PUT' : 'POST';
  const url = id ? `/api/own-sites/${id}` : '/api/own-sites';
  await api(url, { method, body: JSON.stringify(payload) });
  showOwnSiteMessage(id ? '自己站已更新。' : '自己站已保存，可以点击同步读取渠道。', 'success');
  setOwnSiteForm();
  await loadOwnSitesAndRoutes();
});

document.querySelector('#testOwnSiteBtn')?.addEventListener('click', async (event) => {
  const payload = getOwnSitePayload();
  if (!payload.id) {
    showOwnSiteMessage('请先保存自己站，再测试读取渠道。', 'error');
    return;
  }
  await withButton(event.currentTarget, '测试中...', async () => {
    const result = await api(`/api/own-sites/${payload.id}/test`, { method: 'POST' });
    showOwnSiteMessage(`读取成功：${result.routes_count} 条渠道，来源 ${result.source_path}。`, 'success');
  });
});

document.querySelector('#resetOwnSiteFormBtn')?.addEventListener('click', () => {
  setOwnSiteForm();
});

document.querySelector('#refreshOwnSitesBtn')?.addEventListener('click', async (event) => {
  await withButton(event.currentTarget, '刷新中...', loadOwnSitesAndRoutes);
});

document.querySelector('#closeDetailBtn').addEventListener('click', () => {
  state.selectedDetailId = null;
  document.querySelector('#detailPanel').hidden = true;
});

document.addEventListener('click', async (event) => {
  const detailId = event.target?.dataset?.detailId;
  if (detailId) {
    state.selectedDetailId = Number(detailId);
    const detail = await api(`/api/upstreams/${detailId}`);
    state.details.set(Number(detailId), detail);
    renderDetail(detail);
  }

  const scrollTarget = event.target?.dataset?.scrollTarget;
  if (scrollTarget) {
    document.getElementById(scrollTarget)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const copyUrl = event.target?.dataset?.copyUrl;
  if (copyUrl) {
    await navigator.clipboard.writeText(copyUrl);
    event.target.textContent = '已复制';
    setTimeout(() => { event.target.textContent = '复制'; }, 1200);
  }

  const syncId = event.target?.dataset?.syncId;
  if (syncId) {
    await withButton(event.target, '同步中...', async () => {
      await api(`/api/upstreams/${syncId}/sync`, { method: 'POST' });
      await refresh();
    });
  }

  const editId = event.target?.dataset?.editId;
  if (editId) {
    const detail = state.details.get(Number(editId)) || await api(`/api/upstreams/${editId}`);
    setForm(detail.site, detail.credentials);
    document.querySelector('#upstreamForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const deleteId = event.target?.dataset?.deleteId;
  if (deleteId) {
    const site = state.dashboard?.sites?.find((item) => Number(item.id) === Number(deleteId));
    if (!confirm(`确定删除上游「${site?.name || deleteId}」吗？这会同时删除它的快照和日志。`)) return;
    await api(`/api/upstreams/${deleteId}`, { method: 'DELETE' });
    await refresh();
  }

  const statusId = event.target?.dataset?.statusId;
  if (statusId) {
    const nextStatus = event.target.dataset.nextStatus;
    await api(`/api/upstreams/${statusId}/status`, { method: 'POST', body: JSON.stringify({ status: nextStatus }) });
    await refresh();
  }

  const ackRateChangeId = event.target?.dataset?.ackRateChange;
  if (ackRateChangeId) {
    await api(`/api/rate-changes/${ackRateChangeId}/ack`, { method: 'POST' });
    await refresh();
  }

  const createRechargeId = event.target?.dataset?.createRecharge;
  if (createRechargeId) {
    await withButton(event.target, '创建中...', async () => {
      const amount = Number(document.querySelector(`[data-recharge-amount="${createRechargeId}"]`)?.value || 0);
      const paymentType = document.querySelector(`[data-recharge-method="${createRechargeId}"]`)?.value || 'alipay';
      const result = await api(`/api/upstreams/${createRechargeId}/recharge-orders`, {
        method: 'POST',
        body: JSON.stringify({ amount, payment_type: paymentType, order_type: 'balance', is_mobile: false })
      });
      document.querySelector(`#rechargeOrderBox-${createRechargeId}`).innerHTML = renderRechargeOrder(result.order);
      await refresh();
    });
  }

  const refreshRechargeId = event.target?.dataset?.refreshRecharge;
  if (refreshRechargeId) {
    await withButton(event.target, '刷新中...', async () => {
      const result = await api(`/api/recharge-orders/${refreshRechargeId}/refresh`, { method: 'POST' });
      const detail = state.selectedDetailId ? await api(`/api/upstreams/${state.selectedDetailId}`) : null;
      if (detail) {
        state.details.set(Number(detail.site.id), detail);
        renderDetail(detail);
      } else {
        event.target.closest('.payment-order').outerHTML = renderRechargeOrder(result.order);
      }
    });
  }

  const openCreateKeyId = event.target?.dataset?.openCreateKey;
  if (openCreateKeyId) {
    openCreateKeyDialog(Number(openCreateKeyId));
  }

  const toggleKeyId = event.target?.dataset?.toggleKeyId;
  if (toggleKeyId) {
    const siteId = event.target.dataset.toggleSiteId;
    const status = event.target.dataset.toggleStatus;
    await withButton(event.target, '处理中...', async () => {
      await api(`/api/upstreams/${siteId}/keys/${toggleKeyId}`, {
        method: 'PUT',
        body: JSON.stringify({ status })
      });
      await loadUpstreamKeys();
    });
  }

  const deleteKeyId = event.target?.dataset?.deleteKeyId;
  if (deleteKeyId) {
    const siteId = event.target.dataset.deleteSiteId;
    if (!confirm('确定删除这个 Key 吗？此操作不可恢复。')) return;
    await withButton(event.target, '删除中...', async () => {
      await api(`/api/upstreams/${siteId}/keys/${deleteKeyId}`, { method: 'DELETE' });
      await loadUpstreamKeys();
    });
  }

  const ownSyncId = event.target?.dataset?.ownSyncId;
  if (ownSyncId) {
    await withButton(event.target, '同步中...', async () => {
      await api(`/api/own-sites/${ownSyncId}/sync`, { method: 'POST' });
      await loadOwnSitesAndRoutes();
    });
  }

  const ownEditId = event.target?.dataset?.ownEditId;
  if (ownEditId) {
    const detail = await api(`/api/own-sites/${ownEditId}`);
    setOwnSiteForm(detail.site, detail.credentials);
    document.querySelector('#ownSiteForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const ownDeleteId = event.target?.dataset?.ownDeleteId;
  if (ownDeleteId) {
    const site = state.ownSites.find((item) => Number(item.id) === Number(ownDeleteId));
    if (!confirm(`确定删除自己站「${site?.name || ownDeleteId}」吗？这会同时删除它的路由快照。`)) return;
    await api(`/api/own-sites/${ownDeleteId}`, { method: 'DELETE' });
    await loadOwnSitesAndRoutes();
  }

  const bindOwnSiteId = event.target?.dataset?.bindOwnSiteId;
  if (bindOwnSiteId) {
    await openBindOwnRouteDialog(Number(bindOwnSiteId), event.target.dataset.bindRouteId || '');
  }
});

document.querySelector('#syncAllBtn').addEventListener('click', async (event) => {
  await withButton(event.currentTarget, '同步中...', async () => {
    await api('/api/sync-all', { method: 'POST' });
    await refresh();
  });
});

document.querySelector('#searchInput').addEventListener('input', (event) => {
  state.filters.search = event.target.value;
  renderRows();
});

document.querySelector('#tagFilterInput').addEventListener('input', (event) => {
  state.filters.tag = event.target.value;
  renderRows();
});

document.querySelector('#statusFilter').addEventListener('change', (event) => {
  state.filters.status = event.target.value;
  renderRows();
});

document.querySelector('#sortSelect').addEventListener('change', (event) => {
  state.filters.sort = event.target.value;
  renderRows();
});

document.querySelector('#rateSearchInput').addEventListener('input', (event) => {
  state.filters.rateSearch = event.target.value;
  renderRates();
});

document.querySelector('#rateScopeFilter').addEventListener('change', (event) => {
  state.filters.rateScope = event.target.value;
  renderRates();
});

document.querySelector('#openCreateKeyBtn')?.addEventListener('click', () => openCreateKeyDialog());
document.querySelector('#refreshKeysBtn')?.addEventListener('click', async (event) => {
  await withButton(event.currentTarget, '刷新中...', loadUpstreamKeys);
});
document.querySelector('#keyUpstreamFilter')?.addEventListener('change', (event) => {
  state.keyFilters.upstreamSiteId = event.target.value;
  loadUpstreamKeys().catch(console.error);
});
document.querySelector('#keyPlatformFilter')?.addEventListener('change', (event) => {
  state.keyFilters.platform = event.target.value;
  loadUpstreamKeys().catch(console.error);
});
document.querySelector('#keyStatusFilter')?.addEventListener('change', (event) => {
  state.keyFilters.status = event.target.value;
  loadUpstreamKeys().catch(console.error);
});
document.querySelector('#keySearchInput')?.addEventListener('input', (event) => {
  state.keyFilters.search = event.target.value;
  loadUpstreamKeys().catch(console.error);
});
document.querySelector('#ownRouteMatchFilter')?.addEventListener('change', (event) => {
  state.ownRouteFilters.matchStatus = event.target.value;
  loadOwnSitesAndRoutes().catch(console.error);
});
document.querySelector('#ownRouteSearchInput')?.addEventListener('input', (event) => {
  state.ownRouteFilters.search = event.target.value;
  loadOwnSitesAndRoutes().catch(console.error);
});
document.querySelector('#createKeyUpstreamSelect')?.addEventListener('change', (event) => {
  const platform = document.querySelector('#createKeyPlatformFilter')?.value || '';
  loadCreateKeyGroups(event.target.value, platform).catch(console.error);
});
document.querySelector('#createKeyPlatformFilter')?.addEventListener('change', (event) => {
  const siteId = document.querySelector('#createKeyUpstreamSelect')?.value || '';
  state.keyGroupsCache.delete(`${siteId}:${event.target.value}`);
  loadCreateKeyGroups(siteId, event.target.value).catch(console.error);
});
document.querySelector('#closeCreateKeyBtn')?.addEventListener('click', () => {
  document.querySelector('#createKeyDialog')?.close();
});
document.querySelector('#closeCreatedKeyBtn')?.addEventListener('click', () => {
  document.querySelector('#createdKeyDialog')?.close();
});
document.querySelector('#closeBindOwnRouteBtn')?.addEventListener('click', () => {
  document.querySelector('#bindOwnRouteDialog')?.close();
});
document.querySelector('#copyCreatedKeyBtn')?.addEventListener('click', async () => {
  const text = document.querySelector('#createdKeyValue')?.textContent || '';
  if (!text) return;
  await navigator.clipboard.writeText(text);
  showMessage('Key 已复制到剪贴板', 'success');
});
document.querySelector('#bindOwnRouteForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const [upstreamSiteId, upstreamKeyId] = String(form.binding.value || '').split('::');
  const message = document.querySelector('#bindOwnRouteMessage');
  if (!upstreamSiteId || !upstreamKeyId) {
    message.textContent = '请选择要绑定的上游 Key。';
    return;
  }
  await api(`/api/own-sites/${form.own_site_id.value}/routes/${encodeURIComponent(form.route_id.value)}/manual-bind`, {
    method: 'POST',
    body: JSON.stringify({
      upstream_site_id: Number(upstreamSiteId),
      upstream_key_id: upstreamKeyId,
      notes: '前端手动绑定'
    })
  });
  document.querySelector('#bindOwnRouteDialog')?.close();
  await loadOwnSitesAndRoutes();
});
document.querySelector('#createKeyForm')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.querySelector('#createKeyMessage');
  const siteId = Number(form.upstream_site_id.value);
  const groupId = Number(form.group_id.value);
  const name = String(form.name.value || '').trim();
  if (!siteId || !groupId || !name) {
    message.textContent = '请完整填写上游、分组和名称。';
    return;
  }
  const body = { name, group_id: groupId };
  const quota = Number(form.quota.value);
  const expiresInDays = Number(form.expires_in_days.value);
  if (Number.isFinite(quota) && quota > 0) body.quota = quota;
  if (Number.isFinite(expiresInDays) && expiresInDays > 0) body.expires_in_days = expiresInDays;
  message.textContent = '创建中...';
  try {
    const result = await api(`/api/upstreams/${siteId}/keys`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
    document.querySelector('#createKeyDialog')?.close();
    showCreatedKeyDialog(result.key, result.item);
    showMessage(result.message || 'Key 创建成功', 'success');
    await refresh();
  } catch (err) {
    message.textContent = err.message;
  }
});

if (localStorage.getItem('sub2api-theme') === 'dark') {
  document.body.classList.add('dark');
}

bootstrapAuth().catch((err) => {
  document.querySelector('#loginPanel').hidden = true;
  document.querySelector('#consoleShell').hidden = false;
  document.querySelector('#lastUpdated').textContent = `加载失败：${err.message}`;
});

setInterval(() => {
  if (!document.querySelector('#consoleShell').hidden) refresh().catch(console.error);
}, 30000);
