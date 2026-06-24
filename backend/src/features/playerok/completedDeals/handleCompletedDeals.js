const { playerokErrorResponse } = require('../../../infra/playerokErrorResponse')

async function handleCompletedDeals({ payload, currentUserId, deps }) {
  const { getTokenFromBodyOrStored, fetchCompletedDealsFromPlayerok, fetchActiveItemsFromPlayerok, fetchCompletedItemsFromPlayerok } = deps

  const { token } = getTokenFromBodyOrStored(currentUserId, payload)
  const userAgent = payload.userAgent

  if (!token) {
    return { statusCode: 400, data: { error: 'Token is required' } }
  }

  try {
    const [{ deals }, { items: activeItems }, { items: completedItems }] = await Promise.all([
      fetchCompletedDealsFromPlayerok(token, userAgent),
      fetchActiveItemsFromPlayerok(token, userAgent),
      fetchCompletedItemsFromPlayerok(token, userAgent),
    ])

    const itemIdToGame = new Map()
    const titleToGame = new Map()

    for (const it of [...activeItems, ...completedItems]) {
      const id = it.id != null ? String(it.id) : null
      const game = (it.game || '').trim()
      const title = (it.title || '').trim()
      if (id && game) itemIdToGame.set(id, game)
      if (title && game && !titleToGame.has(title)) titleToGame.set(title, game)
    }

    const list = (deals || []).map((d) => {
      let category = (d.category && String(d.category).trim()) || (d.itemId ? itemIdToGame.get(String(d.itemId)) : null) || null

      if (!category && d.productKey && typeof d.productKey === 'string') {
        const sepIndex = d.productKey.indexOf('::')
        if (sepIndex > 0) category = d.productKey.slice(0, sepIndex).trim()
      }

      if (!category && d.productTitle) {
        category = titleToGame.get(String(d.productTitle).trim()) || null
      }

      return {
        id: d.id,
        itemId: d.itemId || null,
        status: d.status || null,
        productKey: d.productKey,
        productTitle: d.productTitle,
        category: category || '',
        soldAt: d.soldAt || 0,
        price: Number(d.price) || 0,
        buyerName: d.buyerName || null,
        buyerSupercellEmail: null,
        chatId: d.chatId || null,
      }
    })

    return { statusCode: 200, data: { list } }
  } catch (err) {
    return playerokErrorResponse(err, 'Не удалось загрузить завершённые сделки с Playerok')
  }
}

module.exports = { handleCompletedDeals }

