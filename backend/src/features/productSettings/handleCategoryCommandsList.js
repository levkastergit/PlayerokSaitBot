async function handleCategoryCommandsList({ query, currentUserId, deps }) {
  const { getTokenFromQueryOrStored, getAllSettings, CATEGORY_SETTINGS_PREFIX } = deps
  const { token } = getTokenFromQueryOrStored(currentUserId, query)

  if (!token) return { statusCode: 400, data: { error: 'token is required' } }

  try {
    const rows = getAllSettings.all(currentUserId)
    const list = []

    for (const row of rows) {
      const key = row.product_key || ''
      if (!key.startsWith(CATEGORY_SETTINGS_PREFIX)) continue

      const category = key.slice(CATEGORY_SETTINGS_PREFIX.length)

      let settings = null
      try {
        settings = row.settings ? JSON.parse(row.settings) : null
      } catch {
        settings = null
      }

      const commands = Array.isArray(settings?.commands)
        ? settings.commands.map((c) => ({
            id: c && c.id ? String(c.id) : null,
            label: c && c.label ? String(c.label) : '',
            text: c && c.text ? String(c.text) : '',
            color: c && c.color ? String(c.color) : '#6c757d',
          }))
        : []

      list.push({ category, commands })
    }

    return { statusCode: 200, data: { list } }
  } catch (err) {
    return { statusCode: 500, data: { error: 'Failed to load category commands', details: err.message } }
  }
}

module.exports = { handleCategoryCommandsList }

