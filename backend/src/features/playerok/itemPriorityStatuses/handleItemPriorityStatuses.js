async function handleItemPriorityStatuses({ payload, currentUserId, deps }) {
  const { getTokenFromBodyOrStored, requestItemById, fetchItemPriorityStatuses } = deps

  const { token } = getTokenFromBodyOrStored(currentUserId, payload)
  const itemId = payload.itemId
  const price = payload.price
  const userAgent = payload.userAgent

  if (!token || !itemId) {
    return { statusCode: 400, data: { error: 'token and itemId are required' } }
  }

  try {
    // ВСЕГДА получаем актуальную цену товара перед запросом статусов
    // НЕ используем переданную цену - она может быть устаревшей
    // Для получения статусов поднятия нужно использовать ОРИГИНАЛЬНУЮ цену (rawPrice), а не цену со скидкой
    let currentPrice = Number(price) || 0
    try {
      const currentItem = await requestItemById(token, userAgent, itemId)
      if (currentItem) {
        // Приоритет: rawPrice (оригинальная цена) > price (цена со скидкой)
        const itemPrice =
          typeof currentItem.rawPrice === 'number' && currentItem.rawPrice > 0
            ? currentItem.rawPrice
            : typeof currentItem.price === 'number' && currentItem.price > 0
              ? currentItem.price
              : null
        if (itemPrice != null && itemPrice > 0) {
          currentPrice = itemPrice
          console.info('[item-priority-statuses] текущая цена обновлена (rawPrice для статусов)', {
            itemId,
            oldPrice: Number(price) || 0,
            currentPrice,
            discountedPrice: currentItem.price,
            rawPrice: currentItem.rawPrice,
          })
        }
      }
    } catch (err) {
      // Если не удалось получить актуальную цену, используем переданную
      console.warn('[item-priority-statuses] не удалось получить текущую цену', {
        itemId,
        error: err?.message,
        usingProvidedPrice: currentPrice,
      })
    }

    const list = await fetchItemPriorityStatuses(token, userAgent, itemId, currentPrice)
    const mapped = (Array.isArray(list) ? list : []).map((s) => ({
      id: s?.id ?? null,
      name: s?.name ?? '',
      type: s?.type ?? null,
      period: s?.period ?? null,
      price: typeof s?.price === 'number' ? s.price : null,
      priceRange: s?.priceRange ? { min: s.priceRange.min ?? null, max: s.priceRange.max ?? null } : null,
    }))

    return { statusCode: 200, data: { list: mapped } }
  } catch (err) {
    return {
      statusCode: 500,
      data: { error: err && err.message ? String(err.message) : 'Failed to load priority statuses' },
    }
  }
}

module.exports = { handleItemPriorityStatuses }

