const { isTokenCryptoConfigured } = require('../../infra/crypto/tokenCrypto')

async function handleSetToken({ payload, currentUserId, deps }) {
  const { encryptToken, upsertStoredToken, deleteStoredToken } = deps

  const token = String(
    payload && Object.prototype.hasOwnProperty.call(payload, 'token') ? payload.token : ''
  ).trim()

  const updatedAt = Math.floor(Date.now() / 1000)

  try {
    if (!token) {
      deleteStoredToken.run(currentUserId)
      return { statusCode: 200, data: { ok: true, updated_at: null } }
    }

    let tokenEnc = null
    if (isTokenCryptoConfigured()) {
      tokenEnc = encryptToken(token)
    } else {
      console.warn(
        '[auth] TOKEN_SECRET/HEAD_CODE не заданы — токен Playerok сохраняется в БД без шифрования. Для продакшена задайте TOKEN_SECRET в .env'
      )
    }
    // При шифровании token дублируем для legacy; без секрета только колонка token (как раньше).
    upsertStoredToken.run(currentUserId, token, tokenEnc, updatedAt)
    return { statusCode: 200, data: { ok: true, updated_at: updatedAt } }
  } catch (err) {
    return {
      statusCode: 500,
      data: {
        error: 'Failed to save token',
        details: err && err.message ? String(err.message) : String(err),
      },
    }
  }
}

module.exports = { handleSetToken }

