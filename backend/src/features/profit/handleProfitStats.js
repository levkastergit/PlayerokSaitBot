async function handleProfitStats({ query, currentUserId, deps }) {
  const {
    getTokenFromQueryOrStored,
    getSalesHistoryAll,
    getBumpHistory,
    getAllSettings,
    getListingFees,
    computeProfitAnalyticsList,
    parseIntSafe,
  } = deps

  const { token } = getTokenFromQueryOrStored(currentUserId, query)

  if (!token) return { statusCode: 400, data: { error: 'token is required' } }

  try {
    const tokenHash = token
    void tokenHash

    const salesRows = getSalesHistoryAll.all(currentUserId)
    const bumpsRows = getBumpHistory.all(currentUserId)
    const settingsRows = getAllSettings.all(currentUserId)
    const listingFeesRows = getListingFees.all(currentUserId)

    const allList = computeProfitAnalyticsList({ salesRows, bumpsRows, settingsRows, listingFeesRows })

    const year = parseIntSafe(query.year, null)
    const month = parseIntSafe(query.month, null)
    const day = parseIntSafe(query.day, null)

    const list =
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

    let totalProfit = 0
    let totalListingCost = 0
    let totalBumpCost = 0
    let totalCost = 0
    let totalRevenue = 0
    let salesCount = 0
    let refundCount = 0

    const profitByHour = Array.from({ length: 24 }, () => 0)
    const profitByWeekday = Array.from({ length: 7 }, () => 0) // 0=Sun..6=Sat

    for (const it of list) {
      const p = Number(it.profit) || 0
      totalProfit += p
      totalListingCost += Number(it.listingCost) || 0
      totalBumpCost += Number(it.bumpCost) || 0
      totalCost += Number(it.cost) || 0
      if (!it.isRefund) totalRevenue += Number(it.salePrice) || 0
      salesCount += 1
      if (it.isRefund) refundCount += 1

      if (it.soldAt) {
        const d = new Date(it.soldAt * 1000)
        const hour = d.getHours()
        const wd = d.getDay()
        if (hour >= 0 && hour < 24) profitByHour[hour] += p
        if (wd >= 0 && wd < 7) profitByWeekday[wd] += p
      }
    }

    const bestHour = profitByHour.reduce(
      (acc, val, idx) => (val > acc.profit ? { hour: idx, profit: val } : acc),
      { hour: 0, profit: profitByHour[0] || 0 }
    )

    const bestWeekday = profitByWeekday.reduce(
      (acc, val, idx) => (val > acc.profit ? { weekday: idx, profit: val } : acc),
      { weekday: 0, profit: profitByWeekday[0] || 0 }
    )

    const avgProfit = salesCount ? totalProfit / salesCount : 0

    return {
      statusCode: 200,
      data: {
        scope: { year: year ?? null, month: month ?? null },
        totals: {
          profit: totalProfit,
          revenue: totalRevenue,
          cost: totalCost,
          listingCost: totalListingCost,
          bumpCost: totalBumpCost,
        },
        counts: { sales: salesCount, refunds: refundCount },
        averages: { profitPerSale: avgProfit },
        best: {
          hour: bestHour,
          weekday: bestWeekday,
        },
      },
    }
  } catch (err) {
    return { statusCode: 500, data: { error: err && err.message ? String(err.message) : 'Failed to load profit stats' } }
  }
}

module.exports = { handleProfitStats }

