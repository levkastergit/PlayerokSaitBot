const { sendJson } = require('./sendJson')
const { readJsonBody } = require('./readJsonBody')

const { handleGetSalesHistory } = require('../features/salesHistory/handleGetSalesHistory')
const { handleClearSalesHistory } = require('../features/salesHistory/handleClearSalesHistory')
const { handleSyncSales } = require('../features/salesHistory/handleSyncSales')
const { handleSyncSalesStream } = require('../features/salesHistory/handleSyncSalesStream')
const { handleBumpHistory } = require('../features/history/handleBumpHistory')
const { handleActionsHistory } = require('../features/history/handleActionsHistory')
const { handleLogs } = require('../features/infra/handleLogs')
const { handleProfitAnalyticsMeta } = require('../features/profit/handleProfitAnalyticsMeta')
const { handleProfitAnalytics } = require('../features/profit/handleProfitAnalytics')
const { handleProfitStats } = require('../features/profit/handleProfitStats')

function attachCustomValuesToCodes(deps, userId, category, list) {
  const valueRows = deps.getValuesByCategory.all(userId, category)
  const valuesByCodeId = new Map()
  for (const row of valueRows) {
    const codeId = Number(row.code_id)
    if (!valuesByCodeId.has(codeId)) valuesByCodeId.set(codeId, {})
    valuesByCodeId.get(codeId)[String(row.column_id)] = row.value ?? ''
  }
  return list.map((item) => ({
    ...item,
    customValues: valuesByCodeId.get(Number(item.id)) || {},
  }))
}

function parseSubtabIdFromCategory(category) {
  const match = String(category || '').match(/^subtab:(\d+)$/)
  if (!match) return null
  const subtabId = Number(match[1])
  return Number.isFinite(subtabId) && subtabId > 0 ? subtabId : null
}

