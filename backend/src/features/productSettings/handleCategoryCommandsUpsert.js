async function handleCategoryCommandsUpsert({ payload, currentUserId, deps }) {
  const { getTokenFromBodyOrStored, upsertSettings, getCategorySettingsKey } = deps
  const { token } = getTokenFromBodyOrStored(currentUserId, payload)
  const rawCategory = payload.category
  const rawCommands = payload.commands
  const category = String(rawCategory || '').trim()

  if (!token || !category) {
    return { statusCode: 400, data: { error: 'token and category are required' } }
  }

  const commands = Array.isArray(rawCommands)
    ? rawCommands.map((c, index) => {
        const safe = typeof c === 'object' && c !== null ? c : {}
        const id =
          safe.id != null && safe.id !== '' ? String(safe.id) : `cmd-${Date.now()}-${index}`
        return {
          id,
          label: safe.label ? String(safe.label) : '',
          text: safe.text ? String(safe.text) : '',
          color: safe.color ? String(safe.color) : '#6c757d',
        }
      })
    : []

  const settings = { commands }
  const settingsStr = JSON.stringify(settings)
  const updatedAt = Math.floor(Date.now() / 1000)

  try {
    const productKey = getCategorySettingsKey(category)
    upsertSettings.run(currentUserId, String(productKey), settingsStr, updatedAt)
    return { statusCode: 200, data: { ok: true, category, updated_at: updatedAt } }
  } catch (err) {
    return { statusCode: 500, data: { error: 'Failed to save category commands', details: err.message } }
  }
}

module.exports = { handleCategoryCommandsUpsert }

