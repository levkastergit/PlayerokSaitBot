async function handleUpsertProductSettings({ payload, currentUserId, deps }) {
  const { getTokenFromBodyOrStored, upsertSettings } = deps
  const { token } = getTokenFromBodyOrStored(currentUserId, payload)
  const productKey = payload.productKey
  const settings = payload.settings

  if (!token || productKey == null || productKey === '') {
    return { statusCode: 400, data: { error: 'token and productKey are required' } }
  }

  const tokenHash = token
  const key = String(productKey)
  const settingsStr = typeof settings === 'object' && settings !== null ? JSON.stringify(settings) : '{}'
  const updatedAt = Math.floor(Date.now() / 1000)

  try {
    upsertSettings.run(currentUserId, key, settingsStr, updatedAt)

    try {
      const s = typeof settings === 'object' && settings !== null ? settings : {}
      console.info('[settings:save]', {
        tokenHash,
        productKey: key,
        hasAutodelivery: Boolean(s && s.autodelivery),
        autodeliveryEnabled: Boolean(s && s.autodelivery && s.autodelivery.enabled),
        codesCount: Array.isArray(s && s.autodelivery && s.autodelivery.codes) ? s.autodelivery.codes.length : 0,
        hasAutomessage: Boolean(s && s.automessage),
        automessageEnabled: Boolean(s && s.automessage && s.automessage.enabled),
        hasAutolist: Boolean(s && s.autolist),
        autolistEnabled: Boolean(s && s.autolist && s.autolist.enabled),
        settingsLabel: typeof s.settingsLabel === 'string' ? s.settingsLabel : null,
      })
    } catch (_) {}

    return { statusCode: 200, data: { ok: true, updated_at: updatedAt } }
  } catch (err) {
    return { statusCode: 500, data: { error: 'Failed to save settings', details: err.message } }
  }
}

module.exports = { handleUpsertProductSettings }

