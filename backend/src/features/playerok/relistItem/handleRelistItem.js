async function handleRelistItem({ payload, currentUserId, deps }) {
  const {
    getTokenFromBodyOrStored,
    publishItem,
    fetchItemPriorityStatuses,
    requestItemById,
    withRetry,
    isPlayerokRateLimitError,
    isPlayerokPublishRetryable,
    AUTOBUMP_PRIORITY_STATUS_ID,
  } = deps

  const { token } = getTokenFromBodyOrStored(currentUserId, payload)
  const itemId = payload.itemId
  const userAgent = payload.userAgent

  if (!token || !itemId) {
    return { statusCode: 400, data: { error: 'token and itemId are required' } }
  }

  try {
    // Получаем текущую цену товара для запроса статусов приоритета.
    let currentPrice = null
    try {
      if (typeof requestItemById === 'function') {
        const item = await requestItemById(token, userAgent, itemId)
        if (item) currentPrice = typeof item.price === 'number' && item.price > 0 ? item.price : null
      }
    } catch (_) { /* используем цену = null */ }

    // Запрашиваем доступные статусы приоритета (бустеры) для этого товара.
    let statusesList = []
    let priorityStatusId = null
    try {
      if (typeof fetchItemPriorityStatuses === 'function') {
        const retryFn = typeof withRetry === 'function' ? withRetry : (fn) => fn()
        const statuses = await retryFn(
          () => fetchItemPriorityStatuses(token, userAgent, itemId, currentPrice),
          { label: 'itemPriorityStatuses(relistItem)', retries: 2, shouldRetry: isPlayerokRateLimitError }
        )
        statusesList = Array.isArray(statuses) ? statuses : []
        if (statusesList.length > 0) {
          const free = statusesList.find((s) => !s?.price || Number(s.price) === 0)
          priorityStatusId = (free || statusesList[0])?.id || null
        }
      }
    } catch (_) { priorityStatusId = null }

    // Пробуем все статусы по очереди, как делает автовыставление.
    const otherStatuses = statusesList
      .filter((s) => s?.id && String(s.id) !== String(priorityStatusId))
      .map((s) => s.id)
    let statusesToTry = priorityStatusId ? [priorityStatusId, ...otherStatuses] : otherStatuses
    if (statusesToTry.length === 0 && AUTOBUMP_PRIORITY_STATUS_ID) {
      statusesToTry = [AUTOBUMP_PRIORITY_STATUS_ID]
    }

    const retryPublish = typeof withRetry === 'function'
      ? withRetry
      : (fn) => fn()

    let relisted = null
    let publishError = null

    for (const tryStatusId of statusesToTry) {
      try {
        relisted = await retryPublish(
          () => publishItem(token, userAgent, itemId, { priorityStatusId: tryStatusId }),
          { label: 'publishItem(relist)', retries: 3, baseDelayMs: 800, shouldRetry: isPlayerokPublishRetryable }
        )
        publishError = null
        break
      } catch (err) {
        const msg = String(err?.message || err)
        publishError = err
        // Если ошибка не связана с некорректным бустером — не пробуем другие.
        if (!msg.includes('некорректных бустеров') && !msg.includes('BAD_REQUEST') && !msg.includes('400')) break
      }
    }

    // Финальный фолбэк: без бустера (priorityStatuses: []).
    if (!relisted) {
      try {
        relisted = await retryPublish(
          () => publishItem(token, userAgent, itemId, { priorityStatusId: null }),
          { label: 'publishItem(relist-no-status)', retries: 2, baseDelayMs: 800, shouldRetry: isPlayerokPublishRetryable }
        )
        publishError = null
      } catch (err) {
        if (!publishError) publishError = err
      }
    }

    if (!relisted) {
      const err = publishError || new Error('Не удалось выставить товар')
      return { statusCode: 500, data: { error: String(err.message || err) } }
    }

    return { statusCode: 200, data: { ok: true, itemId: relisted.id } }
  } catch (err) {
    return {
      statusCode: 500,
      data: { error: err && err.message ? String(err.message) : 'Failed to relist item' },
    }
  }
}

module.exports = { handleRelistItem }

