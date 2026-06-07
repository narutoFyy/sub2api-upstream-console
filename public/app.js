const state = {
  dashboard: null,
  logs: [],
  details: new Map(),
  authEnabled: false,
  filters: {
    search: '',
    status: '',
    sort: 'id_desc',
    rateSearch: '',
    rateScope: ''
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
    throw new Error(data.error || `Request failed: ${res.status}`);
  }
  return data;
}

function getFormPayload() {
  const form = document.querySelector('#upstreamForm');
  const payload = Object.fromEntries(new FormData(form).entries());
  payload.tags = parseList(payload.tags);
  payload.codex_aliases = parseList(payload.codex_aliases || 'codex');
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
  form.auth_mode.value = site?.auth_mode || 'password';
  form.email.value = credentials.email || '';
  form.password.value = '';
  form.token.value = '';
  form.tags.value = (site?.tags || []).join(',');
  form.codex_aliases.value = (site?.codex_aliases || ['codex']).join(',');
  form.low_balance_threshold.value = site?.low_balance_threshold ?? 10;
  form.rate_change_threshold_percent.value = site?.rate_change_threshold_percent ?? 20;
  form.sync_interval_seconds.value = site?.sync_interval_seconds ?? 180;
  form.notes.value = site?.notes || '';
  document.querySelector('#formTitle').textContent = site ? `编辑上游：${site.name}` : '新增上游';
  document.querySelector('#formMessage').textContent = site ? '正在编辑已有上游。密码或 Token 留空时会保留原凭证。' : '';
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
    ['倍率提醒', state.dashboard?.changes?.length || 0],
    ['后台同步', '已开启']
  ];
  document.querySelector('#summaryCards').innerHTML = cards.map(([label, value], index) => `
    <article class="card" style="animation-delay:${index * 35}ms">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </article>
  `).join('');
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
  return warnings;
}

function filteredSites() {
  const sites = [...(state.dashboard?.sites || [])];
  const keyword = state.filters.search.toLowerCase();
  const filtered = sites.filter((site) => {
    const text = `${site.name} ${site.base_url} ${(site.tags || []).join(' ')}`.toLowerCase();
    if (keyword && !text.includes(keyword)) return false;
    if (state.filters.status && site.status !== state.filters.status) return false;
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
          <small>${escapeHtml((site.tags || []).join(' · '))}</small>
        </td>
        <td><span class="status ${escapeHtml(site.status)}">${escapeHtml(statusText(site.status))}</span></td>
        <td class="${warnings.some((item) => item.startsWith('余额')) ? 'danger-text' : ''}">
          ${site.balance ?? '不可用'} <small>${escapeHtml(site.balance_currency || '')}</small>
        </td>
        <td>${tokenText(site.today_tokens)}</td>
        <td>${money.format(site.today_cost || 0)}</td>
        <td>${rateText(site.codex_rate)}</td>
        <td>${rateText(site.min_rate)} - ${rateText(site.max_rate)}</td>
        <td>
          <div>${timeText(site.last_sync_at)}</div>
          ${warnings.length ? `<small class="danger-text">${escapeHtml(warnings.join('；'))}</small>` : ''}
        </td>
        <td class="actions">
          <button class="ghost" data-sync-id="${site.id}">同步</button>
          <button class="ghost" data-edit-id="${site.id}">编辑</button>
          <button class="ghost danger" data-delete-id="${site.id}">删除</button>
        </td>
      </tr>
    `;
  }).join('');
  document.querySelector('#upstreamRows').innerHTML = rows || '<tr><td colspan="9" class="empty">还没有匹配的上游。</td></tr>';
}

function renderRateChanges(changes) {
  document.querySelector('#rateChanges').innerHTML = changes.length ? changes.map((item) => {
    const percent = item.change_percent === null || item.change_percent === undefined ? '' : ` · ${money.format(item.change_percent)}%`;
    return `
      <div class="list-item">
        <strong>${escapeHtml(item.upstream_name)} · ${escapeHtml(item.group_name || item.group_id)}</strong>
        <small>${rateText(item.old_rate)} -> ${rateText(item.new_rate)}${percent} · ${timeText(item.detected_at)}</small>
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
  if (state.filters.rateScope === 'codex') {
    return (detail.site.codex_aliases || ['codex']).some((alias) => text.includes(String(alias).toLowerCase()));
  }
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
      <strong>${escapeHtml(rate.group_name || rate.group_id || '未命名分组')}</strong>
      <span>${rateText(rate.rate)}</span>
      <small>${escapeHtml(rate.upstream)}${rate.model ? ` · ${escapeHtml(rate.model)}` : ''}${rate.scope ? ` · ${escapeHtml(rate.scope)}` : ''}</small>
    </article>
  `).join('') : '<p class="empty">没有匹配的倍率。可以换个筛选条件，或先同步上游。</p>';
}

async function loadDetails(sites) {
  const details = await Promise.all((sites || []).map((site) => api(`/api/upstreams/${site.id}`).catch(() => null)));
  state.details.clear();
  for (const detail of details) {
    if (detail) state.details.set(Number(detail.site.id), detail);
  }
}

async function refresh() {
  const [dashboard, logs] = await Promise.all([
    api('/api/dashboard'),
    api('/api/sync-logs')
  ]);
  state.dashboard = dashboard;
  state.logs = logs.items || [];
  await loadDetails(dashboard.sites || []);
  renderCards(dashboard.totals);
  renderRows();
  renderRateChanges(dashboard.changes || []);
  renderLogs(state.logs.slice(0, 20));
  renderRates();
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
    showMessage(`连接成功：余额 ${result.snapshot.balance ?? '不可用'}，倍率 ${result.rates_count} 个，Key ${result.keys_count} 个。`, 'success');
  });
});

document.querySelector('#resetFormBtn').addEventListener('click', () => {
  setForm();
});

document.addEventListener('click', async (event) => {
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

bootstrapAuth().catch((err) => {
  document.querySelector('#loginPanel').hidden = true;
  document.querySelector('#consoleShell').hidden = false;
  document.querySelector('#lastUpdated').textContent = `加载失败：${err.message}`;
});

setInterval(() => {
  if (!document.querySelector('#consoleShell').hidden) refresh().catch(console.error);
}, 30000);
