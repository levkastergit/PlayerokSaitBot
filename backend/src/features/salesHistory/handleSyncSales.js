async function handleSyncSales({ payload, currentUserId, deps }) {
  const {
    getTokenFromBodyOrStored,
    fetchAllDealsFromPlayerok,
    requestDealById,
    insertSale,
    toUnixTs,
    dealPurchaseUnixTs,
  } = deps

  const { token } = getTokenFromBodyOrStored(currentUserId, payload)
  const userAgent = payload.userAgent

  if (!token) {
    return { statusCode: 400, data: { error: 'token is required' } }
  }

  try {
    const { deals } = await fetchAllDealsFromPlayerok(token, userAgent)

    let inserted = 0
    for (const d of deals) {
      const dealId = d.id || null
      if (!dealId) continue

      let soldAt = d.soldAt
      let buyerName = d.buyerName || null
      let fullDeal = null

      if (!soldAt || !buyerName) {
        try {
          fullDeal = await requestDealById(token, userAgent, dealId)
          if (fullDeal && typeof dealPurchaseUnixTs === 'function') {
            const purchaseTs = dealPurchaseUnixTs(fullDeal, toUnixTs)
            if (purchaseTs) soldAt = purchaseTs
          }
          if (!soldAt) {
            soldAt = fullDeal ? toUnixTs(fullDeal.createdAt) || toUnixTs(fullDeal.completedAt) || 0 : 0
          }
          if (!buyerName) {
            buyerName = (fullDeal && fullDeal.user && fullDeal.user.username) || null
          }
        } catch (_) {
          if (!soldAt) soldAt = 0
        }
      }

      try {
        const result = insertSale.run(
          currentUserId,
          d.productKey || 'Товар',
          d.productTitle || 'Товар',
          soldAt,
          Number(d.price) || 0,
          d.status || null,
          dealId,
          d.itemId || null,
          buyerName || null,
          String(d.status || '') === 'ROLLED_BACK' ? 1 : 0
        )
        if (result.changes > 0) inserted += 1
      } catch (_) {
        // UNIQUE conflict or other — skip
      }
    }

    return { statusCode: 200, data: { ok: true, total: deals.length, inserted } }
  } catch (err) {
    return {
      statusCode: 500,
      data: {
        error: err && err.message ? String(err.message) : 'Не удалось загрузить продажи с Playerok',
      },
    }
  }
}

module.exports = { handleSyncSales }

