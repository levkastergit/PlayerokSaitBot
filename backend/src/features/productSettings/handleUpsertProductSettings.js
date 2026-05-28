async function handleUpsertProductSettings({ payload, currentUserId, deps }) {
  const { getTokenFromBodyOrStored, upsertSettings, autolistClearApprouteChatProcessed } = deps
  const { token } = getTokenFromBodyOrStored(currentUserId, payload)
  const productKey = payload.productKey
  const settings = payload.settings

  if (!token || productKey == null || productKey === '') {
    return { statusCode: 400, data: { error: 'token and productKey are required' } }
  }

  const key = String(productKey)
  const settingsStr = typeof settings === 'object' && settings !== null ? JSON.stringify(settings) : '{}'
  const updatedAt = Math.floor(Date.now() / 1000)

  try {
    upsertSettings.run(currentUserId, key, settingsStr, updatedAt)

    try {
      const s = typeof settings === 'object' && settings !== null ? settings : {}
      if (
        s.autodeliveryApi?.enabled &&
        typeof autolistClearApprouteChatProcessed === 'function'
      ) {
        autolistClearApprouteChatProcessed(token)
      }
    } catch (_) {}

    return { statusCode: 200, data: { ok: true, updated_at: updatedAt } }
  } catch (err) {
    return { statusCode: 500, data: { error: 'Failed to save settings', details: err.message } }
  }
}

module.exports = { handleUpsertProductSettings }

