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
const { execFile, spawnSync } = require('child_process')

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

// Кэш для лотов: уменьшает количество запросов к Playerok API и предотвращает rate limit
const LOTS_CACHE_TTL_MS = 2 * 60 * 1000 // 2 минуты
const lotsCache = new Map() // token -> { active: { data, expiresAt }, completed: { data, expiresAt } }

// Периодическая очистка устаревших записей из кэша
setInterval(() => {
  const now = Date.now()
  let cleaned = 0
  for (const [token, cache] of lotsCache.entries()) {
    if (cache.active && now >= cache.active.expiresAt) {
      delete cache.active
    }
    if (cache.completed && now >= cache.completed.expiresAt) {
      delete cache.completed
    }
    // Удаляем запись, если оба кэша пусты
    if (!cache.active && !cache.completed) {
      lotsCache.delete(token)
      cleaned++
    }
  }
  if (cleaned > 0) {
    console.log('[cache] очищены устаревшие записи кэша', { cleaned, remaining: lotsCache.size })
  }
}, 60 * 1000) // Проверяем каждую минуту

// Система хранения логов в памяти
const LOGS_BUFFER_SIZE = 10000 // Максимальное количество записей
const logsBuffer = []
const originalConsoleLog = console.log
const originalConsoleWarn = console.warn
const originalConsoleError = console.error

function addLogToBuffer(level, args) {
  const timestamp = new Date().toISOString()
  
  // Определяем тег из первого аргумента, если он есть
  let tag = level
  let messageParts = []
  let rawObject = null
  
  if (args.length > 0) {
    // Если первый аргумент - строка с тегом [tag]
    if (typeof args[0] === 'string' && args[0].startsWith('[') && args[0].includes(']')) {
      const match = args[0].match(/^\[([^\]]+)\]/)
      if (match) {
        tag = match[1]
        const restOfFirstArg = args[0].substring(match[0].length).trim()
        if (restOfFirstArg) {
          messageParts.push(restOfFirstArg)
        }
      } else {
        messageParts.push(args[0])
      }
    } else {
      messageParts.push(String(args[0]))
    }
    
    // Обрабатываем остальные аргументы
    for (let i = 1; i < args.length; i++) {
      const arg = args[i]
      if (typeof arg === 'object' && arg !== null) {
        // Если это объект, сохраняем его как raw для красивого форматирования
        if (rawObject === null) {
          rawObject = arg
        } else {
          // Если уже есть raw объект, объединяем их
          try {
            messageParts.push(JSON.stringify(arg, null, 2))
          } catch {
            messageParts.push(String(arg))
          }
        }
      } else {
        messageParts.push(String(arg))
      }
    }
  }
  
  // Формируем финальное сообщение
  let message = messageParts.join(' ')
  if (rawObject !== null && messageParts.length === 0) {
    // Если только объект без текста, форматируем его
    try {
      message = JSON.stringify(rawObject, null, 2)
    } catch {
      message = String(rawObject)
    }
  } else if (rawObject !== null) {
    // Если есть и текст, и объект, добавляем объект в конец
    try {
      message += '\n' + JSON.stringify(rawObject, null, 2)
    } catch {
      message += ' ' + String(rawObject)
    }
  }
  
  const logEntry = {
    timestamp,
    level,
    tag,
    message,
    raw: rawObject
  }
  
  logsBuffer.push(logEntry)
  
  // Ограничиваем размер буфера
  if (logsBuffer.length > LOGS_BUFFER_SIZE) {
    logsBuffer.shift()
  }
}

// Перехватываем console.log, console.warn, console.error
console.log = function(...args) {
  addLogToBuffer('info', args)
  originalConsoleLog.apply(console, args)
}

console.warn = function(...args) {
  addLogToBuffer('warn', args)
  originalConsoleWarn.apply(console, args)
}

console.error = function(...args) {
  addLogToBuffer('error', args)
  originalConsoleError.apply(console, args)
}

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
      console.warn(`[retry] ${label} не удалось, повтор`, { attempt: attempt + 1, delayMs: delay, error: err?.message })
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
const SUPERCELL_PLUGIN_DIR = path.join(__dirname, '..', 'supercell_auto_otp_plugin')
const SUPERCELL_BRIDGE_SCRIPT = path.join(SUPERCELL_PLUGIN_DIR, 'bridge_request_code.py')
const SUPERCELL_REQUEST_TIMEOUT_MS = Number(process.env.SUPERCELL_REQUEST_TIMEOUT_MS) || 45000
const SUPERCELL_CODE_MESSAGE_TEMPLATE =
  'Запросил код на вашу почту для $game_name, скиньте его пожалуйста сюда в чат, как придет'
