const { encryptToken, decryptToken } = require('../infra/crypto/tokenCrypto')

function setupClodeRepo(db) {
  const getRow = db.prepare(`
    SELECT api_key_enc, updated_at FROM clode_settings WHERE user_id = ?
  `)

  const upsertRow = db.prepare(`
    INSERT INTO clode_settings (user_id, api_key_enc, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      api_key_enc = excluded.api_key_enc,
      updated_at = excluded.updated_at
  `)

  const deleteRow = db.prepare(`
    DELETE FROM clode_settings WHERE user_id = ?
  `)

  function loadClodeApiKeyPlain(userId) {
    try {
      const row = getRow.get(userId)
      if (!row?.api_key_enc) return ''
      return decryptToken(row.api_key_enc) || ''
    } catch (e) {
      console.warn('[clode] loadClodeApiKeyPlain', e?.message || e)
      return ''
    }
  }

  function saveClodeApiKey(userId, apiKey) {
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

  function getClodeSettingsMeta(userId) {
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
    loadClodeApiKeyPlain,
    saveClodeApiKey,
    getClodeSettingsMeta,
  }
}

module.exports = { setupClodeRepo }
