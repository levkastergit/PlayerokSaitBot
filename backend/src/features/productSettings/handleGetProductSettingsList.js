async function handleGetProductSettingsList({ query, currentUserId, deps }) {
  const { getTokenFromQueryOrStored, getAllSettings } = deps
  const { token } = getTokenFromQueryOrStored(currentUserId, query)

  if (!token) return { statusCode: 400, data: { error: 'token is required' } }

  try {
    const rows = getAllSettings.all(currentUserId)
    const list = rows.map((row) => {
      let settings = null
      try {
        settings = row.settings ? JSON.parse(row.settings) : null
      } catch {
        // ignore parsing issues for individual rows
      }
      return { productKey: row.product_key, settings }
    })
    return { statusCode: 200, data: { list } }
  } catch (err) {
    return { statusCode: 500, data: { error: 'Failed to load settings list', details: err.message } }
  }
}

module.exports = { handleGetProductSettingsList }

