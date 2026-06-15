function normalizeKeyPart(v) {
  return String(v == null ? '' : v).trim().replace(/\s+/g, ' ')
}

function normalizeProductKey(productKey) {
  const raw = String(productKey == null ? '' : productKey)
  const sepIndex = raw.indexOf('::')
  if (sepIndex === -1) return normalizeKeyPart(raw)
  const game = raw.slice(0, sepIndex)
  const title = raw.slice(sepIndex + 2)
  return `${normalizeKeyPart(game)}::${normalizeKeyPart(title)}`
}

function productTitleKeyFromProductKey(productKey) {
  const raw = String(productKey == null ? '' : productKey)
  const sepIndex = raw.indexOf('::')
  const title = sepIndex === -1 ? raw : raw.slice(sepIndex + 2)
  return normalizeKeyPart(title)
}

const { ymdFromUnix } = require('../fx/usdRateService')

// Себестоимость берём в долларах (поле costUsd) и конвертируем в рубли по курсу
// доллара на дату продажи. Если costUsd не задан — используем старое рублёвое cost.
function resolveCostRub(s, soldAt, usdRateByDate, fallbackRate) {
  const rawUsd = s && (s.costUsd != null ? s.costUsd : s.cost_usd)
  const costUsd = typeof rawUsd === 'number' ? rawUsd : parseFloat(rawUsd)
  if (Number.isFinite(costUsd) && costUsd > 0) {
    let rate = 0
    if (usdRateByDate) {
      const ymd = ymdFromUnix(soldAt)
      rate = (ymd && Number(usdRateByDate[ymd])) || 0
    }
    if (!rate) rate = Number(fallbackRate) || 0
    return { costRub: costUsd * rate, costUsd, usdRate: rate }
  }
  const legacy = typeof s?.cost === 'number' ? s.cost : parseFloat(s?.cost) || 0
  return { costRub: legacy, costUsd: null, usdRate: null }
}

function computeProfitAnalyticsList({
  salesRows,
  bumpsRows,
  settingsRows,
  listingFeesRows,
  usdRateByDate = null,
  fallbackRate = 0,
}) {
  const settingsByKey = {}
  for (const row of settingsRows || []) {
    try {
      const s = row.settings ? JSON.parse(row.settings) : {}
      const rawKey = row.product_key
      if (rawKey != null && rawKey !== '') {
        settingsByKey[String(rawKey)] = s
        const normalized = normalizeProductKey(rawKey)
        if (normalized && !settingsByKey[normalized]) settingsByKey[normalized] = s
      }
    } catch (_) {}
  }

  const listingFeesByProduct = {}
  for (const row of listingFeesRows || []) {
    const k = productTitleKeyFromProductKey(row.product_key)
    if (!k) continue
    if (!listingFeesByProduct[k]) listingFeesByProduct[k] = []
    listingFeesByProduct[k].push({ relistedAt: row.relisted_at, fee: Number(row.fee) || 0 })
  }
  for (const k of Object.keys(listingFeesByProduct)) {
    // Для корректного расчёта суммарной стоимости выставлений между продажами.
    listingFeesByProduct[k].sort((a, b) => a.relistedAt - b.relistedAt)
  }

  const bumpsByProduct = {}
  for (const b of bumpsRows || []) {
    const k = productTitleKeyFromProductKey(b.product_key)
    if (!k) continue
    if (!bumpsByProduct[k]) bumpsByProduct[k] = []
    bumpsByProduct[k].push({ bumpedAt: b.bumped_at, price: Number(b.price) || 0 })
  }
  for (const k of Object.keys(bumpsByProduct)) {
    bumpsByProduct[k].sort((a, b) => a.bumpedAt - b.bumpedAt)
  }

  // Для корректного расчёта "поднятия между продажами" нужно идти по продажам по возрастанию времени.
  const salesAsc = [...(salesRows || [])].sort((a, b) => a.sold_at - b.sold_at)
  const prevSoldByKey = {}
  const computed = []

  for (const row of salesAsc) {
    const productKey = row.product_key
    const lookupKey = productTitleKeyFromProductKey(productKey)
    const soldAt = row.sold_at
    const salePrice = Number(row.price) || 0
    const isRefund = (row.is_refund || 0) === 1

    const s =
      settingsByKey[productKey] ||
      settingsByKey[lookupKey] ||
      {}
    const { costRub: cost, costUsd, usdRate } = resolveCostRub(s, soldAt, usdRateByDate, fallbackRate)

    const productListingFees = listingFeesByProduct[lookupKey] || []
    let listingCost = 0
    for (const lf of productListingFees) {
      // Считаем все платные перевыставления между предыдущей продажей и этой продажей (включительно).
      if (lf.relistedAt > (prevSoldByKey[lookupKey] || 0) && lf.relistedAt <= soldAt) {
        listingCost += lf.fee
      }
    }

    const prevSold = prevSoldByKey[lookupKey] || 0
    const productBumps = bumpsByProduct[lookupKey] || []
    let bumpCost = 0
    for (const b of productBumps) {
      if (b.bumpedAt > prevSold && b.bumpedAt <= soldAt) {
        bumpCost += b.price
      }
    }
    prevSoldByKey[lookupKey] = soldAt

    const expenses = cost + listingCost + bumpCost
    const profit = isRefund ? -(listingCost + bumpCost) : salePrice - expenses

    computed.push({
      productTitle: row.product_title,
      productKey,
      dealId: row.deal_id != null ? String(row.deal_id) : null,
      itemId: row.item_id != null ? String(row.item_id) : null,
      buyerName: row.buyer_name != null ? String(row.buyer_name) : null,
      soldAt,
      salePrice,
      isRefund,
      cost,
      costUsd,
      usdRate,
      listingCost,
      bumpCost,
      profit,
    })
  }

  return computed.sort((a, b) => (b.soldAt || 0) - (a.soldAt || 0))
}

module.exports = { computeProfitAnalyticsList }

