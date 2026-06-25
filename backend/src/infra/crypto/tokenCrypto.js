const crypto = require('crypto')

// Секрет для хранения токена (шифрование). Нужен, чтобы не держать токен в открытом виде в БД.
// Поддерживаем два имени, чтобы проще было настроить: TOKEN_SECRET или HEAD_CODE.
const TOKEN_SECRET_RAW =
  (process.env.TOKEN_SECRET == null ? '' : String(process.env.TOKEN_SECRET)) ||
  (process.env.HEAD_CODE == null ? '' : String(process.env.HEAD_CODE))

// Ключ шифрования токенов выводится как sha256(secret) — это корректно ТОЛЬКО для
// высокоэнтропийного секрета (≥32 случайных символа). KDF (scrypt) тут не применяем
// намеренно: токен расшифровывается на КАЖДОМ запросе, scrypt добавил бы ~100мс latency,
// а смена схемы сломала бы все уже сохранённые токены. Поэтому требуем сильный секрет.
if (TOKEN_SECRET_RAW && TOKEN_SECRET_RAW.length < 32) {
  console.warn(
    '[crypto] ВНИМАНИЕ: TOKEN_SECRET короче 32 символов — это слабо для ключа шифрования. ' +
      'Задайте случайное значение >=32 символов (напр. `openssl rand -hex 32`).'
  )
}

function parseScryptHash(encoded) {
  const raw = String(encoded || '').trim()
  // format: scrypt$<saltB64>$<keyB64>
  const parts = raw.split('$')
  if (parts.length !== 3) return null
  if (parts[0] !== 'scrypt') return null
  try {
    const salt = Buffer.from(parts[1], 'base64')
    const key = Buffer.from(parts[2], 'base64')
    if (!salt.length || !key.length) return null
    return { salt, key }
  } catch {
    return null
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const key = crypto.scryptSync(String(password || ''), salt, 32)
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`
}

function verifyPassword(password, encodedHash) {
  const parsed = parseScryptHash(encodedHash)
  if (!parsed) {
    // УБРАН небезопасный plaintext-фоллбэк (раньше любой не-scrypt хэш сравнивался как
    // открытый текст — пароли в БД, не в формате scrypt$, проходили по равенству строк).
    // Принимаем ТОЛЬКО валидный scrypt$-хэш. Легаси-пароли (если есть) → сменить через регистрацию.
    return false
  }
  const derived = crypto.scryptSync(String(password || ''), parsed.salt, parsed.key.length)
  return crypto.timingSafeEqual(derived, parsed.key)
}

function getTokenCryptoKey() {
  const secret = String(TOKEN_SECRET_RAW || '')
  if (!secret) return null
  // 32 bytes key for AES-256-GCM
  return crypto.createHash('sha256').update(secret).digest()
}

/** Без секрета токен в БД хранится только в колонке `token` (legacy); для продакшена задайте TOKEN_SECRET или HEAD_CODE. */
function isTokenCryptoConfigured() {
  return getTokenCryptoKey() !== null
}

function encryptToken(plainToken) {
  const key = getTokenCryptoKey()
  if (!key) throw new Error('TOKEN_SECRET (or HEAD_CODE) is required to encrypt token')

  const iv = crypto.randomBytes(12) // GCM recommended IV length
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(String(plainToken || ''), 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()

  // payload = iv.tag.ciphertext (all base64)
  return [iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.')
}

function decryptToken(payload) {
  const key = getTokenCryptoKey()
  if (!key) throw new Error('TOKEN_SECRET (or HEAD_CODE) is required to decrypt token')

  const raw = String(payload || '')
  const parts = raw.split('.')
  if (parts.length !== 3) throw new Error('Invalid encrypted token payload')

  const iv = Buffer.from(parts[0], 'base64')
  const tag = Buffer.from(parts[1], 'base64')
  const ciphertext = Buffer.from(parts[2], 'base64')

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plain.toString('utf8')
}

module.exports = {
  hashPassword,
  verifyPassword,
  encryptToken,
  decryptToken,
  isTokenCryptoConfigured,
}