async function dispatchFinance({ req, res, pathname, query, currentUserId, deps }) {
  if (req.method === 'GET' && pathname === '/api/table-tabs') {
    const nowTs = Math.floor(Date.now() / 1000)
    deps.ensureDefaultTabsTx(currentUserId, nowTs)

    const tabs = deps.getTabsByUser.all(currentUserId)
    const subtabs = deps.getSubtabsByUser.all(currentUserId)
    const subtabsByTabId = new Map()
    for (const subtab of subtabs) {
      const tabId = Number(subtab.tab_id)
      if (!subtabsByTabId.has(tabId)) subtabsByTabId.set(tabId, [])
      subtabsByTabId.get(tabId).push({
        id: subtab.id,
        name: subtab.name,
        createdAt: subtab.created_at,
      })
    }

    sendJson(res, 200, {
      list: tabs.map((tab) => ({
        id: tab.id,
        name: tab.name,
        createdAt: tab.created_at,
        subtabs: subtabsByTabId.get(Number(tab.id)) || [],
      })),
    })
    return true
  }

  if (req.method === 'POST' && pathname === '/api/table-tabs') {
    let payload
    try {
      payload = await readJsonBody(req, { fallback: {} })
    } catch (_) {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return true
    }
    const name = String(payload?.name || '').trim()
    if (!name) {
      sendJson(res, 400, { error: 'name is required' })
      return true
    }
    const nowTs = Math.floor(Date.now() / 1000)
    const info = deps.insertTab.run(currentUserId, name, nowTs)
    sendJson(res, 200, {
      ok: true,
      item: { id: info.lastInsertRowid, name, createdAt: nowTs },
    })
    return true
  }

  if (req.method === 'POST' && pathname === '/api/table-subtabs') {
    let payload
    try {
      payload = await readJsonBody(req, { fallback: {} })
    } catch (_) {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return true
    }
    const tabId = Number(payload?.tabId)
    const name = String(payload?.name || '').trim()
    if (!Number.isFinite(tabId) || tabId <= 0) {
      sendJson(res, 400, { error: 'tabId is required' })
      return true
    }
    if (!name) {
      sendJson(res, 400, { error: 'name is required' })
      return true
    }
    const tab = deps.getTabById.get(tabId)
    if (!tab || Number(tab.user_id) !== Number(currentUserId)) {
      sendJson(res, 404, { error: 'tab not found' })
      return true
    }
    const nowTs = Math.floor(Date.now() / 1000)
    const info = deps.insertSubtab.run(currentUserId, tabId, name, nowTs)
    sendJson(res, 200, {
      ok: true,
      item: { id: info.lastInsertRowid, tabId, name, createdAt: nowTs },
    })
    return true
  }

  if (req.method === 'POST' && pathname === '/api/table-subtabs/rename') {
    let payload
    try {
      payload = await readJsonBody(req, { fallback: {} })
    } catch (_) {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return true
    }
    const id = Number(payload?.id)
    const name = String(payload?.name || '').trim()
    if (!Number.isFinite(id) || id <= 0) {
      sendJson(res, 400, { error: 'id is required' })
      return true
    }
    if (!name) {
      sendJson(res, 400, { error: 'name is required' })
      return true
    }
    const subtab = deps.getSubtabById.get(id)
    if (!subtab || Number(subtab.user_id) !== Number(currentUserId)) {
      sendJson(res, 404, { error: 'subtab not found' })
      return true
    }
    const info = deps.updateSubtabName.run(name, id, currentUserId)
    if (!info.changes) {
      sendJson(res, 404, { error: 'subtab not found' })
      return true
    }
    sendJson(res, 200, { ok: true, item: { id, name } })
    return true
  }

  if (req.method === 'POST' && pathname === '/api/table-subtabs/delete') {
    let payload
    try {
      payload = await readJsonBody(req, { fallback: {} })
    } catch (_) {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return true
    }
    const id = Number(payload?.id)
    if (!Number.isFinite(id) || id <= 0) {
      sendJson(res, 400, { error: 'id is required' })
      return true
    }
    const subtab = deps.getSubtabById.get(id)
    if (!subtab || Number(subtab.user_id) !== Number(currentUserId)) {
      sendJson(res, 404, { error: 'subtab not found' })
      return true
    }
    const info = deps.deleteSubtabTx(currentUserId, id)
    if (!info.changes) {
      sendJson(res, 404, { error: 'subtab not found' })
      return true
    }
    sendJson(res, 200, { ok: true, id })
    return true
  }

  if (req.method === 'POST' && pathname === '/api/table-tabs/delete') {
    let payload
    try {
      payload = await readJsonBody(req, { fallback: {} })
    } catch (_) {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return true
    }
    const id = Number(payload?.id)
    if (!Number.isFinite(id) || id <= 0) {
      sendJson(res, 400, { error: 'id is required' })
      return true
    }
    const tab = deps.getTabById.get(id)
    if (!tab || Number(tab.user_id) !== Number(currentUserId)) {
      sendJson(res, 404, { error: 'tab not found' })
      return true
    }
    const info = deps.deleteTabTx(currentUserId, id)
    if (!info.changes) {
      sendJson(res, 404, { error: 'tab not found' })
      return true
    }
    sendJson(res, 200, { ok: true, id })
    return true
  }

  if (req.method === 'GET' && pathname === '/api/table-columns') {
    const subtabId = Number(query?.subtabId)
    if (!Number.isFinite(subtabId) || subtabId <= 0) {
      sendJson(res, 400, { error: 'subtabId is required' })
      return true
    }
    const subtab = deps.getSubtabById.get(subtabId)
    if (!subtab || Number(subtab.user_id) !== Number(currentUserId)) {
      sendJson(res, 404, { error: 'subtab not found' })
      return true
    }
    const rows = deps.getColumnsBySubtab.all(currentUserId, subtabId)
    sendJson(res, 200, {
      list: rows.map((row) => ({
        id: row.id,
        name: row.name,
        sortOrder: row.sort_order,
        createdAt: row.created_at,
      })),
    })
    return true
  }

  if (req.method === 'POST' && pathname === '/api/table-columns') {
    let payload
    try {
      payload = await readJsonBody(req, { fallback: {} })
    } catch (_) {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return true
    }
    const subtabId = Number(payload?.subtabId)
    const name = String(payload?.name || '').trim()
    if (!Number.isFinite(subtabId) || subtabId <= 0) {
      sendJson(res, 400, { error: 'subtabId is required' })
      return true
    }
    if (!name) {
      sendJson(res, 400, { error: 'name is required' })
      return true
    }
    const subtab = deps.getSubtabById.get(subtabId)
    if (!subtab || Number(subtab.user_id) !== Number(currentUserId)) {
      sendJson(res, 404, { error: 'subtab not found' })
      return true
    }
    const maxRow = deps.getMaxSortOrderBySubtab.get(currentUserId, subtabId)
    const sortOrder = Number(maxRow?.max_sort ?? -1) + 1
    const nowTs = Math.floor(Date.now() / 1000)
    const info = deps.insertColumn.run(currentUserId, subtabId, name, sortOrder, nowTs)
    sendJson(res, 200, {
      ok: true,
      item: { id: info.lastInsertRowid, subtabId, name, sortOrder, createdAt: nowTs },
    })
    return true
  }

  if (req.method === 'POST' && pathname === '/api/table-columns/rename') {
    let payload
    try {
      payload = await readJsonBody(req, { fallback: {} })
    } catch (_) {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return true
    }
    const id = Number(payload?.id)
    const name = String(payload?.name || '').trim()
    if (!Number.isFinite(id) || id <= 0) {
      sendJson(res, 400, { error: 'id is required' })
      return true
    }
    if (!name) {
      sendJson(res, 400, { error: 'name is required' })
      return true
    }
    const column = deps.getColumnById.get(id)
    if (!column || Number(column.user_id) !== Number(currentUserId)) {
      sendJson(res, 404, { error: 'column not found' })
      return true
    }
    const info = deps.updateColumnName.run(name, id, currentUserId)
    if (!info.changes) {
      sendJson(res, 404, { error: 'column not found' })
      return true
    }
    sendJson(res, 200, { ok: true, item: { id, name } })
    return true
  }

  if (req.method === 'POST' && pathname === '/api/table-columns/delete') {
    let payload
    try {
      payload = await readJsonBody(req, { fallback: {} })
    } catch (_) {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return true
    }
    const id = Number(payload?.id)
    if (!Number.isFinite(id) || id <= 0) {
      sendJson(res, 400, { error: 'id is required' })
      return true
    }
    const column = deps.getColumnById.get(id)
    if (!column || Number(column.user_id) !== Number(currentUserId)) {
      sendJson(res, 404, { error: 'column not found' })
      return true
    }
    const info = deps.deleteColumnById.run(id, currentUserId)
    if (!info.changes) {
      sendJson(res, 404, { error: 'column not found' })
      return true
    }
    sendJson(res, 200, { ok: true, id })
    return true
  }

  if (req.method === 'POST' && pathname === '/api/table-codes/cell-value') {
    let payload
    try {
      payload = await readJsonBody(req, { fallback: {} })
    } catch (_) {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return true
    }
    const codeId = Number(payload?.codeId)
    const columnId = Number(payload?.columnId)
    const value = String(payload?.value ?? '')
    if (!Number.isFinite(codeId) || codeId <= 0) {
      sendJson(res, 400, { error: 'codeId is required' })
      return true
    }
    if (!Number.isFinite(columnId) || columnId <= 0) {
      sendJson(res, 400, { error: 'columnId is required' })
      return true
    }
    const code = deps.getCodeById.get(codeId)
    if (!code || Number(code.user_id) !== Number(currentUserId)) {
      sendJson(res, 404, { error: 'code not found' })
      return true
    }
    const column = deps.getColumnById.get(columnId)
    if (!column || Number(column.user_id) !== Number(currentUserId)) {
      sendJson(res, 404, { error: 'column not found' })
      return true
    }
    const subtabId = parseSubtabIdFromCategory(code.category)
    if (!subtabId || Number(column.subtab_id) !== subtabId) {
      sendJson(res, 400, { error: 'column does not match code subtab' })
      return true
    }
    deps.upsertCellValue.run(codeId, columnId, value)
    sendJson(res, 200, { ok: true, codeId, columnId, value })
    return true
  }

  if (req.method === 'GET' && pathname === '/api/table-codes') {
    const subtabId = Number(query?.subtabId)
    if (Number.isFinite(subtabId) && subtabId > 0) {
      const subtab = deps.getSubtabById.get(subtabId)
      if (!subtab || Number(subtab.user_id) !== Number(currentUserId)) {
        sendJson(res, 404, { error: 'subtab not found' })
        return true
      }
    }
    const category =
      Number.isFinite(subtabId) && subtabId > 0
        ? `subtab:${subtabId}`
        : String(query?.category || '').trim()
    if (!category) {
      sendJson(res, 400, { error: 'category is required' })
      return true
    }

    const rows = deps.getCodesByUserAndCategory.all(currentUserId, category)
    const list = rows.map((row) => ({
      id: row.id,
      code: row.code,
      used: Number(row.used || 0) === 1,
      dealId: row.deal_id || null,
      itemId: row.item_id || null,
      chatId: row.chat_id || null,
      statusChangedAt: row.status_changed_at ? Number(row.status_changed_at) : null,
      createdAt: row.created_at,
    }))
    sendJson(res, 200, {
      list: attachCustomValuesToCodes(deps, currentUserId, category, list),
    })
    return true
  }

  if (req.method === 'POST' && pathname === '/api/table-codes') {
    let payload
    try {
      payload = await readJsonBody(req, { fallback: {} })
    } catch (_) {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return true
    }

    const subtabId = Number(payload?.subtabId)
    if (Number.isFinite(subtabId) && subtabId > 0) {
      const subtab = deps.getSubtabById.get(subtabId)
      if (!subtab || Number(subtab.user_id) !== Number(currentUserId)) {
        sendJson(res, 404, { error: 'subtab not found' })
        return true
      }
    }
    const category =
      Number.isFinite(subtabId) && subtabId > 0
        ? `subtab:${subtabId}`
        : String(payload?.category || '').trim()
    const code = String(payload?.code || '').trim()
    if (!category) {
      sendJson(res, 400, { error: 'category is required' })
      return true
    }
    if (!code) {
      sendJson(res, 400, { error: 'code is required' })
      return true
    }

    const nowTs = Math.floor(Date.now() / 1000)
    const used = 0
    const dealId = null
    const itemId = null
    const chatId = null
    const statusChangedAt = null
    const info = deps.insertCode.run(
      currentUserId,
      category,
      code,
      used,
      dealId,
      itemId,
      chatId,
      statusChangedAt,
      nowTs
    )
    sendJson(res, 200, {
      ok: true,
      item: {
        id: info.lastInsertRowid,
        code,
        used: false,
        dealId: null,
        itemId: null,
        chatId: null,
        statusChangedAt: null,
        createdAt: nowTs,
        customValues: {},
      },
    })
    return true
  }

  if (req.method === 'POST' && pathname === '/api/table-codes/used') {
    let payload
    try {
      payload = await readJsonBody(req, { fallback: {} })
    } catch (_) {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return true
    }

    const id = Number(payload?.id)
    const used = payload?.used === true ? 1 : 0
    if (!Number.isFinite(id) || id <= 0) {
      sendJson(res, 400, { error: 'id is required' })
      return true
    }

    const statusChangedAt = Math.floor(Date.now() / 1000)
    const info = deps.updateCodeUsed.run(used, statusChangedAt, id, currentUserId)
    if (!info.changes) {
      sendJson(res, 404, { error: 'code not found' })
      return true
    }

    sendJson(res, 200, { ok: true, statusChangedAt })
    return true
  }

  if (req.method === 'POST' && pathname === '/api/table-codes/delete') {
    let payload
    try {
      payload = await readJsonBody(req, { fallback: {} })
    } catch (_) {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return true
    }

    const id = Number(payload?.id)
    if (!Number.isFinite(id) || id <= 0) {
      sendJson(res, 400, { error: 'id is required' })
      return true
    }

    const info = deps.deleteCodeById.run(id, currentUserId)
    if (!info.changes) {
      sendJson(res, 404, { error: 'code not found' })
      return true
    }
    sendJson(res, 200, { ok: true })
    return true
  }

  if (req.method === 'GET' && pathname === '/api/sales-history') {
    const result = await handleGetSalesHistory({
      query,
      currentUserId,
      deps: { getTokenFromQueryOrStored: deps.getTokenFromQueryOrStored, getSalesHistory: deps.getSalesHistory },
    })
    sendJson(res, result.statusCode, result.data)
    return true
  }

  if (req.method === 'POST' && pathname === '/api/sales-history/clear') {
    let payload
    try {
      payload = await readJsonBody(req, { fallback: {} })
    } catch (_) {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return true
    }
    const result = await handleClearSalesHistory({
      payload,
      currentUserId,
      deps: { getTokenFromBodyOrStored: deps.getTokenFromBodyOrStored, deleteSalesHistoryByUser: deps.deleteSalesHistoryByUser },
    })
    sendJson(res, result.statusCode, result.data)
    return true
  }

  if (req.method === 'POST' && pathname === '/api/sync-sales') {
    let payload
    try {
      payload = await readJsonBody(req, { fallback: {} })
    } catch (_) {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return true
    }
    const result = await handleSyncSales({
      payload,
      currentUserId,
      deps: {
        getTokenFromBodyOrStored: deps.getTokenFromBodyOrStored,
        fetchAllDealsFromPlayerok: deps.fetchAllDealsFromPlayerok,
        requestDealById: deps.requestDealById,
        insertSale: deps.insertSale,
        toUnixTs: deps.toUnixTs,
        dealPurchaseUnixTs: deps.dealPurchaseUnixTs,
      },
    })
    sendJson(res, result.statusCode, result.data)
    return true
  }

  if (req.method === 'POST' && pathname === '/api/sync-sales-stream') {
    let payload
    try {
      payload = await readJsonBody(req, { fallback: {} })
    } catch (_) {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return true
    }
    const result = await handleSyncSalesStream({
      payload,
      currentUserId,
      deps: {
        getTokenFromBodyOrStored: deps.getTokenFromBodyOrStored,
        getViewer: deps.getViewer,
        requestDealsPage: deps.requestDealsPage,
        requestDealById: deps.requestDealById,
        insertSale: deps.insertSale,
        toUnixTs: deps.toUnixTs,
        dealPurchaseUnixTs: deps.dealPurchaseUnixTs,
      },
      res,
    })
    if (result) sendJson(res, result.statusCode, result.data)
    return true
  }

  if (req.method === 'GET' && pathname === '/api/bump-history') {
    const result = await handleBumpHistory({
      query,
      currentUserId,
      deps: { getTokenFromQueryOrStored: deps.getTokenFromQueryOrStored, getBumpHistory: deps.getBumpHistory },
    })
    sendJson(res, result.statusCode, result.data)
    return true
  }

  if (req.method === 'GET' && pathname === '/api/actions-history') {
    const result = await handleActionsHistory({
      query,
      currentUserId,
      deps: {
        getTokenFromQueryOrStored: deps.getTokenFromQueryOrStored,
        getBumpHistory: deps.getBumpHistory,
        getListingFees: deps.getListingFees,
      },
    })
    sendJson(res, result.statusCode, result.data)
    return true
  }

  if (req.method === 'GET' && pathname === '/api/logs') {
    const result = await handleLogs({
      query,
      currentUserId,
      deps: { getTokenFromQueryOrStored: deps.getTokenFromQueryOrStored, getLogsBuffer: deps.getLogsBuffer, parseIntSafe: deps.parseIntSafe },
    })
    sendJson(res, result.statusCode, result.data)
    return true
  }

  if (req.method === 'GET' && pathname === '/api/profit-analytics/meta') {
    const result = await handleProfitAnalyticsMeta({
      query,
      currentUserId,
      deps: { getTokenFromQueryOrStored: deps.getTokenFromQueryOrStored, getSalesYears: deps.getSalesYears, getSalesMonthsForYear: deps.getSalesMonthsForYear, parseIntSafe: deps.parseIntSafe },
    })
    sendJson(res, result.statusCode, result.data)
    return true
  }

  if (req.method === 'GET' && pathname === '/api/profit-analytics') {
    const result = await handleProfitAnalytics({
      query,
      currentUserId,
      deps: {
        getTokenFromQueryOrStored: deps.getTokenFromQueryOrStored,
        getSalesHistoryAll: deps.getSalesHistoryAll,
        getBumpHistory: deps.getBumpHistory,
        getAllSettings: deps.getAllSettings,
        getListingFees: deps.getListingFees,
        computeProfitAnalyticsList: deps.computeProfitAnalyticsList,
        parseIntSafe: deps.parseIntSafe,
        clampInt: deps.clampInt,
      },
    })
    sendJson(res, result.statusCode, result.data)
    return true
  }

  if (req.method === 'GET' && pathname === '/api/profit-stats') {
    const result = await handleProfitStats({
      query,
      currentUserId,
      deps: {
        getTokenFromQueryOrStored: deps.getTokenFromQueryOrStored,
        getSalesHistoryAll: deps.getSalesHistoryAll,
        getBumpHistory: deps.getBumpHistory,
        getAllSettings: deps.getAllSettings,
        getListingFees: deps.getListingFees,
        computeProfitAnalyticsList: deps.computeProfitAnalyticsList,
        parseIntSafe: deps.parseIntSafe,
        usdRateService: deps.usdRateService,
      },
    })
    sendJson(res, result.statusCode, result.data)
    return true
  }

  return false
}

module.exports = { dispatchFinance }

