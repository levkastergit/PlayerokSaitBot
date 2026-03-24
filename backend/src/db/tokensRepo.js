const { encryptToken, decryptToken } = require('../infra/crypto/tokenCrypto')

function setupTokensRepo(db) {
  const getStoredToken = db.prepare(`
    SELECT token, token_enc, updated_at FROM tokens WHERE user_id = ?
  `)
  const getAllStoredTokens = db.prepare(`
    SELECT user_id, token, token_enc, updated_at FROM tokens
  `)

  const upsertStoredToken = db.prepare(`
    INSERT INTO tokens (user_id, token, token_enc, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      token = excluded.token,
      token_enc = excluded.token_enc,
      updated_at = excluded.updated_at
  `)

  const deleteStoredToken = db.prepare(`
    DELETE FROM tokens WHERE user_id = ?
  `)

  function loadStoredTokenPlain(userId) {
    const row = getStoredToken.get(userId)
    if (!row) return { token: '', updatedAt: null }

    const updatedAt = row.updated_at != null ? row.updated_at : null
    if (row.token_enc) {
      try {
        const t = decryptToken(row.token_enc)
        return { token: t, updatedAt }
      } catch (e) {
        return { token: '', updatedAt }
      }
    }

    // Legacy: если token_enc нет, токен мог храниться в поле token
    const legacy = row.token ? String(row.token) : ''
    if (!legacy) return { token: '', updatedAt }

    try {
      const enc = encryptToken(legacy)
      upsertStoredToken.run(userId, legacy, enc, updatedAt || Math.floor(Date.now() / 1000))
      return { token: legacy, updatedAt }
    } catch {
      return { token: legacy, updatedAt }
    }
  }

  function getTokenFromBodyOrStored(userId, payload) {
    const raw = payload && Object.prototype.hasOwnProperty.call(payload, 'token') ? payload.token : null
    const provided = raw == null ? '' : String(raw || '').trim()
    if (provided) return { token: provided }

    const stored = loadStoredTokenPlain(userId)
    return { token: stored.token || '' }
  }

  function getTokenFromQueryOrStored(userId, query) {
    const provided = query && query.token != null ? String(query.token || '').trim() : ''
    if (provided) return { token: provided }

    const stored = loadStoredTokenPlain(userId)
    return { token: stored.token || '' }
  }

  return {
    getStoredToken,
    getAllStoredTokens,
    upsertStoredToken,
    deleteStoredToken,
    loadStoredTokenPlain,
    getTokenFromBodyOrStored,
    getTokenFromQueryOrStored,
  }
}

module.exports = { setupTokensRepo }

