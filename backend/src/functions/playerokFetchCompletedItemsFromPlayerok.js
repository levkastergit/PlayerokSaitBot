'use strict'

function createFetchCompletedItemsFromPlayerok({
  getViewer,
  requestItemsPage,
  lotsCache,
  LOTS_CACHE_TTL_MS,
}) {
  if (typeof getViewer !== 'function') throw new Error('getViewer must be a function')
  if (typeof requestItemsPage !== 'function') {
    throw new Error('requestItemsPage must be a function')
  }
  if (!(lotsCache instanceof Map)) throw new Error('lotsCache must be a Map')
  if (typeof LOTS_CACHE_TTL_MS !== 'number') throw new Error('LOTS_CACHE_TTL_MS must be a number')

  return async function fetchCompletedItemsFromPlayerok(
    token,
    userAgent,
    useCache = true
  ) {
    // Проверяем кэш
    if (useCache) {
      const cached = lotsCache.get(token)
      if (cached?.completed) {
        const now = Date.now()
        if (now < cached.completed.expiresAt) {
          console.log('[cache] возврат завершённых лотов из кэша', {
            token: token.substring(0, 10) + '...',
            age:
              Math.floor(
                (now - (cached.completed.expiresAt - LOTS_CACHE_TTL_MS)) / 1000
              ) + 's',
          })
          return cached.completed.data
        }
      }
    }

    // Загружаем свежие данные
    const viewer = await getViewer(token, userAgent)

    const allItems = []
    let afterCursor = null
    let totalCount = 0
    const statusList = ['SOLD', 'EXPIRED']

    do {
      const page = await requestItemsPage(
        token,
        userAgent,
        viewer.id,
        afterCursor,
        statusList
      )
      allItems.push(...page.items)
      if (page.totalCount != null) totalCount = page.totalCount
      afterCursor = page.hasNextPage ? page.endCursor : null
    } while (afterCursor)

    const result = {
      items: allItems,
      totalCount: totalCount || allItems.length,
    }

    // Сохраняем в кэш
    if (useCache) {
      if (!lotsCache.has(token)) {
        lotsCache.set(token, {})
      }
      lotsCache.get(token).completed = {
        data: result,
        expiresAt: Date.now() + LOTS_CACHE_TTL_MS,
      }
    }

    return result
  }
}

module.exports = { createFetchCompletedItemsFromPlayerok }

