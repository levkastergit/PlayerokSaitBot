const { playerokErrorResponse } = require('../../../infra/playerokErrorResponse')

async function handleInProgressDeals({ payload, currentUserId, deps }) {
  const {
    getTokenFromBodyOrStored,
    fetchInProgressDealsFromPlayerok,
    fetchActiveItemsFromPlayerok,
    fetchCompletedItemsFromPlayerok,
  } = deps

  const { token } = getTokenFromBodyOrStored(currentUserId, payload)
  const userAgent = payload.userAgent

  if (!token) {
    return { statusCode: 400, data: { error: 'Token is required' } }
  }

  try {
    // Оптимизация: сначала загружаем только сделки, без активных/завершённых лотов
    const { deals } = await fetchInProgressDealsFromPlayerok(token, userAgent)

    const getCategoryFromProductKey = (productKey) => {
      if (!productKey || typeof productKey !== 'string') return null
      const sepIndex = productKey.indexOf('::')
      if (sepIndex <= 0) return null
      const gameFromPk = productKey.slice(0, sepIndex).trim()
      return gameFromPk || null
    }

    const inferFallbackCategoryFromTitle = (productTitle) => {
      if (!productTitle || typeof productTitle !== 'string') return null
      const title = productTitle.trim()
      if (!title) return null
      const commonGames = [
        'Clash of Clans',
        'Clash Royale',
        'Brawl Stars',
        'Hay Day',
        'Boom Beach',
        'PUBG',
        'PUBG Mobile',
        'Call of Duty',
        'Free Fire',
        'Fortnite',
        'CS:GO',
        'CS2',
        'Counter-Strike',
        'Dota 2',
        'League of Legends',
        'Valorant',
        'Apex Legends',
        'Genshin Impact',
        'Honkai',
        'Star Rail',
        'World of Tanks',
        'World of Warships',
        'War Thunder',
        'Minecraft',
        'Roblox',
        'Among Us',
        'Fall Guys',
        'Mobile Legends',
        'Wild Rift',
        'Arena of Valor',
        'Heroes of the Storm',
        'Overwatch',
        'YouTube',
        'Claude',
        'ChatGPT',
        'ЧатГПТ',
        'Telegram',
        'Discord',
      ]
      for (const game of commonGames) {
        if (title.toLowerCase().includes(game.toLowerCase())) {
          return game
        }
      }
      const words = title.split(/\s+/).filter((w) => w.length > 0)
      if (words.length === 0) return null
      let candidate = words.slice(0, 3).join(' ')
      if (candidate.length > 50) candidate = candidate.substring(0, 50).trim()
      return candidate || null
    }

    // Сначала пытаемся определить категории из точных источников без дополнительных API запросов.
    const dealsNeedingMapping = []
    const list = (deals || []).map((d) => {
      const categoryFromProductKey = getCategoryFromProductKey(d.productKey)
      let category = categoryFromProductKey || (d.category && String(d.category).trim()) || null

      // Если точной категории из productKey нет, даём точному маппингу по itemId/title шанс
      // переопределить грубую категорию, пришедшую из sales.
      if (!categoryFromProductKey && (d.itemId || d.productTitle)) {
        dealsNeedingMapping.push(d)
      }

      return {
        id: d.id,
        itemId: d.itemId || null,
        status: d.status || null,
        productKey: d.productKey,
        productTitle: d.productTitle,
        category: category || null,
        soldAt: d.soldAt || 0,
        price: Number(d.price) || 0,
        buyerName: d.buyerName || null,
        // Почту Supercell ID подтягиваем при запросе чата (/deal-chat-messages),
        // чтобы не делать по /in-progress-deals N дополнительных запросов deal-by-id и не ловить rate limit.
        buyerSupercellEmail: null,
        chatId: d.chatId || null,
      }
    })

    // Логирование для отладки категорий
    const dealsWithoutCategory = list.filter(
      (d) =>
        !d.category ||
        (typeof d.category === 'string' && !d.category.trim()) ||
        d.category === 'Общий чат'
    )

    if (dealsWithoutCategory.length > 0) {
      console.log('[in-progress-deals] сделки без категории или с fallback:', {
        count: dealsWithoutCategory.length,
        total: list.length,
        deals: dealsWithoutCategory.map((d) => ({
          id: d.id,
          category: d.category,
          productKey: d.productKey,
          productTitle: d.productTitle,
          itemId: d.itemId,
        })),
      })
    }

    // Загружаем активные/завершённые лоты только если есть сделки без категорий
    if (dealsNeedingMapping.length > 0) {
      try {
        const [{ items: activeItems }, { items: completedItems }] = await Promise.all([
          fetchActiveItemsFromPlayerok(token, userAgent),
          fetchCompletedItemsFromPlayerok(token, userAgent),
        ])

        const itemIdToGame = new Map()
        const titleToGame = new Map()

        for (const it of [...(activeItems || []), ...(completedItems || [])]) {
          const id = it.id != null ? String(it.id) : null
          const game = (it.game || '').trim()
          const title = (it.title || '').trim()
          if (id && game) {
            if (!itemIdToGame.has(id)) itemIdToGame.set(id, game)
          }
          if (title && game) {
            if (!titleToGame.has(title)) titleToGame.set(title, game)
          }
        }

        console.log('[in-progress-deals] маппинг категорий:', {
          itemIdToGameSize: itemIdToGame.size,
          titleToGameSize: titleToGame.size,
          dealsNeedingMapping: dealsNeedingMapping.length,
        })

        // Обновляем категории для сделок, которым нужен точный маппинг.
        for (const deal of dealsNeedingMapping) {
          const dealIndex = list.findIndex((d) => d.id === deal.id)
          if (dealIndex === -1) continue

          const existingCategory = (list[dealIndex].category && String(list[dealIndex].category).trim()) || null
          const mappedByItemId =
            deal.itemId != null ? itemIdToGame.get(String(deal.itemId)) || null : null
          const mappedByTitle =
            deal.productTitle ? titleToGame.get(String(deal.productTitle).trim()) || null : null

          let category = mappedByItemId || mappedByTitle || getCategoryFromProductKey(deal.productKey) || existingCategory || null

          if (!category) {
            category = inferFallbackCategoryFromTitle(deal.productTitle)
          }
          if (!category) {
            category = 'Общий чат'
          }

          // Обновляем категорию в списке
          list[dealIndex].category = category
          console.log('[in-progress-deals] категория обновлена для сделки:', {
            dealId: deal.id,
            category,
            source:
              mappedByItemId
                ? 'itemIdToGame'
                : mappedByTitle
                  ? 'titleToGame'
                  : getCategoryFromProductKey(deal.productKey)
                    ? 'productKey'
                    : existingCategory
                      ? 'sales'
                      : 'fallback',
          })
        }
      } catch (mappingErr) {
        // Если маппинг не удался, продолжаем с уже определёнными категориями
        console.warn('[in-progress-deals] не удалось сопоставить категории', { error: mappingErr?.message })
      }
    }

    for (const deal of list) {
      const normalizedCategory =
        (deal.category && String(deal.category).trim()) ||
        inferFallbackCategoryFromTitle(deal.productTitle) ||
        'Общий чат'
      deal.category = normalizedCategory
    }

    // Финальная проверка: все сделки должны иметь категорию
    const allDealsHaveCategory = list.every(
      (d) => d.category && typeof d.category === 'string' && d.category.trim()
    )

    if (!allDealsHaveCategory) {
      console.error('[in-progress-deals] КРИТИЧЕСКАЯ ОШИБКА: не все сделки имеют категорию перед отправкой:', {
        total: list.length,
        withoutCategory: list.filter(
          (d) => !d.category || (typeof d.category === 'string' && !d.category.trim())
        ).length,
      })
    }

    return { statusCode: 200, data: { list } }
  } catch (err) {
    return playerokErrorResponse(err, 'Не удалось загрузить сделки в выполнении с Playerok')
  }
}

module.exports = { handleInProgressDeals }

