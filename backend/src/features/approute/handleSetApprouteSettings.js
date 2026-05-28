async function handleSetApprouteSettings({ payload, currentUserId, deps }) {
  const { saveApprouteApiKey } = deps
  if (typeof saveApprouteApiKey !== 'function') {
    return { statusCode: 500, data: { error: 'Server misconfiguration' } }
  }

  const raw = payload && Object.prototype.hasOwnProperty.call(payload, 'apiKey') ? payload.apiKey : null
  const clear = payload && payload.clear === true
  const apiKey = clear ? '' : raw == null ? null : String(raw || '').trim()

  if (apiKey === null) {
    return { statusCode: 400, data: { error: 'apiKey is required (or clear: true)' } }
  }

  try {
    const saved = saveApprouteApiKey(currentUserId, apiKey)
    return {
      statusCode: 200,
      data: {
        ok: true,
        configured: Boolean(saved.configured),
        updated_at: saved.updatedAt != null ? saved.updatedAt : null,
      },
    }
  } catch (err) {
    return {
      statusCode: 500,
      data: { error: 'Failed to save AppRoute API key', details: err?.message || String(err) },
    }
  }
}

module.exports = { handleSetApprouteSettings }
