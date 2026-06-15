async function handleProfitStats({ query, currentUserId, deps }) {
  const {
    getTokenFromQueryOrStored,
    getSalesHistoryAll,
    getBumpHistory,
    getAllSettings,
    getListingFees,
    computeProfitAnalyticsList,
    parseIntSafe,
    usdRateService,
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

    // Курсы USD→RUB на даты продаж (для конвертации себестоимости в USD).
    let usdRateByDate = null
    let fallbackRate = 0
    if (usdRateService && typeof usdRateService.ensureRatesForDates === 'function') {
      const dates = [
        ...new Set(
          salesRows.map((r) => usdRateService.ymdFromUnix(r.sold_at)).filter(Boolean)
        ),
      ]
      usdRateByDate = await usdRateService.ensureRatesForDates(dates)
      fallbackRate = usdRateService.getLatestCachedRate() || 0
    }

    const allList = computeProfitAnalyticsList({
      salesRows,
      bumpsRows,
      settingsRows,
      listingFeesRows,
      usdRateByDate,
      fallbackRate,
    })

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
    // Динамика по дням (для графика): дата YYYY-MM-DD → { profit, revenue, sales }.
    const dailyMap = new Map()

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
        const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        const bucket = dailyMap.get(ymd) || { date: ymd, profit: 0, revenue: 0, sales: 0 }
        bucket.profit += p
        if (!it.isRefund) bucket.revenue += Number(it.salePrice) || 0
        bucket.sales += 1
        dailyMap.set(ymd, bucket)
      }
    }

    const daily = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date))

    const bestHour = profitByHour.reduce(
      (acc, val, idx) => (val > acc.profit ? { hour: idx, profit: val } : acc),
      { hour: 0, profit: profitByHour[0] || 0 }
    )

    const bestWeekday = profitByWeekday.reduce(
      (acc, val, idx) => (val > acc.profit ? { weekday: idx, profit: val } : acc),
      { weekday: 0, profit: profitByWeekday[0] || 0 }
    )

    const paidSales = salesCount - refundCount
    const avgProfit = salesCount ? totalProfit / salesCount : 0
    const avgSale = paidSales ? totalRevenue / paidSales : 0
    // Маржа = прибыль / выручка (доля прибыли в выручке), в процентах.
    const margin = totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0

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
          expenses: totalCost + totalListingCost + totalBumpCost,
        },
        counts: { sales: salesCount, refunds: refundCount, paid: paidSales },
        averages: { profitPerSale: avgProfit, salePrice: avgSale, margin },
        best: {
          hour: bestHour,
          weekday: bestWeekday,
        },
        daily,
      },
    }
  } catch (err) {
    return { statusCode: 500, data: { error: err && err.message ? String(err.message) : 'Failed to load profit stats' } }
  }
}

module.exports = { handleProfitStats }

