async function handleGetToken({ currentUserId, deps }) {
  const { loadStoredTokenPlain } = deps

  try {
    const stored = loadStoredTokenPlain(currentUserId)
    if (!stored.token && !stored.tokenKey) {
      return { statusCode: 200, data: { token: null, updated_at: null } }
    }

    return { statusCode: 200, data: { token: stored.token || null, updated_at: stored.updatedAt } }
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

