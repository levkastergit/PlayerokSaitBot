'use strict'

function createFetchActiveItemsFromPlayerok({
  getViewer,
  requestItemsPage,
  lotsCache,
  LOTS_CACHE_TTL_MS,
}) {
  if (typeof getViewer !== 'function') throw new Error('getViewer must be a function')
  if (typeof requestItemsPage !== 'function') throw new Error('requestItemsPage must be a function')
  if (!(lotsCache instanceof Map)) throw new Error('lotsCache must be a Map')
  if (typeof LOTS_CACHE_TTL_MS !== 'number') throw new Error('LOTS_CACHE_TTL_MS must be a number')

  return async function fetchActiveItemsFromPlayerok(
    token,
    userAgent,
    useCache = true
  ) {
    // Проверяем кэш
    if (useCache) {
      const cached = lotsCache.get(token)
      if (cached?.active) {
        const now = Date.now()
        if (now < cached.active.expiresAt) {
          return cached.active.data
        }
      }
    }

    // Загружаем свежие данные; при любом сбое (брейкер/таймаут/429) отдаём last-good из кэша.
    let result
    try {
      const viewer = await getViewer(token, userAgent)

      const allItems = []
      let afterCursor = null
      let totalCount = 0

      do {
        const page = await requestItemsPage(
          token,
          userAgent,
          viewer.id,
          afterCursor,
          ['APPROVED']
        )
        allItems.push(...page.items)
        if (page.totalCount != null) totalCount = page.totalCount
        afterCursor = page.hasNextPage ? page.endCursor : null
      } while (afterCursor)

      result = {
        items: allItems,
        totalCount: totalCount || allItems.length,
      }
    } catch (err) {
      const cached = lotsCache.get(token)
      if (cached?.active?.data) {
        return { ...cached.active.data, _stale: true }
      }
      throw err
    }

    // Сохраняем в кэш
    if (useCache) {
      if (!lotsCache.has(token)) {
        lotsCache.set(token, {})
      }
      lotsCache.get(token).active = {
        data: result,
        expiresAt: Date.now() + LOTS_CACHE_TTL_MS,
      }
    }

    return result
  }
}

module.exports = { createFetchActiveItemsFromPlayerok }

