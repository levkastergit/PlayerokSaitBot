async function handleGetProductSettings({ query, currentUserId, deps }) {
  const { getTokenFromQueryOrStored, getSettings } = deps
  const { token } = getTokenFromQueryOrStored(currentUserId, query)
  const productKey = query.productKey

  if (!token || productKey == null || productKey === '') {
    return { statusCode: 400, data: { error: 'token and productKey are required' } }
  }

  try {
    const key = String(productKey)
    const row = getSettings.get(currentUserId, key)
    if (!row) {
      return { statusCode: 200, data: { settings: null } }
    }

    let settings
    try {
      settings = JSON.parse(row.settings)
    } catch {
      settings = null
    }

    return { statusCode: 200, data: { settings, updated_at: row.updated_at } }
  } catch (err) {
    return { statusCode: 500, data: { error: 'Failed to load settings', details: err.message } }
  }
}

module.exports = { handleGetProductSettings }

