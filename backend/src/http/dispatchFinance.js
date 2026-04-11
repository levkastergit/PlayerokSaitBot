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

async function dispatchFinance({ req, res, pathname, query, currentUserId, deps }) {
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
      },
    })
    sendJson(res, result.statusCode, result.data)
    return true
  }

  return false
}

module.exports = { dispatchFinance }

