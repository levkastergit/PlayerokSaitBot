const { encryptToken, decryptToken } = require('../infra/crypto/tokenCrypto')

// Настройки Swizzyer на пользователя: API-ключ (swz_live_...) и секрет подписи
// вебхуков (whsec_...). Оба хранятся в зашифрованном виде (AES-256-GCM, как
// токены Playerok / ключ AppRoute).
function setupSwizzyerRepo(db) {
  const getRow = db.prepare(`
    SELECT api_key_enc, webhook_secret_enc, updated_at FROM swizzyer_settings WHERE user_id = ?
  `)

  const upsertRow = db.prepare(`
    INSERT INTO swizzyer_settings (user_id, api_key_enc, webhook_secret_enc, updated_at)
    VALUES (@user_id, @api_key_enc, @webhook_secret_enc, @updated_at)
    ON CONFLICT(user_id) DO UPDATE SET
      api_key_enc = excluded.api_key_enc,
      webhook_secret_enc = excluded.webhook_secret_enc,
      updated_at = excluded.updated_at
  `)

  const deleteRow = db.prepare(`DELETE FROM swizzyer_settings WHERE user_id = ?`)

  function decryptSafe(value, label) {
    if (!value) return ''
    try {
      return decryptToken(value) || ''
    } catch (e) {
      console.warn(`[swizzyer] decrypt ${label}`, e?.message || e)
      return ''
    }
  }

  function loadSwizzyerApiKeyPlain(userId) {
    try {
      const row = getRow.get(userId)
      return decryptSafe(row?.api_key_enc, 'apiKey')
    } catch (e) {
      console.warn('[swizzyer] loadSwizzyerApiKeyPlain', e?.message || e)
      return ''
    }
  }

  function loadSwizzyerWebhookSecretPlain(userId) {
    try {
      const row = getRow.get(userId)
      return decryptSafe(row?.webhook_secret_enc, 'webhookSecret')
    } catch (e) {
      console.warn('[swizzyer] loadSwizzyerWebhookSecretPlain', e?.message || e)
      return ''
    }
  }

  // Частичное обновление: переданные поля (apiKey/webhookSecret) перезаписываются,
  // остальные сохраняют текущее значение. '' (пустая строка) очищает поле.
  function saveSwizzyerSettings(userId, { apiKey, webhookSecret } = {}) {
    const existing = getRow.get(userId) || {}
    const nextApiKeyPlain =
      apiKey === undefined ? decryptSafe(existing.api_key_enc, 'apiKey') : String(apiKey || '').trim()
    const nextSecretPlain =
      webhookSecret === undefined
        ? decryptSafe(existing.webhook_secret_enc, 'webhookSecret')
        : String(webhookSecret || '').trim()

    const updatedAt = Math.floor(Date.now() / 1000)
    if (!nextApiKeyPlain && !nextSecretPlain) {
      deleteRow.run(userId)
      return { apiKeyConfigured: false, webhookConfigured: false, updatedAt: null }
    }
    upsertRow.run({
      user_id: userId,
      api_key_enc: nextApiKeyPlain ? encryptToken(nextApiKeyPlain) : null,
      webhook_secret_enc: nextSecretPlain ? encryptToken(nextSecretPlain) : null,
      updated_at: updatedAt,
    })
    return {
      apiKeyConfigured: Boolean(nextApiKeyPlain),
      webhookConfigured: Boolean(nextSecretPlain),
      updatedAt,
    }
  }

  function getSwizzyerSettingsMeta(userId) {
    try {
      const row = getRow.get(userId)
      if (!row) return { apiKeyConfigured: false, webhookConfigured: false, updatedAt: null }
      return {
        apiKeyConfigured: Boolean(row.api_key_enc),
        webhookConfigured: Boolean(row.webhook_secret_enc),
        updatedAt: row.updated_at != null ? row.updated_at : null,
      }
    } catch {
      return { apiKeyConfigured: false, webhookConfigured: false, updatedAt: null }
    }
  }

  return {
    loadSwizzyerApiKeyPlain,
    loadSwizzyerWebhookSecretPlain,
    saveSwizzyerSettings,
    getSwizzyerSettingsMeta,
  }
}

module.exports = { setupSwizzyerRepo }
