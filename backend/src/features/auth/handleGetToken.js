async function handleGetToken({ currentUserId, deps }) {
  try {
    const loadStoredTokenPlain = deps && deps.loadStoredTokenPlain
    if (typeof loadStoredTokenPlain !== 'function') {
      return { statusCode: 500, data: { error: 'Server misconfiguration' } }
    }

    const stored = loadStoredTokenPlain(currentUserId) || { token: '', updatedAt: null }
    const token = stored.token && String(stored.token).trim() ? stored.token : null
    return {
      statusCode: 200,
      data: {
        token,
        updated_at: stored.updatedAt != null ? stored.updatedAt : null,
      },
    }
  } catch (err) {
    return {
      statusCode: 500,
      data: {
        error: 'Failed to load token',
        details: err && err.message ? String(err.message) : String(err),
      },
    }
  }
}

module.exports = { handleGetToken }

