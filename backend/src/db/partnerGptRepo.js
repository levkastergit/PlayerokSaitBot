const { encryptToken, decryptToken } = require('../infra/crypto/tokenCrypto')

// API-ключ Partner Redemption (ChatGPT, ogp_live_...) на пользователя —
// зашифрован (AES-256-GCM), как ключ AppRoute/Clode.
function setupPartnerGptRepo(db) {
  const getRow = db.prepare(`SELECT api_key_enc, updated_at FROM partner_gpt_settings WHERE user_id = ?`)
  const upsertRow = db.prepare(`
    INSERT INTO partner_gpt_settings (user_id, api_key_enc, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      api_key_enc = excluded.api_key_enc,
      updated_at = excluded.updated_at
  `)
  const deleteRow = db.prepare(`DELETE FROM partner_gpt_settings WHERE user_id = ?`)

  function loadPartnerGptApiKeyPlain(userId) {
    try {
      const row = getRow.get(userId)
      if (!row?.api_key_enc) return ''
      return decryptToken(row.api_key_enc) || ''
    } catch (e) {
      console.warn('[partner-gpt] loadPartnerGptApiKeyPlain', e?.message || e)
      return ''
    }
  }

  function savePartnerGptApiKey(userId, apiKey) {
    const trimmed = String(apiKey || '').trim()
    const updatedAt = Math.floor(Date.now() / 1000)
    if (!trimmed) {
      deleteRow.run(userId)
      return { configured: false, updatedAt: null }
    }
    upsertRow.run(userId, encryptToken(trimmed), updatedAt)
    return { configured: true, updatedAt }
  }

  function getPartnerGptSettingsMeta(userId) {
    try {
      const row = getRow.get(userId)
      if (!row?.api_key_enc) return { configured: false, updatedAt: null }
      return { configured: true, updatedAt: row.updated_at != null ? row.updated_at : null }
    } catch {
      return { configured: false, updatedAt: null }
    }
  }

  return { loadPartnerGptApiKeyPlain, savePartnerGptApiKey, getPartnerGptSettingsMeta }
}

module.exports = { setupPartnerGptRepo }
