async function handleCompletedLots({ payload, currentUserId, nowTs, deps }) {
  const {
    getTokenFromBodyOrStored,
    fetchCompletedItemsFromPlayerok,
    autolistPruneItemStateMap,
    autolistGetItemState,
  } = deps

  const { token } = getTokenFromBodyOrStored(currentUserId, payload)
  const userAgent = payload.userAgent

  if (!token) {
    return { statusCode: 400, data: { error: 'Token is required' } }
  }

  try {
    const result = await fetchCompletedItemsFromPlayerok(token, userAgent)

    try {
      const tokenHash = token
      autolistPruneItemStateMap(tokenHash, nowTs)

      if (Array.isArray(result?.items)) {
        result.items = result.items.map((it) => {
          const id = it && it.id != null ? String(it.id) : null
          if (!id) return it
          const st = autolistGetItemState(tokenHash, id)
          if (!st) return it
          return { ...it, autolistRuntime: st }
        })
      }
    } catch (_) {}

    return { statusCode: 200, data: result }
  } catch (err) {
    const message = err && err.message ? String(err.message) : 'Не удалось загрузить завершённые лоты с Playerok'
    return { statusCode: 500, data: { error: message } }
  }
}

module.exports = { handleCompletedLots }

