try {
  require('dotenv').config()
} catch (_) {
  // dotenv не установлен — запустите в папке backend: npm install dotenv
}
const http = require('http')
const https = require('https')
const crypto = require('crypto')
const path = require('path')
const fs = require('fs')
const { URLSearchParams } = require('url')

const PORT = process.env.PORT || 3000

// Аутентификация: логин и пароль из .env.
// - AUTH_LOGIN: логин (включает аутентификацию, если задан)
// - AUTH_PASSWORD_HASH: предпочтительно (scrypt) — пароль в виде хэша
// - AUTH_PASSWORD: legacy/plaintext (не рекомендуется)
const AUTH_LOGIN = (process.env.AUTH_LOGIN || '').trim()
const AUTH_PASSWORD = process.env.AUTH_PASSWORD == null ? '' : String(process.env.AUTH_PASSWORD)
const AUTH_PASSWORD_HASH =
  process.env.AUTH_PASSWORD_HASH == null ? '' : String(process.env.AUTH_PASSWORD_HASH).trim()
const AUTH_ENABLED = AUTH_LOGIN !== ''

const SESSION_TTL_MS = 24 * 60 * 60 * 1000 // 24 часа
const sessions = new Map() // sessionId -> { expiresAt }

// "Код от хеда": user-agent для запросов к Playerok берём из .env, чтобы не был захардкожен в коде.
const PLAYEROK_USER_AGENT =
  process.env.PLAYEROK_USER_AGENT == null ? '' : String(process.env.PLAYEROK_USER_AGENT).trim()

// Секрет для хранения токена (шифрование). Нужен, чтобы не держать токен в открытом виде в БД.
// Поддерживаем два имени, чтобы проще было настроить: TOKEN_SECRET или HEAD_CODE.
const TOKEN_SECRET_RAW =
  (process.env.TOKEN_SECRET == null ? '' : String(process.env.TOKEN_SECRET)) ||
  (process.env.HEAD_CODE == null ? '' : String(process.env.HEAD_CODE))

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

function verifyPassword(password, encodedHash) {
  const parsed = parseScryptHash(encodedHash)
  if (!parsed) return false
  const derived = crypto.scryptSync(String(password || ''), parsed.salt, parsed.key.length)
  return crypto.timingSafeEqual(derived, parsed.key)
}

function getTokenCryptoKey() {
  const secret = String(TOKEN_SECRET_RAW || '')
  if (!secret) return null
  // 32 bytes key for AES-256-GCM
  return crypto.createHash('sha256').update(secret).digest()
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isPlayerokRateLimitError(err) {
  const msg = err && err.message ? String(err.message) : String(err || '')
  return (
    msg.includes('Слишком много попыток') ||
    msg.toLowerCase().includes('too many attempts') ||
    msg.toLowerCase().includes('rate limit') ||
    msg.toLowerCase().includes('status 429') ||
    msg.toLowerCase().includes('status 403')
  )
}

async function withRetry(fn, opts = {}) {
  const {
    retries = 3,
    baseDelayMs = 700,
    maxDelayMs = 8000,
    shouldRetry = () => false,
    label = 'op',
  } = opts

  let lastErr = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const retryable = attempt < retries && shouldRetry(err)
      if (!retryable) break

      const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt))
      const jitter = Math.floor(Math.random() * 250)
      const delay = exp + jitter
      console.warn(`[retry] ${label} failed, retrying`, { attempt: attempt + 1, delayMs: delay, error: err?.message })
      await sleep(delay)
    }
  }
  throw lastErr
}

function getSessionIdFromRequest(req) {
  const cookie = req.headers.cookie || ''
  const match = cookie.match(/\bsession=([a-f0-9]+)/i)
  if (match) return match[1]
  const auth = req.headers.authorization || ''
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim()
  return null
}

function isSessionValid(sessionId) {
  if (!sessionId) return false
  const s = sessions.get(sessionId)
  if (!s || Date.now() > s.expiresAt) {
    if (s) sessions.delete(sessionId)
    return false
  }
  return true
}

function createSession() {
  const sessionId = crypto.randomBytes(32).toString('hex')
  sessions.set(sessionId, { expiresAt: Date.now() + SESSION_TTL_MS })
  return sessionId
}

function destroySession(sessionId) {
  if (sessionId) sessions.delete(sessionId)
}

const FRONTEND_DIST = path.join(__dirname, '..', 'frontend', 'dist')

const Database = require('better-sqlite3')
const DATA_DIR = path.join(__dirname, 'data')
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
const DB_PATH = path.join(DATA_DIR, 'product-settings.db')
const db = new Database(DB_PATH)
db.exec(`
  CREATE TABLE IF NOT EXISTS product_settings (
    token_hash TEXT NOT NULL,
    product_key TEXT NOT NULL,
    settings TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (token_hash, product_key)
  )
`)
db.exec(`
  CREATE TABLE IF NOT EXISTS tokens (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    token TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )
`)
// Миграция tokens: добавляем безопасные поля (шифротекст + хэш), старое поле token оставляем для совместимости.
try {
  const cols = db.prepare('PRAGMA table_info(tokens)').all()
  if (!cols.some((c) => c.name === 'token_hash')) {
    db.exec('ALTER TABLE tokens ADD COLUMN token_hash TEXT')
  }
  if (!cols.some((c) => c.name === 'token_enc')) {
    db.exec('ALTER TABLE tokens ADD COLUMN token_enc TEXT')
  }
} catch (_) { }
// Миграция bump_history: добавляем item_id для подсчёта поднятий конкретного лота.
try {
  const bumpCols = db.prepare('PRAGMA table_info(bump_history)').all()
  if (!bumpCols.some((c) => c.name === 'item_id')) {
    db.exec('ALTER TABLE bump_history ADD COLUMN item_id TEXT')
    db.exec('CREATE INDEX IF NOT EXISTS idx_bump_history_item ON bump_history(item_id)')
  }
} catch (_) { }
db.exec(`
  CREATE TABLE IF NOT EXISTS bump_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL,
    product_key TEXT NOT NULL,
    product_title TEXT NOT NULL,
    bumped_at INTEGER NOT NULL,
    price REAL NOT NULL DEFAULT 0,
    item_id TEXT
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_bump_history_token ON bump_history(token_hash)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_bump_history_bumped_at ON bump_history(bumped_at DESC)`)

db.exec(`
  CREATE TABLE IF NOT EXISTS sales_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL,
    product_key TEXT NOT NULL,
    product_title TEXT NOT NULL,
    sold_at INTEGER NOT NULL,
    price REAL NOT NULL DEFAULT 0,
    status TEXT,
    deal_id TEXT,
    item_id TEXT,
    buyer_name TEXT,
    UNIQUE(token_hash, deal_id)
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_history_token ON sales_history(token_hash)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_history_sold_at ON sales_history(sold_at DESC)`)
try {
  const cols = db.prepare('PRAGMA table_info(sales_history)').all()
  if (!cols.some((c) => c.name === 'is_refund')) {
    db.exec('ALTER TABLE sales_history ADD COLUMN is_refund INTEGER DEFAULT 0')
  }
  if (!cols.some((c) => c.name === 'buyer_name')) {
    db.exec('ALTER TABLE sales_history ADD COLUMN buyer_name TEXT')
  }
} catch (_) { }

db.exec(`
  CREATE TABLE IF NOT EXISTS listing_fees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL,
    product_key TEXT NOT NULL,
    fee REAL NOT NULL DEFAULT 0,
    relisted_at INTEGER NOT NULL
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_listing_fees_token ON listing_fees(token_hash)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_listing_fees_product ON listing_fees(token_hash, product_key, relisted_at)`)

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 32)
}

function loadStoredTokenPlain() {
  const row = getStoredToken.get()
  if (!row) return { token: '', tokenHash: null, updatedAt: null }
  const updatedAt = row.updated_at != null ? row.updated_at : null

  // Предпочтительно: token_enc (шифрованный токен) + token_hash
  if (row.token_enc) {
    try {
      const t = decryptToken(row.token_enc)
      const h = row.token_hash || hashToken(t)
      return { token: t, tokenHash: h, updatedAt }
    } catch (e) {
      // если секрет сменили/повреждено — не отдаём токен
      return { token: '', tokenHash: row.token_hash || null, updatedAt }
    }
  }

  // Legacy: token в открытом виде (хэшируем и по возможности мигрируем в безопасный формат)
  const legacy = row.token ? String(row.token) : ''
  if (!legacy) return { token: '', tokenHash: row.token_hash || null, updatedAt }
  const legacyHash = row.token_hash || hashToken(legacy)
  try {
    const enc = encryptToken(legacy)
    // сохраняем миграцию: оставляем token как есть, но добавляем token_hash/token_enc
    upsertStoredToken.run(legacy, legacyHash, enc, updatedAt || Math.floor(Date.now() / 1000))
    return { token: legacy, tokenHash: legacyHash, updatedAt }
  } catch {
    // если нет секрета — хотя бы возвращаем legacy токен в рантайм, но фронтенду не будем его показывать
    return { token: legacy, tokenHash: legacyHash, updatedAt }
  }
}

function getTokenFromBodyOrStored(payload) {
  const raw = payload && Object.prototype.hasOwnProperty.call(payload, 'token') ? payload.token : null
  const provided = raw == null ? '' : String(raw || '').trim()
  if (provided) return { token: provided, tokenHash: hashToken(provided) }
  const stored = loadStoredTokenPlain()
  if (!stored.token) return { token: '', tokenHash: stored.tokenHash || null }
  return { token: stored.token, tokenHash: stored.tokenHash || hashToken(stored.token) }
}

function getTokenFromQueryOrStored(query) {
  const provided = query && query.token != null ? String(query.token || '').trim() : ''
  if (provided) return { token: provided, tokenHash: hashToken(provided) }
  const stored = loadStoredTokenPlain()
  if (!stored.token) return { token: '', tokenHash: stored.tokenHash || null }
  return { token: stored.token, tokenHash: stored.tokenHash || hashToken(stored.token) }
}

const getSettings = db.prepare(`
  SELECT settings, updated_at FROM product_settings
  WHERE token_hash = ? AND product_key = ?
`)
const getAllSettings = db.prepare(`
  SELECT product_key, settings FROM product_settings WHERE token_hash = ?
`)
const upsertSettings = db.prepare(`
  INSERT INTO product_settings (token_hash, product_key, settings, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT (token_hash, product_key) DO UPDATE SET
    settings = excluded.settings,
    updated_at = excluded.updated_at
`)
const deleteSettings = db.prepare(`
  DELETE FROM product_settings WHERE token_hash = ? AND product_key = ?
`)

const insertBump = db.prepare(`
  INSERT INTO bump_history (token_hash, product_key, product_title, bumped_at, price, item_id)
  VALUES (?, ?, ?, ?, ?, ?)
`)
const getBumpHistory = db.prepare(`
  SELECT product_key, product_title, bumped_at, price, item_id FROM bump_history
  WHERE token_hash = ? ORDER BY bumped_at DESC LIMIT 500
`)

