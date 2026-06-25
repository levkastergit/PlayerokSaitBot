async function handleGetToken({ currentUserId, deps }) {
  try {
    const loadStoredTokenPlain = deps && deps.loadStoredTokenPlain
    if (typeof loadStoredTokenPlain !== 'function') {
      return { statusCode: 500, data: { error: 'Server misconfiguration' } }
    }

    const stored = loadStoredTokenPlain(currentUserId) || { token: '', updatedAt: null }
    const hasToken = Boolean(stored.token && String(stored.token).trim())
    return {
      statusCode: 200,
      data: {
        // Сырой токен Playerok НАРУЖУ НЕ отдаём (защита от кражи через XSS/логи). Бэкенд сам
        // использует stored-токен по сессии (см. санитайз body-token в dispatchPlayerok).
        // Фронту достаточно факта наличия токена.
        hasToken,
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

