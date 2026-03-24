async function handleGetProductSettings({ query, currentUserId, deps }) {
  const { getTokenFromQueryOrStored, getSettings } = deps
  const { token } = getTokenFromQueryOrStored(currentUserId, query)
  const productKey = query.productKey

  if (!token || productKey == null || productKey === '') {
    return { statusCode: 400, data: { error: 'token and productKey are required' } }
  }

  try {
    const tokenHash = token
    const key = String(productKey)
    console.info('[settings:get]', { tokenHash, productKey: key })
    const row = getSettings.get(currentUserId, key)
    if (!row) {
      console.info('[settings:get] не найдено', { tokenHash, productKey: key })
      return { statusCode: 200, data: { settings: null } }
    }

    let settings
    try {
      settings = JSON.parse(row.settings)
    } catch {
      settings = null
    }

    // Логирование не должно ломать ответ
    try {
      const s = settings || {}
      console.info('[settings:get] попадание в кэш', {
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

    return { statusCode: 200, data: { settings, updated_at: row.updated_at } }
  } catch (err) {
    return { statusCode: 500, data: { error: 'Failed to load settings', details: err.message } }
  }
}

module.exports = { handleGetProductSettings }

