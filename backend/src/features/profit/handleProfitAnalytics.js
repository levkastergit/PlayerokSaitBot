async function handleProfitAnalytics({ query, currentUserId, deps }) {
  const {
    getTokenFromQueryOrStored,
    getSalesHistoryAll,
    getBumpHistory,
    getAllSettings,
    getListingFees,
    computeProfitAnalyticsList,
    parseIntSafe,
    clampInt,
  } = deps

  const { token } = getTokenFromQueryOrStored(currentUserId, query)

  if (!token) return { statusCode: 400, data: { error: 'token is required' } }

  try {
    const tokenHash = token
    void tokenHash // used in the original code path for potential logging

    const salesRows = getSalesHistoryAll.all(currentUserId)
    const bumpsRows = getBumpHistory.all(currentUserId)
    const settingsRows = getAllSettings.all(currentUserId)
    const listingFeesRows = getListingFees.all(currentUserId)
    const allList = computeProfitAnalyticsList({ salesRows, bumpsRows, settingsRows, listingFeesRows })

    const year = parseIntSafe(query.year, null)
    const month = parseIntSafe(query.month, null)
    const day = parseIntSafe(query.day, null)

    const filtered =
      year == null
        ? allList
        : allList.filter((it) => {
            if (!it?.soldAt) return false
            const d = new Date(it.soldAt * 1000)
            const y = d.getFullYear()
            const m = d.getMonth() + 1
            const dayNum = d.getDate()
            if (y !== year) return false
            if (month != null && m !== month) return false
            if (day != null && dayNum !== day) return false
            return true
          })

    const limit = clampInt(parseIntSafe(query.limit, 100), 1, 1000)
    const offset = clampInt(parseIntSafe(query.offset, 0), 0, 2_000_000_000)

    const total = filtered.length
    const list = filtered.slice(offset, offset + limit)

    return { statusCode: 200, data: { list, total, limit, offset } }
  } catch (err) {
    return {
      statusCode: 500,
      data: { error: err && err.message ? String(err.message) : 'Failed to load profit analytics' },
    }
  }
}

module.exports = { handleProfitAnalytics }

