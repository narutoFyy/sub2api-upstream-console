const { requestJson } = require('./upstreamClient');

const LIST_PAGE_SIZE = 100;
const MAX_LIST_PAGES = 5;

function adminOptions(apiKey, timeoutMs) {
  return { headers: { 'x-api-key': apiKey }, timeoutMs };
}

function unwrapItems(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.list)) return data.list;
  return [];
}

function normalizeGroup(raw) {
  return {
    id: String(raw?.id ?? ''),
    name: String(raw?.name || `分组 ${raw?.id ?? ''}`),
    platform: String(raw?.platform || ''),
    is_exclusive: Boolean(raw?.is_exclusive),
    status: String(raw?.status || '')
  };
}

async function listAdminGroups({ baseUrl, apiKey, timeoutMs = 15000 }) {
  let items;
  try {
    items = unwrapItems(await requestJson(baseUrl, '/admin/groups/all?include_inactive=true', adminOptions(apiKey, timeoutMs)));
  } catch (error) {
    if (![404, 405].includes(Number(error.status))) throw error;
    items = unwrapItems(await requestJson(baseUrl, '/admin/groups?page=1&page_size=1000', adminOptions(apiKey, timeoutMs)));
  }
  return items.map(normalizeGroup).filter((group) => group.id);
}

async function listRequestErrors({ baseUrl, apiKey, startTime, endTime, groupId = '', timeoutMs = 15000 }) {
  const items = [];
  for (let page = 1; page <= MAX_LIST_PAGES; page += 1) {
    const params = new URLSearchParams({
      start_time: startTime,
      end_time: endTime,
      page: String(page),
      page_size: String(LIST_PAGE_SIZE),
      sort_by: 'created_at',
      sort_order: 'desc'
    });
    if (groupId) params.set('group_id', String(groupId));
    const data = await requestJson(baseUrl, `/admin/ops/request-errors?${params}`, adminOptions(apiKey, timeoutMs));
    const pageItems = unwrapItems(data);
    items.push(...pageItems);
    const pages = Number(data?.pages);
    if (pageItems.length < LIST_PAGE_SIZE || (Number.isFinite(pages) && page >= pages)) break;
  }
  return items;
}

async function getRequestErrorDetail({ baseUrl, apiKey, errorId, timeoutMs = 15000 }) {
  return requestJson(baseUrl, `/admin/ops/request-errors/${encodeURIComponent(errorId)}`, adminOptions(apiKey, timeoutMs));
}

async function listRelatedUpstreamErrors({ baseUrl, apiKey, errorId, timeoutMs = 15000 }) {
  const params = new URLSearchParams({ include_detail: '1', page: '1', page_size: '50' });
  return unwrapItems(await requestJson(
    baseUrl,
    `/admin/ops/request-errors/${encodeURIComponent(errorId)}/upstream-errors?${params}`,
    adminOptions(apiKey, timeoutMs)
  ));
}

module.exports = {
  listAdminGroups,
  listRequestErrors,
  getRequestErrorDetail,
  listRelatedUpstreamErrors,
  normalizeGroup
};