const insertSale = db.prepare(`
  INSERT OR REPLACE INTO sales_history
    (token_hash, product_key, product_title, sold_at, price, status, deal_id, item_id, buyer_name, is_refund)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
const getSalesHistory = db.prepare(`
  SELECT product_key, product_title, sold_at, price, status, is_refund, buyer_name
  FROM sales_history
  WHERE token_hash = ?
  ORDER BY sold_at DESC
  LIMIT 500
`)
const getSalesHistoryAll = db.prepare(`
  SELECT product_key, product_title, sold_at, price, status, is_refund, buyer_name
  FROM sales_history
  WHERE token_hash = ?
  ORDER BY sold_at DESC
`)
const deleteSalesHistoryByToken = db.prepare(`
  DELETE FROM sales_history WHERE token_hash = ?
`)

const insertListingFee = db.prepare(`
  INSERT INTO listing_fees (token_hash, product_key, fee, relisted_at)
  VALUES (?, ?, ?, ?)
`)
const getListingFees = db.prepare(`
  SELECT product_key, fee, relisted_at FROM listing_fees
  WHERE token_hash = ? ORDER BY relisted_at DESC
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS hidden_chats (
    token_hash TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    hidden_at INTEGER NOT NULL,
    PRIMARY KEY (token_hash, chat_id)
  )
`)

const upsertHiddenChat = db.prepare(`
  INSERT INTO hidden_chats (token_hash, chat_id, hidden_at)
  VALUES (?, ?, ?)
  ON CONFLICT(token_hash, chat_id) DO UPDATE SET
    hidden_at = excluded.hidden_at
`)
const deleteHiddenChat = db.prepare(`
  DELETE FROM hidden_chats WHERE token_hash = ? AND chat_id = ?
`)
const getHiddenChats = db.prepare(`
  SELECT chat_id FROM hidden_chats WHERE token_hash = ?
`)

const getStoredToken = db.prepare(`
  SELECT token, token_hash, token_enc, updated_at FROM tokens WHERE id = 1
`)
const upsertStoredToken = db.prepare(`
  INSERT INTO tokens (id, token, token_hash, token_enc, updated_at)
  VALUES (1, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    token = excluded.token,
    token_hash = excluded.token_hash,
    token_enc = excluded.token_enc,
    updated_at = excluded.updated_at
`)
const deleteStoredToken = db.prepare(`
  DELETE FROM tokens WHERE id = 1
`)

const getSalesYears = db.prepare(`
  SELECT DISTINCT CAST(strftime('%Y', sold_at, 'unixepoch') AS INTEGER) AS year
  FROM sales_history
  WHERE token_hash = ? AND sold_at > 0
  ORDER BY year DESC
`)
const getSalesMonthsForYear = db.prepare(`
  SELECT DISTINCT CAST(strftime('%m', sold_at, 'unixepoch') AS INTEGER) AS month
  FROM sales_history
  WHERE token_hash = ? AND sold_at > 0 AND strftime('%Y', sold_at, 'unixepoch') = ?
  ORDER BY month ASC
`)

const CATEGORY_SETTINGS_PREFIX = '__category__::'
const GROUP_SETTINGS_PREFIX = '__group__::'

function getCategorySettingsKey(category) {
  const name = String(category || '').trim()
  return `${CATEGORY_SETTINGS_PREFIX}${name}`
}

function getGroupSettingsKey(label) {
  const name = String(label || '').trim()
  return name ? `${GROUP_SETTINGS_PREFIX}${name}` : ''
}

// Миграция product_settings: нормализуем ключи (игра::название), старые кривые записи удаляем.
try {
  const all = db
    .prepare('SELECT token_hash, product_key, settings, updated_at, rowid FROM product_settings')
    .all()
  const seen = new Set()
  for (const row of all) {
    const key = String(row.product_key || '')
    // Не трогаем служебные ключи категорий и групп
    if (key.startsWith(CATEGORY_SETTINGS_PREFIX) || key.startsWith(GROUP_SETTINGS_PREFIX)) {
      continue
    }
    const normalized = normalizeProductKey(key)
    if (!normalized || normalized === key) {
      continue
    }
    const sig = `${row.token_hash}::${normalized}`
    if (!seen.has(sig)) {
      // Переносим настройки под нормализованный ключ
      upsertSettings.run(row.token_hash, normalized, row.settings, row.updated_at)
      seen.add(sig)
    }
    // Удаляем старую "кривую" запись
    deleteSettings.run(row.token_hash, key)
  }
} catch (_) {
  // миграция не критична для работы — ошибки игнорируем
}

function sendJson(res, statusCode, data) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(data))
}

const PAGE_SIZE = 24
const ITEMS_PERSISTED_HASH =
  '63eefcfd813442882ad846360d925279bc376e8bc85a577ebefbee0f9c78b557'

const VIEWER_QUERY =
  'query viewer { viewer { ...Viewer __typename } } fragment Viewer on User { id username email role __typename }'

const AUTOBUMP_PRIORITY_STATUS_ID = '1f00f21b-7768-62a0-296f-75a31ee8ce72'
const ITEM_PRIORITY_STATUSES_PERSISTED_HASH =
  'b922220c6f979537e1b99de6af8f5c13727daeff66727f679f07f986ce1c025a'
const DEALS_PERSISTED_HASH =
  'c3b623b5fe0758cf91b2335ebf36ff65f8650a6672a792a3ca7a36d270d396fb'
const USER_CHATS_PERSISTED_HASH =
  '999f86b7c94a4cb525ed5549d8f24d0d24036214f02a213e8fd7cefc742bbd58'
const ITEM_PERSISTED_HASH =
  '37d2d9f947e950c09322e2f5e3056451ee5f12dc38565eb811423e915c094c22'
const DEAL_PERSISTED_HASH =
  '5652037a966d8da6d41180b0be8226051fe0ed1357d460c6ae348c3138a0fba3'
const CHAT_PERSISTED_HASH =
  '38efcc58bdc432cc05bc743345e9ef9653a3ca1c0f45db822f4166d0f0cc17c4'

const AUTOLIST_LAST_CHAT_FRESH_SEC = 600
const AUTOLIST_MAX_CHATS_TO_SCAN = 10
const AUTOLIST_PROCESSED_TTL_SEC = 60 * 60
const AUTOLIST_SEEN_CHAT_TTL_SEC = 24 * 60 * 60
const AUTOLIST_ITEM_STATE_TTL_SEC = 24 * 60 * 60
// Даже если новых чатов нет, периодически сканируем последние завершённые товары.
// Иначе "ожидает автовыставления" может висеть бесконечно. Интервал — 2 минуты.
const AUTOLIST_COMPLETED_SCAN_INTERVAL_SEC = 120

function autolistGetProcessedMap(tokenHash) {
  global.__autolistProcessedByTokenHash = global.__autolistProcessedByTokenHash || {}
  const key = String(tokenHash)
  const map = global.__autolistProcessedByTokenHash[key]
  if (map && typeof map === 'object') return map
  global.__autolistProcessedByTokenHash[key] = {}
  return global.__autolistProcessedByTokenHash[key]
}

function autolistPruneProcessedMap(tokenHash, nowTs) {
  const map = autolistGetProcessedMap(tokenHash)
  for (const [k, ts] of Object.entries(map)) {
    if (!ts || (nowTs - Number(ts)) > AUTOLIST_PROCESSED_TTL_SEC) delete map[k]
  }
}

function autolistWasProcessed(tokenHash, eventKey) {
  if (!eventKey) return false
  const map = autolistGetProcessedMap(tokenHash)
  return map[eventKey] != null
}

function autolistMarkProcessed(tokenHash, eventKey, nowTs) {
  if (!eventKey) return
  const map = autolistGetProcessedMap(tokenHash)
  map[eventKey] = nowTs
}

function autolistGetSeenChatsMap(tokenHash) {
  global.__autolistSeenChatsByTokenHash = global.__autolistSeenChatsByTokenHash || {}
  const key = String(tokenHash)
  const map = global.__autolistSeenChatsByTokenHash[key]
  if (map && typeof map === 'object') return map
  global.__autolistSeenChatsByTokenHash[key] = {}
  return global.__autolistSeenChatsByTokenHash[key]
}

function autolistPruneSeenChatsMap(tokenHash, nowTs) {
  const map = autolistGetSeenChatsMap(tokenHash)
  for (const [chatId, ts] of Object.entries(map)) {
    if (!ts || (nowTs - Number(ts)) > AUTOLIST_SEEN_CHAT_TTL_SEC) delete map[chatId]
  }
}

function autolistWasChatSeen(tokenHash, chatId) {
  if (!chatId) return false
  const map = autolistGetSeenChatsMap(tokenHash)
  return map[String(chatId)] != null
}

function autolistMarkChatSeen(tokenHash, chatId, nowTs) {
  if (!chatId) return
  const map = autolistGetSeenChatsMap(tokenHash)
  map[String(chatId)] = nowTs
}

function autolistGetItemStateMap(tokenHash) {
  global.__autolistItemStateByTokenHash = global.__autolistItemStateByTokenHash || {}
  const key = String(tokenHash)
  const map = global.__autolistItemStateByTokenHash[key]
  if (map && typeof map === 'object') return map
  global.__autolistItemStateByTokenHash[key] = {}
  return global.__autolistItemStateByTokenHash[key]
}

function autolistPruneItemStateMap(tokenHash, nowTs) {
  const map = autolistGetItemStateMap(tokenHash)
  for (const [itemId, st] of Object.entries(map)) {
    const ts = st && typeof st === 'object' ? Number(st.updatedAt || 0) : 0
    if (!ts || (nowTs - ts) > AUTOLIST_ITEM_STATE_TTL_SEC) delete map[itemId]
  }
}

function autolistSetItemState(tokenHash, itemId, state) {
  if (!itemId) return
  const map = autolistGetItemStateMap(tokenHash)
  map[String(itemId)] = state
}

function autolistGetItemState(tokenHash, itemId) {
  if (!itemId) return null
  const map = autolistGetItemStateMap(tokenHash)
  return map[String(itemId)] || null
}

function autolistGetCompletedScanMap(tokenHash) {
  global.__autolistCompletedScanByTokenHash = global.__autolistCompletedScanByTokenHash || {}
  const key = String(tokenHash)
  const map = global.__autolistCompletedScanByTokenHash[key]
  if (map && typeof map === 'object') return map
  global.__autolistCompletedScanByTokenHash[key] = { lastScanTs: 0 }
  return global.__autolistCompletedScanByTokenHash[key]
}

function autolistGetLastChatMeta(tokenHash) {
  global.__autolistLastChatByTokenHash = global.__autolistLastChatByTokenHash || {}
  const key = String(tokenHash)
  const meta = global.__autolistLastChatByTokenHash[key]
  if (meta && typeof meta === 'object') return meta
  global.__autolistLastChatByTokenHash[key] = { lastChatId: null, lastPaidTs: 0 }
  return global.__autolistLastChatByTokenHash[key]
}

function parseIntSafe(v, fallback = null) {
  if (v == null || v === '') return fallback
  const n = parseInt(String(v), 10)
  return Number.isFinite(n) ? n : fallback
}

function clampInt(n, min, max) {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

function normalizeKeyPart(v) {
  return String(v == null ? '' : v)
    .trim()
    .replace(/\s+/g, ' ')
}

function normalizeProductKey(productKey) {
  const raw = String(productKey == null ? '' : productKey)
  const sepIndex = raw.indexOf('::')
  if (sepIndex === -1) return normalizeKeyPart(raw)
  const game = raw.slice(0, sepIndex)
  const title = raw.slice(sepIndex + 2)
  return `${normalizeKeyPart(game)}::${normalizeKeyPart(title)}`
}

function buildProductKey(game, title) {
  const g = normalizeKeyPart(game)
  const t = normalizeKeyPart(title)
  return g ? `${g}::${t}` : t
}

function productTitleKeyFromProductKey(productKey) {
  const raw = String(productKey == null ? '' : productKey)
  const sepIndex = raw.indexOf('::')
  const title = sepIndex === -1 ? raw : raw.slice(sepIndex + 2)
  return normalizeKeyPart(title)
}

function computeProfitAnalyticsList({ salesRows, bumpsRows, settingsRows, listingFeesRows }) {
  const settingsByKey = {}
  for (const row of settingsRows || []) {
    try {
      const s = row.settings ? JSON.parse(row.settings) : {}
      const rawKey = row.product_key
      if (rawKey != null && rawKey !== '') {
        settingsByKey[String(rawKey)] = s
        const normalized = normalizeProductKey(rawKey)
        if (normalized && !settingsByKey[normalized]) settingsByKey[normalized] = s
      }
    } catch (_) { }
  }

  const listingFeesByProduct = {}
  for (const row of listingFeesRows || []) {
    const k = productTitleKeyFromProductKey(row.product_key)
    if (!k) continue
    if (!listingFeesByProduct[k]) listingFeesByProduct[k] = []
    listingFeesByProduct[k].push({ relistedAt: row.relisted_at, fee: Number(row.fee) || 0 })
  }
  for (const k of Object.keys(listingFeesByProduct)) {
    // Для корректного расчёта суммарной стоимости выставлений между продажами
    // сортируем по возрастанию времени перевыставления.
    listingFeesByProduct[k].sort((a, b) => a.relistedAt - b.relistedAt)
  }

  const bumpsByProduct = {}
  for (const b of bumpsRows || []) {
    const k = productTitleKeyFromProductKey(b.product_key)
    if (!k) continue
    if (!bumpsByProduct[k]) bumpsByProduct[k] = []
    bumpsByProduct[k].push({ bumpedAt: b.bumped_at, price: Number(b.price) || 0 })
  }
  for (const k of Object.keys(bumpsByProduct)) {
    bumpsByProduct[k].sort((a, b) => a.bumpedAt - b.bumpedAt)
  }

  // Для корректного расчёта "поднятия между продажами" нужно идти по продажам по возрастанию времени.
  const salesAsc = [...(salesRows || [])].sort((a, b) => a.sold_at - b.sold_at)
  const prevSoldByKey = {}
  const computed = []

  for (const row of salesAsc) {
    const productKey = row.product_key
    const lookupKey = productTitleKeyFromProductKey(productKey)
    const soldAt = row.sold_at
    const salePrice = Number(row.price) || 0
    const isRefund = (row.is_refund || 0) === 1

    const s =
      settingsByKey[productKey] ||
      settingsByKey[lookupKey] ||
      {}
    const cost = typeof s.cost === 'number' ? s.cost : (parseFloat(s.cost) || 0)

    const productListingFees = listingFeesByProduct[lookupKey] || []
    let listingCost = 0
    for (const lf of productListingFees) {
      // Считаем все платные перевыставления между предыдущей продажей и этой продажей (включительно).
      if (lf.relistedAt > (prevSoldByKey[lookupKey] || 0) && lf.relistedAt <= soldAt) {
        listingCost += lf.fee
      }
    }

    const prevSold = prevSoldByKey[lookupKey] || 0
    const productBumps = bumpsByProduct[lookupKey] || []
    let bumpCost = 0
    for (const b of productBumps) {
      if (b.bumpedAt > prevSold && b.bumpedAt <= soldAt) {
        bumpCost += b.price
      }
    }
    prevSoldByKey[lookupKey] = soldAt

    const expenses = cost + listingCost + bumpCost
    const profit = isRefund ? -(listingCost + bumpCost) : salePrice - expenses

    computed.push({
      productTitle: row.product_title,
      productKey,
      soldAt,
      salePrice,
      isRefund,
      cost,
      listingCost,
      bumpCost,
      profit,
    })
  }

  return computed.sort((a, b) => (b.soldAt || 0) - (a.soldAt || 0))
}

/**
 * Дополнительные строки для вкладки «Прибыль» по активным товарам:
 * показываем текущие расходы на выставление и поднятия до первой продажи.
 */
function computeActiveProfitItems({ activeItems, salesRows, bumpsRows, settingsRows, listingFeesRows }) {
  const settingsByKey = {}
  for (const row of settingsRows || []) {
    try {
      const s = row.settings ? JSON.parse(row.settings) : {}
      const rawKey = row.product_key
      if (rawKey != null && rawKey !== '') {
        settingsByKey[String(rawKey)] = s
        const normalized = normalizeProductKey(rawKey)
        if (normalized && !settingsByKey[normalized]) settingsByKey[normalized] = s
      }
    } catch (_) {}
  }

  const listingFeesByProduct = {}
  for (const row of listingFeesRows || []) {
    const raw = row.product_key
    const k = (raw && normalizeProductKey(raw)) || raw
    if (!k) continue
    if (!listingFeesByProduct[k]) listingFeesByProduct[k] = []
    listingFeesByProduct[k].push({ relistedAt: row.relisted_at, fee: Number(row.fee) || 0 })
  }

  const bumpsByProduct = {}
  for (const b of bumpsRows || []) {
    const raw = b.product_key
    const k = (raw && normalizeProductKey(raw)) || raw
    if (!k) continue
    if (!bumpsByProduct[k]) bumpsByProduct[k] = []
    bumpsByProduct[k].push({ bumpedAt: b.bumped_at, price: Number(b.price) || 0 })
  }

  // Последняя продажа по товару (без возвратов): расходы считаем только после неё.
  const lastSaleByKey = {}
  for (const row of salesRows || []) {
    if (row.is_refund) continue
    const raw = row.product_key
    const k = (raw && normalizeProductKey(raw)) || raw
    if (!k) continue
    const t = row.sold_at || 0
    if (!lastSaleByKey[k] || t > lastSaleByKey[k]) lastSaleByKey[k] = t
  }

  const computed = []

  for (const lot of activeItems || []) {
    const rawTitle = lot.title || lot.name || ''
    const rawGame = lot.game || (lot.game && lot.game.name) || lot.game_name || ''
    const title = normalizeKeyPart(rawTitle) || 'Товар'
    const game = normalizeKeyPart(rawGame)
    const productKey = buildProductKey(game, title)
    const lookupKey = (productKey && normalizeProductKey(productKey)) || productKey

    const s =
      settingsByKey[productKey] ||
      settingsByKey[lookupKey] ||
      {}
    const cost = typeof s.cost === 'number' ? s.cost : (parseFloat(s.cost) || 0)

    const lastSold = lastSaleByKey[lookupKey] || 0

    let listingCost = 0
    const productListingFees = listingFeesByProduct[lookupKey] || []
    for (const lf of productListingFees) {
      if (lf.relistedAt > lastSold) {
        listingCost += lf.fee
      }
    }

    let bumpCost = 0
    const productBumps = bumpsByProduct[lookupKey] || []
    for (const b of productBumps) {
      if (b.bumpedAt > lastSold) {
        bumpCost += b.price
      }
    }

    const salePrice = Number(lot.price) || 0
    const profit = -(listingCost + bumpCost)

    computed.push({
      productTitle: title,
      productKey,
      soldAt: null,
      salePrice,
      isRefund: false,
      cost,
      listingCost,
      bumpCost,
      profit,
    })
  }

  return computed
}

function getViewer(token, userAgent) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      operationName: 'viewer',
      query: VIEWER_QUERY,
      variables: {},
    })
    const options = {
      hostname: 'playerok.com',
      path: '/graphql',
      method: 'POST',
      headers: {
        accept: '*/*',
        'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        'content-type': 'application/json',
        cookie: `token=${token}`,
        origin: 'https://playerok.com',
        referer: 'https://playerok.com/',
        'apollographql-client-name': 'web',
        'apollo-require-preflight': 'true',
        'user-agent':
          userAgent ||
          PLAYEROK_USER_AGENT ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        'Content-Length': Buffer.byteLength(body, 'utf8'),
      },
    }
    const req = https.request(options, (resp) => {
      let data = ''
      resp.on('data', (chunk) => { data += chunk })
      resp.on('end', () => {
        if (resp.statusCode !== 200) {
          return reject(new Error(`Playerok viewer: status ${resp.statusCode}`))
        }
        let json
        try {
          json = JSON.parse(data)
        } catch (err) {
          return reject(new Error(`Invalid JSON: ${err.message}`))
        }
        if (json.errors && json.errors.length) {
          return reject(
            new Error(json.errors.map((e) => e.message || 'GraphQL error').join('; '))
          )
        }
        const viewer = json?.data?.viewer
        if (!viewer || !viewer.id) {
          return reject(new Error('Не удалось получить данные аккаунта (токен неверный или истёк)'))
        }
        resolve({ id: viewer.id, username: viewer.username || 'me' })
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function increaseItemPriorityStatus(token, userAgent, itemId, opts = {}) {
  return new Promise((resolve, reject) => {
    const priorityStatusId = opts.priorityStatusId || AUTOBUMP_PRIORITY_STATUS_ID
    const transactionProviderId = opts.transactionProviderId || 'LOCAL'
    const paymentMethodId =
      Object.prototype.hasOwnProperty.call(opts, 'paymentMethodId') ? opts.paymentMethodId : null
    const bodyJson = {
      operationName: 'increaseItemPriorityStatus',
      variables: {
        input: {
          priorityStatuses: [String(priorityStatusId)],
          transactionProviderId: String(transactionProviderId),
          transactionProviderData: { paymentMethodId: paymentMethodId ?? null },
          itemId: String(itemId),
        },
      },
      // Важно: используем реальные переводы строк, а не литералы "\\n",
      // иначе Playerok GraphQL парсер падает с GRAPHQL_PARSE_FAILED.
      query: `mutation increaseItemPriorityStatus($input: PublishItemInput!) {
  increaseItemPriorityStatus(input: $input) {
    id
    __typename
    ... on MyItem {
      priorityPrice
      statusPayment {
        id
        status
        statusDescription
        value
        props {
          paymentURL
          __typename
        }
        __typename
      }
    }
  }
}
`,
    }

    const body = JSON.stringify(bodyJson)
    const options = {
      hostname: 'playerok.com',
      path: '/graphql',
      method: 'POST',
      headers: {
        accept: '*/*',
        'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        'access-control-allow-headers': 'sentry-trace, baggage',
        'content-type': 'application/json',
        cookie: `token=${token}`,
        origin: 'https://playerok.com',
        priority: 'u=1, i',
        referer: 'https://playerok.com/',
        'apollographql-client-name': 'web',
        'apollo-require-preflight': 'true',
        'x-timezone-offset': String(new Date().getTimezoneOffset()),
        'x-gql-op': 'increaseItemPriorityStatus',
        'x-gql-path': '/',
        'user-agent':
          userAgent ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        'Content-Length': Buffer.byteLength(body, 'utf8'),
      },
    }

    const req = https.request(options, (resp) => {
      let data = ''
      resp.on('data', (chunk) => {
        data += chunk
      })
      resp.on('end', () => {
        if (resp.statusCode !== 200) {
          const bodyPreview = String(data || '').slice(0, 800)
          return reject(
            new Error(
              `Playerok bump: status ${resp.statusCode}` +
              (bodyPreview ? `; body: ${bodyPreview}` : '')
            )
          )
        }
        let json
        try {
          json = JSON.parse(data)
        } catch (err) {
          return reject(new Error(`Invalid JSON from Playerok bump: ${err.message}`))
        }
        if (json.errors && json.errors.length) {
          return reject(new Error(json.errors.map((e) => e.message || 'GraphQL error').join('; ')))
        }
        const item = json?.data?.increaseItemPriorityStatus
        if (!item || !item.id) {
          return reject(new Error('Playerok bump: empty response'))
        }
        resolve(item)
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

/** Выставить завершённый товар снова (relist) — тот же itemId, Playerok может вернуть новый id после публикации */
function publishItem(token, userAgent, itemId, opts = {}) {
  return new Promise((resolve, reject) => {
    const priorityStatusId = opts.priorityStatusId || AUTOBUMP_PRIORITY_STATUS_ID
    const bodyJson = {
      operationName: 'publishItem',
      variables: {
        input: {
          itemId: String(itemId),
          priorityStatuses: [String(priorityStatusId)],
          // В соответствии с неофициальным PlayerokAPI: только provider и статус приоритета
          transactionProviderId: 'LOCAL',
        },
      },
      query: `mutation publishItem($input: PublishItemInput!) {
  publishItem(input: $input) {
    id
    __typename
    ... on MyItem {
      id
      name
      price
      status
      statusPayment {
        value
        fee
        __typename
      }
      __typename
    }
  }
}
`,
    }
    const body = JSON.stringify(bodyJson)
    const options = {
      hostname: 'playerok.com',
      path: '/graphql',
      method: 'POST',
      headers: {
        accept: '*/*',
        'content-type': 'application/json',
        cookie: `token=${token}`,
        origin: 'https://playerok.com',
        referer: 'https://playerok.com/',
        'apollographql-client-name': 'web',
        'apollo-require-preflight': 'true',
        'user-agent':
          userAgent ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        'Content-Length': Buffer.byteLength(body, 'utf8'),
      },
    }
    const req = https.request(options, (resp) => {
      let data = ''
      resp.on('data', (chunk) => { data += chunk })
      resp.on('end', () => {
        if (resp.statusCode !== 200) {
          const preview = String(data || '').slice(0, 600)
          return reject(new Error(`Playerok publishItem: status ${resp.statusCode}` + (preview ? `; ${preview}` : '')))
        }
        let json
        try {
          json = JSON.parse(data)
        } catch (err) {
          return reject(new Error(`Invalid JSON: ${err.message}`))
        }
        if (json.errors && json.errors.length) {
          return reject(new Error(json.errors.map((e) => e.message || 'GraphQL error').join('; ')))
        }
        const item = json?.data?.publishItem
        if (!item || !item.id) {
          return reject(new Error('Playerok publishItem: empty response'))
        }
        const sp = item.statusPayment || {}
        const listingFee = Number(sp.value) || Number(sp.fee) || 0
        resolve({ ...item, listingFee })
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

/** Отправить сообщение в чат */
function createChatMessage(token, userAgent, chatId, text) {
  return new Promise((resolve, reject) => {
    const bodyJson = {
      operationName: 'createChatMessage',
      variables: {
        input: {
          chatId: String(chatId),
          text: String(text || ''),
        },
      },
      query: `mutation createChatMessage($input: CreateChatMessageInput!) {
  createChatMessage(input: $input) {
    id
    text
    __typename
  }
}
`,
    }
    const body = JSON.stringify(bodyJson)
    const options = {
      hostname: 'playerok.com',
      path: '/graphql',
      method: 'POST',
      headers: {
        accept: '*/*',
        'content-type': 'application/json',
        cookie: `token=${token}`,
        origin: 'https://playerok.com',
        referer: 'https://playerok.com/chats',
        'apollographql-client-name': 'web',
        'apollo-require-preflight': 'true',
        'user-agent':
          userAgent ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        'Content-Length': Buffer.byteLength(body, 'utf8'),
      },
    }
    const req = https.request(options, (resp) => {
      let data = ''
      resp.on('data', (chunk) => { data += chunk })
      resp.on('end', () => {
        if (resp.statusCode !== 200) {
          const preview = String(data || '').slice(0, 600)
          return reject(new Error(`Playerok createChatMessage: status ${resp.statusCode}` + (preview ? `; ${preview}` : '')))
        }
        let json
        try {
          json = JSON.parse(data)
        } catch (err) {
          return reject(new Error(`Invalid JSON: ${err.message}`))
        }
        if (json.errors && json.errors.length) {
          return reject(new Error(json.errors.map((e) => e.message || 'GraphQL error').join('; ')))
        }
        resolve(json?.data?.createChatMessage || {})
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

/** Обновить статус сделки (например, SENT / ROLLED_BACK) */
function updateDealStatus(token, userAgent, dealId, newStatus) {
  return new Promise((resolve, reject) => {
    const bodyJson = {
      operationName: 'updateDeal',
      variables: {
        input: {
          id: String(dealId),
          status: String(newStatus),
        },
      },
      query: `mutation updateDeal($input: UpdateItemDealInput!) {
  updateDeal(input: $input) {
    id
    status
    statusDescription
    __typename
  }
}
`,
    }
    const body = JSON.stringify(bodyJson)
    const options = {
      hostname: 'playerok.com',
      path: '/graphql',
      method: 'POST',
      headers: {
        accept: '*/*',
        'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        'content-type': 'application/json',
        cookie: `token=${token}`,
        origin: 'https://playerok.com',
        referer: `https://playerok.com/deal/${String(dealId)}`,
        'apollographql-client-name': 'web',
        'apollo-require-preflight': 'true',
        'x-timezone-offset': String(new Date().getTimezoneOffset()),
        'x-gql-op': 'updateDeal',
        'x-gql-path': '/',
        'user-agent':
          userAgent ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        'Content-Length': Buffer.byteLength(body, 'utf8'),
      },
    }
    const req = https.request(options, (resp) => {
      let data = ''
      resp.on('data', (chunk) => { data += chunk })
      resp.on('end', () => {
        if (resp.statusCode !== 200) {
          const preview = String(data || '').slice(0, 800)
          return reject(new Error(`Playerok updateDeal: status ${resp.statusCode}` + (preview ? `; ${preview}` : '')))
        }
        let json
        try {
          json = JSON.parse(data)
        } catch (err) {
          return reject(new Error(`Invalid JSON from updateDeal: ${err.message}`))
        }
        if (json.errors && json.errors.length) {
          return reject(new Error(json.errors.map((e) => e.message || 'GraphQL error').join('; ')))
        }
        const deal = json?.data?.updateDeal || null
        if (!deal || !deal.id) {
          return reject(new Error('Playerok updateDeal: empty response'))
        }
        resolve(deal)
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function fetchItemPriorityStatuses(token, userAgent, itemId, price) {
  return new Promise((resolve, reject) => {
    const variables = {
      itemId: String(itemId),
      price: Number(price) || 0,
    }
    const params = new URLSearchParams({
      operationName: 'itemPriorityStatuses',
      variables: JSON.stringify(variables),
      extensions: JSON.stringify({
        persistedQuery: { version: 1, sha256Hash: ITEM_PRIORITY_STATUSES_PERSISTED_HASH },
      }),
    })
    const options = {
      hostname: 'playerok.com',
      path: `/graphql?${params.toString()}`,
      method: 'GET',
      headers: {
        accept: '*/*',
        'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        'access-control-allow-headers': 'sentry-trace, baggage',
        'content-type': 'application/json',
        cookie: `token=${token}`,
        origin: 'https://playerok.com',
        priority: 'u=1, i',
        referer: `https://playerok.com/products/${String(itemId)}`,
        'apollographql-client-name': 'web',
        'apollo-require-preflight': 'true',
        'x-timezone-offset': String(new Date().getTimezoneOffset()),
        'x-gql-op': 'itemPriorityStatuses',
        'x-gql-path': '/',
        'user-agent':
          userAgent ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      },
    }
    const req = https.request(options, (resp) => {
      let data = ''
      resp.on('data', (chunk) => { data += chunk })
      resp.on('end', () => {
        if (resp.statusCode !== 200) {
          const bodyPreview = String(data || '').slice(0, 800)
          return reject(
            new Error(
              `Playerok itemPriorityStatuses: status ${resp.statusCode}` +
              (bodyPreview ? `; body: ${bodyPreview}` : '')
            )
          )
        }
        let json
        try {
          json = JSON.parse(data)
        } catch (err) {
          return reject(new Error(`Invalid JSON from Playerok itemPriorityStatuses: ${err.message}`))
        }
        if (json.errors && json.errors.length) {
          return reject(
            new Error(json.errors.map((e) => e.message || 'GraphQL error').join('; '))
          )
        }
        resolve(json?.data?.itemPriorityStatuses || [])
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function requestItemsPage(token, userAgent, userId, afterCursor, statusList = ['APPROVED']) {
  return new Promise((resolve, reject) => {
    const variables = {
      pagination: {
        first: PAGE_SIZE,
        after: afterCursor,
      },
      filter: {
        userId,
        status: statusList,
      },
      showForbiddenImage: false,
    }

    const params = new URLSearchParams({
      operationName: 'items',
      variables: JSON.stringify(variables),
      extensions: JSON.stringify({
        persistedQuery: { version: 1, sha256Hash: ITEMS_PERSISTED_HASH },
      }),
    })

    const options = {
      hostname: 'playerok.com',
      path: `/graphql?${params.toString()}`,
      method: 'GET',
      headers: {
        accept: '*/*',
        'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        'content-type': 'application/json',
        cookie: `token=${token}`,
        origin: 'https://playerok.com',
        referer: 'https://playerok.com/',
        'apollographql-client-name': 'web',
        'apollo-require-preflight': 'true',
        'x-gql-op': 'items',
        'x-gql-path': '/',
        'user-agent':
          userAgent ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      },
    }

    const req = https.request(options, (resp) => {
      let data = ''
      resp.on('data', (chunk) => { data += chunk })
      resp.on('end', () => {
        if (resp.statusCode !== 200) {
          let errMsg = `Playerok responded with status ${resp.statusCode}`
          try {
            const errJson = JSON.parse(data)
            if (errJson?.errors?.[0]?.message) errMsg = errJson.errors[0].message
            else if (errJson?.message) errMsg = errJson.message
          } catch (_) {
            if (data && data.length < 500) errMsg += `: ${data}`
          }
          return reject(new Error(errMsg))
        }
        let json
        try {
          json = JSON.parse(data)
        } catch (err) {
          return reject(new Error(`Invalid JSON from Playerok: ${err.message}`))
        }
        if (json.errors && json.errors.length) {
          return reject(
            new Error(json.errors.map((e) => e.message || 'GraphQL error').join('; '))
          )
        }
        const itemsData = json?.data?.items
        const edges = itemsData?.edges || []
        const pageInfo = itemsData?.pageInfo || {}
        const items = edges
          .map((edge) => edge && edge.node)
          .filter(Boolean)
          .map((node) => {
            const attachment = node.attachment || (node.attachments && node.attachments[0])
            const imageUrl = attachment?.url || null
            const price = node.price ?? node.rawPrice ?? 0
            const rawPrice = node.rawPrice != null ? Number(node.rawPrice) : null
            const discount =
              rawPrice != null && rawPrice > 0 && price < rawPrice
                ? Math.round(((rawPrice - price) / rawPrice) * 100)
                : null
            return {
              id: node.id,
              title: node.name,
              game: node.game?.name || '',
              price,
              currency: '₽',
              status: node.status,
              imageUrl,
              url: `https://playerok.com/profile/${node.user?.username || 'me'}/products`,
              updatedAt: node.updatedAt != null ? node.updatedAt : null,
              createdAt: node.createdAt != null ? node.createdAt : null,
              ...(rawPrice != null && rawPrice > 0 && { oldPrice: rawPrice }),
              ...(discount != null && discount > 0 && { discount }),
            }
          })
        resolve({
          items,
          totalCount: itemsData?.totalCount,
          hasNextPage: pageInfo.hasNextPage === true,
          endCursor: pageInfo.endCursor || null,
        })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

/** Сделки (продажи) со страницы /profile/.../sales — все статусы: выполнение, подтверждение, завершено, возврат */
function requestDealsPage(token, userAgent, userId, afterCursor, statusList, direction = 'OUT') {
  return new Promise((resolve, reject) => {
    const variables = {
      pagination: { first: PAGE_SIZE, after: afterCursor },
      filter: {
        userId,
        direction,
        status: statusList,
      },
      showForbiddenImage: false,
    }
    const params = new URLSearchParams({
      operationName: 'deals',
      variables: JSON.stringify(variables),
      extensions: JSON.stringify({
        persistedQuery: { version: 1, sha256Hash: DEALS_PERSISTED_HASH },
      }),
    })
    const options = {
      hostname: 'playerok.com',
      path: `/graphql?${params.toString()}`,
      method: 'GET',
      headers: {
        accept: '*/*',
        'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        'content-type': 'application/json',
        cookie: `token=${token}`,
        origin: 'https://playerok.com',
        referer: 'https://playerok.com/profile/Levkaster/sales',
        'apollographql-client-name': 'web',
        'apollo-require-preflight': 'true',
        'x-gql-op': 'deals',
        'x-gql-path': '/',
        'user-agent':
          userAgent ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      },
    }
    const req = https.request(options, (resp) => {
      let data = ''
      resp.on('data', (chunk) => { data += chunk })
      resp.on('end', () => {
        if (resp.statusCode !== 200) {
          let errMsg = `Playerok deals: status ${resp.statusCode}`
          try {
            const errJson = JSON.parse(data)
            if (errJson?.errors?.[0]?.message) errMsg = errJson.errors[0].message
          } catch (_) {
            if (data && data.length < 500) errMsg += `: ${data}`
          }
          return reject(new Error(errMsg))
        }
        let json
        try {
          json = JSON.parse(data)
        } catch (err) {
          return reject(new Error(`Invalid JSON from Playerok deals: ${err.message}`))
        }
        if (json.errors && json.errors.length) {
          return reject(
            new Error(json.errors.map((e) => e.message || 'GraphQL error').join('; '))
          )
        }
        const dealsData = json?.data?.deals
        const edges = dealsData?.edges || []
        const pageInfo = dealsData?.pageInfo || {}
        const toTs = (v) => {
          if (v == null) return 0
          if (typeof v === 'number') {
            if (v < 1e12) return v
            return Math.floor(v / 1000)
          }
          const d = new Date(v)
          return isNaN(d.getTime()) ? 0 : Math.floor(d.getTime() / 1000)
        }
        const deals = edges
          .map((edge) => edge && edge.node)
          .filter(Boolean)
          .map((node) => {
            const item = node.item || {}
            const buyerName =
              (node.user && node.user.username) ||
              (item.buyer && item.buyer.username) ||
              null
            const game = item.game?.name || ''
            const title = item.name || item.title || 'Товар'
            const price = node.transaction?.value ?? item.price ?? node.price ?? 0
            const tx = node.transaction || {}
            const soldAt =
              toTs(node.completedAt) ||
              toTs(node.createdAt) ||
              toTs(node.updatedAt) ||
              toTs(node.completed_at) ||
              toTs(node.created_at) ||
              toTs(node.updated_at) ||
              toTs(tx.completedAt) ||
              toTs(tx.createdAt) ||
              toTs(tx.created_at) ||
              toTs(item.updatedAt) ||
              toTs(item.createdAt) ||
              toTs(item.soldAt) ||
              toTs(item.updated_at) ||
              toTs(item.created_at) ||
              0
            return {
              id: node.id,
              itemId: item.id || null,
              status: node.status,
              productKey: buildProductKey(game, title),
              productTitle: normalizeKeyPart(title) || 'Товар',
              category: normalizeKeyPart(game),
              soldAt,
              price: Number(price) || 0,
              buyerName,
              chatId: node.chat?.id || node.chatId || null,
            }
          })
        resolve({
          deals,
          totalCount: dealsData?.totalCount,
          hasNextPage: pageInfo.hasNextPage === true,
          endCursor: pageInfo.endCursor || null,
        })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function requestUserChatsPage(token, userAgent, userId, opts) {
  const options = opts && typeof opts === 'object' ? opts : {}
  const firstRaw = options.first
  let first = Number.isFinite(firstRaw) ? Number(firstRaw) : null
  if (!first || first <= 0) first = AUTOLIST_MAX_CHATS_TO_SCAN
  if (first > 50) first = 50
  const after = options.after != null ? String(options.after) : null
  return new Promise((resolve, reject) => {
    const variables = {
      pagination: { first, after },
      filter: { userId, type: null, status: null },
      hasSupportAccess: false,
    }
    const params = new URLSearchParams({
      operationName: 'userChats',
      variables: JSON.stringify(variables),
      extensions: JSON.stringify({
        persistedQuery: { version: 1, sha256Hash: USER_CHATS_PERSISTED_HASH },
      }),
    })
    const options = {
      hostname: 'playerok.com',
      path: `/graphql?${params.toString()}`,
      method: 'GET',
      headers: {
        accept: '*/*',
        'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        'content-type': 'application/json',
        cookie: `token=${token}`,
        origin: 'https://playerok.com',
        referer: 'https://playerok.com/chats',
        'apollographql-client-name': 'web',
        'apollo-require-preflight': 'true',
        'x-gql-op': 'userChats',
        'x-gql-path': '/',
        'user-agent':
          userAgent ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      },
    }
    const req = https.request(options, (resp) => {
      let data = ''
      resp.on('data', (chunk) => { data += chunk })
      resp.on('end', () => {
        if (resp.statusCode !== 200) {
          const preview = String(data || '').slice(0, 500)
          return reject(new Error(`Playerok userChats: status ${resp.statusCode}` + (preview ? `; ${preview}` : '')))
        }
        let json
        try {
          json = JSON.parse(data)
        } catch (err) {
          return reject(new Error(`Invalid JSON from userChats: ${err.message}`))
        }
        if (json.errors && json.errors.length) {
          return reject(new Error(json.errors.map((e) => e.message || 'GraphQL error').join('; ')))
        }
        resolve(json?.data?.chats || null)
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function requestChatById(token, userAgent, chatId) {
  return new Promise((resolve, reject) => {
    const variables = { id: String(chatId) }
    const params = new URLSearchParams({
      operationName: 'chat',
      variables: JSON.stringify(variables),
      extensions: JSON.stringify({
        persistedQuery: { version: 1, sha256Hash: CHAT_PERSISTED_HASH },
      }),
    })
    const options = {
      hostname: 'playerok.com',
      path: `/graphql?${params.toString()}`,
      method: 'GET',
      headers: {
        accept: '*/*',
        'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        'content-type': 'application/json',
        cookie: `token=${token}`,
        origin: 'https://playerok.com',
        referer: 'https://playerok.com/chats',
        'apollographql-client-name': 'web',
        'apollo-require-preflight': 'true',
        'user-agent':
          userAgent ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      },
    }
    const req = https.request(options, (resp) => {
      let data = ''
      resp.on('data', (chunk) => { data += chunk })
      resp.on('end', () => {
        if (resp.statusCode !== 200) {
          const preview = String(data || '').slice(0, 500)
          return reject(new Error(`Playerok chat: status ${resp.statusCode}` + (preview ? `; ${preview}` : '')))
        }
        let json
        try {
          json = JSON.parse(data)
        } catch (err) {
          return reject(new Error(`Invalid JSON from chat: ${err.message}`))
        }
        if (json.errors && json.errors.length) {
          return reject(new Error(json.errors.map((e) => e.message || 'GraphQL error').join('; ')))
        }
        resolve(json?.data?.chat || null)
      })
    })
    req.on('error', reject)
    req.end()
  })
}

/** Страница сообщений чата (аналог get_chat_messages из PlayerokAPI) */
function requestChatMessagesPage(token, userAgent, chatId, afterCursor = null, count = 24, opts = {}) {
  const referer = opts.referer || 'https://playerok.com/chats'
  return new Promise((resolve, reject) => {
    const bodyJson = {
      operationName: 'chatMessages',
      // Используем обычный текстовый запрос вместо persistedQuery,
      // чтобы не зависеть от хеша Playerok.
      query: `query chatMessages {
  chatMessages(
    pagination: { first: ${Number(count) || 24}, after: ${afterCursor ? `"${String(afterCursor)}"` : 'null'} },
    filter: { chatId: "${String(chatId)}" }
  ) {
    edges {
      node {
        __typename
        id
        text
        createdAt
        user {
          id
          username
        }
        file {
          id
          url
        }
        deal {
          id
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`,
      variables: {},
    }

    const body = JSON.stringify(bodyJson)
    const options = {
      hostname: 'playerok.com',
      path: '/graphql',
      method: 'POST',
      headers: {
        accept: '*/*',
        'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        'content-type': 'application/json',
        cookie: `token=${token}`,
        origin: 'https://playerok.com',
        referer,
        'apollographql-client-name': 'web',
        'apollo-require-preflight': 'true',
        'user-agent':
          userAgent ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        'Content-Length': Buffer.byteLength(body, 'utf8'),
      },
    }

    const req = https.request(options, (resp) => {
      let data = ''
      resp.on('data', (chunk) => { data += chunk })
      resp.on('end', () => {
        if (resp.statusCode !== 200) {
          const preview = String(data || '').slice(0, 600)
          return reject(
            new Error(
              `Playerok chatMessages: status ${resp.statusCode}` +
              (preview ? `; ${preview}` : '')
            )
          )
        }
        let json
        try {
          json = JSON.parse(data)
        } catch (err) {
          return reject(new Error(`Invalid JSON from chatMessages: ${err.message}`))
        }
        if (json.errors && json.errors.length) {
          return reject(
            new Error(json.errors.map((e) => e.message || 'GraphQL error').join('; '))
          )
        }
        const cm = json?.data?.chatMessages
        if (!cm) {
          return resolve({ messages: [], pageInfo: { hasNextPage: false, endCursor: null } })
        }
        const edges = Array.isArray(cm.edges) ? cm.edges : []
        const messages = edges
          .map((edge) => edge && edge.node)
          .filter(Boolean)
          .map((node) => {
            const file = node.file || node.attachment || node.image
            const fileUrl = file && (file.url || file.link || file.src)
            const imageUrl = fileUrl || (node.attachments && node.attachments[0] && (node.attachments[0].url || node.attachments[0].link)) || null
            return {
              id: node.id,
              text: node.text || '',
              createdAt: node.createdAt || null,
              imageUrl,
              dealId: node.deal && node.deal.id ? node.deal.id : null,
              user: node.user
                ? {
                  id: node.user.id || null,
                  username: node.user.username || '',
                }
                : null,
            }
          })
        const pageInfo = cm.pageInfo || {}
        resolve({
          messages,
          pageInfo: {
            hasNextPage: !!pageInfo.hasNextPage,
            endCursor: pageInfo.endCursor || null,
          },
        })
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function requestItemById(token, userAgent, itemId) {
  return new Promise((resolve, reject) => {
    const variables = {
      id: String(itemId),
      slug: null,
      hasSupportAccess: false,
      showForbiddenImage: true,
    }
    const params = new URLSearchParams({
      operationName: 'item',
      variables: JSON.stringify(variables),
      extensions: JSON.stringify({
        persistedQuery: { version: 1, sha256Hash: ITEM_PERSISTED_HASH },
      }),
    })
    const options = {
      hostname: 'playerok.com',
      path: `/graphql?${params.toString()}`,
      method: 'GET',
      headers: {
        accept: '*/*',
        'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        'content-type': 'application/json',
        cookie: `token=${token}`,
        origin: 'https://playerok.com',
        referer: 'https://playerok.com/profile/Levkaster/products',
        'apollographql-client-name': 'web',
        'apollo-require-preflight': 'true',
        'x-gql-op': 'item',
        'x-gql-path': '/',
        'user-agent':
          userAgent ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      },
    }
    const req = https.request(options, (resp) => {
      let data = ''
      resp.on('data', (chunk) => { data += chunk })
      resp.on('end', () => {
        if (resp.statusCode !== 200) {
          const preview = String(data || '').slice(0, 500)
          return reject(new Error(`Playerok item: status ${resp.statusCode}` + (preview ? `; ${preview}` : '')))
        }
        let json
        try {
          json = JSON.parse(data)
        } catch (err) {
          return reject(new Error(`Invalid JSON from item: ${err.message}`))
        }
        if (json.errors && json.errors.length) {
          return reject(new Error(json.errors.map((e) => e.message || 'GraphQL error').join('; ')))
        }
        resolve(json?.data?.item || null)
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function requestDealById(token, userAgent, dealId) {
  return new Promise((resolve, reject) => {
    const variables = {
      id: String(dealId),
      hasSupportAccess: false,
      showForbiddenImage: true,
    }
    const params = new URLSearchParams({
      operationName: 'deal',
      variables: JSON.stringify(variables),
      extensions: JSON.stringify({
        persistedQuery: { version: 1, sha256Hash: DEAL_PERSISTED_HASH },
      }),
    })
    const options = {
      hostname: 'playerok.com',
      path: `/graphql?${params.toString()}`,
      method: 'GET',
      headers: {
        accept: '*/*',
        'content-type': 'application/json',
        cookie: `token=${token}`,
        origin: 'https://playerok.com',
        referer: 'https://playerok.com/chats',
        'apollographql-client-name': 'web',
        'apollo-require-preflight': 'true',
        'user-agent':
          userAgent ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
      },
    }
    const req = https.request(options, (resp) => {
      let data = ''
      resp.on('data', (chunk) => { data += chunk })
      resp.on('end', () => {
        if (resp.statusCode !== 200) {
          const preview = String(data || '').slice(0, 500)
          return reject(new Error(`Playerok deal: status ${resp.statusCode}` + (preview ? `; ${preview}` : '')))
        }
        let json
        try {
          json = JSON.parse(data)
        } catch (err) {
          return reject(new Error(`Invalid JSON from deal: ${err.message}`))
        }
        if (json.errors && json.errors.length) {
          return reject(new Error(json.errors.map((e) => e.message || 'GraphQL error').join('; ')))
        }
        resolve(json?.data?.deal || null)
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function extractItemImageUrl(item) {
  if (!item || typeof item !== 'object') return null
  const directFields = [
    'imageUrl',
    'image',
    'previewImage',
    'picture',
    'thumbnail',
    'mainImage',
  ]
  for (const key of directFields) {
    const v = item[key]
    if (!v) continue
    if (typeof v === 'string') return v
    if (typeof v === 'object') {
      if (typeof v.url === 'string') return v.url
      if (typeof v.src === 'string') return v.src
      if (typeof v.link === 'string') return v.link
      if (typeof v.href === 'string') return v.href
    }
  }
  const arrayFields = ['images', 'gallery', 'pictures', 'media', 'attachments']
  for (const key of arrayFields) {
    const arr = item[key]
    if (!Array.isArray(arr) || arr.length === 0) continue
    for (const el of arr) {
      if (!el) continue
      if (typeof el === 'string') return el
      if (typeof el === 'object') {
        if (typeof el.url === 'string') return el.url
        if (typeof el.src === 'string') return el.src
        if (typeof el.link === 'string') return el.link
        if (typeof el.href === 'string') return el.href
      }
    }
  }
  // chat-image debug logging removed
  return null
}

function toUnixTs(v) {
  if (v == null) return 0
  if (typeof v === 'number') {
    if (v < 1e12) return v
    return Math.floor(v / 1000)
  }
  const d = new Date(v)
  return isNaN(d.getTime()) ? 0 : Math.floor(d.getTime() / 1000)
}

/** Продажи со страницы /profile/.../sales — ограничено для быстрой загрузки истории */
const SALES_HISTORY_LIMIT = 72

async function fetchDealsFromPlayerok(token, userAgent) {
  const viewer = await getViewer(token, userAgent)
  const statusList = ['PAID', 'PENDING', 'SENT', 'CONFIRMED', 'ROLLED_BACK']
  const allDeals = []
  let afterCursor = null
  do {
    const page = await requestDealsPage(
      token,
      userAgent,
      viewer.id,
      afterCursor,
      statusList,
      'OUT'
    )
    allDeals.push(...page.deals)
    afterCursor = page.hasNextPage ? page.endCursor : null
  } while (afterCursor && allDeals.length < SALES_HISTORY_LIMIT)
  return { deals: allDeals }
}

/** Актуальные сделки в выполнении (напрямую с Playerok, без БД) */
async function fetchInProgressDealsFromPlayerok(token, userAgent) {
  const viewer = await getViewer(token, userAgent)
  const statusList = ['PAID']
  const allDeals = []
  let afterCursor = null
  do {
    const page = await requestDealsPage(
      token,
      userAgent,
      viewer.id,
      afterCursor,
      statusList,
      'OUT'
    )
    allDeals.push(...page.deals)
    afterCursor = page.hasNextPage ? page.endCursor : null
  } while (afterCursor)
  return { deals: allDeals }
}

/** Завершённые сделки (SENT, CONFIRMED) — для блока «Непрочитанные чаты» */
async function fetchCompletedDealsFromPlayerok(token, userAgent) {
  const viewer = await getViewer(token, userAgent)
  const statusList = ['SENT', 'CONFIRMED']
  const allDeals = []
  let afterCursor = null
  do {
    const page = await requestDealsPage(
      token,
      userAgent,
      viewer.id,
      afterCursor,
      statusList,
      'OUT'
    )
    allDeals.push(...page.deals)
    afterCursor = page.hasNextPage ? page.endCursor : null
  } while (afterCursor)
  return { deals: allDeals }
}

/** Все сообщения чата по chatId или по dealId (если chatId не передан). Подгружаем все страницы. */
async function fetchDealChatMessagesFromPlayerok(token, userAgent, dealId, chatIdFromDeal) {
  let chatId = chatIdFromDeal || null
  if (!chatId && dealId) {
    const fullDeal = await requestDealById(token, userAgent, dealId)
    chatId = fullDeal?.chat?.id || fullDeal?.chatId || null
  }
  if (!chatId) {
    return { messages: [], buyerSupercellEmail: null, itemTitle: null, itemImageUrl: null }
  }
  const referer = dealId ? `https://playerok.com/deal/${dealId}` : undefined
  const allMessages = []
  let afterCursor = null
  const maxPages = 10
  let pageCount = 0
  do {
    const page = await requestChatMessagesPage(token, userAgent, chatId, afterCursor, 24, { referer })
    allMessages.push(...(page.messages || []))
    afterCursor = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null
    pageCount++
  } while (afterCursor && pageCount < maxPages)

  // Пытаемся определить сделку и вытащить почту Supercell ID и данные товара
  let effectiveDealId = dealId || null
  if (!effectiveDealId) {
    for (const m of allMessages) {
      if (m.dealId) {
        effectiveDealId = m.dealId
        break
      }
    }
  }

  let buyerSupercellEmail = null
  let itemTitle = null
  let itemImageUrl = null
  if (effectiveDealId) {
    try {
      const fullDeal = await requestDealById(token, userAgent, effectiveDealId)
      const item = fullDeal && fullDeal.item ? fullDeal.item : null
      itemTitle =
        (item && (item.title || item.name)) ||
        fullDeal?.productTitle ||
        null
      itemImageUrl = extractItemImageUrl(item) || itemImageUrl
      // chat-image debug logging removed
      const fields =
        (fullDeal && Array.isArray(fullDeal.obtainingFields) && fullDeal.obtainingFields) ||
        (fullDeal &&
          fullDeal.item &&
          Array.isArray(fullDeal.item.dataFields) &&
          fullDeal.item.dataFields) ||
        []
      for (const f of fields) {
        const label = (f && typeof f.label === 'string' && f.label) || ''
        const value =
          f && Object.prototype.hasOwnProperty.call(f, 'value') ? f.value : null
        if (!value) continue
        const normalized = label.toLowerCase()
        if (
          normalized.includes('supercell') ||
          normalized.includes('super cell') ||
          normalized.includes('super sell') ||
          normalized === 'почта supercell id' ||
          normalized === 'supercell id'
        ) {
          buyerSupercellEmail = String(value)
          break
        }
      }
    } catch (_) {
      // ignore errors when fetching full deal
    }
  }

  return { messages: allMessages, buyerSupercellEmail, itemTitle, itemImageUrl }
}

// Отправить текстовое сообщение в чат по chatId или dealId.
async function sendChatMessageToPlayerok(token, userAgent, dealId, chatIdFromBody, text) {
  const trimmed = String(text || '').trim()
  if (!trimmed) {
    throw new Error('Пустое сообщение')
  }
  let chatId = chatIdFromBody || null
  if (!chatId && dealId) {
    const fullDeal = await requestDealById(token, userAgent, dealId)
    chatId = fullDeal?.chat?.id || fullDeal?.chatId || null
  }
  if (!chatId) {
    throw new Error('Не удалось определить чат для отправки сообщения')
  }
  const msg = await createChatMessage(token, userAgent, chatId, trimmed)
  const nowIso = new Date().toISOString()
  return {
    id: msg?.id || null,
    text: msg?.text || trimmed,
    createdAt: nowIso,
  }
}

/** Все сделки (продажи) с Playerok без лимита — для синхронизации в БД */
async function fetchAllDealsFromPlayerok(token, userAgent) {
  const viewer = await getViewer(token, userAgent)
  const statusList = ['PAID', 'PENDING', 'SENT', 'CONFIRMED', 'ROLLED_BACK']
  const allDeals = []
  let afterCursor = null
  do {
    const page = await requestDealsPage(
      token,
      userAgent,
      viewer.id,
      afterCursor,
      statusList,
      'OUT'
    )
    allDeals.push(...page.deals)
    afterCursor = page.hasNextPage ? page.endCursor : null
  } while (afterCursor)
  return { deals: allDeals }
}

async function fetchActiveItemsFromPlayerok(token, userAgent) {
  const viewer = await getViewer(token, userAgent)

  const allItems = []
  let afterCursor = null
  let totalCount = 0

  do {
    const page = await requestItemsPage(token, userAgent, viewer.id, afterCursor, ['APPROVED'])
    allItems.push(...page.items)
    if (page.totalCount != null) totalCount = page.totalCount
    afterCursor = page.hasNextPage ? page.endCursor : null
  } while (afterCursor)

  return {
    items: allItems,
    totalCount: totalCount || allItems.length,
  }
}

/** Завершённые товары: /profile/.../products/completed — на странице отображаются SOLD и EXPIRED. */
async function fetchCompletedItemsFromPlayerok(token, userAgent) {
  const viewer = await getViewer(token, userAgent)

  const allItems = []
  let afterCursor = null
  let totalCount = 0
  const statusList = ['SOLD', 'EXPIRED']

  do {
    const page = await requestItemsPage(token, userAgent, viewer.id, afterCursor, statusList)
    allItems.push(...page.items)
    if (page.totalCount != null) totalCount = page.totalCount
    afterCursor = page.hasNextPage ? page.endCursor : null
  } while (afterCursor)

  return {
    items: allItems,
    totalCount: totalCount || allItems.length,
  }
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin
  res.setHeader('Access-Control-Allow-Origin', AUTH_ENABLED && origin ? origin : '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (AUTH_ENABLED) res.setHeader('Access-Control-Allow-Credentials', 'true')

  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    return res.end()
  }

  const parsedUrl = new URL(req.url || '/', `http://localhost:${PORT}`)
  const pathname = parsedUrl.pathname
  const query = Object.fromEntries(parsedUrl.searchParams)
  const nowTs = Math.floor(Date.now() / 1000)

  // POST /api/auth/login — единственный публичный API при включённой аутентификации
  if (req.method === 'POST' && pathname === '/api/auth/login') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      let payload
      try {
        payload = body ? JSON.parse(body) : {}
      } catch (err) {
        return sendJson(res, 400, { error: 'Invalid JSON body' })
      }
      const login = (payload.login != null ? String(payload.login) : '').trim()
      const password = payload.password != null ? String(payload.password) : ''
      if (!AUTH_ENABLED) {
        return sendJson(res, 200, { ok: true, sessionToken: 'disabled' })
      }
      const loginOk = login === AUTH_LOGIN
      const passOk =
        AUTH_PASSWORD_HASH
          ? verifyPassword(password, AUTH_PASSWORD_HASH)
          : password === AUTH_PASSWORD
      if (!loginOk || !passOk) {
        return sendJson(res, 401, { error: 'Неверный логин или пароль' })
      }
      const sessionId = createSession()
      res.setHeader('Set-Cookie', `session=${sessionId}; Path=/; HttpOnly; Max-Age=86400; SameSite=Lax`)
      return sendJson(res, 200, { ok: true, sessionToken: sessionId })
    })
    return
  }

  // Требуем сессию для всех остальных /api/* при включённой аутентификации (кроме запросов с localhost — для фоновых задач)
  if (AUTH_ENABLED && pathname.startsWith('/api/')) {
    const remote = req.socket.remoteAddress || ''
    const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
    if (!isLocal) {
      const sessionId = getSessionIdFromRequest(req)
      if (!sessionId || !isSessionValid(sessionId)) {
        return sendJson(res, 401, { error: 'Unauthorized' })
      }
    }
  }

  if (req.method === 'GET' && pathname === '/api/auth/me') {
    return sendJson(res, 200, { ok: true })
  }

  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    const sessionId = getSessionIdFromRequest(req)
    destroySession(sessionId)
    res.setHeader('Set-Cookie', 'session=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax')
    return sendJson(res, 200, { ok: true })
  }

  if (req.method === 'GET' && pathname === '/api/token') {
    try {
      const stored = loadStoredTokenPlain()
      if (!stored.token && !stored.tokenHash) {
        return sendJson(res, 200, { token: null, updated_at: null })
      }
      // В БД токен хранится в зашифрованном виде; здесь отдаём расшифрованное значение только в рамках активной сессии.
      return sendJson(res, 200, { token: stored.token || null, updated_at: stored.updatedAt })
    } catch (err) {
      return sendJson(res, 500, {
        error: 'Failed to load token',
        details: err && err.message ? String(err.message) : String(err),
      })
    }
  }

  if (req.method === 'POST' && pathname === '/api/token') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      let payload
      try {
        payload = body ? JSON.parse(body) : {}
      } catch (err) {
        return sendJson(res, 400, { error: 'Invalid JSON body' })
      }
      const rawToken = payload && Object.prototype.hasOwnProperty.call(payload, 'token')
        ? payload.token
        : ''
      const token = String(rawToken || '').trim()
      const updatedAt = Math.floor(Date.now() / 1000)
      try {
        if (!token) {
          deleteStoredToken.run()
          return sendJson(res, 200, { ok: true, tokenHash: null, updated_at: null })
        }
        const tokenHash = hashToken(token)
        const tokenEnc = encryptToken(token)
        // token сохраняем только для обратной совместимости (старые части кода), но фронту не отдаём
        upsertStoredToken.run(token, tokenHash, tokenEnc, updatedAt)
        return sendJson(res, 200, { ok: true, tokenHash, updated_at: updatedAt })
      } catch (err) {
        return sendJson(res, 500, {
          error: 'Failed to save token',
          details: err && err.message ? String(err.message) : String(err),
        })
      }
    })
    return
  }

  if (req.method === 'GET' && pathname === '/api/product-settings') {
    const { token } = getTokenFromQueryOrStored(query)
    const productKey = query.productKey
    if (!token || productKey == null || productKey === '') {
      return sendJson(res, 400, { error: 'token and productKey are required' })
    }
    try {
      const tokenHash = hashToken(token)
      const key = String(productKey)
      console.info('[settings:get]', { tokenHash, productKey: key })
      const row = getSettings.get(tokenHash, key)
      if (!row) {
        console.info('[settings:get] not_found', { tokenHash, productKey: key })
        return sendJson(res, 200, { settings: null })
      }
      let settings
      try {
        settings = JSON.parse(row.settings)
      } catch {
        settings = null
      }
      try {
        const s = settings || {}
        console.info('[settings:get] hit', {
          tokenHash,
          productKey: key,
          hasAutodelivery: Boolean(s && s.autodelivery),
          autodeliveryEnabled: Boolean(s && s.autodelivery && s.autodelivery.enabled),
          codesCount: Array.isArray(s && s.autodelivery && s.autodelivery.codes)
            ? s.autodelivery.codes.length
            : 0,
          hasAutomessage: Boolean(s && s.automessage),
          automessageEnabled: Boolean(s && s.automessage && s.automessage.enabled),
          hasAutolist: Boolean(s && s.autolist),
          autolistEnabled: Boolean(s && s.autolist && s.autolist.enabled),
          settingsLabel: typeof s.settingsLabel === 'string' ? s.settingsLabel : null,
        })
      } catch (_) {
        // логирование не должно ломать ответ
      }
      return sendJson(res, 200, { settings, updated_at: row.updated_at })
    } catch (err) {
      return sendJson(res, 500, { error: 'Failed to load settings', details: err.message })
    }
  }

  if (req.method === 'GET' && pathname === '/api/product-settings/list') {
    const { token } = getTokenFromQueryOrStored(query)
    if (!token) return sendJson(res, 400, { error: 'token is required' })
    try {
      const rows = getAllSettings.all(hashToken(token))
      const list = rows.map((row) => {
        let settings = null
        try {
          settings = row.settings ? JSON.parse(row.settings) : null
        } catch {
          // ignore
        }
        return { productKey: row.product_key, settings }
      })
      return sendJson(res, 200, { list })
    } catch (err) {
      return sendJson(res, 500, { error: 'Failed to load settings list', details: err.message })
    }
  }

  if (req.method === 'GET' && pathname === '/api/category-commands/list') {
    const { token } = getTokenFromQueryOrStored(query)
    if (!token) return sendJson(res, 400, { error: 'token is required' })
    try {
      const rows = getAllSettings.all(hashToken(token))
      const list = []
      for (const row of rows) {
        const key = row.product_key || ''
        if (!key.startsWith(CATEGORY_SETTINGS_PREFIX)) continue
        const category = key.slice(CATEGORY_SETTINGS_PREFIX.length)
        let settings = null
        try {
          settings = row.settings ? JSON.parse(row.settings) : null
        } catch {
          settings = null
        }
        const commands = Array.isArray(settings?.commands)
          ? settings.commands.map((c) => ({
            id: c && c.id ? String(c.id) : null,
            label: c && c.label ? String(c.label) : '',
            text: c && c.text ? String(c.text) : '',
          }))
          : []
        list.push({ category, commands })
      }
      return sendJson(res, 200, { list })
    } catch (err) {
      return sendJson(res, 500, { error: 'Failed to load category commands', details: err.message })
    }
  }

  if (req.method === 'POST' && pathname === '/api/category-commands') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      let payload
      try {
        payload = body ? JSON.parse(body) : {}
      } catch (err) {
        return sendJson(res, 400, { error: 'Invalid JSON body' })
      }
      const { token } = getTokenFromBodyOrStored(payload)
      const rawCategory = payload.category
      const rawCommands = payload.commands
      const category = String(rawCategory || '').trim()
      if (!token || !category) {
        return sendJson(res, 400, { error: 'token and category are required' })
      }
      const commands = Array.isArray(rawCommands)
        ? rawCommands.map((c, index) => {
          const safe = typeof c === 'object' && c !== null ? c : {}
          const id =
            safe.id != null && safe.id !== ''
              ? String(safe.id)
              : `cmd-${Date.now()}-${index}`
          return {
            id,
            label: safe.label ? String(safe.label) : '',
            text: safe.text ? String(safe.text) : '',
          }
        })
        : []
      const settings = { commands }
      const settingsStr = JSON.stringify(settings)
      const updatedAt = Math.floor(Date.now() / 1000)
      try {
        const productKey = getCategorySettingsKey(category)
        upsertSettings.run(hashToken(token), String(productKey), settingsStr, updatedAt)
        return sendJson(res, 200, { ok: true, category, updated_at: updatedAt })
      } catch (err) {
        return sendJson(res, 500, { error: 'Failed to save category commands', details: err.message })
      }
    })
    return
  }

  if (req.method === 'POST' && pathname === '/api/product-settings') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      let payload
      try {
        payload = body ? JSON.parse(body) : {}
      } catch (err) {
        return sendJson(res, 400, { error: 'Invalid JSON body' })
      }
      const { token } = getTokenFromBodyOrStored(payload)
      const productKey = payload.productKey
      const settings = payload.settings
      if (!token || productKey == null || productKey === '') {
        return sendJson(res, 400, { error: 'token and productKey are required' })
      }
      const tokenHash = hashToken(token)
      const key = String(productKey)
      const settingsStr = typeof settings === 'object' && settings !== null
        ? JSON.stringify(settings)
        : '{}'
      const updatedAt = Math.floor(Date.now() / 1000)
      try {
        upsertSettings.run(tokenHash, key, settingsStr, updatedAt)
        try {
          const s = typeof settings === 'object' && settings !== null ? settings : {}
          console.info('[settings:save]', {
            tokenHash,
            productKey: key,
            hasAutodelivery: Boolean(s && s.autodelivery),
            autodeliveryEnabled: Boolean(s && s.autodelivery && s.autodelivery.enabled),
            codesCount: Array.isArray(s && s.autodelivery && s.autodelivery.codes)
              ? s.autodelivery.codes.length
              : 0,
            hasAutomessage: Boolean(s && s.automessage),
            automessageEnabled: Boolean(s && s.automessage && s.automessage.enabled),
            hasAutolist: Boolean(s && s.autolist),
            autolistEnabled: Boolean(s && s.autolist && s.autolist.enabled),
            settingsLabel: typeof s.settingsLabel === 'string' ? s.settingsLabel : null,
          })
        } catch (_) {
          // ignore log errors
        }
        return sendJson(res, 200, { ok: true, updated_at: updatedAt })
      } catch (err) {
        return sendJson(res, 500, { error: 'Failed to save settings', details: err.message })
      }
    })
    return
  }

  if (req.method === 'POST' && pathname === '/api/product-settings/delete') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      let payload
      try {
        payload = body ? JSON.parse(body) : {}
      } catch (err) {
        return sendJson(res, 400, { error: 'Invalid JSON body' })
      }
      const { token } = getTokenFromBodyOrStored(payload)
      const productKey = payload.productKey
      if (!token || productKey == null || productKey === '') {
        return sendJson(res, 400, { error: 'token and productKey are required' })
      }
      try {
        const tokenHash = hashToken(token)
        const key = String(productKey)
        const result = deleteSettings.run(tokenHash, key)
        console.info('[settings:delete]', { tokenHash, productKey: key, deleted: result.changes || 0 })
        return sendJson(res, 200, { ok: true, deleted: result.changes || 0 })
      } catch (err) {
        return sendJson(res, 500, { error: 'Failed to delete settings', details: err.message })
      }
    })
    return
  }

  if (req.method === 'POST' && pathname === '/api/playerok/active-lots') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1e6) {
        req.connection.destroy()
      }
    })

    req.on('end', async () => {
      let payload
      try {
        payload = body ? JSON.parse(body) : {}
      } catch (err) {
        return sendJson(res, 400, { error: 'Invalid JSON body' })
      }

      const { token } = getTokenFromBodyOrStored(payload)
      const userAgent = payload.userAgent

      if (!token) {
        return sendJson(res, 400, { error: 'Token is required' })
      }

      try {
        const result = await fetchActiveItemsFromPlayerok(token, userAgent)
        return sendJson(res, 200, result)
      } catch (err) {
        const message = err && err.message ? String(err.message) : 'Не удалось загрузить лоты с Playerok'
        return sendJson(res, 500, { error: message })
      }
    })

    return
  }

  if (req.method === 'POST' && pathname === '/api/playerok/chats') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1e6) {
        req.connection.destroy()
      }
    })
    req.on('end', async () => {
      let payload
      try {
        payload = body ? JSON.parse(body) : {}
      } catch (err) {
        return sendJson(res, 400, { error: 'Invalid JSON body' })
      }
      const { token } = getTokenFromBodyOrStored(payload)
      const userAgent = payload.userAgent
      const afterCursor = payload.afterCursor || payload.after || null
      const limitRaw = payload.limit
      let limit = Number.isFinite(limitRaw) ? Number(limitRaw) : null
      if (!limit || limit <= 0) limit = 24
      if (limit > 50) limit = 50
      if (!token) {
        return sendJson(res, 400, { error: 'Token is required' })
      }
      try {
        const tokenHash = hashToken(token)
        const hiddenRows = getHiddenChats.all(tokenHash)
        const hiddenSet = new Set(
          (hiddenRows || []).map((r) => (r && r.chat_id != null ? String(r.chat_id) : null)).filter(Boolean)
        )
        const viewer = await withRetry(
          () => getViewer(token, userAgent),
          { label: 'getViewer(chats)', retries: 2, shouldRetry: isPlayerokRateLimitError }
        )
        const chatsData = await withRetry(
          () => requestUserChatsPage(token, userAgent, viewer.id, { first: limit, after: afterCursor }),
          { label: 'userChats(ui)', retries: 3, shouldRetry: isPlayerokRateLimitError }
        )
        const edges = Array.isArray(chatsData?.edges) ? chatsData.edges : []

        // Собираем dealId и itemId для маппинга игры/категории (как в /completed-deals)
        const itemIdSet = new Set()
        const dealIdSet = new Set()
        for (const edge of edges) {
          const node = edge && edge.node
          if (!node) continue
          const lastMessage = node.lastMessage || null
          const deal = lastMessage?.deal || node.deal || null
          const item = deal?.item || null
          const itemId = item && item.id != null ? String(item.id) : null
          const dealId = deal && deal.id != null ? String(deal.id) : null
          if (itemId) itemIdSet.add(itemId)
          if (dealId) dealIdSet.add(dealId)
        }

        const itemIdToGame = new Map()
        if (itemIdSet.size > 0) {
          try {
            const [{ items: activeItems }, { items: completedItems }] = await Promise.all([
              fetchActiveItemsFromPlayerok(token, userAgent),
              fetchCompletedItemsFromPlayerok(token, userAgent),
            ])
            for (const it of [...(activeItems || []), ...(completedItems || [])]) {
              const id = it && it.id != null ? String(it.id) : null
              const gameName = (it && it.game) ? String(it.game).trim() : ''
              if (id && gameName && !itemIdToGame.has(id)) {
                itemIdToGame.set(id, gameName)
              }
            }
          } catch (e) {
            console.warn('[userChats] failed to map itemIdToGame', { error: e && e.message })
          }
        }

        const dealIdToCategory = new Map()
        if (dealIdSet.size > 0) {
          const dealIds = Array.from(dealIdSet)
          try {
            await Promise.all(
              dealIds.map(async (id) => {
                try {
                  const fullDeal = await withRetry(
                    () => requestDealById(token, userAgent, id),
                    { label: 'dealById(userChats)', retries: 2, shouldRetry: isPlayerokRateLimitError }
                  )
                  if (!fullDeal) return
                  let category =
                    (fullDeal.category && String(fullDeal.category).trim()) ||
                    null
                  const item = fullDeal.item || null
                  if (!category && item) {
                    const gameName =
                      (item.game && (item.game.name || item.game.title)) ||
                      null
                    if (gameName) category = String(gameName).trim()
                  }
                  if (!category && typeof fullDeal.productKey === 'string') {
                    const pk = fullDeal.productKey
                    const sepIndex = pk.indexOf('::')
                    if (sepIndex > 0) {
                      const gameFromPk = pk.slice(0, sepIndex).trim()
                      if (gameFromPk) category = gameFromPk
                    }
                  }
                  if (category) {
                    dealIdToCategory.set(String(id), category)
                  }
                } catch (e) {
                  console.warn('[userChats] failed to load deal for category', { dealId: id, error: e && e.message })
                }
              })
            )
          } catch (_) {
            // ignore batch errors
          }
        }

        const list = edges
          .map((edge) => edge && edge.node)
          .filter(Boolean)
          .map((node) => {
            const lastMessage = node.lastMessage || null
            const deal = lastMessage?.deal || node.deal || null
            const item = deal?.item || null
            const buyer = deal?.buyer || node.buyer || null
            const itemTitle =
              (item && (item.title || item.name)) ||
              (deal && deal.productTitle) ||
              null
            const itemImageUrl = item ? extractItemImageUrl(item) : null
            let category =
              (item && item.game && (item.game.name || item.game.title)) ||
              (item && item.category && (item.category.name || item.category.title)) ||
              (node && node.game && (node.game.name || node.game.title)) ||
              (node && node.category && (node.category.name || node.category.title)) ||
              (deal && typeof deal.category === 'string' && deal.category) ||
              null
            if (!category && deal && typeof deal.productKey === 'string') {
              const pk = deal.productKey
              const sepIndex = pk.indexOf('::')
              if (sepIndex > 0) {
                category = pk.slice(0, sepIndex).trim() || null
              }
            }
            if (!category) {
              const itemId = item && item.id != null ? String(item.id) : null
              if (itemId && itemIdToGame.has(itemId)) {
                category = itemIdToGame.get(itemId)
              }
            }
            if (!category && deal && deal.id != null) {
              const did = String(deal.id)
              if (dealIdToCategory.has(did)) {
                category = dealIdToCategory.get(did)
              }
            }
            const status = deal && typeof deal.status === 'string' ? deal.status : null
            return {
              id: node.id,
              unreadCount:
                typeof node.unreadMessagesCount === 'number'
                  ? node.unreadMessagesCount
                  : null,
              lastMessageId: lastMessage?.id || null,
              lastMessageText: lastMessage?.text || null,
              lastMessageCreatedAt: lastMessage?.createdAt || null,
              dealId: deal?.id || null,
              itemId: item?.id || null,
              itemTitle,
              itemImageUrl,
              category,
              status,
              buyerName: buyer?.username || buyer?.name || null,
              isHidden: node.id != null && hiddenSet.has(String(node.id)),
            }
          })
        // chat-image debug logging removed
        const pageInfo = (chatsData && chatsData.pageInfo) || {}
        return sendJson(res, 200, {
          list,
          pageInfo: {
            hasNextPage: Boolean(pageInfo.hasNextPage),
            endCursor: pageInfo.endCursor || null,
          },
        })
      } catch (err) {
        const message =
          err && err.message
            ? String(err.message)
            : 'Не удалось загрузить чаты с Playerok'
        return sendJson(res, 500, { error: message })
      }
    })
    return
  }

  if (req.method === 'POST' && pathname === '/api/playerok/hide-chat') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1e6) {
        req.connection.destroy()
      }
    })
    req.on('end', () => {
      let payload
      try {
        payload = body ? JSON.parse(body) : {}
      } catch (err) {
        return sendJson(res, 400, { error: 'Invalid JSON body' })
      }
      const { token } = getTokenFromBodyOrStored(payload)
      const chatId = payload.chatId
      if (!token || !chatId) {
        return sendJson(res, 400, { error: 'token and chatId are required' })
      }
      const tokenHash = hashToken(token)
      const nowTs = Math.floor(Date.now() / 1000)
      try {
        upsertHiddenChat.run(tokenHash, String(chatId), nowTs)
        return sendJson(res, 200, { ok: true, chatId: String(chatId) })
      } catch (err) {
        return sendJson(res, 500, { error: 'Failed to hide chat', details: err.message })
      }
    })
    return
  }

  if (req.method === 'POST' && pathname === '/api/playerok/unhide-chat') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1e6) {
        req.connection.destroy()
      }
    })
    req.on('end', () => {
      let payload
      try {
        payload = body ? JSON.parse(body) : {}
      } catch (err) {
        return sendJson(res, 400, { error: 'Invalid JSON body' })
      }
      const { token } = getTokenFromBodyOrStored(payload)
      const chatId = payload.chatId
      if (!token || !chatId) {
        return sendJson(res, 400, { error: 'token and chatId are required' })
      }
      const tokenHash = hashToken(token)
      try {
        deleteHiddenChat.run(tokenHash, String(chatId))
        return sendJson(res, 200, { ok: true, chatId: String(chatId) })
      } catch (err) {
        return sendJson(res, 500, { error: 'Failed to unhide chat', details: err.message })
      }
    })
    return
  }

  if (req.method === 'GET' && pathname === '/api/sales-history') {
    const { token } = getTokenFromQueryOrStored(query)
    if (!token) return sendJson(res, 400, { error: 'token is required' })
    try {
      const rows = getSalesHistory.all(hashToken(token))
      const list = rows.map((row) => ({
        productKey: row.product_key,
        productTitle: row.product_title,
        soldAt: row.sold_at,
        price: row.price ?? 0,
        status: row.status || null,
        buyerName: row.buyer_name || null,
      }))
      return sendJson(res, 200, { list })
    } catch (err) {
      return sendJson(res, 500, {
        error: err && err.message ? String(err.message) : 'Failed to load sales history',
      })
    }
  }

  if (req.method === 'POST' && pathname === '/api/sales-history/clear') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      let payload
      try {
        payload = body ? JSON.parse(body) : {}
      } catch (err) {
        return sendJson(res, 400, { error: 'Invalid JSON body' })
      }
      const { token } = getTokenFromBodyOrStored(payload)
      if (!token) {
        return sendJson(res, 400, { error: 'token is required' })
      }
      try {
        const result = deleteSalesHistoryByToken.run(hashToken(token))
        return sendJson(res, 200, { ok: true, deleted: result.changes })
      } catch (err) {
        return sendJson(res, 500, {
          error: err && err.message ? String(err.message) : 'Failed to clear sales history',
        })
      }
    })
    return
  }

  if (req.method === 'POST' && pathname === '/api/sync-sales') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', async () => {
      let payload
      try {
        payload = body ? JSON.parse(body) : {}
      } catch (err) {
        return sendJson(res, 400, { error: 'Invalid JSON body' })
      }
      const { token } = getTokenFromBodyOrStored(payload)
      const userAgent = payload.userAgent
      if (!token) {
        return sendJson(res, 400, { error: 'token is required' })
      }
      try {
        const { deals } = await fetchAllDealsFromPlayerok(token, userAgent)
        const tokenHash = hashToken(token)
        let inserted = 0
        for (const d of deals) {
          const dealId = d.id || null
          if (!dealId) continue
          let soldAt = d.soldAt
          let buyerName = d.buyerName || null
          let fullDeal = null
          if (!soldAt || !buyerName) {
            try {
              fullDeal = await requestDealById(token, userAgent, dealId)
              if (!soldAt) {
                soldAt = fullDeal
                  ? toUnixTs(fullDeal.createdAt) || toUnixTs(fullDeal.completedAt) || 0
                  : 0
              }
              if (!buyerName) {
                buyerName = (fullDeal && fullDeal.user && fullDeal.user.username) || null
              }
            } catch (_) {
              if (!soldAt) soldAt = 0
            }
          }
          try {
            const result = insertSale.run(
              tokenHash,
              d.productKey || 'Товар',
              d.productTitle || 'Товар',
              soldAt,
              Number(d.price) || 0,
              d.status || null,
              dealId,
              d.itemId || null,
              buyerName || null,
              String(d.status || '') === 'ROLLED_BACK' ? 1 : 0
            )
            if (result.changes > 0) inserted += 1
          } catch (_) {
            // UNIQUE conflict or other — skip
          }
        }
        return sendJson(res, 200, {
          ok: true,
          total: deals.length,
          inserted,
        })
      } catch (err) {
        return sendJson(res, 500, {
          error: err && err.message ? String(err.message) : 'Не удалось загрузить продажи с Playerok',
        })
      }
    })
    return
  }

  if (req.method === 'POST' && pathname === '/api/sync-sales-stream') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', async () => {
      let payload
      try {
        payload = body ? JSON.parse(body) : {}
      } catch (err) {
        return sendJson(res, 400, { error: 'Invalid JSON body' })
      }
      const { token } = getTokenFromBodyOrStored(payload)
      const userAgent = payload.userAgent
      if (!token) {
        return sendJson(res, 400, { error: 'token is required' })
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      })
      const sendEvent = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`)
      }
      try {
        const viewer = await getViewer(token, userAgent)
        const tokenHash = hashToken(token)
        const statusList = ['PAID', 'PENDING', 'SENT', 'CONFIRMED', 'ROLLED_BACK']
        let afterCursor = null
        let fetched = 0
        let inserted = 0
        // Каждая сделка (deal) = одна покупка: свой товар и дата; в одном чате может быть несколько сделок
        do {
          const page = await requestDealsPage(
            token,
            userAgent,
            viewer.id,
            afterCursor,
            statusList,
            'OUT'
          )
          for (const d of page.deals) {
            const dealId = d.id || null
            let soldAt = d.soldAt
            let buyerName = d.buyerName || null
            if (dealId && (!soldAt || !buyerName)) {
              try {
                const fullDeal = await requestDealById(token, userAgent, dealId)
                if (!soldAt) {
                  soldAt = fullDeal
                    ? toUnixTs(fullDeal.createdAt) || toUnixTs(fullDeal.completedAt) || 0
                    : 0
                }
                if (!buyerName) {
                  buyerName = (fullDeal && fullDeal.user && fullDeal.user.username) || null
                }
              } catch (_) {
                if (!soldAt) soldAt = 0
              }
            }
            if (dealId) {
              try {
                const result = insertSale.run(
                  tokenHash,
                  d.productKey || 'Товар',
                  d.productTitle || 'Товар',
                  soldAt,
                  Number(d.price) || 0,
                  d.status || null,
                  dealId,
                  d.itemId || null,
                  buyerName || null,
                  String(d.status || '') === 'ROLLED_BACK' ? 1 : 0
                )
                if (result.changes > 0) inserted += 1
              } catch (_) { }
            }
            fetched += 1
          }
          sendEvent({ fetched, inserted })
          afterCursor = page.hasNextPage ? page.endCursor : null
        } while (afterCursor)
        sendEvent({ done: true, total: fetched, inserted })
      } catch (err) {
        sendEvent({ error: err && err.message ? String(err.message) : 'Ошибка синхронизации' })
      } finally {
        res.end()
      }
    })
    return
  }

  if (req.method === 'GET' && pathname === '/api/bump-history') {
    const { token } = getTokenFromQueryOrStored(query)
    if (!token) return sendJson(res, 400, { error: 'token is required' })
    try {
      const rows = getBumpHistory.all(hashToken(token))
      const list = rows.map((row) => ({
        productKey: row.product_key,
        productTitle: row.product_title,
        bumpedAt: row.bumped_at,
        price: row.price ?? 0,
        itemId: row.item_id || null,
      }))
      return sendJson(res, 200, { list })
    } catch (err) {
      return sendJson(res, 500, { error: 'Failed to load bump history', details: err.message })
    }
  }

  if (req.method === 'GET' && pathname === '/api/profit-analytics/meta') {
    const { token } = getTokenFromQueryOrStored(query)
    if (!token) return sendJson(res, 400, { error: 'token is required' })
    try {
      const tokenHash = hashToken(token)
      const years = getSalesYears.all(tokenHash).map((r) => r.year).filter((y) => y != null)
      const yearQ = parseIntSafe(query.year, null)
      const months =
        yearQ != null
          ? getSalesMonthsForYear.all(tokenHash, String(yearQ)).map((r) => r.month).filter((m) => m != null)
          : []
      return sendJson(res, 200, { years, months })
    } catch (err) {
      return sendJson(res, 500, { error: err && err.message ? String(err.message) : 'Failed to load profit meta' })
    }
  }

  if (req.method === 'GET' && pathname === '/api/profit-analytics') {
    const { token } = getTokenFromQueryOrStored(query)
    if (!token) return sendJson(res, 400, { error: 'token is required' })
    try {
      const tokenHash = hashToken(token)
      const salesRows = getSalesHistoryAll.all(tokenHash)
      const bumpsRows = getBumpHistory.all(tokenHash)
      const settingsRows = getAllSettings.all(tokenHash)
      const listingFeesRows = getListingFees.all(tokenHash)
      const allList = computeProfitAnalyticsList({ salesRows, bumpsRows, settingsRows, listingFeesRows })

      const year = parseIntSafe(query.year, null)
      const month = parseIntSafe(query.month, null)
      const day = parseIntSafe(query.day, null)
      const filtered =
        year == null
          ? allList
          : allList.filter((it) => {
            if (!it?.soldAt) return false
            const d = new Date(it.soldAt * 1000)
            const y = d.getFullYear()
            const m = d.getMonth() + 1
            const dayNum = d.getDate()
            if (y !== year) return false
            if (month != null && m !== month) return false
            if (day != null && dayNum !== day) return false
            return true
          })

      const limit = clampInt(parseIntSafe(query.limit, 100), 1, 1000)
      const offset = clampInt(parseIntSafe(query.offset, 0), 0, 2_000_000_000)
      const total = filtered.length
      const list = filtered.slice(offset, offset + limit)
      return sendJson(res, 200, { list, total, limit, offset })
    } catch (err) {
      return sendJson(res, 500, {
        error: err && err.message ? String(err.message) : 'Failed to load profit analytics',
      })
    }
  }

  if (req.method === 'GET' && pathname === '/api/profit-stats') {
    const { token } = getTokenFromQueryOrStored(query)
    if (!token) return sendJson(res, 400, { error: 'token is required' })
    try {
      const tokenHash = hashToken(token)
      const salesRows = getSalesHistoryAll.all(tokenHash)
      const bumpsRows = getBumpHistory.all(tokenHash)
      const settingsRows = getAllSettings.all(tokenHash)
      const listingFeesRows = getListingFees.all(tokenHash)

      const allList = computeProfitAnalyticsList({ salesRows, bumpsRows, settingsRows, listingFeesRows })

      const year = parseIntSafe(query.year, null)
      const month = parseIntSafe(query.month, null)
      const day = parseIntSafe(query.day, null)
      const list =
        year == null
          ? allList
          : allList.filter((it) => {
            if (!it?.soldAt) return false
            const d = new Date(it.soldAt * 1000)
            const y = d.getFullYear()
            const m = d.getMonth() + 1
            const dayNum = d.getDate()
            if (y !== year) return false
            if (month != null && m !== month) return false
            if (day != null && dayNum !== day) return false
            return true
          })

      let totalProfit = 0
      let totalListingCost = 0
      let totalBumpCost = 0
      let totalCost = 0
      let totalRevenue = 0
      let salesCount = 0
      let refundCount = 0

      const profitByHour = Array.from({ length: 24 }, () => 0)
      const profitByWeekday = Array.from({ length: 7 }, () => 0) // 0=Sun..6=Sat

      for (const it of list) {
        const p = Number(it.profit) || 0
        totalProfit += p
        totalListingCost += Number(it.listingCost) || 0
        totalBumpCost += Number(it.bumpCost) || 0
        totalCost += Number(it.cost) || 0
        if (!it.isRefund) totalRevenue += Number(it.salePrice) || 0
        salesCount += 1
        if (it.isRefund) refundCount += 1

        if (it.soldAt) {
          const d = new Date(it.soldAt * 1000)
          const hour = d.getHours()
          const wd = d.getDay()
          if (hour >= 0 && hour < 24) profitByHour[hour] += p
          if (wd >= 0 && wd < 7) profitByWeekday[wd] += p
        }
      }

      const bestHour = profitByHour.reduce(
        (acc, val, idx) => (val > acc.profit ? { hour: idx, profit: val } : acc),
        { hour: 0, profit: profitByHour[0] || 0 }
      )
      const bestWeekday = profitByWeekday.reduce(
        (acc, val, idx) => (val > acc.profit ? { weekday: idx, profit: val } : acc),
        { weekday: 0, profit: profitByWeekday[0] || 0 }
      )

      const avgProfit = salesCount ? totalProfit / salesCount : 0

      return sendJson(res, 200, {
        scope: { year: year ?? null, month: month ?? null },
        totals: {
          profit: totalProfit,
          revenue: totalRevenue,
          cost: totalCost,
          listingCost: totalListingCost,
          bumpCost: totalBumpCost,
        },
        counts: { sales: salesCount, refunds: refundCount },
        averages: { profitPerSale: avgProfit },
        best: {
          hour: bestHour,
          weekday: bestWeekday,
        },
      })
    } catch (err) {
      return sendJson(res, 500, { error: err && err.message ? String(err.message) : 'Failed to load profit stats' })
    }
  }

  if (req.method === 'POST' && pathname === '/api/playerok/bump') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', async () => {
      let payload
      try {
        payload = body ? JSON.parse(body) : {}
      } catch (err) {
        return sendJson(res, 400, { error: 'Invalid JSON body' })
      }
      const { token } = getTokenFromBodyOrStored(payload)
      const productKey = payload.productKey
      const productTitle = payload.productTitle || 'Товар'
      const itemId = payload.itemId
      const userAgent = payload.userAgent
      const requestedPrice = typeof payload.price === 'number' ? payload.price : null
      const userPriorityStatusId = payload.priorityStatusId || null
      const transactionProviderId = payload.transactionProviderId || 'LOCAL'
      const paymentMethodId =
        Object.prototype.hasOwnProperty.call(payload, 'paymentMethodId') ? payload.paymentMethodId : null

      if (!token || !productKey || !itemId) {
        return sendJson(res, 400, { error: 'token, productKey and itemId are required' })
      }

      const bumpedAt = Math.floor(Date.now() / 1000)
      const tokenHash = hashToken(token)
      const reqId = crypto.randomBytes(6).toString('hex')
      console.info('[bump] start', {
        reqId,
        tokenHash,
        productKey: String(productKey),
        itemId: String(itemId),
        productTitle: String(productTitle),
      })

      let priorityStatusId = userPriorityStatusId
      try {
        const statuses = await fetchItemPriorityStatuses(token, userAgent, itemId, requestedPrice ?? 0)
        const list = Array.isArray(statuses) ? statuses : []
        if (list.length === 0) {
          return sendJson(res, 400, {
            error: 'Нет доступных статусов поднятия для этого товара. Проверьте, что товар активен.',
            reqId,
          })
        }
        const found = userPriorityStatusId
          ? list.find((s) => String(s?.id || '') === String(userPriorityStatusId))
          : null
        priorityStatusId = (found || list[0])?.id || null
        if (!priorityStatusId) {
          return sendJson(res, 400, {
            error: 'Не удалось определить статус поднятия для товара',
            reqId,
          })
        }
      } catch (fetchErr) {
        console.warn('[bump] fetch statuses failed', { reqId, itemId, error: fetchErr?.message })
        return sendJson(res, 500, {
          error: fetchErr && fetchErr.message ? String(fetchErr.message) : 'Не удалось получить статусы поднятия',
          reqId,
        })
      }

      try {
        const item = await increaseItemPriorityStatus(token, userAgent, itemId, {
          priorityStatusId,
          transactionProviderId,
          paymentMethodId,
        })
        const paymentURL = item?.statusPayment?.props?.paymentURL || null
        const statusDescription = item?.statusPayment?.statusDescription || null
        const status = item?.statusPayment?.status || null
        const price =
          typeof item?.priorityPrice === 'number'
            ? item.priorityPrice
            : typeof item?.statusPayment?.value === 'number'
              ? item.statusPayment.value
              : requestedPrice != null
                ? requestedPrice
                : 0

        if (paymentURL) {
          console.warn('[bump] payment_required', {
            reqId,
            tokenHash,
            productKey: String(productKey),
            itemId: String(itemId),
            priorityStatusId: String(priorityStatusId),
            transactionProviderId: String(transactionProviderId),
            status,
            statusDescription,
            paymentURL,
            price: Number(price) || 0,
          })
          return sendJson(res, 402, { error: statusDescription || 'Требуется оплата поднятия', paymentURL })
        }

        insertBump.run(
          tokenHash,
          String(productKey),
          String(productTitle),
          bumpedAt,
          Number(price) || 0,
          itemId ? String(itemId) : null
        )
        console.info('[bump] success', {
          reqId,
          tokenHash,
          productKey: String(productKey),
          itemId: String(itemId),
          priorityStatusId: String(priorityStatusId),
          transactionProviderId: String(transactionProviderId),
          bumpedAt,
          price: Number(price) || 0,
          status,
          statusDescription,
        })
        return sendJson(res, 200, { ok: true, bumpedAt, price: Number(price) || 0 })
      } catch (err) {
        console.warn('[bump] failed', {
          reqId,
          tokenHash,
          productKey: String(productKey),
          itemId: String(itemId),
          priorityStatusId: String(priorityStatusId),
          transactionProviderId: String(transactionProviderId),
          error: err && err.message ? String(err.message) : String(err),
        })
        return sendJson(res, 500, {
          error: err && err.message ? String(err.message) : 'Failed to bump item',
          reqId,
        })
      }
    })
    return
  }

  if (req.method === 'POST' && pathname === '/api/playerok/autolist-tick') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', async () => {
      let payload
      try {
        payload = body ? JSON.parse(body) : {}
      } catch {
        return sendJson(res, 400, { error: 'Invalid JSON body' })
      }
      const { token } = getTokenFromBodyOrStored(payload)
      const userAgent = payload.userAgent
      if (!token) return sendJson(res, 400, { error: 'Token is required' })

      const tokenHash = hashToken(token)
      const scanMeta = autolistGetCompletedScanMap(tokenHash)
      const lastChatMeta = autolistGetLastChatMeta(tokenHash)
      try {
        console.log('[autolist-tick] start', { tokenHash, nowTs })
        const viewer = await withRetry(
          () => getViewer(token, userAgent),
          { label: 'getViewer', retries: 2, shouldRetry: isPlayerokRateLimitError }
        )

        const chatsData = await withRetry(
          () => requestUserChatsPage(token, userAgent, viewer.id),
          { label: 'userChats', retries: 3, shouldRetry: isPlayerokRateLimitError }
        )
        const chatNodes = Array.isArray(chatsData?.edges)
          ? chatsData.edges
            .map((e) => e && e.node)
            .filter(Boolean)
            .slice(0, AUTOLIST_MAX_CHATS_TO_SCAN)
          : []
        autolistPruneProcessedMap(tokenHash, nowTs)
        autolistPruneSeenChatsMap(tokenHash, nowTs)
        autolistPruneItemStateMap(tokenHash, nowTs)

        // === 1. Автопроверка каждые 2 минуты: сканируем завершённые товары и перевыставляем все с автовыставлением ===
        async function scanCompletedAndRelist(trigger) {
          scanMeta.lastScanTs = nowTs
          try {
            const completed = await withRetry(
              () => fetchCompletedItemsFromPlayerok(token, userAgent),
              { label: 'completedItems', retries: 3, shouldRetry: isPlayerokRateLimitError }
            )
            const items = Array.isArray(completed?.items) ? completed.items : []
            const lastTen = items.slice(0, 10)
            console.log('[autolist-tick] scanCompletedAndRelist start', {
              trigger,
              totalItems: items.length,
              scanned: lastTen.length,
            })
            const relistedItems = []
            const relistErrors = []
            for (const it of lastTen) {
              const itemId = it?.id != null ? String(it.id) : null
              if (!itemId) continue

              const itemStatus = it?.status || null
              if (String(itemStatus) !== 'SOLD') continue

              const rawTitle = it?.title || it?.name || ''
              const rawGame = it?.game || (it?.game && it.game.name) || it?.game_name || ''
              const title = normalizeKeyPart(rawTitle)
              const game = normalizeKeyPart(rawGame)
              const productKey = buildProductKey(game, title)

              const eventKey = `completed:${itemId}`
              if (autolistWasProcessed(tokenHash, eventKey)) continue

              // Настройки: по productKey; если есть settingsLabel — берём из группы __group__::метка
              let effectiveSettings = null
              let effectiveKey = String(productKey)
              try {
                const row = getSettings.get(hashToken(token), effectiveKey)
                if (row?.settings) {
                  effectiveSettings = JSON.parse(row.settings)
                  const label = (effectiveSettings && typeof effectiveSettings.settingsLabel === 'string')
                    ? effectiveSettings.settingsLabel.trim()
                    : ''
                  if (label) {
                    const gk = getGroupSettingsKey(label)
                    const groupRow = getSettings.get(hashToken(token), gk)
                    if (groupRow?.settings) {
                      effectiveSettings = JSON.parse(groupRow.settings)
                      effectiveKey = gk
                    }
                  }
                }
              } catch (_) {
                effectiveSettings = null
              }

              const s = effectiveSettings
              const autolistEnabled = Boolean(s?.autolist?.enabled)
              if (!autolistEnabled) {
                autolistMarkProcessed(tokenHash, eventKey, nowTs)
                autolistSetItemState(tokenHash, itemId, {
                  status: 'disabled',
                  error: null,
                  updatedAt: nowTs,
                })
                continue
              }

              try {
                autolistSetItemState(tokenHash, itemId, {
                  status: 'processing',
                  error: null,
                  updatedAt: nowTs,
                })
                // Выбираем корректный статус приоритета для этого товара (аналогично PlayerokAPI: get_item_priority_statuses)
                let priorityStatusId = null
                try {
                  const statuses = await withRetry(
                    () => fetchItemPriorityStatuses(token, userAgent, itemId, it?.price ?? 0),
                    { label: 'itemPriorityStatuses(autolist)', retries: 2, shouldRetry: isPlayerokRateLimitError }
                  )
                  const list = Array.isArray(statuses) ? statuses : []
                  // Берём бесплатный/нулевой или первый доступный
                  const free = list.find((s) => !s?.price || Number(s.price) === 0)
                  priorityStatusId = (free && free.id) || (list[0] && list[0].id) || null
                } catch (_) {
                  priorityStatusId = null
                }
                const relisted = await withRetry(
                  () => publishItem(token, userAgent, itemId, priorityStatusId ? { priorityStatusId } : {}),
                  { label: 'publishItem(completedScan)', retries: 3, shouldRetry: isPlayerokRateLimitError }
                )
                try {
                  insertListingFee.run(tokenHash, String(productKey), Number(relisted.listingFee) || 0, nowTs)
                } catch (_) { }
                autolistMarkProcessed(tokenHash, eventKey, nowTs)
                autolistSetItemState(tokenHash, itemId, {
                  status: 'success',
                  error: null,
                  updatedAt: nowTs,
                })
                relistedItems.push({
                  oldItemId: itemId,
                  newItemId: relisted.id,
                  productKey,
                })
              } catch (err) {
                const msg = err && err.message ? String(err.message) : String(err)
                const cannotUpdateStatus = msg.includes('нельзя обновить статус')
                console.warn('[autolist-tick] relist failed', {
                  trigger,
                  itemId,
                  productKey,
                  error: msg,
                })
                if (cannotUpdateStatus) {
                  // Товар уже в нужном статусе: помечаем событие обработанным и больше не трогаем его.
                  autolistMarkProcessed(tokenHash, eventKey, nowTs)
                }
                autolistSetItemState(tokenHash, itemId, {
                  status: cannotUpdateStatus ? 'disabled' : 'error',
                  error: msg,
                  updatedAt: nowTs,
                })
                relistErrors.push({
                  itemId,
                  productKey,
                  error: msg,
                })
              }
            }

            if (relistedItems.length > 0) {
              console.log('[autolist-tick] scanCompletedAndRelist relisted', {
                trigger,
                relistedCount: relistedItems.length,
                errorsCount: relistErrors.length,
              })
              return { ok: true, action: 'relisted', trigger, relisted: relistedItems, errors: relistErrors }
            }
            console.log('[autolist-tick] scanCompletedAndRelist no_relist', { trigger })
            return { ok: true, action: 'none', trigger }
          } catch (err) {
            console.warn('[autolist-tick] completed scan failed', { trigger, error: err?.message })
            if (isPlayerokRateLimitError(err)) {
              scanMeta.lastScanTs = nowTs + AUTOLIST_COMPLETED_SCAN_INTERVAL_SEC
            }
            return { ok: false, error: err && err.message ? String(err.message) : 'scan_failed', trigger }
          }
        }

        // 1.1 Периодический запуск: каждые 2 минуты
        let periodicResult = null
        const lastScanTs = Number(scanMeta?.lastScanTs || 0)
        const shouldPeriodicScan = !lastScanTs || (nowTs - lastScanTs) >= AUTOLIST_COMPLETED_SCAN_INTERVAL_SEC
        if (shouldPeriodicScan) {
          periodicResult = await scanCompletedAndRelist('periodic')
        }

        // === 2. Триггер по смене последнего чата и свежему событию оплаты (paid) ===
        let lastChat = null
        let lastMessage = null
        let lastMessageId = null
        let lastMessageCreatedAt = null
        let deal = null
        let dealId = null
        let dealStatus = null
        let dealItemId = null
        let dealTs = null

        const currentLastChat = chatNodes.length > 0 ? chatNodes[0] : null
        const currentLastChatId = currentLastChat?.id || null

        if (currentLastChatId && lastChatMeta.lastChatId && lastChatMeta.lastChatId !== currentLastChatId) {
          const lm = currentLastChat?.lastMessage || null
          const d = lm?.deal || null
          const dItemId = d?.item?.id || null
          if (dItemId) {
            const candidateDealId = d?.id || null
            const candidateLastMessageId = lm?.id || null

            let candidateDealTs = 0
            try {
              const fullDeal = await withRetry(
                () => requestDealById(token, userAgent, candidateDealId),
                { label: 'dealById(lastChat)', retries: 2, shouldRetry: isPlayerokRateLimitError }
              )
              candidateDealTs =
                fullDeal
                  ? toUnixTs(fullDeal.createdAt) || toUnixTs(fullDeal.completedAt) || 0
                  : toUnixTs(lm?.createdAt)
              dealStatus = fullDeal?.status || d?.status || null
            } catch (_) {
              candidateDealTs = toUnixTs(lm?.createdAt) || 0
              dealStatus = d?.status || null
            }

            const candidateAgeSec = candidateDealTs ? nowTs - candidateDealTs : null
            const isFreshPaid = candidateDealTs &&
              (candidateAgeSec == null || candidateAgeSec <= AUTOLIST_LAST_CHAT_FRESH_SEC) &&
              (lastChatMeta.lastPaidTs == null || candidateDealTs > Number(lastChatMeta.lastPaidTs || 0))

            if (isFreshPaid) {
              lastChat = currentLastChat
              lastMessage = lm
              lastMessageId = candidateLastMessageId
              lastMessageCreatedAt = lm?.createdAt || null
              deal = d
              dealId = candidateDealId
              dealItemId = dItemId
              dealTs = candidateDealTs

              // 2.1 Сканируем завершённые товары и перевыставляем все с автовыставлением
              const paidScanResult = await scanCompletedAndRelist('paid_chat')

              // 2.2 Фиксируем продажу и выполняем автосообщения/автовыдачу для этого товара
              const item = await withRetry(
                () => requestItemById(token, userAgent, dealItemId),
                { label: 'itemById', retries: 3, shouldRetry: isPlayerokRateLimitError }
              )
              if (item) {
                const itemStatus = item.status || null
                const rawTitle = item.title || item.name || ''
                const rawGame = item.game || (item.game && item.game.name) || ''
                const title = normalizeKeyPart(rawTitle)
                const game = normalizeKeyPart(rawGame)
                const productKey = buildProductKey(game, title)

                // 2.3 Пытаемся перевыставить конкретный товар из сделки, подбирая корректный статус приоритета
                try {
                  let priorityStatusId = null
                  try {
                    const statuses = await withRetry(
                      () => fetchItemPriorityStatuses(token, userAgent, dealItemId, item?.price ?? 0),
                      { label: 'itemPriorityStatuses(paid_chat)', retries: 2, shouldRetry: isPlayerokRateLimitError }
                    )
                    const list = Array.isArray(statuses) ? statuses : []
                    const free = list.find((s) => !s?.price || Number(s.price) === 0)
                    priorityStatusId = (free && free.id) || (list[0] && list[0].id) || null
                  } catch (_) {
                    priorityStatusId = null
                  }
                  if (String(itemStatus) === 'SOLD') {
                    const relisted = await withRetry(
                      () => publishItem(token, userAgent, dealItemId, priorityStatusId ? { priorityStatusId } : {}),
                      { label: 'publishItem(paid_chat)', retries: 3, shouldRetry: isPlayerokRateLimitError }
                    )
                    try {
                      insertListingFee.run(tokenHash, String(productKey), Number(relisted.listingFee) || 0, nowTs)
                    } catch (_) { }
                    autolistMarkProcessed(tokenHash, `deal:${dealId || dealItemId}`, nowTs)
                    autolistSetItemState(tokenHash, dealItemId, {
                      status: 'success',
                      error: null,
                      updatedAt: nowTs,
                    })
                  }
                } catch (err) {
                  const msg = err && err.message ? String(err.message) : String(err)
                  const cannotUpdateStatus = msg.includes('нельзя обновить статус')
                  console.warn('[autolist-tick] relist failed', {
                    trigger: 'paid_chat',
                    itemId: dealItemId,
                    productKey,
                    error: msg,
                  })
                  if (cannotUpdateStatus) {
                    autolistMarkProcessed(tokenHash, `deal:${dealId || dealItemId}`, nowTs)
                  }
                  autolistSetItemState(tokenHash, dealItemId, {
                    status: cannotUpdateStatus ? 'disabled' : 'error',
                    error: msg,
                    updatedAt: nowTs,
                  })
                }

                try {
                  const salePrice =
                    typeof item.price === 'number'
                      ? item.price
                      : typeof item.rawPrice === 'number'
                        ? item.rawPrice
                        : 0
                  let buyerName = null
                  try {
                    const fullDeal = await withRetry(
                      () => requestDealById(token, userAgent, dealId),
                      { label: 'dealById(buyerName)', retries: 2, shouldRetry: isPlayerokRateLimitError }
                    )
                    buyerName = (fullDeal && fullDeal.user && fullDeal.user.username) || null
                  } catch (_) {
                    buyerName = null
                  }
                  insertSale.run(
                    tokenHash,
                    productKey,
                    title || 'Товар',
                    dealTs || nowTs,
                    Number(salePrice) || 0,
                    dealStatus || null,
                    dealId || null,
                    dealItemId || null,
                    buyerName,
                    String(dealStatus || '') === 'ROLLED_BACK' ? 1 : 0
                  )
                } catch (e) {
                  // ignore sale record failure
                }

                // Настройки: по productKey; если есть settingsLabel — берём из группы __group__::метка
                let effectiveSettings = null
                let effectiveKey = String(productKey)
                try {
                  const row = getSettings.get(hashToken(token), effectiveKey)
                  if (row?.settings) {
                    effectiveSettings = JSON.parse(row.settings)
                    const label = (effectiveSettings && typeof effectiveSettings.settingsLabel === 'string')
                      ? effectiveSettings.settingsLabel.trim()
                      : ''
                    if (label) {
                      const gk = getGroupSettingsKey(label)
                      const groupRow = getSettings.get(hashToken(token), gk)
                      if (groupRow?.settings) {
                        effectiveSettings = JSON.parse(groupRow.settings)
                        effectiveKey = gk
                      }
                    }
                  }
                } catch (_) {
                  // ignore
                }

                const s = effectiveSettings
                if (s) {
                  // Автосообщение
                  const am = s.automessage
                  if (am?.enabled && lastChat?.id) {
                    const raw = am.messages
                    const messages = Array.isArray(raw)
                      ? raw.map((m) => String(m).trim()).filter(Boolean)
                      : typeof raw === 'string' && raw.trim()
                        ? raw.split('\n').map((line) => line.trim()).filter(Boolean)
                        : []
                    for (let i = 0; i < messages.length; i++) {
                      try {
                        await withRetry(
                          () => createChatMessage(token, userAgent, lastChat.id, messages[i]),
                          { label: 'createChatMessage(automessage)', retries: 3, shouldRetry: isPlayerokRateLimitError }
                        )
                        if (i < messages.length - 1) {
                          await sleep(900)
                        }
                      } catch (_) {
                        // ignore single message failure
                      }
                    }
                  }

                  // Автовыдача
                  if (s.autodelivery?.enabled && lastChat?.id) {
                    const messageOnPurchase = (s.autodelivery.messageOnPurchase && String(s.autodelivery.messageOnPurchase).trim()) || ''
                    if (messageOnPurchase) {
                      try {
                        await withRetry(
                          () => createChatMessage(token, userAgent, lastChat.id, messageOnPurchase),
                          { label: 'createChatMessage(messageOnPurchase)', retries: 3, shouldRetry: isPlayerokRateLimitError }
                        )
                      } catch (err) {
                        console.warn('[autolist-tick] autodelivery messageOnPurchase failed', { error: err?.message })
                      }
                    }
                    if (Array.isArray(s.autodelivery.codes) && s.autodelivery.codes.length > 0) {
                      const codeToSend = String(s.autodelivery.codes[0]).trim()
                      if (codeToSend) {
                        try {
                          await withRetry(
                            () => createChatMessage(token, userAgent, lastChat.id, codeToSend),
                            { label: 'createChatMessage(code)', retries: 3, shouldRetry: isPlayerokRateLimitError }
                          )
                          const newCodes = s.autodelivery.codes.slice(1)
                          const updated = {
                            ...s,
                            autodelivery: { ...s.autodelivery, codes: newCodes },
                          }
                          const updatedAt = Math.floor(Date.now() / 1000)
                          upsertSettings.run(hashToken(token), effectiveKey, JSON.stringify(updated), updatedAt)
                        } catch (err) {
                          console.warn('[autolist-tick] autodelivery send code failed', { productKey: effectiveKey, error: err?.message })
                        }
                      }
                    }
                  }
                }
              }

              lastChatMeta.lastPaidTs = dealTs || nowTs

              return sendJson(res, 200, {
                ok: true,
                from: 'paid_chat',
                periodic: periodicResult,
                chatId: currentLastChatId,
              })
            }
          }
        }

        // обновляем сохранённый последний чат, даже если не было fresh paid
        lastChatMeta.lastChatId = currentLastChatId || lastChatMeta.lastChatId

        if (periodicResult && periodicResult.action === 'relisted') {
          return sendJson(res, 200, {
            ok: true,
            from: 'periodic',
            ...periodicResult,
          })
        }

        if (!currentLastChatId) {
          return sendJson(res, 200, { ok: true, skipped: 'no_chats' })
        }

        return sendJson(res, 200, {
          ok: true,
          skipped: 'no_fresh_paid_or_relist',
          periodic: periodicResult,
          chatId: currentLastChatId,
        })
      } catch (err) {
        try {
          if (dealItemId) {
            autolistSetItemState(tokenHash, dealItemId, {
              status: 'error',
              error: err && err.message ? String(err.message) : String(err),
              updatedAt: nowTs,
            })
          }
        } catch (_) { }
        return sendJson(res, 500, { error: err && err.message ? String(err.message) : 'autolist failed' })
      }
    })
    return
  }

  if (req.method === 'POST' && pathname === '/api/playerok/relist-item') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', async () => {
      let payload
      try {
        payload = body ? JSON.parse(body) : {}
      } catch {
        return sendJson(res, 400, { error: 'Invalid JSON body' })
      }
      const { token } = getTokenFromBodyOrStored(payload)
      const itemId = payload.itemId
      const priorityStatusId = payload.priorityStatusId || null
      const userAgent = payload.userAgent

      if (!token || !itemId) {
        return sendJson(res, 400, { error: 'token and itemId are required' })
      }
      try {
        const item = await publishItem(token, userAgent, itemId, {
          priorityStatusId: priorityStatusId || undefined,
        })
        return sendJson(res, 200, { ok: true, itemId: item.id })
      } catch (err) {
        return sendJson(res, 500, {
          error: err && err.message ? String(err.message) : 'Failed to relist item',
        })
      }
    })
    return
  }

  if (req.method === 'POST' && pathname === '/api/playerok/item-priority-statuses') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', async () => {
      let payload
      try {
        payload = body ? JSON.parse(body) : {}
      } catch {
        return sendJson(res, 400, { error: 'Invalid JSON body' })
      }
      const { token } = getTokenFromBodyOrStored(payload)
      const itemId = payload.itemId
      const price = payload.price
      const userAgent = payload.userAgent

      if (!token || !itemId) {
        return sendJson(res, 400, { error: 'token and itemId are required' })
      }

      try {
        const list = await fetchItemPriorityStatuses(token, userAgent, itemId, price)
        const mapped = (Array.isArray(list) ? list : []).map((s) => ({
          id: s?.id ?? null,
          name: s?.name ?? '',
          type: s?.type ?? null,
          period: s?.period ?? null,
          price: typeof s?.price === 'number' ? s.price : null,
          priceRange: s?.priceRange
            ? { min: s.priceRange.min ?? null, max: s.priceRange.max ?? null }
            : null,
        }))
        return sendJson(res, 200, { list: mapped })
      } catch (err) {
        return sendJson(res, 500, { error: err && err.message ? String(err.message) : 'Failed to load priority statuses' })
      }
    })
    return
  }

  if (req.method === 'POST' && pathname === '/api/playerok/completed-lots') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1e6) {
        req.connection.destroy()
      }
    })

    req.on('end', async () => {
      let payload
      try {
        payload = body ? JSON.parse(body) : {}
      } catch (err) {
        return sendJson(res, 400, { error: 'Invalid JSON body' })
      }

      const { token } = getTokenFromBodyOrStored(payload)
      const userAgent = payload.userAgent

      if (!token) {
        return sendJson(res, 400, { error: 'Token is required' })
      }

      try {
        const result = await fetchCompletedItemsFromPlayerok(token, userAgent)
        try {
          const tokenHash = hashToken(token)
          autolistPruneItemStateMap(tokenHash, nowTs)
          if (Array.isArray(result?.items)) {
            result.items = result.items.map((it) => {
              const id = it && it.id != null ? String(it.id) : null
              if (!id) return it
              const st = autolistGetItemState(tokenHash, id)
              if (!st) return it
              return { ...it, autolistRuntime: st }
            })
          }
        } catch (_) { }
        return sendJson(res, 200, result)
      } catch (err) {
        const message = err && err.message ? String(err.message) : 'Не удалось загрузить завершённые лоты с Playerok'
        return sendJson(res, 500, { error: message })
      }
    })

    return
  }

  if (req.method === 'POST' && pathname === '/api/playerok/in-progress-deals') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1e6) {
        req.connection.destroy()
      }
    })
    req.on('end', async () => {
      let payload
      try {
        payload = body ? JSON.parse(body) : {}
      } catch (err) {
        return sendJson(res, 400, { error: 'Invalid JSON body' })
      }
      const { token } = getTokenFromBodyOrStored(payload)
      const userAgent = payload.userAgent
      if (!token) {
        return sendJson(res, 400, { error: 'Token is required' })
      }
      try {
        const [{ deals }, { items: activeItems }, { items: completedItems }] = await Promise.all([
          fetchInProgressDealsFromPlayerok(token, userAgent),
          fetchActiveItemsFromPlayerok(token, userAgent),
          fetchCompletedItemsFromPlayerok(token, userAgent),
        ])
        // В API сделок у item часто нет game; стараемся восстановить категорию максимально надёжно.
        // 1) маппим по itemId (если совпадает id товара);
        // 2) дополнительно маппим по названию товара (productTitle);
        const itemIdToGame = new Map()
        const titleToGame = new Map()
        for (const it of [...activeItems, ...completedItems]) {
          const id = it.id != null ? String(it.id) : null
          const game = (it.game || '').trim()
          const title = (it.title || '').trim()
          if (id && game) {
            if (!itemIdToGame.has(id)) itemIdToGame.set(id, game)
          }
          if (title && game) {
            // если одно и то же название в разных играх, останется первое попавшееся
            if (!titleToGame.has(title)) titleToGame.set(title, game)
          }
        }
        const list = await Promise.all(deals.map(async (d) => {
          let category =
            (d.category && String(d.category).trim()) ||
            (d.itemId ? itemIdToGame.get(String(d.itemId)) : null) ||
            null

          // если по itemId не нашли, пробуем вытащить игру из productKey (формат \"Game::Title\")
          if (!category && d.productKey && typeof d.productKey === 'string') {
            const pk = d.productKey
            const sepIndex = pk.indexOf('::')
            if (sepIndex > 0) {
              const gameFromPk = pk.slice(0, sepIndex).trim()
              if (gameFromPk) category = gameFromPk
            }
          }

          // если всё ещё пусто — пробуем по названию товара, как на вкладке Активные
          if (!category && d.productTitle) {
            const byTitle = titleToGame.get(String(d.productTitle).trim())
            if (byTitle) category = byTitle
          }

          return {
            id: d.id,
            itemId: d.itemId || null,
            status: d.status || null,
            productKey: d.productKey,
            productTitle: d.productTitle,
            category: category || '',
            soldAt: d.soldAt || 0,
            price: Number(d.price) || 0,
            buyerName: d.buyerName || null,
            // Почту Supercell ID подтягиваем при запросе чата (/deal-chat-messages),
            // чтобы не делать по /in-progress-deals N дополнительных запросов deal-by-id и не ловить rate limit.
            buyerSupercellEmail: null,
            chatId: d.chatId || null,
          }
        }))
        return sendJson(res, 200, { list })
      } catch (err) {
        const message =
          err && err.message
            ? String(err.message)
            : 'Не удалось загрузить сделки в выполнении с Playerok'
        return sendJson(res, 500, { error: message })
      }
    })
    return
  }

  if (req.method === 'POST' && pathname === '/api/playerok/completed-deals') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1e6) {
        req.connection.destroy()
      }
    })
    req.on('end', async () => {
      let payload
      try {
        payload = body ? JSON.parse(body) : {}
      } catch (err) {
        return sendJson(res, 400, { error: 'Invalid JSON body' })
      }
      const { token } = getTokenFromBodyOrStored(payload)
      const userAgent = payload.userAgent
      if (!token) {
        return sendJson(res, 400, { error: 'Token is required' })
      }
      try {
        const [{ deals }, { items: activeItems }, { items: completedItems }] = await Promise.all([
          fetchCompletedDealsFromPlayerok(token, userAgent),
          fetchActiveItemsFromPlayerok(token, userAgent),
          fetchCompletedItemsFromPlayerok(token, userAgent),
        ])
        const itemIdToGame = new Map()
        const titleToGame = new Map()
        for (const it of [...activeItems, ...completedItems]) {
          const id = it.id != null ? String(it.id) : null
          const game = (it.game || '').trim()
          const title = (it.title || '').trim()
          if (id && game) itemIdToGame.set(id, game)
          if (title && game && !titleToGame.has(title)) titleToGame.set(title, game)
        }
        const list = deals.map((d) => {
          let category =
            (d.category && String(d.category).trim()) ||
            (d.itemId ? itemIdToGame.get(String(d.itemId)) : null) ||
            null
          if (!category && d.productKey && typeof d.productKey === 'string') {
            const sepIndex = d.productKey.indexOf('::')
            if (sepIndex > 0) category = d.productKey.slice(0, sepIndex).trim()
          }
          if (!category && d.productTitle) {
            category = titleToGame.get(String(d.productTitle).trim()) || null
          }
          return {
            id: d.id,
            itemId: d.itemId || null,
            status: d.status || null,
            productKey: d.productKey,
            productTitle: d.productTitle,
            category: category || '',
            soldAt: d.soldAt || 0,
            price: Number(d.price) || 0,
            buyerName: d.buyerName || null,
            buyerSupercellEmail: null,
            chatId: d.chatId || null,
          }
        })
        return sendJson(res, 200, { list })
      } catch (err) {
        const message =
          err && err.message
            ? String(err.message)
            : 'Не удалось загрузить завершённые сделки с Playerok'
        return sendJson(res, 500, { error: message })
      }
    })
    return
  }

  if (req.method === 'POST' && pathname === '/api/playerok/deal-chat-messages') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1e6) {
        req.connection.destroy()
      }
    })
    req.on('end', async () => {
      let payload
      try {
        payload = body ? JSON.parse(body) : {}
      } catch (err) {
        return sendJson(res, 400, { error: 'Invalid JSON body' })
      }
      const { token } = getTokenFromBodyOrStored(payload)
      const userAgent = payload.userAgent
      const dealId = payload.dealId || null
      const chatId = payload.chatId || null
      if (!token || (!dealId && !chatId)) {
        return sendJson(res, 400, { error: 'token and (dealId or chatId) are required' })
      }
      try {
        const { messages, buyerSupercellEmail, itemTitle, itemImageUrl } = await fetchDealChatMessagesFromPlayerok(
          token,
          userAgent,
          dealId,
          chatId
        )
        return sendJson(res, 200, { list: messages, buyerSupercellEmail, itemTitle, itemImageUrl })
      } catch (err) {
        const message =
          err && err.message
            ? String(err.message)
            : 'Не удалось загрузить сообщения чата с Playerok'
        return sendJson(res, 500, { error: message })
      }
    })
    return
  }

  if (req.method === 'POST' && pathname === '/api/playerok/send-chat-message') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1e6) {
        req.connection.destroy()
      }
    })
    req.on('end', async () => {
      let payload
      try {
        payload = body ? JSON.parse(body) : {}
      } catch (err) {
        return sendJson(res, 400, { error: 'Invalid JSON body' })
      }
      const { token } = getTokenFromBodyOrStored(payload)
      const userAgent = payload.userAgent
      const dealId = payload.dealId || null
      const chatId = payload.chatId || null
      const text = payload.text
      if (!token) {
        return sendJson(res, 400, { error: 'token is required' })
      }
      if (!dealId && !chatId) {
        return sendJson(res, 400, { error: 'dealId or chatId is required' })
      }
      try {
        const message = await sendChatMessageToPlayerok(
          token,
          userAgent,
          dealId,
          chatId,
          text
        )
        return sendJson(res, 200, { ok: true, message })
      } catch (err) {
        const message =
          err && err.message
            ? String(err.message)
            : 'Не удалось отправить сообщение в чат Playerok'
        return sendJson(res, 500, { error: message })
      }
    })
    return
  }

  if (req.method === 'POST' && pathname === '/api/playerok/cancel-deal') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1e6) req.connection.destroy()
    })
    req.on('end', async () => {
      let payload
      try {
        payload = body ? JSON.parse(body) : {}
      } catch (err) {
        return sendJson(res, 400, { error: 'Invalid JSON body' })
      }
      const { token } = getTokenFromBodyOrStored(payload)
      const userAgent = payload.userAgent
      const dealId = payload.dealId || payload.id || null
      if (!token || !dealId) {
        return sendJson(res, 400, { error: 'token and dealId are required' })
      }
      try {
        const deal = await updateDealStatus(token, userAgent, dealId, 'ROLLED_BACK')
        return sendJson(res, 200, { ok: true, deal })
      } catch (err) {
        return sendJson(res, 500, {
          error: err && err.message ? String(err.message) : 'Не удалось отменить сделку на Playerok',
        })
      }
    })
    return
  }

  if (req.method === 'POST' && pathname === '/api/playerok/confirm-deal') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1e6) req.connection.destroy()
    })
    req.on('end', async () => {
      let payload
      try {
        payload = body ? JSON.parse(body) : {}
      } catch (err) {
        return sendJson(res, 400, { error: 'Invalid JSON body' })
      }
      const { token } = getTokenFromBodyOrStored(payload)
      const userAgent = payload.userAgent
      const dealId = payload.dealId || payload.id || null
      if (!token || !dealId) {
        return sendJson(res, 400, { error: 'token and dealId are required' })
      }
      try {
        const deal = await updateDealStatus(token, userAgent, dealId, 'SENT')
        return sendJson(res, 200, { ok: true, deal })
      } catch (err) {
        return sendJson(res, 500, {
          error: err && err.message ? String(err.message) : 'Не удалось подтвердить выполнение сделки на Playerok',
        })
      }
    })
    return
  }

  // Раздача фронтенда (статика из frontend/dist)
  if (req.method === 'GET' && !pathname.startsWith('/api/')) {
    const safePath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '').replace(/\.\./g, '')
    const filePath = path.join(FRONTEND_DIST, safePath)
    if (fs.existsSync(FRONTEND_DIST) && fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath)
      if (stat.isFile()) {
        const ext = path.extname(filePath)
        const types = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.ico': 'image/x-icon',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.svg': 'image/svg+xml',
          '.woff': 'font/woff',
          '.woff2': 'font/woff2',
        }
        res.setHeader('Content-Type', types[ext] || 'application/octet-stream')
        res.statusCode = 200
        return res.end(fs.readFileSync(filePath))
      }
    }
    // SPA: неизвестный путь — отдаём index.html (клиентский роутинг)
    const indexHtml = path.join(FRONTEND_DIST, 'index.html')
    if (fs.existsSync(indexHtml)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.statusCode = 200
      return res.end(fs.readFileSync(indexHtml))
    }
  }

  sendJson(res, 404, { error: 'Not found' })
})

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`)

  const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'

  function postLocal(pathname, body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body)
      const req = http.request({
        hostname: '127.0.0.1',
        port: PORT,
        path: pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      }, (res) => {
        let chunks = ''
        res.on('data', (c) => { chunks += c })
        res.on('end', () => {
          try {
            const json = chunks ? JSON.parse(chunks) : {}
            if (res.statusCode >= 400) resolve({ ok: false, error: json.error || res.statusCode })
            else resolve(json)
          } catch {
            resolve({ ok: false, error: 'parse error' })
          }
        })
      })
      req.on('error', reject)
      req.write(data)
      req.end()
    })
  }

  // Автовыставление: периодически вызываем autolist-tick (по сохранённому токену).
  // Важно: не допускаем наложения вызовов, иначе легко ловим rate limit Playerok.
  let autolistInFlight = false
  console.log('[autolist] background task scheduled (interval: 15s)')
  setInterval(async () => {
    if (autolistInFlight) return
    try {
      const row = getStoredToken.get()
      if (!row || !row.token) return
      autolistInFlight = true
      const stored = loadStoredTokenPlain()
      await postLocal('/api/playerok/autolist-tick', { token: stored.token, userAgent: PLAYEROK_USER_AGENT || DEFAULT_USER_AGENT })
    } catch (_) { /* ignore */ }
    finally {
      autolistInFlight = false
    }
  }, 15000)

  // Автоподнятие: раз в 15 сек проверяем для каждого товара «пора ли поднять» по его расписанию.
  // Отдельный таймер на каждый товар не делаем — один общий цикл проще и надёжнее при перезапуске процесса.
  const autobumpLastAttemptByKey = {}
  console.log('[autobump] background task scheduled (interval: 15s)')
  setInterval(async () => {
    try {
      const row = getStoredToken.get()
      if (!row || !row.token) return
      const token = row.token
      const userAgent = DEFAULT_USER_AGENT
      const tokenHash = hashToken(token)

      const [settingsRows, bumpRows, salesRows, activeResult] = await Promise.all([
        Promise.resolve(getAllSettings.all(tokenHash)),
        Promise.resolve(getBumpHistory.all(tokenHash)),
        Promise.resolve(getSalesHistory.all(tokenHash)),
        fetchActiveItemsFromPlayerok(token, userAgent),
      ])

      const settingsByKey = {}
      for (const r of settingsRows || []) {
        if (r.product_key && r.settings) {
          try {
            settingsByKey[r.product_key] = JSON.parse(r.settings)
          } catch (_) { }
        }
      }
      const lastBumpByKey = {}
      for (const r of bumpRows || []) {
        const k = r.product_key || r.product_title
        if (!k) continue
        const t = r.bumped_at || 0
        if (!lastBumpByKey[k] || t > lastBumpByKey[k]) lastBumpByKey[k] = t
      }
      // Последняя продажа по товару (без возвратов): сбрасывает «интервал» — следующее поднятие = sold_at + interval.
      const lastSaleByKey = {}
      for (const r of salesRows || []) {
        if (r.is_refund) continue
        const k = r.product_key || r.product_title
        if (!k) continue
        const t = r.sold_at || 0
        if (!lastSaleByKey[k] || t > lastSaleByKey[k]) lastSaleByKey[k] = t
      }
      const items = activeResult.items || []
      const activeLotByKey = {}
      for (const lot of items) {
        const st = String(lot?.status || '').toUpperCase()
        if (st && st !== 'APPROVED' && st !== 'ACTIVE' && st !== 'PUBLISHED') continue
        const key = buildProductKey(lot.game || '', lot.title || '')
        if (!activeLotByKey[key]) activeLotByKey[key] = lot
      }

      // Вся логика автоподнятия работает в часовом поясе МСК (Europe/Moscow),
      // независимо от локального часового пояса сервера.
      const MSK_OFFSET_MINUTES = 3 * 60
      const MSK_OFFSET_MS = MSK_OFFSET_MINUTES * 60 * 1000
      const nowUtcMs = Date.now()
      const nowMsk = new Date(nowUtcMs + MSK_OFFSET_MS)
      const nowMins = nowMsk.getUTCHours() * 60 + nowMsk.getUTCMinutes()
      const nowTs = Math.floor(nowUtcMs / 1000)
      const mskStartOfDayUtcMs = Date.UTC(
        nowMsk.getUTCFullYear(),
        nowMsk.getUTCMonth(),
        nowMsk.getUTCDate()
      ) - MSK_OFFSET_MS
      const startOfDayTs = Math.floor(mskStartOfDayUtcMs / 1000)

      for (const [key, s] of Object.entries(settingsByKey)) {
        if (String(key).startsWith('__group__::')) continue
        if (!s?.autobump?.enabled || !Array.isArray(s.autobump.schedule) || s.autobump.schedule.length === 0) continue
        const lot = activeLotByKey[key]
        if (!lot) continue

        const schedule = s.autobump.schedule || []
        const windowsContainingNow = schedule
          .map((win) => {
            const startParts = (win.start || '00:00').toString().split(':')
            const endParts = (win.end || '23:59').toString().split(':')
            const startMins = parseInt(startParts[0], 10) * 60 + parseInt(startParts[1], 10) || 0
            const endMins = parseInt(endParts[0], 10) * 60 + parseInt(endParts[1], 10) || 0
            const inWindow = startMins <= endMins
              ? (nowMins >= startMins && nowMins < endMins)
              : (nowMins >= startMins || nowMins < endMins)
            return inWindow ? { win, startMins, endMins } : null
          })
          .filter(Boolean)
        const byPriority = windowsContainingNow.sort(
          (a, b) => (Number(a.win.priority) ?? 1) - (Number(b.win.priority) ?? 1)
        )
        const active = byPriority[0]
        if (!active) continue

        const { win } = active
        const startMins = active.startMins
        const endMins = active.endMins
        const intervalSec = (win.intervalMinutes || 3) * 60
        let windowStartTs = startOfDayTs + startMins * 60
        let windowEndTs = startOfDayTs + endMins * 60
        if (endMins <= startMins) windowEndTs += 24 * 3600

        const lastBump = lastBumpByKey[key] || 0
        const lastSale = lastSaleByKey[key] || 0
        const enabledAt = Number(s?.autobump?.enabledAt || 0)
        let baseTs = Math.max(lastBump, lastSale, enabledAt)

        if (!lastBump && !lastSale && !enabledAt) {
          // Новый товар без истории и без явного enabledAt:
          // - если сейчас внутри окна, считаем первое поднятие от «сейчас» + интервал
          // - если сейчас вне окна, просто используем логику «от начала окна»
          if (nowTs >= windowStartTs && nowTs <= windowEndTs) {
            const candidateNext = nowTs + intervalSec
            if (candidateNext > windowEndTs) continue
            baseTs = nowTs
          } else {
            if (baseTs < windowStartTs) baseTs = windowStartTs
          }
        } else {
          if (baseTs < windowStartTs) baseTs = windowStartTs
        }

        const nextBumpTs = baseTs + intervalSec

        if (nextBumpTs > windowEndTs) continue
        if (nowTs < nextBumpTs) continue

        const lastAttempt = autobumpLastAttemptByKey[key] || 0
        if (nowTs - lastAttempt < 60) continue
        autobumpLastAttemptByKey[key] = nowTs

        const res = await postLocal('/api/playerok/bump', {
          token,
          userAgent,
          productKey: key,
          productTitle: lot.title || 'Товар',
          itemId: lot.id,
          price: Number(lot.price) || 0,
          priorityStatusId: s?.autobump?.priorityStatusId || null,
        })
        if (res.ok && res.bumpedAt) lastBumpByKey[key] = res.bumpedAt
      }
    } catch (_) { /* ignore */ }
  }, 15000)
})