const SUPERCELL_EMAIL_CANDIDATE_REGEX =
  /([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[^\s<>"'`]+)/i
const SUPERCELL_CATEGORY_TO_GAME = new Map([
  ['brawl stars', { gameKey: 'laser', gameName: 'Brawl Stars' }],
  ['brawlstars', { gameKey: 'laser', gameName: 'Brawl Stars' }],
  ['бравл старс', { gameKey: 'laser', gameName: 'Brawl Stars' }],
  ['бравл старк', { gameKey: 'laser', gameName: 'Brawl Stars' }],
  ['clash royale', { gameKey: 'scroll', gameName: 'Clash Royale' }],
  ['clashroyale', { gameKey: 'scroll', gameName: 'Clash Royale' }],
  ['клеш рояль', { gameKey: 'scroll', gameName: 'Clash Royale' }],
  ['clash of clans', { gameKey: 'magic', gameName: 'Clash of Clans' }],
  ['clashofclans', { gameKey: 'magic', gameName: 'Clash of Clans' }],
  ['клеш оф кланс', { gameKey: 'magic', gameName: 'Clash of Clans' }],
  ['клеш оф кленс', { gameKey: 'magic', gameName: 'Clash of Clans' }],
])
let cachedSupercellPython = null

function normalizeCategoryName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

function getSupercellGameByCategory(category) {
  return SUPERCELL_CATEGORY_TO_GAME.get(normalizeCategoryName(category)) || null
}

function formatSupercellCodeRequestedMessage(gameName) {
  return SUPERCELL_CODE_MESSAGE_TEMPLATE.replace('$game_name', gameName || 'игры')
}

function normalizeComparableUsername(value) {
  return String(value || '').trim().toLowerCase()
}

function isEmailValid(email) {
  const value = String(email || '').trim()
  if (!value) return false
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function extractEmailFromText(text) {
  const value = String(text || '').trim()
  if (!value) return null
  const match = value.match(SUPERCELL_EMAIL_CANDIDATE_REGEX)
  if (!match || !match[1]) return null
  return String(match[1])
    .trim()
    .replace(/^[<("'`\[{]+/, '')
    .replace(/[>"')`\]},!?;:]+$/, '')
}

function extractSupercellEmailFromFields(fields) {
  const list = Array.isArray(fields) ? fields : []
  for (const f of list) {
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
      return String(value).trim()
    }
  }
  return null
}

function getLatestBuyerEmailFromMessages(messages, viewerUsername) {
  const normalizedViewer = normalizeComparableUsername(viewerUsername)
  const list = Array.isArray(messages)
    ? [...messages].sort((a, b) => {
        const ta = a?.createdAt ? new Date(a.createdAt).getTime() : 0
        const tb = b?.createdAt ? new Date(b.createdAt).getTime() : 0
        return ta - tb
      })
    : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const msg = list[i]
    const username = normalizeComparableUsername(msg?.user?.username || msg?.user?.name || '')
    if (normalizedViewer && username && username === normalizedViewer) continue
    const extracted = extractEmailFromText(msg?.text || '')
    if (extracted) {
      return extracted
    }
  }
  return null
}

function hasSupercellCodeRequestedMessage(messages, viewerUsername, gameName) {
  const expectedText = formatSupercellCodeRequestedMessage(gameName)
  const normalizedViewer = normalizeComparableUsername(viewerUsername)
  const list = Array.isArray(messages) ? messages : []
  return list.some((msg) => {
    const text = String(msg?.text || '').trim()
    if (text !== expectedText) return false
    const username = normalizeComparableUsername(msg?.user?.username || msg?.user?.name || '')
    if (!normalizedViewer) return true
    return !username || username === normalizedViewer
  })
}

function resolveEffectiveProductSettings(productKey) {
  const normalizedKey = normalizeProductKey(productKey)
  if (!normalizedKey) {
    return { effectiveSettings: null, effectiveKey: '' }
  }
  let effectiveSettings = null
  let effectiveKey = normalizedKey
  try {
    const row = getSettings.get(normalizedKey)
    if (row?.settings) {
      effectiveSettings = JSON.parse(row.settings)
      const label = (effectiveSettings && typeof effectiveSettings.settingsLabel === 'string')
        ? effectiveSettings.settingsLabel.trim()
        : ''
      if (label) {
        const groupKey = getGroupSettingsKey(label)
        const groupRow = getSettings.get(groupKey)
        if (groupRow?.settings) {
          effectiveSettings = JSON.parse(groupRow.settings)
          effectiveKey = groupKey
        }
      }
    }
  } catch (_) {
    effectiveSettings = null
  }
  return { effectiveSettings, effectiveKey }
}

function resolveSupercellPython() {
  if (cachedSupercellPython) return cachedSupercellPython

  const candidates = []
  const envPython = (process.env.SUPERCELL_PYTHON_BIN || '').trim()
  if (envPython) candidates.push({ command: envPython, args: [] })
  candidates.push(
    { command: 'py', args: ['-3'] },
    { command: 'python', args: [] },
    { command: 'python3', args: [] }
  )

  for (const candidate of candidates) {
    const check = spawnSync(candidate.command, [...candidate.args, '--version'], {
      cwd: SUPERCELL_PLUGIN_DIR,
      windowsHide: true,
      encoding: 'utf8',
    })
    if (check.status === 0) {
      cachedSupercellPython = candidate
      return candidate
    }
  }

  throw new Error(
    'Не найден Python 3 для supercell bridge. Установите Python 3 или задайте SUPERCELL_PYTHON_BIN.'
  )
}

function runSupercellRequestCode({ email, gameKey }) {
  if (!fs.existsSync(SUPERCELL_BRIDGE_SCRIPT)) {
    return Promise.reject(new Error('Файл bridge_request_code.py не найден'))
  }

  const python = resolveSupercellPython()
  const args = [...python.args, SUPERCELL_BRIDGE_SCRIPT, '--email', email, '--game', gameKey]

  return new Promise((resolve, reject) => {
    execFile(
      python.command,
      args,
      {
        cwd: SUPERCELL_PLUGIN_DIR,
        timeout: SUPERCELL_REQUEST_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        let payload = null
        const rawStdout = String(stdout || '').trim()
        if (rawStdout) {
          try {
            payload = JSON.parse(rawStdout)
          } catch (_) {
            payload = null
          }
        }

        if (error) {
          if (error.killed) {
            return reject(new Error('Истек таймаут запроса кода Supercell'))
          }
          if (payload && payload.error) {
            return reject(new Error(String(payload.error)))
          }
          const stderrText = String(stderr || '').trim()
          return reject(new Error(stderrText || error.message || 'Не удалось запустить supercell bridge'))
        }

        if (!payload || typeof payload !== 'object') {
          return reject(new Error('Supercell bridge вернул некорректный ответ'))
        }
        if (!payload.ok) {
          return reject(new Error(payload.error || 'Supercell bridge не смог запросить код'))
        }
        return resolve(payload)
      }
    )
  })
}

async function requestSupercellCodeForChat({
  token,
  userAgent,
  dealId,
  chatId,
  email,
  category,
}) {
  const trimmedEmail = String(email || '').trim()
  const trimmedCategory = String(category || '').trim()
  if (!token) throw new Error('token is required')
  if (!dealId && !chatId) throw new Error('dealId or chatId is required')
  if (!trimmedEmail) throw new Error('email is required')
  const game = getSupercellGameByCategory(trimmedCategory)
  if (!game) {
    throw new Error('Категория не поддерживает запрос кода Supercell')
  }
  const supercell = await runSupercellRequestCode({
    email: trimmedEmail,
    gameKey: game.gameKey,
  })
  const chatMessage = formatSupercellCodeRequestedMessage(game.gameName)
  const message = await sendChatMessageToPlayerok(
    token,
    userAgent,
    dealId,
    chatId,
    chatMessage
  )
  return {
    ok: true,
    gameKey: game.gameKey,
    gameName: game.gameName,
    email: trimmedEmail,
    chatMessage: message?.text || chatMessage,
    message,
    supercell,
  }
}

const Database = require('better-sqlite3')
const DATA_DIR = path.join(__dirname, 'data')
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
const DB_PATH = path.join(DATA_DIR, 'product-settings.db')
const db = new Database(DB_PATH)
db.exec(`
  CREATE TABLE IF NOT EXISTS product_settings (
    product_key TEXT NOT NULL PRIMARY KEY,
    settings TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )
`)
db.exec(`
  CREATE TABLE IF NOT EXISTS tokens (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    token TEXT NOT NULL,
    token_enc TEXT,
    updated_at INTEGER NOT NULL
  )
`)
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
    product_key TEXT NOT NULL,
    product_title TEXT NOT NULL,
    bumped_at INTEGER NOT NULL,
    price REAL NOT NULL DEFAULT 0,
    item_id TEXT
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_bump_history_bumped_at ON bump_history(bumped_at DESC)`)

db.exec(`
  CREATE TABLE IF NOT EXISTS sales_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_key TEXT NOT NULL,
    product_title TEXT NOT NULL,
    sold_at INTEGER NOT NULL,
    price REAL NOT NULL DEFAULT 0,
    status TEXT,
    deal_id TEXT,
    item_id TEXT,
    buyer_name TEXT,
    is_refund INTEGER DEFAULT 0,
    UNIQUE(deal_id)
  )
`)
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
    product_key TEXT NOT NULL,
    fee REAL NOT NULL DEFAULT 0,
    relisted_at INTEGER NOT NULL
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_listing_fees_product ON listing_fees(product_key, relisted_at)`)

// Миграция: удаляем token_hash из всех таблиц — токен хранится только в tokens. Должна выполниться ДО определения prepared statements.
function migrateRemoveTokenHash() {
  try {
    const psCols = db.prepare('PRAGMA table_info(product_settings)').all()
    const bhCols = db.prepare('PRAGMA table_info(bump_history)').all()
    const needProductSettings = psCols.some((c) => c.name === 'token_hash')
    const needOthers = bhCols.some((c) => c.name === 'token_hash')
    if (!needProductSettings && !needOthers) return
    if (needProductSettings) {
      db.exec(`CREATE TABLE product_settings_new (product_key TEXT NOT NULL PRIMARY KEY, settings TEXT NOT NULL, updated_at INTEGER NOT NULL)`)
      db.exec(`INSERT OR REPLACE INTO product_settings_new (product_key, settings, updated_at) SELECT product_key, settings, updated_at FROM product_settings ORDER BY updated_at ASC`)
      db.exec(`DROP TABLE product_settings`)
      db.exec(`ALTER TABLE product_settings_new RENAME TO product_settings`)
    }
    if (needOthers) {
    db.exec(`CREATE TABLE bump_history_new (id INTEGER PRIMARY KEY AUTOINCREMENT, product_key TEXT NOT NULL, product_title TEXT NOT NULL, bumped_at INTEGER NOT NULL, price REAL NOT NULL DEFAULT 0, item_id TEXT)`)
    db.exec(`INSERT INTO bump_history_new (id, product_key, product_title, bumped_at, price, item_id) SELECT id, product_key, product_title, bumped_at, price, item_id FROM bump_history`)
    db.exec(`DROP TABLE bump_history`)
    db.exec(`ALTER TABLE bump_history_new RENAME TO bump_history`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_bump_history_bumped_at ON bump_history(bumped_at DESC)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_bump_history_item ON bump_history(item_id)`)
    const shCols = db.prepare('PRAGMA table_info(sales_history)').all()
    const hasIsRefund = shCols.some((c) => c.name === 'is_refund')
    const hasBuyerName = shCols.some((c) => c.name === 'buyer_name')
    const shColsList = `id, product_key, product_title, sold_at, price, status, deal_id, item_id${hasBuyerName ? ', buyer_name' : ''}${hasIsRefund ? ', is_refund' : ''}`
    db.exec(`CREATE TABLE sales_history_new (id INTEGER PRIMARY KEY AUTOINCREMENT, product_key TEXT NOT NULL, product_title TEXT NOT NULL, sold_at INTEGER NOT NULL, price REAL NOT NULL DEFAULT 0, status TEXT, deal_id TEXT, item_id TEXT, buyer_name TEXT, is_refund INTEGER DEFAULT 0, UNIQUE(deal_id))`)
    db.exec(`INSERT OR REPLACE INTO sales_history_new ${hasIsRefund && hasBuyerName ? `SELECT id, product_key, product_title, sold_at, price, status, deal_id, item_id, buyer_name, is_refund FROM sales_history` : 'SELECT id, product_key, product_title, sold_at, price, status, deal_id, item_id, COALESCE(buyer_name,""), COALESCE(is_refund,0) FROM sales_history'}`)
    db.exec(`DROP TABLE sales_history`)
    db.exec(`ALTER TABLE sales_history_new RENAME TO sales_history`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_history_sold_at ON sales_history(sold_at DESC)`)
    db.exec(`CREATE TABLE listing_fees_new (id INTEGER PRIMARY KEY AUTOINCREMENT, product_key TEXT NOT NULL, fee REAL NOT NULL DEFAULT 0, relisted_at INTEGER NOT NULL)`)
    db.exec(`INSERT INTO listing_fees_new (id, product_key, fee, relisted_at) SELECT id, product_key, fee, relisted_at FROM listing_fees`)
    db.exec(`DROP TABLE listing_fees`)
    db.exec(`ALTER TABLE listing_fees_new RENAME TO listing_fees`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_listing_fees_product ON listing_fees(product_key, relisted_at)`)
    db.exec(`CREATE TABLE hidden_chats_new (chat_id TEXT NOT NULL PRIMARY KEY, hidden_at INTEGER NOT NULL)`)
    db.exec(`INSERT OR REPLACE INTO hidden_chats_new (chat_id, hidden_at) SELECT chat_id, max(hidden_at) FROM hidden_chats GROUP BY chat_id`)
    db.exec(`DROP TABLE hidden_chats`)
    db.exec(`ALTER TABLE hidden_chats_new RENAME TO hidden_chats`)
    const tCols = db.prepare('PRAGMA table_info(tokens)').all()
    if (tCols.some((c) => c.name === 'token_hash')) {
      db.exec(`CREATE TABLE tokens_new (id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL, token_enc TEXT, updated_at INTEGER NOT NULL)`)
      db.exec(`INSERT INTO tokens_new (id, token, token_enc, updated_at) SELECT id, token, token_enc, updated_at FROM tokens`)
      db.exec(`DROP TABLE tokens`)
      db.exec(`ALTER TABLE tokens_new RENAME TO tokens`)
    }
    console.info('[migration] token_hash удалён из всех таблиц')
    }
  } catch (e) {
    console.warn('[migration] удаление token_hash:', e?.message)
  }
}

migrateRemoveTokenHash()

const getStoredToken = db.prepare(`
  SELECT token, token_enc, updated_at FROM tokens WHERE id = 1
`)
const upsertStoredToken = db.prepare(`
  INSERT INTO tokens (id, token, token_enc, updated_at)
  VALUES (1, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    token = excluded.token,
    token_enc = excluded.token_enc,
    updated_at = excluded.updated_at
`)
const deleteStoredToken = db.prepare(`
  DELETE FROM tokens WHERE id = 1
`)

function loadStoredTokenPlain() {
  const row = getStoredToken.get()
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
  const legacy = row.token ? String(row.token) : ''
  if (!legacy) return { token: '', updatedAt }
  try {
    const enc = encryptToken(legacy)
    upsertStoredToken.run(legacy, enc, updatedAt || Math.floor(Date.now() / 1000))
    return { token: legacy, updatedAt }
  } catch {
    return { token: legacy, updatedAt }
  }
}

function getTokenFromBodyOrStored(payload) {
  const raw = payload && Object.prototype.hasOwnProperty.call(payload, 'token') ? payload.token : null
  const provided = raw == null ? '' : String(raw || '').trim()
  if (provided) return { token: provided }
  const stored = loadStoredTokenPlain()
  return { token: stored.token || '' }
}

function getTokenFromQueryOrStored(query) {
  const provided = query && query.token != null ? String(query.token || '').trim() : ''
  if (provided) return { token: provided }
  const stored = loadStoredTokenPlain()
  return { token: stored.token || '' }
}

migrateRemoveTokenHash()

const getSettings = db.prepare(`
  SELECT settings, updated_at FROM product_settings WHERE product_key = ?
`)
const getAllSettings = db.prepare(`
  SELECT product_key, settings FROM product_settings
`)
const upsertSettings = db.prepare(`
  INSERT INTO product_settings (product_key, settings, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT (product_key) DO UPDATE SET
    settings = excluded.settings,
    updated_at = excluded.updated_at
`)
const deleteSettings = db.prepare(`
  DELETE FROM product_settings WHERE product_key = ?
`)

const insertBump = db.prepare(`
  INSERT INTO bump_history (product_key, product_title, bumped_at, price, item_id)
  VALUES (?, ?, ?, ?, ?)
`)
const getBumpHistory = db.prepare(`
  SELECT product_key, product_title, bumped_at, price, item_id FROM bump_history
  ORDER BY bumped_at DESC LIMIT 500
`)

const insertSale = db.prepare(`
  INSERT OR REPLACE INTO sales_history
    (product_key, product_title, sold_at, price, status, deal_id, item_id, buyer_name, is_refund)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`)
const getSalesHistory = db.prepare(`
  SELECT product_key, product_title, sold_at, price, status, is_refund, buyer_name
  FROM sales_history
  ORDER BY sold_at DESC
  LIMIT 500
`)
const getSalesHistoryAll = db.prepare(`
  SELECT product_key, product_title, sold_at, price, status, is_refund, buyer_name
  FROM sales_history
  ORDER BY sold_at DESC
`)
const deleteSalesHistoryByToken = db.prepare(`
  DELETE FROM sales_history
`)

const insertListingFee = db.prepare(`
  INSERT INTO listing_fees (product_key, fee, relisted_at)
  VALUES (?, ?, ?)
`)
const getListingFees = db.prepare(`
  SELECT product_key, fee, relisted_at FROM listing_fees
  ORDER BY relisted_at DESC
`)

db.exec(`
  CREATE TABLE IF NOT EXISTS hidden_chats (
    chat_id TEXT NOT NULL PRIMARY KEY,
    hidden_at INTEGER NOT NULL
  )
`)

function getTokenFromBodyOrStored(payload) {
  const raw = payload && Object.prototype.hasOwnProperty.call(payload, 'token') ? payload.token : null
  const provided = raw == null ? '' : String(raw || '').trim()
  if (provided) return { token: provided }
  const stored = loadStoredTokenPlain()
  return { token: stored.token || '' }
}

function getTokenFromQueryOrStored(query) {
  const provided = query && query.token != null ? String(query.token || '').trim() : ''
  if (provided) return { token: provided }
  const stored = loadStoredTokenPlain()
  return { token: stored.token || '' }
}

const upsertHiddenChat = db.prepare(`
  INSERT INTO hidden_chats (chat_id, hidden_at)
  VALUES (?, ?)
  ON CONFLICT(chat_id) DO UPDATE SET
    hidden_at = excluded.hidden_at
`)
const deleteHiddenChat = db.prepare(`
  DELETE FROM hidden_chats WHERE chat_id = ?
`)
const getHiddenChats = db.prepare(`
  SELECT chat_id FROM hidden_chats
`)

const getSalesYears = db.prepare(`
  SELECT DISTINCT CAST(strftime('%Y', sold_at, 'unixepoch') AS INTEGER) AS year
  FROM sales_history
  WHERE sold_at > 0
  ORDER BY year DESC
`)
const getSalesMonthsForYear = db.prepare(`
  SELECT DISTINCT CAST(strftime('%m', sold_at, 'unixepoch') AS INTEGER) AS month
  FROM sales_history
  WHERE sold_at > 0 AND strftime('%Y', sold_at, 'unixepoch') = ?
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
  const all = db.prepare('SELECT product_key, settings, updated_at FROM product_settings').all()
  const seen = new Set()
  for (const row of all) {
    const key = String(row.product_key || '')
    if (key.startsWith(CATEGORY_SETTINGS_PREFIX) || key.startsWith(GROUP_SETTINGS_PREFIX)) continue
    const normalized = normalizeProductKey(key)
    if (!normalized || normalized === key) continue
    const sig = `::${normalized}`
    if (!seen.has(sig)) {
      upsertSettings.run(normalized, row.settings, row.updated_at)
      seen.add(sig)
    }
    deleteSettings.run(key)
  }
} catch (_) {
  // миграция не критична для работы — ошибки игнорируем
}

// Миграция: удаляем priorityStatusId из всех настроек (autobump и autolist)
// priorityStatusId больше не сохраняется - всегда используется актуальный список статусов
try {
  const all = db.prepare('SELECT product_key, settings, updated_at FROM product_settings').all()
  for (const row of all) {
    try {
      const settings = JSON.parse(row.settings || '{}')
      let updated = false
      
      // Удаляем priorityStatusId из autobump
      if (settings.autobump && typeof settings.autobump === 'object' && 'priorityStatusId' in settings.autobump) {
        const { priorityStatusId, ...autobumpWithoutPriority } = settings.autobump
        settings.autobump = autobumpWithoutPriority
        updated = true
      }
      
      // Удаляем priorityStatusId из autolist
      if (settings.autolist && typeof settings.autolist === 'object' && 'priorityStatusId' in settings.autolist) {
        const { priorityStatusId, ...autolistWithoutPriority } = settings.autolist
        settings.autolist = autolistWithoutPriority
        updated = true
      }
      
      // Сохраняем обновленные настройки, если были изменения
      if (updated) {
        const settingsStr = JSON.stringify(settings)
        const updatedAt = Math.floor(Date.now() / 1000)
        upsertSettings.run(String(row.product_key), settingsStr, updatedAt)
      }
    } catch (err) {
      // Игнорируем ошибки парсинга JSON для отдельных записей
      console.warn('[migration] не удалось удалить priorityStatusId из настроек', {
        productKey: row.product_key,
        error: err?.message,
      })
    }
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

function autolistGetSupercellFlowMap(tokenHash) {
  global.__autolistSupercellFlowByTokenHash = global.__autolistSupercellFlowByTokenHash || {}
  const key = String(tokenHash)
  const map = global.__autolistSupercellFlowByTokenHash[key]
  if (map && typeof map === 'object') return map
  global.__autolistSupercellFlowByTokenHash[key] = {}
  return global.__autolistSupercellFlowByTokenHash[key]
}

function autolistPruneSupercellFlowMap(tokenHash, nowTs) {
  const map = autolistGetSupercellFlowMap(tokenHash)
  for (const [chatId, state] of Object.entries(map)) {
    const updatedAt = Number(state?.updatedAt || state?.createdAt || 0)
    const ageSec = updatedAt ? nowTs - updatedAt : Number.MAX_SAFE_INTEGER
    const maxAgeSec = state?.active ? 24 * 60 * 60 : 60 * 60
    if (ageSec > maxAgeSec) {
      delete map[chatId]
    }
  }
}

/** Обработка одного конкретного Supercell flow чата */
async function processSingleSupercellFlow(chatId, token, userAgent, viewerUsername, nowTs) {
  const tokenHash = token
  const flowMap = autolistGetSupercellFlowMap(tokenHash)
  const state = flowMap[String(chatId)]
  if (!state || !state.active) return false

  const category = String(state.category || '').trim()
  const game = getSupercellGameByCategory(category)
  if (!game) {
    console.warn('[processSingleSupercellFlow] пропуск: категория не Supercell', { chatId, category })
    flowMap[String(chatId)] = {
      ...state,
      active: false,
      updatedAt: nowTs,
    }
    return false
  }

  try {
    const chatData = await fetchDealChatMessagesFromPlayerok(
      token,
      userAgent,
      state.dealId || null,
      chatId,
      { viewerUsername: viewerUsername || null }
    )
    const messages = Array.isArray(chatData?.messages) ? chatData.messages : []
    const alreadyRequested = hasSupercellCodeRequestedMessage(
      messages,
      viewerUsername || null,
      game.gameName
    )
    if (alreadyRequested) {
      flowMap[String(chatId)] = {
        ...state,
        requestCodeRequested: true,
        active: false,
        updatedAt: nowTs,
      }
      return false
    }

    const invalidEmailMessage = String(state.invalidEmailMessage || '').trim()
    // Используем email из чата/сделки; если в chatData нет — берём из state (был сохранён при создании flow из полей сделки)
    const emailFromChat = String(chatData?.buyerSupercellEmail || '').trim() || null
    const nextState = {
      ...state,
      latestEmail: emailFromChat || state.latestEmail || null,
    }
    if (!nextState.invalidMessageSent && invalidEmailMessage) {
      await withRetry(
        () => createChatMessage(token, userAgent, chatId, invalidEmailMessage),
        {
          label: 'createChatMessage(supercell-invalid-email)',
          retries: 3,
          shouldRetry: isPlayerokRateLimitError,
        }
      )
      nextState.invalidMessageSent = true
      nextState.updatedAt = nowTs
      flowMap[String(chatId)] = nextState
    }

    const effectiveEmail = String(nextState.latestEmail || '').trim()
    const emailIsValid = isEmailValid(effectiveEmail)
    if (!emailIsValid) {
      console.warn('[processSingleSupercellFlow] пропуск: нет или неверный email', {
        chatId,
        dealId: state.dealId || null,
        category,
        hasEmailFromChat: Boolean(emailFromChat),
        hasEmailInState: Boolean(state.latestEmail),
      })
      flowMap[String(chatId)] = {
        ...nextState,
        updatedAt: nowTs,
      }
      return false
    }

    await requestSupercellCodeForChat({
      token,
      userAgent,
      dealId: state.dealId || null,
      chatId,
      email: effectiveEmail,
      category,
    })
    flowMap[String(chatId)] = {
      ...nextState,
      latestEmail: effectiveEmail,
      requestCodeRequested: true,
      active: false,
      updatedAt: nowTs,
    }
    return true
  } catch (err) {
    console.warn('[processSingleSupercellFlow] ошибка', {
      chatId,
      dealId: state.dealId || null,
      category,
      error: err?.message || String(err),
    })
    return false
  }
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
    // Если priorityStatusId явно передан (включая null), используем его; иначе используем значение по умолчанию
    // Используем hasOwnProperty чтобы различать "не передан" и "передан как null"
    let priorityStatusId = Object.prototype.hasOwnProperty.call(opts, 'priorityStatusId')
      ? opts.priorityStatusId
      : AUTOBUMP_PRIORITY_STATUS_ID
    
    const input = {
      itemId: String(itemId),
      // В соответствии с неофициальным PlayerokAPI: только provider и статус приоритета
      transactionProviderId: 'LOCAL',
      // priorityStatuses: если priorityStatusId null, передаем пустой массив (для завершенных товаров)
      priorityStatuses: (priorityStatusId != null && String(priorityStatusId).trim() !== '')
        ? [String(priorityStatusId)]
        : [], // Пустой массив для товаров без статуса поднятия
    }
    const bodyJson = {
      operationName: 'publishItem',
      variables: {
        input,
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
            
            // Определение категории с fallback
            let category = normalizeKeyPart(game)
            
            // Если категория не определена, пытаемся извлечь из названия товара
            if (!category || (typeof category === 'string' && !category.trim())) {
              const normalizedTitle = normalizeKeyPart(title)
              if (normalizedTitle && normalizedTitle.trim()) {
                const titleLower = normalizedTitle.toLowerCase()
                // Список известных игр для поиска в названии
                const commonGames = [
                  'Clash of Clans', 'Clash Royale', 'Brawl Stars', 'Hay Day', 'Boom Beach',
                  'PUBG', 'PUBG Mobile', 'Call of Duty', 'Free Fire', 'Fortnite',
                  'CS:GO', 'CS2', 'Counter-Strike', 'Dota 2', 'League of Legends',
                  'Valorant', 'Apex Legends', 'Genshin Impact', 'Honkai', 'Star Rail',
                  'World of Tanks', 'World of Warships', 'War Thunder',
                  'Minecraft', 'Roblox', 'Among Us', 'Fall Guys', 'Mobile Legends',
                  'Wild Rift', 'Arena of Valor', 'Heroes of the Storm', 'Overwatch',
                  'YouTube', 'Claude', 'ChatGPT', 'ЧатГПТ', 'Telegram', 'Discord'
                ]
                for (const gameName of commonGames) {
                  if (titleLower.includes(gameName.toLowerCase())) {
                    category = gameName
                    break
                  }
                }
                // Если не нашли известную игру, используем первые слова названия
                if (!category || (typeof category === 'string' && !category.trim())) {
                  const words = normalizedTitle.split(/\s+/).filter(w => w.length > 0)
                  if (words.length > 0) {
                    let candidate = words.slice(0, 3).join(' ')
                    if (candidate.length > 50) candidate = candidate.substring(0, 50).trim()
                    if (candidate) category = candidate
                  }
                }
              }
              // Если всё ещё нет категории, используем "Общий чат"
              if (!category || (typeof category === 'string' && !category.trim())) {
                category = 'Общий чат'
              }
            }
            
            return {
              id: node.id,
              itemId: item.id || null,
              status: node.status,
              productKey: buildProductKey(game, title),
              productTitle: normalizeKeyPart(title) || 'Товар',
              category: category, // Гарантируем, что категория всегда определена
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
async function fetchDealChatMessagesFromPlayerok(token, userAgent, dealId, chatIdFromDeal, opts = {}) {
  let chatId = chatIdFromDeal || null
  if (!chatId && dealId) {
    const fullDeal = await requestDealById(token, userAgent, dealId)
    chatId = fullDeal?.chat?.id || fullDeal?.chatId || null
  }
  if (!chatId) {
    return {
      messages: [],
      buyerSupercellEmail: null,
      dealBuyerSupercellEmail: null,
      buyerMessageSupercellEmail: null,
      itemTitle: null,
      itemImageUrl: null,
    }
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

  let dealBuyerSupercellEmail = null
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
      dealBuyerSupercellEmail = extractSupercellEmailFromFields(fields)
    } catch (_) {
      // ignore errors when fetching full deal
    }
  }

  const buyerMessageSupercellEmail = getLatestBuyerEmailFromMessages(
    allMessages,
    opts.viewerUsername || null
  )
  const buyerSupercellEmail = buyerMessageSupercellEmail || dealBuyerSupercellEmail || null

  return {
    messages: allMessages,
    buyerSupercellEmail,
    dealBuyerSupercellEmail,
    buyerMessageSupercellEmail,
    itemTitle,
    itemImageUrl,
  }
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

async function fetchActiveItemsFromPlayerok(token, userAgent, useCache = true) {
  // Проверяем кэш
  if (useCache) {
    const cached = lotsCache.get(token)
    if (cached?.active) {
      const now = Date.now()
      if (now < cached.active.expiresAt) {
        console.log('[cache] возврат активных лотов из кэша', { token: token.substring(0, 10) + '...', age: Math.floor((now - (cached.active.expiresAt - LOTS_CACHE_TTL_MS)) / 1000) + 's' })
        return cached.active.data
      }
    }
  }

  // Загружаем свежие данные
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

  const result = {
    items: allItems,
    totalCount: totalCount || allItems.length,
  }

  // Сохраняем в кэш
  if (useCache) {
    if (!lotsCache.has(token)) {
      lotsCache.set(token, {})
    }
    lotsCache.get(token).active = {
      data: result,
      expiresAt: Date.now() + LOTS_CACHE_TTL_MS,
    }
  }

  return result
}

/** Завершённые товары: /profile/.../products/completed — на странице отображаются SOLD и EXPIRED. */
async function fetchCompletedItemsFromPlayerok(token, userAgent, useCache = true) {
  // Проверяем кэш
  if (useCache) {
    const cached = lotsCache.get(token)
    if (cached?.completed) {
      const now = Date.now()
      if (now < cached.completed.expiresAt) {
        console.log('[cache] возврат завершённых лотов из кэша', { token: token.substring(0, 10) + '...', age: Math.floor((now - (cached.completed.expiresAt - LOTS_CACHE_TTL_MS)) / 1000) + 's' })
        return cached.completed.data
      }
    }
  }

  // Загружаем свежие данные
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

  const result = {
    items: allItems,
    totalCount: totalCount || allItems.length,
  }

  // Сохраняем в кэш
  if (useCache) {
    if (!lotsCache.has(token)) {
      lotsCache.set(token, {})
    }
    lotsCache.get(token).completed = {
      data: result,
      expiresAt: Date.now() + LOTS_CACHE_TTL_MS,
    }
  }

  return result
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
      if (!stored.token && !stored.tokenKey) {
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
          return sendJson(res, 200, { ok: true, updated_at: null })
        }
        const tokenHash = token
        const tokenEnc = encryptToken(token)
        // token сохраняем только для обратной совместимости (старые части кода), но фронту не отдаём
        upsertStoredToken.run(token, tokenEnc, updatedAt)
        return sendJson(res, 200, { ok: true, updated_at: updatedAt })
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
      const tokenHash = token
      const key = String(productKey)
      console.info('[settings:get]', { tokenHash, productKey: key })
      const row = getSettings.get(key)
      if (!row) {
        console.info('[settings:get] не найдено', { tokenHash, productKey: key })
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
        console.info('[settings:get] попадание в кэш', {
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
      const rows = getAllSettings.all()
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
      const rows = getAllSettings.all()
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
            color: c && c.color ? String(c.color) : '#6c757d', // возвращаем цвет или используем серый по умолчанию
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
            color: safe.color ? String(safe.color) : '#6c757d', // сохраняем цвет или используем серый по умолчанию
          }
        })
        : []
      const settings = { commands }
      const settingsStr = JSON.stringify(settings)
      const updatedAt = Math.floor(Date.now() / 1000)
      try {
        const productKey = getCategorySettingsKey(category)
        upsertSettings.run(String(productKey), settingsStr, updatedAt)
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
      const tokenHash = token
      const key = String(productKey)
      const settingsStr = typeof settings === 'object' && settings !== null
        ? JSON.stringify(settings)
        : '{}'
      const updatedAt = Math.floor(Date.now() / 1000)
      try {
        upsertSettings.run(key, settingsStr, updatedAt)
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
        const tokenHash = token
        const key = String(productKey)
        const result = deleteSettings.run(key)
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
        const tokenHash = token
        const hiddenRows = getHiddenChats.all()
        const hiddenSet = new Set(
          (hiddenRows || []).map((r) => (r && r.chat_id != null ? String(r.chat_id) : null)).filter(Boolean)
        )
        const viewer = await withRetry(
          () => getViewer(token, userAgent),
          { label: 'getViewer(chats)', retries: 2, shouldRetry: isPlayerokRateLimitError }
        )
        const normalizeComparableUsername = (value) =>
          String(value || '').trim().toLowerCase()
        const viewerUsernameNormalized = normalizeComparableUsername(viewer?.username)
        const isViewerUsername = (value) => {
          const normalized = normalizeComparableUsername(value)
          if (!normalized) return false
          return viewerUsernameNormalized ? normalized === viewerUsernameNormalized : false
        }
        const extractBuyerNameFromMessages = (messages) => {
          const list = Array.isArray(messages) ? messages : []
          for (const message of list) {
            const username = message?.user?.username || message?.user?.name || null
            if (username && !isViewerUsername(username)) {
              return String(username).trim()
            }
          }
          return null
        }
        const extractBuyerNameFromChatNode = (node) => {
          if (!node || typeof node !== 'object') return null
          const lastMessage = node.lastMessage || null
          const deal = lastMessage?.deal || node.deal || null
          const item = deal?.item || null
          const directBuyer = deal?.buyer || node.buyer || item?.buyer || null
          if (directBuyer) {
            const directUsername =
              directBuyer.username ||
              directBuyer.name ||
              directBuyer.id ||
              null
            if (directUsername && !isViewerUsername(directUsername)) {
              return String(directUsername).trim()
            }
          }
          const candidateUsers = [lastMessage?.user || null, deal?.user || null, node.user || null]
          for (const user of candidateUsers) {
            const username = user?.username || user?.name || null
            if (username && !isViewerUsername(username)) {
              return String(username).trim()
            }
          }
          return null
        }
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
        const titleToGame = new Map()
        if (itemIdSet.size > 0) {
          try {
            const [{ items: activeItems }, { items: completedItems }] = await Promise.all([
              fetchActiveItemsFromPlayerok(token, userAgent),
              fetchCompletedItemsFromPlayerok(token, userAgent),
            ])
            for (const it of [...(activeItems || []), ...(completedItems || [])]) {
              const id = it && it.id != null ? String(it.id) : null
              const gameName = (it && it.game) ? String(it.game).trim() : ''
              const title = (it && (it.title || it.name)) ? String(it.title || it.name).trim() : ''
              if (id && gameName && !itemIdToGame.has(id)) {
                itemIdToGame.set(id, gameName)
              }
              // Маппинг названия товара на игру (как в /completed-deals)
              if (title && gameName && !titleToGame.has(title)) {
                titleToGame.set(title, gameName)
              }
            }
          } catch (e) {
          }
        }

        const chatIdToLatestSale = new Map()
        try {
          const { deals: recentDeals } = await fetchDealsFromPlayerok(token, userAgent)
          for (const sale of recentDeals || []) {
            const saleChatId = sale && sale.chatId != null ? String(sale.chatId) : null
            const saleCategory = sale && typeof sale.category === 'string' ? sale.category.trim() : ''
            if (!saleChatId || !saleCategory) continue

            const saleTs = Number(sale.soldAt) || 0
            const prev = chatIdToLatestSale.get(saleChatId)
            if (!prev || saleTs >= prev.soldAt) {
              chatIdToLatestSale.set(saleChatId, {
                soldAt: saleTs,
                category: saleCategory,
              })
            }
          }
        } catch (e) {
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
                }
              })
            )
          } catch (_) {
            // ignore batch errors
          }
        }

        // КРИТИЧНО: Для чатов без deal и item загружаем dealId из сообщений и получаем категорию
        // Это самый надежный способ, так как категория всегда есть в deal
        const chatIdToCategory = new Map()
        const chatIdToBuyerName = new Map()
        const chatsNeedingDealId = []
        const dealIdsToLoad = new Set()
        
        // Сначала собираем dealId из lastMessage для всех чатов без deal
        for (const edge of edges) {
          const node = edge && edge.node
          if (!node) continue
          const lastMessage = node.lastMessage || null
          const deal = lastMessage?.deal || node.deal || null
          const item = deal?.item || null
          
          // Если нет deal и item, но есть dealId в lastMessage, добавляем его для загрузки
          if (!deal && !item && lastMessage?.deal?.id) {
            const dealId = String(lastMessage.deal.id)
            dealIdsToLoad.add(dealId)
            chatsNeedingDealId.push({ chatId: node.id, dealId })
          } else if (!deal && !item) {
            // Если нет deal и item, и нет dealId в lastMessage, нужно загрузить полную информацию
            chatsNeedingDealId.push({ chatId: node.id, dealId: null })
          }
        }
        
        // Загружаем deals по найденным dealId
        if (dealIdsToLoad.size > 0) {
          try {
            await Promise.all(
              Array.from(dealIdsToLoad).map(async (dealId) => {
                try {
                  if (dealIdToCategory.has(dealId)) {
                    return // Уже загружен
                  }
                  const foundDeal = await withRetry(
                    () => requestDealById(token, userAgent, dealId),
                    { label: 'dealById(userChats-fromLastMessage)', retries: 1, shouldRetry: isPlayerokRateLimitError }
                  )
                  if (foundDeal) {
                    let dealCategory =
                      (foundDeal.category && String(foundDeal.category).trim()) ||
                      null
                    const dealItem = foundDeal.item || null
                    if (!dealCategory && dealItem) {
                      const gameName =
                        (dealItem.game && (dealItem.game.name || dealItem.game.title)) ||
                        null
                      if (gameName) dealCategory = String(gameName).trim()
                    }
                    if (!dealCategory && typeof foundDeal.productKey === 'string') {
                      const pk = foundDeal.productKey
                      const sepIndex = pk.indexOf('::')
                      if (sepIndex > 0) {
                        const gameFromPk = pk.slice(0, sepIndex).trim()
                        if (gameFromPk) dealCategory = gameFromPk
                      }
                    }
                    if (dealCategory) {
                      dealIdToCategory.set(dealId, dealCategory)
                    }
                  }
                } catch (e) {
                  
                }
              })
            )
          } catch (e) {
            
          }
        }
        
        // Для чатов без dealId в lastMessage загружаем полную информацию о чате
        const chatsNeedingFullInfo = chatsNeedingDealId
          .filter(c => !c.dealId)
          .map(c => c.chatId)
        
        if (chatsNeedingFullInfo.length > 0) {
          try {
            // Загружаем батчами по 2, чтобы не перегрузить API
            const BATCH_SIZE = 2
            for (let i = 0; i < chatsNeedingFullInfo.length; i += BATCH_SIZE) {
              const batch = chatsNeedingFullInfo.slice(i, i + BATCH_SIZE)
              await Promise.all(
                batch.map(async (chatId) => {
                  try {
                    // Сначала пытаемся загрузить полную информацию о чате
                    const fullChat = await withRetry(
                      () => requestChatById(token, userAgent, chatId),
                      { label: 'chatById(userChats)', retries: 1, shouldRetry: isPlayerokRateLimitError }
                    )
                    
                    let category = null
                    let dealIdFromChat = null
                    
                    if (fullChat) {
                      // Пытаемся найти deal в полной информации о чате
                      const chatDeal = fullChat.deal || null
                      const chatItem = chatDeal?.item || null
                      
                      if (chatItem && chatItem.game) {
                        category = (chatItem.game.name || chatItem.game.title || '').trim() || null
                      }
                      if (!category && chatItem && chatItem.category) {
                        category = (chatItem.category.name || chatItem.category.title || '').trim() || null
                      }
                      if (!category && chatDeal) {
                        if (typeof chatDeal.category === 'string') {
                          category = chatDeal.category.trim() || null
                        }
                        if (!category && typeof chatDeal.productKey === 'string') {
                          const pk = chatDeal.productKey
                          const sepIndex = pk.indexOf('::')
                          if (sepIndex > 0) {
                            const gameFromPk = pk.slice(0, sepIndex).trim()
                            if (gameFromPk) {
                              category = gameFromPk
                            }
                          }
                        }
                        if (chatDeal.id) {
                          dealIdFromChat = String(chatDeal.id)
                          // Если нашли dealId, пытаемся загрузить deal
                          if (!category && !dealIdToCategory.has(dealIdFromChat)) {
                            try {
                              const foundDeal = await withRetry(
                                () => requestDealById(token, userAgent, dealIdFromChat),
                                { label: 'dealById(userChats-fromFullChat)', retries: 1, shouldRetry: isPlayerokRateLimitError }
                              )
                              if (foundDeal) {
                                let dealCategory =
                                  (foundDeal.category && String(foundDeal.category).trim()) ||
                                  null
                                const dealItem = foundDeal.item || null
                                if (!dealCategory && dealItem) {
                                  const gameName =
                                    (dealItem.game && (dealItem.game.name || dealItem.game.title)) ||
                                    null
                                  if (gameName) dealCategory = String(gameName).trim()
                                }
                                if (!dealCategory && typeof foundDeal.productKey === 'string') {
                                  const pk = foundDeal.productKey
                                  const sepIndex = pk.indexOf('::')
                                  if (sepIndex > 0) {
                                    const gameFromPk = pk.slice(0, sepIndex).trim()
                                    if (gameFromPk) dealCategory = gameFromPk
                                  }
                                }
                                if (dealCategory) {
                                  dealIdToCategory.set(dealIdFromChat, dealCategory)
                                  category = dealCategory
                                }
                              }
                            } catch (e) {
                              
                            }
                          } else if (dealIdToCategory.has(dealIdFromChat)) {
                            category = dealIdToCategory.get(dealIdFromChat)
                          }
                        }
                      }
                    }
                    
                    // Если категория не найдена или имя покупателя не удалось определить по данным чата,
                    // пытаемся добрать это из последних сообщений.
                    if (!category || !chatIdToBuyerName.has(String(chatId))) {
                      try {
                        const messagesData = await withRetry(
                          () => requestChatMessagesPage(token, userAgent, chatId, null, 10),
                          { label: 'chatMessages(userChats)', retries: 1, shouldRetry: isPlayerokRateLimitError }
                        )
                        const messages = Array.isArray(messagesData?.messages) ? messagesData.messages : []
                        const buyerNameFromMessages = extractBuyerNameFromMessages(messages)
                        if (buyerNameFromMessages) {
                          chatIdToBuyerName.set(String(chatId), buyerNameFromMessages)
                        }
                        if (messages.length > 0) {
                          for (const msg of messages) {
                            const foundDealId = msg?.dealId ? String(msg.dealId) : null
                            if (!foundDealId) continue
                            if (!dealIdToCategory.has(foundDealId)) {
                              try {
                                const foundDeal = await withRetry(
                                  () => requestDealById(token, userAgent, foundDealId),
                                  { label: 'dealById(userChats-fromMsg)', retries: 1, shouldRetry: isPlayerokRateLimitError }
                                )
                                if (foundDeal) {
                                  let dealCategory =
                                    (foundDeal.category && String(foundDeal.category).trim()) ||
                                    null
                                  const dealItem = foundDeal.item || null
                                  if (!dealCategory && dealItem) {
                                    const gameName =
                                      (dealItem.game && (dealItem.game.name || dealItem.game.title)) ||
                                      null
                                    if (gameName) dealCategory = String(gameName).trim()
                                  }
                                  if (!dealCategory && typeof foundDeal.productKey === 'string') {
                                    const pk = foundDeal.productKey
                                    const sepIndex = pk.indexOf('::')
                                    if (sepIndex > 0) {
                                      const gameFromPk = pk.slice(0, sepIndex).trim()
                                      if (gameFromPk) dealCategory = gameFromPk
                                    }
                                  }
                                  if (dealCategory) {
                                    dealIdToCategory.set(foundDealId, dealCategory)
                                    category = dealCategory
                                    break
                                  }
                                }
                              } catch (e) {
                                
                              }
                            } else {
                              category = dealIdToCategory.get(foundDealId)
                              if (category) break
                            }
                          }
                        }
                      } catch (e) {
                      }
                    }
                    
                    if (category) {
                      chatIdToCategory.set(String(chatId), category)
                    }
                  } catch (e) {
                    
                  }
                })
              )
              // Небольшая задержка между батчами
              if (i + BATCH_SIZE < chatsNeedingFullInfo.length) {
                await new Promise(resolve => setTimeout(resolve, 300))
              }
            }
          } catch (e) {
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
            const chatId = node.id != null ? String(node.id) : null
            const latestSale = chatId ? chatIdToLatestSale.get(chatId) : null
            
            // Пытаемся извлечь buyerName из разных источников
            let buyerName = extractBuyerNameFromChatNode(node)
            if (!buyerName && chatId && chatIdToBuyerName.has(chatId)) {
              buyerName = chatIdToBuyerName.get(chatId)
            }
            
            const itemTitle =
              (item && (item.title || item.name)) ||
              (deal && deal.productTitle) ||
              null
            const itemImageUrl = item ? extractItemImageUrl(item) : null
            // Логирование для отладки определения категории
            const categoryDebugInfo = {
              chatId: node.id,
              hasItem: !!item,
              hasDeal: !!deal,
              hasNode: !!node,
              itemGame: item?.game ? (item.game.name || item.game.title) : null,
              itemCategory: item?.category ? (item.category.name || item.category.title) : null,
              nodeGame: node?.game ? (node.game.name || node.game.title) : null,
              nodeCategory: node?.category ? (node.category.name || node.category.title) : null,
              dealCategory: deal && typeof deal.category === 'string' ? deal.category : null,
              dealProductKey: deal && typeof deal.productKey === 'string' ? deal.productKey : null,
              itemId: item && item.id != null ? String(item.id) : null,
              dealId: deal && deal.id != null ? String(deal.id) : null,
              itemTitle: itemTitle || null,
              latestSaleCategory: latestSale?.category || null,
              latestSaleSoldAt: latestSale?.soldAt || null,
            }
            
            let category =
              (latestSale && latestSale.category) ||
              (item && item.game && (item.game.name || item.game.title)) ||
              (item && item.category && (item.category.name || item.category.title)) ||
              (node && node.game && (node.game.name || node.game.title)) ||
              (node && node.category && (node.category.name || node.category.title)) ||
              (deal && typeof deal.category === 'string' && deal.category) ||
              null
            
            let categorySource = null
            if (category) {
              categorySource = latestSale?.category
                ? 'latest sale by chatId'
                : 'item.game или node.game или deal.category'
            }
            
            if (!category && deal && typeof deal.productKey === 'string') {
              const pk = deal.productKey
              const sepIndex = pk.indexOf('::')
              if (sepIndex > 0) {
                category = pk.slice(0, sepIndex).trim() || null
                if (category) categorySource = 'deal.productKey'
              }
            }
            
            if (!category) {
              const itemId = item && item.id != null ? String(item.id) : null
              if (itemId && itemIdToGame.has(itemId)) {
                category = itemIdToGame.get(itemId)
                if (category) categorySource = 'itemIdToGame map'
              }
            }
            
            if (!category && deal && deal.id != null) {
              const did = String(deal.id)
              if (dealIdToCategory.has(did)) {
                category = dealIdToCategory.get(did)
                if (category) categorySource = 'dealIdToCategory map'
              }
            }
            
            // КРИТИЧНО: Для чатов без deal и item пытаемся найти категорию
            // Приоритет: 1) dealId из lastMessage -> dealIdToCategory, 2) chatIdToCategory, 3) загрузка полной информации
            if (!category && !deal && !item && node.id != null) {
              const chatId = String(node.id)
              
              // ПРИОРИТЕТ 1: Если есть dealId в lastMessage, используем категорию из dealIdToCategory
              if (lastMessage && lastMessage.deal && lastMessage.deal.id) {
                const dealIdFromMessage = String(lastMessage.deal.id)
                if (dealIdToCategory.has(dealIdFromMessage)) {
                  category = dealIdToCategory.get(dealIdFromMessage)
                  if (category) {
                    categorySource = 'dealIdToCategory map (from lastMessage.deal)'
                  }
                }
              }
              
              // ПРИОРИТЕТ 2: Проверяем, есть ли категория в chatIdToCategory (из загруженной полной информации)
              if (!category && chatIdToCategory.has(chatId)) {
                category = chatIdToCategory.get(chatId)
                if (category) {
                  categorySource = 'chatIdToCategory map (requestChatById)'
                }
              }
            }
            
            // Попытка извлечь категорию из itemTitle (как в /completed-deals)
            if (!category && itemTitle && typeof itemTitle === 'string') {
              const title = itemTitle.trim()
              // Сначала пытаемся найти в titleToGame мапе (как в /completed-deals)
              if (title && titleToGame.has(title)) {
                category = titleToGame.get(title)
                if (category) {
                  categorySource = 'titleToGame map'
                }
              }
              // Если не нашли в мапе, пытаемся найти известные игры в названии товара
              if (!category) {
                const commonGames = [
                  'Clash of Clans', 'Clash Royale', 'Brawl Stars', 'Hay Day', 'Boom Beach',
                  'PUBG', 'PUBG Mobile', 'Call of Duty', 'Free Fire', 'Fortnite',
                  'CS:GO', 'CS2', 'Counter-Strike', 'Dota 2', 'League of Legends',
                  'Valorant', 'Apex Legends', 'Genshin Impact', 'Honkai', 'Star Rail',
                  'World of Tanks', 'World of Warships', 'War Thunder',
                  'Minecraft', 'Roblox', 'Among Us', 'Fall Guys', 'Mobile Legends',
                  'Wild Rift', 'Arena of Valor', 'Heroes of the Storm', 'Overwatch',
                  'YouTube', 'Claude', 'ChatGPT', 'ЧатГПТ'
                ]
                for (const game of commonGames) {
                  if (title.toLowerCase().includes(game.toLowerCase())) {
                    category = game
                    categorySource = 'itemTitle (common games)'
                    break
                  }
                }
              }
            }
            
            // Примечание: deals уже загружаются выше в dealIdToCategory map (строки 2888-2929)
            // Если категория всё ещё не определена, значит deal не был найден или не содержит категорию
            // В этом случае используем fallback ниже
            
            // Нормализация категории
            if (category && typeof category === 'string') {
              category = category.trim()
              if (!category) category = null
            }
            
            categoryDebugInfo.finalCategory = category
            categoryDebugInfo.categorySource = categorySource
            
            // КРИТИЧНО: категория должна быть всегда определена
            // Если после всех попыток категория не найдена, это критическая ошибка
            if (!category || (typeof category === 'string' && !category.trim())) {
              // Пытаемся извлечь категорию из itemTitle более агрессивно
              let fallbackCategory = null
              if (itemTitle && typeof itemTitle === 'string' && itemTitle.trim()) {
                const title = itemTitle.trim()
                // Список известных игр для поиска в названии
                const commonGames = [
                  'Clash of Clans', 'Clash Royale', 'Brawl Stars', 'Hay Day', 'Boom Beach',
                  'PUBG', 'PUBG Mobile', 'Call of Duty', 'Free Fire', 'Fortnite',
                  'CS:GO', 'CS2', 'Counter-Strike', 'Dota 2', 'League of Legends',
                  'Valorant', 'Apex Legends', 'Genshin Impact', 'Honkai', 'Star Rail',
                  'World of Tanks', 'World of Warships', 'War Thunder',
                  'Minecraft', 'Roblox', 'Among Us', 'Fall Guys', 'Mobile Legends',
                  'Wild Rift', 'Arena of Valor', 'Heroes of the Storm', 'Overwatch',
                  'YouTube', 'Claude', 'ChatGPT', 'ЧатГПТ', 'Telegram', 'Discord'
                ]
                for (const game of commonGames) {
                  if (title.toLowerCase().includes(game.toLowerCase())) {
                    fallbackCategory = game
                    break
                  }
                }
                // Если не нашли известную игру, используем первые слова названия
                if (!fallbackCategory) {
                  const words = title.split(/\s+/).filter(w => w.length > 0)
                  if (words.length > 0) {
                    // Берем первые 2-3 слова, но не более 50 символов
                    let candidate = words.slice(0, 3).join(' ')
                    if (candidate.length > 50) {
                      candidate = candidate.substring(0, 50).trim()
                    }
                    if (candidate) fallbackCategory = candidate
                  }
                }
              }
              
              // Если категория всё ещё не найдена, пытаемся извлечь из текста последнего сообщения
              if (!fallbackCategory) {
                let messageText = null
                if (lastMessage && lastMessage.text && typeof lastMessage.text === 'string') {
                  messageText = lastMessage.text.trim()
                }
                
                if (messageText) {
                  // Список известных игр/сервисов для поиска в тексте сообщения
                  const commonGames = [
                    'Clash of Clans', 'Clash Royale', 'Brawl Stars', 'Hay Day', 'Boom Beach',
                    'PUBG', 'PUBG Mobile', 'Call of Duty', 'Free Fire', 'Fortnite',
                    'CS:GO', 'CS2', 'Counter-Strike', 'Dota 2', 'League of Legends',
                    'Valorant', 'Apex Legends', 'Genshin Impact', 'Honkai', 'Star Rail',
                    'World of Tanks', 'World of Warships', 'War Thunder',
                    'Minecraft', 'Roblox', 'Among Us', 'Fall Guys', 'Mobile Legends',
                    'Wild Rift', 'Arena of Valor', 'Heroes of the Storm', 'Overwatch',
                    'YouTube', 'Claude', 'ChatGPT', 'ЧатГПТ', 'Telegram', 'Discord'
                  ]
                  for (const game of commonGames) {
                    if (messageText.toLowerCase().includes(game.toLowerCase())) {
                      fallbackCategory = game
                      break
                    }
                  }
                }
              }
              
              // Если категория всё ещё не найдена, это критическая ошибка - категория должна быть всегда!
              if (!fallbackCategory || (typeof fallbackCategory === 'string' && !fallbackCategory.trim())) {
                // Используем первые слова itemTitle как последний fallback
                if (itemTitle && typeof itemTitle === 'string' && itemTitle.trim()) {
                  const words = itemTitle.trim().split(/\s+/).filter(w => w.length > 0)
                  if (words.length > 0) {
                    fallbackCategory = words.slice(0, 2).join(' ')
                  }
                }
              }
              
              // Если категория найдена через fallback, используем её
              if (fallbackCategory && (typeof fallbackCategory === 'string' && fallbackCategory.trim())) {
                category = fallbackCategory
                categorySource = itemTitle ? 'itemTitle fallback' : (lastMessage?.text ? 'lastMessage fallback' : 'itemTitle words fallback')
              }
            }
            
            // Финальная проверка: категория НЕ МОЖЕТ быть пустой или null
            // Если категория всё ещё не найдена, это критическая ошибка
            if (!category || (typeof category === 'string' && !category.trim())) {
              // В крайнем случае используем первые слова itemTitle или "Категория не определена"
              if (itemTitle && typeof itemTitle === 'string' && itemTitle.trim()) {
                const words = itemTitle.trim().split(/\s+/).filter(w => w.length > 0)
                if (words.length > 0) {
                  category = words.slice(0, 2).join(' ')
                }
              }
              // Если и это не помогло, это критическая ошибка - категория должна быть всегда!
              if (!category || (typeof category === 'string' && !category.trim())) {
                // Используем "Категория не определена" как признак критической ошибки
                category = 'Категория не определена'
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
              buyerName: buyerName || null,
              isHidden: node.id != null && hiddenSet.has(String(node.id)),
            }
          })

        const chatsNeedingBuyerName = list.filter((chat) => !chat.buyerName && chat.id != null)
        if (chatsNeedingBuyerName.length > 0) {
          try {
            const BATCH_SIZE = 4
            for (let i = 0; i < chatsNeedingBuyerName.length; i += BATCH_SIZE) {
              const batch = chatsNeedingBuyerName.slice(i, i + BATCH_SIZE)
              await Promise.all(
                batch.map(async (chat) => {
                  try {
                    const chatId = String(chat.id)
                    if (chatIdToBuyerName.has(chatId)) {
                      return
                    }
                    const messagesData = await withRetry(
                      () => requestChatMessagesPage(token, userAgent, chatId, null, 10),
                      { label: 'chatMessages(userChats-buyer)', retries: 1, shouldRetry: isPlayerokRateLimitError }
                    )
                    const messages = Array.isArray(messagesData?.messages) ? messagesData.messages : []
                    const buyerName = extractBuyerNameFromMessages(messages)
                    if (buyerName) {
                      chatIdToBuyerName.set(chatId, buyerName)
                    }
                  } catch (e) {
                  }
                })
              )
              if (i + BATCH_SIZE < chatsNeedingBuyerName.length) {
                await new Promise((resolve) => setTimeout(resolve, 250))
              }
            }
          } catch (e) {
          }

          for (const chat of chatsNeedingBuyerName) {
            const resolvedBuyerName = chatIdToBuyerName.get(String(chat.id)) || null
            if (resolvedBuyerName) {
              chat.buyerName = resolvedBuyerName
            }
          }
        }
        
        // Обновляем категории из мапов для чатов, которым нужен маппинг (как в /in-progress-deals)
        const chatsNeedingMapping = list.filter(chat => {
          // Нужен маппинг, если категория не определена или это fallback категория
          const cat = chat.category
          return !cat || 
                 (typeof cat === 'string' && (!cat.trim() || 
                  cat === 'Категория не определена' || 
                  cat.includes('fallback') ||
                  (chat.itemTitle && !titleToGame.has(chat.itemTitle.trim()))))
        })
        
        if (chatsNeedingMapping.length > 0) {
          for (const chat of chatsNeedingMapping) {
            let category = chat.category
            const chatIndex = list.findIndex(c => c.id === chat.id)
            if (chatIndex === -1) continue
            
            // Пропускаем, если категория уже определена (не fallback)
            if (category && 
                category !== 'Категория не определена' && 
                !category.includes('fallback') &&
                category.trim()) {
              // Проверяем, можно ли улучшить категорию из мапов
              if (chat.itemId) {
                const betterCategory = itemIdToGame.get(String(chat.itemId))
                if (betterCategory && betterCategory !== category) {
                  category = betterCategory
                }
              }
              if (chat.itemTitle && typeof chat.itemTitle === 'string') {
                const title = chat.itemTitle.trim()
                const betterCategory = titleToGame.get(title)
                if (betterCategory && betterCategory !== category) {
                  category = betterCategory
                }
              }
            } else {
              // Категория не определена: повторно пытаемся определить её по полным данным чата/сделки
              if ((!category || category === 'Категория не определена') && chat.id != null) {
                const retryChatId = String(chat.id)
                try {
                  const latestSaleRetry = chatIdToLatestSale.get(retryChatId)
                  if (latestSaleRetry?.category) {
                    category = latestSaleRetry.category
                  }

                  if (!category) {
                    const fullChat = await withRetry(
                      () => requestChatById(token, userAgent, retryChatId),
                      { label: 'chatById(userChats-retryCategory)', retries: 1, shouldRetry: isPlayerokRateLimitError }
                    )

                    const retryDeal = fullChat?.deal || null
                    const retryItem = retryDeal?.item || null

                    category =
                      (retryItem?.game && (retryItem.game.name || retryItem.game.title)) ||
                      (retryItem?.category && (retryItem.category.name || retryItem.category.title)) ||
                      (typeof retryDeal?.category === 'string' && retryDeal.category) ||
                      null

                    if (!category && typeof retryDeal?.productKey === 'string') {
                      const sepIndex = retryDeal.productKey.indexOf('::')
                      if (sepIndex > 0) {
                        category = retryDeal.productKey.slice(0, sepIndex).trim() || null
                      }
                    }

                    if (!category && retryDeal?.id != null) {
                      const retryDealId = String(retryDeal.id)
                      if (dealIdToCategory.has(retryDealId)) {
                        category = dealIdToCategory.get(retryDealId) || null
                      } else {
                        try {
                          const fullDeal = await withRetry(
                            () => requestDealById(token, userAgent, retryDealId),
                            { label: 'dealById(userChats-retryCategory)', retries: 1, shouldRetry: isPlayerokRateLimitError }
                          )
                          if (fullDeal) {
                            category =
                              (fullDeal.category && String(fullDeal.category).trim()) ||
                              (fullDeal.item?.game && (fullDeal.item.game.name || fullDeal.item.game.title)) ||
                              null
                            if (!category && typeof fullDeal.productKey === 'string') {
                              const sepIndex = fullDeal.productKey.indexOf('::')
                              if (sepIndex > 0) {
                                category = fullDeal.productKey.slice(0, sepIndex).trim() || null
                              }
                            }
                            if (category) {
                              dealIdToCategory.set(retryDealId, category)
                            }
                          }
                        } catch (e) {
                        }
                      }
                    }

                    if (category) {
                      chatIdToCategory.set(retryChatId, String(category).trim())
                    }
                  }

                  if (!category) {
                    try {
                      const messagesData = await withRetry(
                        () => requestChatMessagesPage(token, userAgent, retryChatId, null, 12),
                        { label: 'chatMessages(userChats-retryCategory)', retries: 1, shouldRetry: isPlayerokRateLimitError }
                      )
                      const messages = Array.isArray(messagesData?.messages) ? messagesData.messages : []
                      for (const msg of messages) {
                        const retryDealId =
                          (msg?.dealId != null ? String(msg.dealId) : null) ||
                          (msg?.deal?.id != null ? String(msg.deal.id) : null)
                        if (!retryDealId) continue

                        if (dealIdToCategory.has(retryDealId)) {
                          category = dealIdToCategory.get(retryDealId) || null
                          if (category) break
                        }

                        try {
                          const fullDeal = await withRetry(
                            () => requestDealById(token, userAgent, retryDealId),
                            { label: 'dealById(userChats-retryCategoryFromMsg)', retries: 1, shouldRetry: isPlayerokRateLimitError }
                          )
                          if (!fullDeal) continue

                          category =
                            (fullDeal.category && String(fullDeal.category).trim()) ||
                            (fullDeal.item?.game && (fullDeal.item.game.name || fullDeal.item.game.title)) ||
                            null

                          if (!category && typeof fullDeal.productKey === 'string') {
                            const sepIndex = fullDeal.productKey.indexOf('::')
                            if (sepIndex > 0) {
                              category = fullDeal.productKey.slice(0, sepIndex).trim() || null
                            }
                          }

                          if (category) {
                            dealIdToCategory.set(retryDealId, category)
                            chatIdToCategory.set(retryChatId, category)
                            break
                          }
                        } catch (e) {
                        }
                      }
                    } catch (e) {
                    }
                  }
                } catch (e) {
                }
              }

              // Если повторная попытка не помогла, пытаемся найти из мапов
              if (!category && chat.itemId) {
                category = itemIdToGame.get(String(chat.itemId)) || null
              }
              if (!category && chat.itemTitle && typeof chat.itemTitle === 'string') {
                const title = chat.itemTitle.trim()
                category = titleToGame.get(title) || null
              }
              
              // Если категория всё ещё не найдена, используем fallback из itemTitle
              if (!category || (typeof category === 'string' && !category.trim())) {
                if (chat.itemTitle && typeof chat.itemTitle === 'string' && chat.itemTitle.trim()) {
                  const title = chat.itemTitle.trim()
                  const commonGames = [
                    'Clash of Clans', 'Clash Royale', 'Brawl Stars', 'Hay Day', 'Boom Beach',
                    'PUBG', 'PUBG Mobile', 'Call of Duty', 'Free Fire', 'Fortnite',
                    'CS:GO', 'CS2', 'Counter-Strike', 'Dota 2', 'League of Legends',
                    'Valorant', 'Apex Legends', 'Genshin Impact', 'Honkai', 'Star Rail',
                    'World of Tanks', 'World of Warships', 'War Thunder',
                    'Minecraft', 'Roblox', 'Among Us', 'Fall Guys', 'Mobile Legends',
                    'Wild Rift', 'Arena of Valor', 'Heroes of the Storm', 'Overwatch',
                    'YouTube', 'Claude', 'ChatGPT', 'ЧатГПТ', 'Telegram', 'Discord'
                  ]
                  for (const game of commonGames) {
                    if (title.toLowerCase().includes(game.toLowerCase())) {
                      category = game
                      break
                    }
                  }
                  if (!category || (typeof category === 'string' && !category.trim())) {
                    const words = title.split(/\s+/).filter(w => w.length > 0)
                    if (words.length > 0) {
                      let candidate = words.slice(0, 3).join(' ')
                      if (candidate.length > 50) candidate = candidate.substring(0, 50).trim()
                      if (candidate) category = candidate
                    }
                  }
                }
                // Если всё ещё нет категории, используем "Категория не определена"
                if (!category || (typeof category === 'string' && !category.trim())) {
                  category = 'Категория не определена'
                }
              }
            }
            
            // Обновляем категорию в списке
            if (category && category !== chat.category) {
              list[chatIndex].category = category
            }
          }
        }
        
        // Финальная проверка: все чаты должны иметь категорию
        const chatsWithoutCategory = list.filter(c => !c.category || (typeof c.category === 'string' && !c.category.trim()))
        if (chatsWithoutCategory.length > 0) {
          // Принудительно устанавливаем категорию для всех чатов без категории
          for (const chat of chatsWithoutCategory) {
            const chatIndex = list.findIndex(c => c.id === chat.id)
            if (chatIndex !== -1) {
              if (chat.itemTitle && typeof chat.itemTitle === 'string' && chat.itemTitle.trim()) {
                const words = chat.itemTitle.trim().split(/\s+/).filter(w => w.length > 0)
                if (words.length > 0) {
                  list[chatIndex].category = words.slice(0, 2).join(' ')
                } else {
                  list[chatIndex].category = 'Категория не определена'
                }
              } else {
                list[chatIndex].category = 'Категория не определена'
              }
            }
          }
        }
        
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
      const tokenHash = token
      const nowTs = Math.floor(Date.now() / 1000)
      try {
        upsertHiddenChat.run(String(chatId), nowTs)
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
      const tokenHash = token
      try {
        deleteHiddenChat.run(String(chatId))
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
      const rows = getSalesHistory.all(token)
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
        const result = deleteSalesHistoryByToken.run(token)
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
        const tokenHash = token
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
        const tokenHash = token
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
      const rows = getBumpHistory.all()
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

  if (req.method === 'GET' && pathname === '/api/logs') {
    const { token } = getTokenFromQueryOrStored(query)
    if (!token) return sendJson(res, 400, { error: 'token is required' })
    try {
      // Возвращаем последние логи из буфера
      const limit = parseIntSafe(query.limit, 1000)
      const logs = logsBuffer.slice(-limit)
      return sendJson(res, 200, { logs })
    } catch (err) {
      return sendJson(res, 500, { error: 'Failed to load logs', details: err.message })
    }
  }

  if (req.method === 'GET' && pathname === '/api/profit-analytics/meta') {
    const { token } = getTokenFromQueryOrStored(query)
    if (!token) return sendJson(res, 400, { error: 'token is required' })
    try {
      const tokenHash = token
      const years = getSalesYears.all().map((r) => r.year).filter((y) => y != null)
      const yearQ = parseIntSafe(query.year, null)
      const months =
        yearQ != null
          ? getSalesMonthsForYear.all(String(yearQ)).map((r) => r.month).filter((m) => m != null)
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
      const tokenHash = token
      const salesRows = getSalesHistoryAll.all()
      const bumpsRows = getBumpHistory.all()
      const settingsRows = getAllSettings.all()
      const listingFeesRows = getListingFees.all()
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
      const tokenHash = token
      const salesRows = getSalesHistoryAll.all()
      const bumpsRows = getBumpHistory.all()
      const settingsRows = getAllSettings.all()
      const listingFeesRows = getListingFees.all()

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
      const tokenHash = token
      const reqId = crypto.randomBytes(6).toString('hex')
      console.info('[bump] старт', {
        reqId,
        tokenHash,
        productKey: String(productKey),
        itemId: String(itemId),
        productTitle: String(productTitle),
      })

      // ВСЕГДА получаем актуальную цену товара перед запросом статусов
      // Для получения статусов поднятия нужно использовать ОРИГИНАЛЬНУЮ цену (rawPrice), а не цену со скидкой
      let currentPrice = requestedPrice ?? 0
      try {
        const currentItem = await requestItemById(token, userAgent, itemId)
        if (currentItem) {
          // Приоритет: rawPrice (оригинальная цена) > price (цена со скидкой)
          const itemPrice = typeof currentItem.rawPrice === 'number' && currentItem.rawPrice > 0
            ? currentItem.rawPrice
            : typeof currentItem.price === 'number' && currentItem.price > 0
              ? currentItem.price
              : null
          if (itemPrice != null && itemPrice > 0) {
            currentPrice = itemPrice
            console.info('[bump] текущая цена обновлена (rawPrice для статусов)', {
              reqId,
              itemId,
              oldPrice: requestedPrice ?? 0,
              currentPrice,
              discountedPrice: currentItem.price,
              rawPrice: currentItem.rawPrice,
            })
          }
        }
      } catch (err) {
        // Если не удалось получить актуальную цену, используем переданную
        console.warn('[bump] не удалось получить текущую цену', {
          reqId,
          itemId,
          error: err?.message,
          usingProvidedPrice: currentPrice,
        })
      }
      
      // ВСЕГДА получаем актуальный список статусов поднятия
      let priorityStatusId = null
      try {
        const statuses = await fetchItemPriorityStatuses(token, userAgent, itemId, currentPrice)
        const list = Array.isArray(statuses) ? statuses : []
        if (list.length === 0) {
          return sendJson(res, 400, {
            error: 'Нет доступных статусов поднятия для этого товара. Проверьте, что товар активен.',
            reqId,
          })
        }
        // Если передан userPriorityStatusId, проверяем его валидность в актуальном списке
        const found = userPriorityStatusId
          ? list.find((s) => String(s?.id || '') === String(userPriorityStatusId))
          : null
        // Используем переданный статус только если он валиден, иначе выбираем из актуального списка
        priorityStatusId = (found || list[0])?.id || null
        if (!priorityStatusId) {
          console.warn('[bump] не найден допустимый priorityStatusId', {
            reqId,
            itemId,
            productKey: String(productKey || ''),
            availableStatuses: list.map(s => ({ id: s?.id, price: s?.price })),
            requestedPriorityStatusId: userPriorityStatusId,
          })
          return sendJson(res, 400, {
            error: 'Не удалось определить статус поднятия для товара',
            reqId,
          })
        }
      } catch (fetchErr) {
        console.warn('[bump] ошибка получения статусов', { reqId, itemId, error: fetchErr?.message })
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
          console.warn('[bump] требуется оплата', {
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

        // НЕ сохраняем цену поднятия в БД - всегда используем актуальные данные из API
        insertBump.run(
          String(productKey),
          String(productTitle),
          bumpedAt,
          0, // Цена не сохраняется - всегда получаем актуальную из API
          itemId ? String(itemId) : null
        )
        console.info('[bump] успех', {
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
        const msg = err && err.message ? String(err.message) : String(err)
        const isInvalidBooster = msg.includes('некорректных бустеров') || msg.includes('BAD_REQUEST')
        console.warn('[bump] ошибка', {
          reqId,
          tokenHash,
          productKey: String(productKey),
          itemId: String(itemId),
          priorityStatusId: String(priorityStatusId),
          transactionProviderId: String(transactionProviderId),
          error: msg,
          isInvalidBooster,
        })
        if (isInvalidBooster) {
          // Если статус невалидный, пытаемся получить свежий список и повторить с другим доступным статусом
          try {
            const statuses = await fetchItemPriorityStatuses(token, userAgent, itemId, requestedPrice ?? 0)
            const list = Array.isArray(statuses) ? statuses : []
            console.warn('[bump] некорректный бустер — повтор со свежими статусами', {
              reqId,
              productKey: String(productKey),
              itemId: String(itemId),
              usedPriorityStatusId: String(priorityStatusId),
              availableStatuses: list.map(s => ({ id: s?.id, price: s?.price, name: s?.name })),
            })
            if (list.length > 0) {
              // Пробуем все доступные статусы по очереди, начиная с тех, которые отличаются от проблемного
              const otherStatuses = list.filter(s => String(s?.id || '') !== String(priorityStatusId))
              // Если нет других статусов, значит все статусы некорректны - прекращаем попытки
              if (otherStatuses.length === 0) {
                console.warn('[bump] все доступные статусы недействительны', {
                  reqId,
                  productKey: String(productKey),
                  itemId: String(itemId),
                  availableStatuses: list.map(s => ({ id: s?.id, price: s?.price, name: s?.name })),
                })
              } else {
                for (const statusOption of otherStatuses) {
                  const retryStatusId = statusOption?.id
                  if (!retryStatusId || String(retryStatusId) === String(priorityStatusId)) continue
                  
                  console.info('[bump] повтор с другим статусом', {
                    reqId,
                    oldPriorityStatusId: String(priorityStatusId),
                    newPriorityStatusId: String(retryStatusId),
                  })
                try {
                  const item = await increaseItemPriorityStatus(token, userAgent, itemId, {
                    priorityStatusId: retryStatusId,
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
                    console.warn('[bump] требуется оплата (повтор)', {
                      reqId,
                      tokenHash,
                      productKey: String(productKey),
                      itemId: String(itemId),
                      priorityStatusId: String(retryStatusId),
                      transactionProviderId: String(transactionProviderId),
                      status,
                      statusDescription,
                      paymentURL,
                      price: Number(price) || 0,
                    })
                    return sendJson(res, 402, { error: statusDescription || 'Требуется оплата поднятия', paymentURL })
                  }

                  // НЕ сохраняем цену поднятия в БД - всегда используем актуальные данные из API
                  insertBump.run(
                    String(productKey),
                    String(productTitle),
                    bumpedAt,
                    0, // Цена не сохраняется - всегда получаем актуальную из API
                    itemId ? String(itemId) : null
                  )
                  console.info('[bump] успех (повтор)', {
                    reqId,
                    tokenHash,
                    productKey: String(productKey),
                    itemId: String(itemId),
                    priorityStatusId: String(retryStatusId),
                    transactionProviderId: String(transactionProviderId),
                    bumpedAt,
                    price: Number(price) || 0,
                    status,
                    statusDescription,
                  })
                  return sendJson(res, 200, { ok: true, bumpedAt, price: Number(price) || 0 })
                } catch (retryErr) {
                  const retryMsg = retryErr && retryErr.message ? String(retryErr.message) : String(retryErr)
                  const isRetryInvalidBooster = retryMsg.includes('некорректных бустеров') || retryMsg.includes('BAD_REQUEST')
                  console.warn('[bump] повтор не удался', {
                    reqId,
                    retryStatusId: String(retryStatusId),
                    error: retryMsg,
                    isRetryInvalidBooster,
                  })
                  // Если этот статус тоже некорректный, пробуем следующий
                  if (!isRetryInvalidBooster) {
                    // Если ошибка не связана с некорректным бустером, прекращаем попытки
                    break
                  }
                  // Иначе продолжаем пробовать другие статусы
                }
              }
              }
            }
          } catch (fetchErr) {
            console.warn('[bump] не удалось получить свежие статусы для повтора', { reqId, error: fetchErr?.message })
          }
        }
        return sendJson(res, 500, {
          error: msg,
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

      const tokenHash = token
      const scanMeta = autolistGetCompletedScanMap(tokenHash)
      const lastChatMeta = autolistGetLastChatMeta(tokenHash)
      try {
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
        autolistPruneSupercellFlowMap(tokenHash, nowTs)

        async function processActiveSupercellFlows() {
          const flowMap = autolistGetSupercellFlowMap(tokenHash)
          const activeFlows = Object.entries(flowMap)
            .map(([chatId, state]) => ({
              chatId,
              state: state && typeof state === 'object' ? state : null,
            }))
            .filter(({ chatId, state }) => Boolean(chatId && state && state.active))

          for (const { chatId, state } of activeFlows) {
            await processSingleSupercellFlow(chatId, token, userAgent, viewer?.username || null, nowTs)
          }
        }
 
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
            
            // Собираем товары со статусом 'retry' или 'error' (после 500) для повторной обработки
            const retryItems = []
            for (const it of items) {
              const itemId = it?.id != null ? String(it.id) : null
              if (!itemId) continue
              const itemState = autolistGetItemState(tokenHash, itemId)
              if (itemState && (itemState.status === 'retry' || 
                  (itemState.status === 'error' && (itemState.error?.includes('status 500') || 
                   itemState.error?.includes('INTERNAL_SERVER_ERROR') || 
                   itemState.error?.includes('priorityStatuses'))))) {
                retryItems.push(it)
              }
            }
            
            // Объединяем последние 10 и товары для повторной попытки, убираем дубликаты
            const itemsToProcess = []
            const processedIds = new Set()
            for (const it of [...retryItems, ...lastTen]) {
              const itemId = it?.id != null ? String(it.id) : null
              if (itemId && !processedIds.has(itemId)) {
                itemsToProcess.push(it)
                processedIds.add(itemId)
              }
            }
            
            const relistedItems = []
            const relistErrors = []
            const scanSummary = []
            const shortLabel = (it, pk) => (pk || ((it?.game || it?.game_name || '') + '::' + ((it?.title || it?.name || '').slice(0, 45))))

            for (const it of itemsToProcess) {
              const itemId = it?.id != null ? String(it.id) : null
              if (!itemId) {
                scanSummary.push({ товар: shortLabel(it, null), результат: 'не выставлен', причина: 'нет itemId' })
                continue
              }

              const itemStatus = it?.status || null
              if (String(itemStatus) !== 'SOLD') {
                scanSummary.push({ товар: shortLabel(it, null), результат: 'не выставлен', причина: 'статус не SOLD (' + String(itemStatus) + ')' })
                continue
              }

              const rawTitle = it?.title || it?.name || ''
              const rawGame = typeof it?.game === 'string' 
                ? it.game 
                : (it?.game?.name && typeof it.game.name === 'string' ? it.game.name : '') || it?.game_name || ''
              const title = normalizeKeyPart(rawTitle)
              const game = normalizeKeyPart(rawGame)
              const productKey = buildProductKey(game, title)

              const eventKey = `completed:${itemId}`
              const itemState = autolistGetItemState(tokenHash, itemId)
              const shouldRetry = itemState && (itemState.status === 'retry' || 
                (itemState.status === 'error' && (itemState.error?.includes('status 500') || 
                 itemState.error?.includes('INTERNAL_SERVER_ERROR') || 
                 itemState.error?.includes('priorityStatuses'))))
              const wasProcessed = autolistWasProcessed(tokenHash, eventKey)
              
              if (wasProcessed && !shouldRetry) {
                scanSummary.push({ товар: shortLabel(it, productKey), результат: 'не выставлен', причина: 'уже обработан' })
                continue
              }

              let effectiveSettings = null
              let effectiveKey = String(productKey)
              try {
                const row = getSettings.get(effectiveKey)
                if (row?.settings) {
                  effectiveSettings = JSON.parse(row.settings)
                  const label = (effectiveSettings && typeof effectiveSettings.settingsLabel === 'string')
                    ? effectiveSettings.settingsLabel.trim()
                    : ''
                  if (label) {
                    const gk = getGroupSettingsKey(label)
                    const groupRow = getSettings.get(gk)
                    if (groupRow?.settings) {
                      effectiveSettings = JSON.parse(groupRow.settings)
                      effectiveKey = gk
                    }
                  }
                }
              } catch (err) {
                effectiveSettings = null
              }

              const s = effectiveSettings
              const autolistEnabled = Boolean(s?.autolist?.enabled)
              
              if (!autolistEnabled) {
                scanSummary.push({ товар: shortLabel(it, productKey), результат: 'не выставлен', причина: 'автовыставление отключено' })
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
                
                let currentPrice = it?.price ?? 0
                const oldPrice = currentPrice
                try {
                  const currentItem = await withRetry(
                    () => requestItemById(token, userAgent, itemId),
                    { label: 'itemById(autolist-price)', retries: 1, shouldRetry: isPlayerokRateLimitError }
                  )
                  if (currentItem) {
                    const itemPrice = typeof currentItem.rawPrice === 'number' && currentItem.rawPrice > 0
                      ? currentItem.rawPrice
                      : typeof currentItem.price === 'number' && currentItem.price > 0
                        ? currentItem.price
                        : null
                    if (itemPrice != null && itemPrice > 0) currentPrice = itemPrice
                  }
                } catch (err) {
                  // используем цену из завершенного товара
                }
                
                let priorityStatusId = null
                let statusesList = []
                try {
                  const statuses = await withRetry(
                    () => fetchItemPriorityStatuses(token, userAgent, itemId, currentPrice),
                    { label: 'itemPriorityStatuses(autolist)', retries: 2, shouldRetry: isPlayerokRateLimitError }
                  )
                  statusesList = Array.isArray(statuses) ? statuses : []
                  if (statusesList.length > 0) {
                    const free = statusesList.find((s) => !s?.price || Number(s.price) === 0)
                    const selectedStatus = free || statusesList[0] || null
                    priorityStatusId = selectedStatus?.id || null
                  }
                } catch (err) {
                  priorityStatusId = null
                }
                
                let relisted = null
                let publishError = null
                const otherStatuses = statusesList.filter(s => s?.id && String(s.id) !== String(priorityStatusId)).map(s => s.id)
                let statusesToTry = priorityStatusId 
                  ? [priorityStatusId, ...otherStatuses]
                  : otherStatuses
                if (statusesToTry.length === 0) statusesToTry = [AUTOBUMP_PRIORITY_STATUS_ID]
                
                for (let attemptIndex = 0; attemptIndex < statusesToTry.length; attemptIndex++) {
                  const tryStatusId = statusesToTry[attemptIndex]
                  try {
                    relisted = await withRetry(
                      () => publishItem(token, userAgent, itemId, { priorityStatusId: tryStatusId }),
                      { label: 'publishItem(completedScan)', retries: 3, shouldRetry: isPlayerokRateLimitError }
                    )
                    publishError = null
                    break
                  } catch (err) {
                    const msg = err && err.message ? String(err.message) : String(err)
                    const isInvalidBooster = msg.includes('некорректных бустеров') || msg.includes('BAD_REQUEST')
                    publishError = err
                    if (!isInvalidBooster) break
                  }
                }
                
                if (!relisted) {
                  try {
                    relisted = await withRetry(
                      () => publishItem(token, userAgent, itemId, { priorityStatusId: null }),
                      { label: 'publishItem(completedScan-no-status)', retries: 1, shouldRetry: isPlayerokRateLimitError }
                    )
                    publishError = null
                  } catch (err) {
                    // publishError уже установлен
                  }
                }
                
                if (!relisted) {
                  const finalError = publishError || new Error('Не удалось опубликовать товар')
                  throw finalError
                }
                
                try {
                  insertListingFee.run(String(productKey), Number(relisted.listingFee) || 0, nowTs)
                } catch (feeErr) {
                  // игнорируем
                }
                
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
                scanSummary.push({ товар: shortLabel(it, productKey), результат: 'выставлен', причина: 'ок' })
              } catch (err) {
                const msg = err && err.message ? String(err.message) : String(err)
                const cannotUpdateStatus = msg.includes('нельзя обновить статус')
                const isServerError = msg.includes('status 500') || msg.includes('INTERNAL_SERVER_ERROR') || msg.includes('priorityStatuses')
                const reasonShort = cannotUpdateStatus ? 'нельзя обновить статус' : (isServerError ? 'ошибка сервера (500)' : msg.slice(0, 80))
                scanSummary.push({ товар: shortLabel(it, productKey), результат: 'не выставлен', причина: reasonShort })
                if (cannotUpdateStatus) {
                  // Товар уже в нужном статусе: помечаем событие обработанным и больше не трогаем его.
                  autolistMarkProcessed(tokenHash, eventKey, nowTs)
                  autolistSetItemState(tokenHash, itemId, {
                    status: 'disabled',
                    error: msg,
                    updatedAt: nowTs,
                  })
                } else if (isServerError) {
                  // Ошибка 500 - не помечаем как обработанное, чтобы система продолжала пытаться выставить товар
                  // Помечаем как 'retry' чтобы система знала, что нужно продолжать попытки
                  autolistSetItemState(tokenHash, itemId, {
                    status: 'retry',
                    error: msg,
                    updatedAt: nowTs,
                  })
                  // НЕ вызываем autolistMarkProcessed - товар будет обрабатываться в следующих циклах
                } else {
                  // Другие ошибки - помечаем как error, но не обработанное, чтобы можно было повторить
                  autolistSetItemState(tokenHash, itemId, {
                    status: 'error',
                    error: msg,
                    updatedAt: nowTs,
                  })
                  // НЕ вызываем autolistMarkProcessed для обычных ошибок, чтобы можно было повторить
                }
                relistErrors.push({
                  itemId,
                  productKey,
                  error: msg,
                })
              }
            }

            console.log('[autolist-tick] сводка', {
              trigger,
              проверено: itemsToProcess.length,
              выставлено: relistedItems.length,
              товары: scanSummary,
            })
            if (relistedItems.length > 0) {
              return { ok: true, action: 'relisted', trigger, relisted: relistedItems, errors: relistErrors }
            }
            return { ok: true, action: 'none', trigger }
          } catch (err) {
            console.warn('[autolist-tick] сканирование завершённых не удалось', { trigger, error: err?.message })
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
        let fullDealSnapshot = null

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
              fullDealSnapshot = fullDeal || null
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
              const relistedByScanIds = (paidScanResult?.relisted && Array.isArray(paidScanResult.relisted))
                ? paidScanResult.relisted.map((r) => String(r.oldItemId))
                : []
              console.log('[autolist-tick] paid_chat: после scan', {
                trigger: 'paid_chat',
                dealItemId,
                scanAction: paidScanResult?.action || null,
                relistedByScanCount: relistedByScanIds.length,
                relistedByScanIds: relistedByScanIds.slice(0, 20),
              })

              // 2.2 Фиксируем продажу и выполняем автосообщения/автовыдачу для этого товара
              const item = await withRetry(
                () => requestItemById(token, userAgent, dealItemId),
                { label: 'itemById', retries: 3, shouldRetry: isPlayerokRateLimitError }
              )
              if (item) {
                const itemStatus = item.status || null
                const rawTitle = item.title || item.name || ''
                const rawGame = typeof item?.game === 'string' 
                  ? item.game 
                  : (item?.game?.name && typeof item.game.name === 'string' ? item.game.name : '') || item?.game_name || ''
                const title = normalizeKeyPart(rawTitle)
                const game = normalizeKeyPart(rawGame)
                const productKey = buildProductKey(game, title)

                // 2.3 Пытаемся перевыставить конкретный товар из сделки, подбирая корректный статус приоритета
                let paidChatPriorityStatusId = null
                let paidChatStatusIds = []
                try {
                  // Для получения статусов поднятия используем ОРИГИНАЛЬНУЮ цену (rawPrice), а не цену со скидкой
                  const priceForStatuses = (typeof item?.rawPrice === 'number' && item.rawPrice > 0)
                    ? item.rawPrice
                    : (typeof item?.price === 'number' && item.price > 0)
                      ? item.price
                      : 0

                  let statusesList = []
                  let priorityStatusId = null
                  try {
                    const statuses = await withRetry(
                      () => fetchItemPriorityStatuses(token, userAgent, dealItemId, priceForStatuses),
                      { label: 'itemPriorityStatuses(paid_chat)', retries: 2, shouldRetry: isPlayerokRateLimitError }
                    )
                    const list = Array.isArray(statuses) ? statuses : []
                    statusesList = list
                    paidChatStatusIds = list.map((s) => (s?.id != null ? String(s.id) : null)).filter(Boolean)
                    const free = list.find((s) => !s?.price || Number(s.price) === 0)
                    const selectedStatus = free || list[0] || null
                    priorityStatusId = selectedStatus?.id || null
                    paidChatPriorityStatusId = priorityStatusId
                  } catch (_) {
                    priorityStatusId = null
                    statusesList = []
                  }

                  const wasRelistedByScan = relistedByScanIds.includes(String(dealItemId))
                  if (wasRelistedByScan) {
                    console.log('[autolist-tick] paid_chat: товар уже перевыставлен в scan, пропуск publishItem', {
                      dealItemId,
                      productKey: String(productKey || ''),
                    })
                    autolistMarkProcessed(tokenHash, `deal:${dealId || dealItemId}`, nowTs)
                    autolistSetItemState(tokenHash, dealItemId, {
                      status: 'success',
                      error: null,
                      updatedAt: nowTs,
                    })
                  } else if (String(itemStatus) === 'SOLD') {
                    // Логика выбора статуса такая же, как в scanCompletedAndRelist: пробуем несколько статусов и затем null
                    let relisted = null
                    let publishError = null
                    const otherStatuses = statusesList
                      .filter(s => s?.id && String(s.id) !== String(priorityStatusId))
                      .map(s => s.id)
                    let statusesToTry = priorityStatusId
                      ? [priorityStatusId, ...otherStatuses]
                      : otherStatuses
                    if (statusesToTry.length === 0) statusesToTry = [AUTOBUMP_PRIORITY_STATUS_ID]

                    console.log('[autolist-tick] paid_chat: перед publishItem', {
                      dealItemId,
                      itemIdFromItem: item?.id,
                      itemStatus,
                      productKey: String(productKey || ''),
                      priceForStatuses,
                      priorityStatusId: paidChatPriorityStatusId,
                      statusIdsFromApi: paidChatStatusIds,
                      statusesToTry: statusesToTry.map(String),
                    })

                    for (let attemptIndex = 0; attemptIndex < statusesToTry.length; attemptIndex++) {
                      const tryStatusId = statusesToTry[attemptIndex]
                      try {
                        relisted = await withRetry(
                          () => publishItem(token, userAgent, dealItemId, { priorityStatusId: tryStatusId }),
                          { label: 'publishItem(paid_chat)', retries: 3, shouldRetry: isPlayerokRateLimitError }
                        )
                        publishError = null
                        break
                      } catch (err) {
                        const msg = err && err.message ? String(err.message) : String(err)
                        const isInvalidBooster = msg.includes('некорректных бустеров') || msg.includes('BAD_REQUEST')
                        publishError = err
                        if (!isInvalidBooster) break
                      }
                    }

                    if (!relisted) {
                      try {
                        relisted = await withRetry(
                          () => publishItem(token, userAgent, dealItemId, { priorityStatusId: null }),
                          { label: 'publishItem(paid_chat-no-status)', retries: 1, shouldRetry: isPlayerokRateLimitError }
                        )
                        publishError = null
                      } catch (err) {
                        // publishError уже установлен
                      }
                    }

                    if (!relisted) {
                      const finalError = publishError || new Error('Не удалось опубликовать товар (paid_chat)')
                      throw finalError
                    }

                    try {
                      insertListingFee.run(String(productKey), Number(relisted.listingFee) || 0, nowTs)
                    } catch (_) { }
                    autolistMarkProcessed(tokenHash, `deal:${dealId || dealItemId}`, nowTs)
                    autolistSetItemState(tokenHash, dealItemId, {
                      status: 'success',
                      error: null,
                      updatedAt: nowTs,
                    })
                  } else {
                    console.log('[autolist-tick] paid_chat: publishItem не вызывался — статус товара не SOLD', {
                      dealItemId,
                      itemStatus,
                      productKey: String(productKey || ''),
                    })
                  }
                } catch (err) {
                  const msg = err && err.message ? String(err.message) : String(err)
                  const cannotUpdateStatus = msg.includes('нельзя обновить статус')
                  const isServerError = msg.includes('status 500') || msg.includes('INTERNAL_SERVER_ERROR') || msg.includes('priorityStatuses')
                  console.warn('[autolist-tick] перевыставление не удалось', {
                    trigger: 'paid_chat',
                    itemId: dealItemId,
                    productKey: String(productKey || ''),
                    error: msg,
                    isServerError,
                    paidChatItemStatus: item?.status ?? null,
                    paidChatPriorityStatusId: paidChatPriorityStatusId,
                    paidChatStatusIdsFromApi: paidChatStatusIds,
                    wasRelistedByScan: relistedByScanIds.includes(String(dealItemId)),
                  })
                  if (cannotUpdateStatus) {
                    autolistMarkProcessed(tokenHash, `deal:${dealId || dealItemId}`, nowTs)
                    autolistSetItemState(tokenHash, dealItemId, {
                      status: 'disabled',
                      error: msg,
                      updatedAt: nowTs,
                    })
                  } else if (isServerError) {
                    // Ошибка 500 - не помечаем как обработанное, чтобы система продолжала пытаться выставить товар
                    autolistSetItemState(tokenHash, dealItemId, {
                      status: 'retry',
                      error: msg,
                      updatedAt: nowTs,
                    })
                    // НЕ вызываем autolistMarkProcessed - товар будет обрабатываться в следующих циклах
                  } else {
                    // Другие ошибки
                    autolistSetItemState(tokenHash, dealItemId, {
                      status: 'error',
                      error: msg,
                      updatedAt: nowTs,
                    })
                    // НЕ вызываем autolistMarkProcessed для обычных ошибок, чтобы можно было повторить
                  }
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
                const { effectiveSettings, effectiveKey } = resolveEffectiveProductSettings(productKey)

                const dealCategory = fullDealSnapshot && typeof fullDealSnapshot.productKey === 'string' && fullDealSnapshot.productKey.indexOf('::') > 0
                  ? fullDealSnapshot.productKey.slice(0, fullDealSnapshot.productKey.indexOf('::')).trim()
                  : (fullDealSnapshot && typeof fullDealSnapshot.category === 'string' ? fullDealSnapshot.category.trim() : '')
                const effectiveCategory = rawGame || game || dealCategory || ''
                const supercellGame = getSupercellGameByCategory(effectiveCategory)
                if (supercellGame && lastChat?.id) {
                  const flowMap = autolistGetSupercellFlowMap(tokenHash)
                  const flowChatId = String(lastChat.id)
                  const validation =
                    effectiveSettings?.emailValidation && typeof effectiveSettings.emailValidation === 'object'
                      ? effectiveSettings.emailValidation
                      : {}
                  const invalidEmailMessage = validation.enabled && typeof validation.invalidEmailMessage === 'string'
                    ? validation.invalidEmailMessage.trim()
                    : ''
                  flowMap[flowChatId] = {
                    ...(flowMap[flowChatId] || {}),
                    chatId: flowChatId,
                    dealId: dealId || null,
                    productKey,
                    category: effectiveCategory,
                    invalidEmailMessage,
                    invalidMessageSent: Boolean(flowMap[flowChatId]?.invalidMessageSent),
                    requestCodeRequested: Boolean(flowMap[flowChatId]?.requestCodeRequested),
                    latestEmail:
                      String(
                        extractSupercellEmailFromFields(
                          (fullDealSnapshot && Array.isArray(fullDealSnapshot.obtainingFields) && fullDealSnapshot.obtainingFields) ||
                          (fullDealSnapshot &&
                            fullDealSnapshot.item &&
                            Array.isArray(fullDealSnapshot.item.dataFields) &&
                            fullDealSnapshot.item.dataFields) ||
                          []
                        ) || ''
                      ).trim() || null,
                    active: true,
                    createdAt: Number(flowMap[flowChatId]?.createdAt || nowTs),
                    updatedAt: nowTs,
                  }
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
                        console.warn('[autolist-tick] автодоставка messageOnPurchase не удалась', { error: err?.message })
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
                          upsertSettings.run(token, effectiveKey, JSON.stringify(updated), updatedAt)
                        } catch (err) {
                          console.warn('[autolist-tick] автодоставка отправка кода не удалась', { productKey: effectiveKey, error: err?.message })
                        }
                      }
                    }
                  }
                }
              }

              lastChatMeta.lastPaidTs = dealTs || nowTs
              await processActiveSupercellFlows()

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
        await processActiveSupercellFlows()

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
        // ВСЕГДА получаем актуальную цену товара перед запросом статусов
        // НЕ используем переданную цену - она может быть устаревшей
        // Для получения статусов поднятия нужно использовать ОРИГИНАЛЬНУЮ цену (rawPrice), а не цену со скидкой
        let currentPrice = Number(price) || 0
        try {
          const currentItem = await requestItemById(token, userAgent, itemId)
          if (currentItem) {
            // Приоритет: rawPrice (оригинальная цена) > price (цена со скидкой)
            const itemPrice = typeof currentItem.rawPrice === 'number' && currentItem.rawPrice > 0
              ? currentItem.rawPrice
              : typeof currentItem.price === 'number' && currentItem.price > 0
                ? currentItem.price
                : null
            if (itemPrice != null && itemPrice > 0) {
              currentPrice = itemPrice
              console.info('[item-priority-statuses] текущая цена обновлена (rawPrice для статусов)', {
                itemId,
                oldPrice: Number(price) || 0,
                currentPrice,
                discountedPrice: currentItem.price,
                rawPrice: currentItem.rawPrice,
              })
            }
          }
        } catch (err) {
          // Если не удалось получить актуальную цену, используем переданную
          console.warn('[item-priority-statuses] не удалось получить текущую цену', {
            itemId,
            error: err?.message,
            usingProvidedPrice: currentPrice,
          })
        }
        
        const list = await fetchItemPriorityStatuses(token, userAgent, itemId, currentPrice)
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
          const tokenHash = token
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
        // Оптимизация: сначала загружаем только сделки, без активных/завершённых лотов
        const { deals } = await fetchInProgressDealsFromPlayerok(token, userAgent)

        const getCategoryFromProductKey = (productKey) => {
          if (!productKey || typeof productKey !== 'string') return null
          const sepIndex = productKey.indexOf('::')
          if (sepIndex <= 0) return null
          const gameFromPk = productKey.slice(0, sepIndex).trim()
          return gameFromPk || null
        }

        const inferFallbackCategoryFromTitle = (productTitle) => {
          if (!productTitle || typeof productTitle !== 'string') return null
          const title = productTitle.trim()
          if (!title) return null
          const commonGames = [
            'Clash of Clans', 'Clash Royale', 'Brawl Stars', 'Hay Day', 'Boom Beach',
            'PUBG', 'PUBG Mobile', 'Call of Duty', 'Free Fire', 'Fortnite',
            'CS:GO', 'CS2', 'Counter-Strike', 'Dota 2', 'League of Legends',
            'Valorant', 'Apex Legends', 'Genshin Impact', 'Honkai', 'Star Rail',
            'World of Tanks', 'World of Warships', 'War Thunder',
            'Minecraft', 'Roblox', 'Among Us', 'Fall Guys', 'Mobile Legends',
            'Wild Rift', 'Arena of Valor', 'Heroes of the Storm', 'Overwatch',
            'YouTube', 'Claude', 'ChatGPT', 'ЧатГПТ', 'Telegram', 'Discord'
          ]
          for (const game of commonGames) {
            if (title.toLowerCase().includes(game.toLowerCase())) {
              return game
            }
          }
          const words = title.split(/\s+/).filter(w => w.length > 0)
          if (words.length === 0) return null
          let candidate = words.slice(0, 3).join(' ')
          if (candidate.length > 50) candidate = candidate.substring(0, 50).trim()
          return candidate || null
        }

        // Сначала пытаемся определить категории из точных источников без дополнительных API запросов.
        const dealsNeedingMapping = []
        const list = deals.map((d) => {
          const categoryFromProductKey = getCategoryFromProductKey(d.productKey)
          let category = categoryFromProductKey || (d.category && String(d.category).trim()) || null

          // Если точной категории из productKey нет, даём точному маппингу по itemId/title шанс
          // переопределить грубую категорию, пришедшую из sales.
          if (!categoryFromProductKey && (d.itemId || d.productTitle)) {
            dealsNeedingMapping.push(d)
          }

          return {
            id: d.id,
            itemId: d.itemId || null,
            status: d.status || null,
            productKey: d.productKey,
            productTitle: d.productTitle,
            category: category || null,
            soldAt: d.soldAt || 0,
            price: Number(d.price) || 0,
            buyerName: d.buyerName || null,
            // Почту Supercell ID подтягиваем при запросе чата (/deal-chat-messages),
            // чтобы не делать по /in-progress-deals N дополнительных запросов deal-by-id и не ловить rate limit.
            buyerSupercellEmail: null,
            chatId: d.chatId || null,
          }
        })

        // Логирование для отладки категорий
        const dealsWithoutCategory = list.filter(d => !d.category || (typeof d.category === 'string' && !d.category.trim()) || d.category === 'Общий чат')
        if (dealsWithoutCategory.length > 0) {
          console.log('[in-progress-deals] сделки без категории или с fallback:', {
            count: dealsWithoutCategory.length,
            total: list.length,
            deals: dealsWithoutCategory.map(d => ({
              id: d.id,
              category: d.category,
              productKey: d.productKey,
              productTitle: d.productTitle,
              itemId: d.itemId
            }))
          })
        }
        
        // Загружаем активные/завершённые лоты только если есть сделки без категорий
        if (dealsNeedingMapping.length > 0) {
          try {
            const [{ items: activeItems }, { items: completedItems }] = await Promise.all([
              fetchActiveItemsFromPlayerok(token, userAgent),
              fetchCompletedItemsFromPlayerok(token, userAgent),
            ])
            
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
                if (!titleToGame.has(title)) titleToGame.set(title, game)
              }
            }
            
            console.log('[in-progress-deals] маппинг категорий:', {
              itemIdToGameSize: itemIdToGame.size,
              titleToGameSize: titleToGame.size,
              dealsNeedingMapping: dealsNeedingMapping.length
            })

            // Обновляем категории для сделок, которым нужен точный маппинг.
            for (const deal of dealsNeedingMapping) {
              const dealIndex = list.findIndex((d) => d.id === deal.id)
              if (dealIndex === -1) continue

              const existingCategory =
                (list[dealIndex].category && String(list[dealIndex].category).trim()) || null
              const mappedByItemId =
                deal.itemId != null ? itemIdToGame.get(String(deal.itemId)) || null : null
              const mappedByTitle =
                deal.productTitle ? titleToGame.get(String(deal.productTitle).trim()) || null : null

              let category =
                mappedByItemId ||
                mappedByTitle ||
                getCategoryFromProductKey(deal.productKey) ||
                existingCategory ||
                null

              if (!category) {
                category = inferFallbackCategoryFromTitle(deal.productTitle)
              }
              if (!category) {
                category = 'Общий чат'
              }

              // Обновляем категорию в списке
              if (category) {
                list[dealIndex].category = category
                console.log('[in-progress-deals] категория обновлена для сделки:', {
                  dealId: deal.id,
                  category,
                  source:
                    mappedByItemId
                      ? 'itemIdToGame'
                      : mappedByTitle
                        ? 'titleToGame'
                        : getCategoryFromProductKey(deal.productKey)
                          ? 'productKey'
                          : existingCategory
                            ? 'sales'
                            : 'fallback'
                })
              }
            }
          } catch (mappingErr) {
            // Если маппинг не удался, продолжаем с уже определёнными категориями
            console.warn('[in-progress-deals] не удалось сопоставить категории', { error: mappingErr?.message })
          }
        }

        for (const deal of list) {
          const normalizedCategory =
            (deal.category && String(deal.category).trim()) ||
            inferFallbackCategoryFromTitle(deal.productTitle) ||
            'Общий чат'
          deal.category = normalizedCategory
        }

        // Финальная проверка: все сделки должны иметь категорию
        const allDealsHaveCategory = list.every(d => d.category && typeof d.category === 'string' && d.category.trim())
        if (!allDealsHaveCategory) {
          console.error('[in-progress-deals] КРИТИЧЕСКАЯ ОШИБКА: не все сделки имеют категорию перед отправкой:', {
            total: list.length,
            withoutCategory: list.filter(d => !d.category || (typeof d.category === 'string' && !d.category.trim())).length
          })
        }
        
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
        let viewer = null
        try {
          viewer = await withRetry(
            () => getViewer(token, userAgent),
            { label: 'getViewer(deal-chat-messages)', retries: 2, shouldRetry: isPlayerokRateLimitError }
          )
        } catch (_) {
          viewer = null
        }
        const { messages, buyerSupercellEmail, itemTitle, itemImageUrl } = await fetchDealChatMessagesFromPlayerok(
          token,
          userAgent,
          dealId,
          chatId,
          { viewerUsername: viewer?.username || null }
        )
        
        // Немедленная обработка Supercell flow для этого чата, если он активен
        if (chatId) {
          const tokenHash = token
          const flowMap = autolistGetSupercellFlowMap(tokenHash)
          const state = flowMap[String(chatId)]
          if (state && state.active) {
            // Запускаем обработку асинхронно, не блокируя ответ клиенту
            const nowTs = Math.floor(Date.now() / 1000)
            processSingleSupercellFlow(chatId, token, userAgent, viewer?.username || null, nowTs).catch((err) => {
              console.warn('[deal-chat-messages] немедленная обработка supercell flow не удалась', {
                chatId,
                dealId,
                error: err?.message || String(err),
              })
            })
          }
        }
        
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

  if (req.method === 'POST' && pathname === '/api/playerok/request-supercell-code') {
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
      const email = String(payload.email || '').trim()
      const category = String(payload.category || '').trim()

      if (!token) {
        return sendJson(res, 400, { error: 'token is required' })
      }
      if (!dealId && !chatId) {
        return sendJson(res, 400, { error: 'dealId or chatId is required' })
      }
      if (!email) {
        return sendJson(res, 400, { error: 'email is required' })
      }
      if (!getSupercellGameByCategory(category)) {
        return sendJson(res, 400, { error: 'Категория не поддерживает запрос кода Supercell' })
      }

      try {
        const result = await requestSupercellCodeForChat({
          token,
          userAgent,
          dealId,
          chatId,
          email,
          category,
        })
        return sendJson(res, 200, result)
      } catch (err) {
        return sendJson(res, 500, {
          error: err && err.message ? String(err.message) : 'Не удалось запросить код Supercell',
        })
      }
    })
    return
  }

  if (req.method === 'POST' && pathname === '/api/playerok/request-supercell-code-test') {
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

      const email = String(payload.email || '').trim()
      const category = String(payload.category || '').trim()
      if (!email) {
        return sendJson(res, 400, { error: 'email is required' })
      }

      const game = getSupercellGameByCategory(category)
      if (!game) {
        return sendJson(res, 400, { error: 'Категория не поддерживается' })
      }

      try {
        const result = await runSupercellRequestCode({
          email,
          gameKey: game.gameKey,
        })
        return sendJson(res, 200, {
          ok: true,
          email,
          category,
          gameKey: game.gameKey,
          gameName: game.gameName,
          statusCode: result?.status_code || null,
          supercell: result,
        })
      } catch (err) {
        return sendJson(res, 500, {
          error: err && err.message ? String(err.message) : 'Не удалось запросить код Supercell',
        })
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
  console.log('[autolist] фоновое задание запланировано (интервал: 15 с)')
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
  console.log('[autobump] фоновое задание запланировано (интервал: 15 с)')
  setInterval(async () => {
    try {
      const row = getStoredToken.get()
      if (!row || !row.token) return
      const token = row.token
      const userAgent = DEFAULT_USER_AGENT
      const tokenHash = token

      const [settingsRows, bumpRows, salesRows, activeResult] = await Promise.all([
        Promise.resolve(getAllSettings.all()),
        Promise.resolve(getBumpHistory.all()),
        Promise.resolve(getSalesHistoryAll.all()),
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
        if (!s?.autobump?.enabled || !Array.isArray(s.autobump.schedule) || s.autobump.schedule.length === 0) {
          continue
        }
        const lot = activeLotByKey[key]
        if (!lot) {
          continue
        }

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
        if (!active) {
          continue
        }

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

        if (nextBumpTs > windowEndTs) {
          continue
        }
        if (nowTs < nextBumpTs) {
          continue
        }

        const lastAttempt = autobumpLastAttemptByKey[key] || 0
        if (nowTs - lastAttempt < 60) {
          continue
        }
        autobumpLastAttemptByKey[key] = nowTs

        // НЕ передаем priorityStatusId из настроек - endpoint /api/playerok/bump всегда получает актуальный список статусов
        const res = await postLocal('/api/playerok/bump', {
          token,
          userAgent,
          productKey: key,
          productTitle: lot.title || 'Товар',
          itemId: lot.id,
          price: Number(lot.price) || 0,
          // priorityStatusId не передается - всегда используется актуальный список статусов
        })
        if (res.ok && res.bumpedAt) {
          lastBumpByKey[key] = res.bumpedAt
        } else {
          console.warn('[autobump-tick] поднятие не удалось', { key, res })
        }
      }
    } catch (err) {
      // Обработка ошибок Redis OOM и других
      const errMsg = err?.message || String(err || '')
      if (errMsg.includes('OOM') || errMsg.includes('maxmemory')) {
        console.warn('[autobump-tick] Redis OOM — пропуск этого тика', { error: errMsg })
      } else {
        console.error('[autobump-tick] ошибка', err)
      }
    }
  }, 15000)
})

