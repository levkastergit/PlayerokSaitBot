const { encryptToken, decryptToken } = require('../infra/crypto/tokenCrypto')

function setupApprouteRepo(db) {
  const getRow = db.prepare(`
    SELECT api_key_enc, updated_at FROM approute_settings WHERE user_id = ?
  `)

  const upsertRow = db.prepare(`
    INSERT INTO approute_settings (user_id, api_key_enc, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      api_key_enc = excluded.api_key_enc,
      updated_at = excluded.updated_at
  `)

  const deleteRow = db.prepare(`
    DELETE FROM approute_settings WHERE user_id = ?
  `)

  function loadApprouteApiKeyPlain(userId) {
    try {
      const row = getRow.get(userId)
      if (!row?.api_key_enc) return ''
      return decryptToken(row.api_key_enc) || ''
    } catch (e) {
      console.warn('[approute] loadApprouteApiKeyPlain', e?.message || e)
      return ''
    }
  }

  function saveApprouteApiKey(userId, apiKey) {
    const trimmed = String(apiKey || '').trim()
    const updatedAt = Math.floor(Date.now() / 1000)
    if (!trimmed) {
      deleteRow.run(userId)
      return { configured: false, updatedAt: null }
    }
    const enc = encryptToken(trimmed)
    upsertRow.run(userId, enc, updatedAt)
    return { configured: true, updatedAt }
  }

  function getApprouteSettingsMeta(userId) {
    try {
      const row = getRow.get(userId)
      if (!row?.api_key_enc) return { configured: false, updatedAt: null }
      return {
        configured: true,
        updatedAt: row.updated_at != null ? row.updated_at : null,
      }
    } catch {
      return { configured: false, updatedAt: null }
    }
  }

  return {
    loadApprouteApiKeyPlain,
    saveApprouteApiKey,
    getApprouteSettingsMeta,
  }
}

module.exports = { setupApprouteRepo }
