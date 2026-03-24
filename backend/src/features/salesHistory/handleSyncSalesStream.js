async function handleSyncSalesStream({ payload, currentUserId, deps, res }) {
  const {
    getTokenFromBodyOrStored,
    getViewer,
    requestDealsPage,
    requestDealById,
    insertSale,
    toUnixTs,
  } = deps

  const { token } = getTokenFromBodyOrStored(currentUserId, payload)
  const userAgent = payload.userAgent

  if (!token) {
    return { statusCode: 400, data: { error: 'token is required' } }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })

  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  try {
    const viewer = await getViewer(token, userAgent)
    void viewer?.id
    const tokenHash = token
    void tokenHash

    const statusList = ['PAID', 'PENDING', 'SENT', 'CONFIRMED', 'ROLLED_BACK']
    let afterCursor = null
    let fetched = 0
    let inserted = 0

    // Каждая сделка (deal) = одна покупка: свой товар и дата; в одном чате может быть несколько сделок
    do {
      const page = await requestDealsPage(token, userAgent, viewer.id, afterCursor, statusList, 'OUT')

      for (const d of page.deals) {
        const dealId = d.id || null
        let soldAt = d.soldAt
        let buyerName = d.buyerName || null

        if (dealId && (!soldAt || !buyerName)) {
          try {
            const fullDeal = await requestDealById(token, userAgent, dealId)

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

        if (dealId) {
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
          } catch (_) {}
        }

        fetched += 1
      }

      sendEvent({ fetched, inserted })
      afterCursor = page.hasNextPage ? page.endCursor : null
    } while (afterCursor)

    sendEvent({ done: true, total: fetched, inserted })
  } catch (err) {
    sendEvent({ error: err && err.message ? String(err.message) : 'Ошибка синхронизации' })
  } finally {
    res.end()
  }

  return null
}

module.exports = { handleSyncSalesStream }

