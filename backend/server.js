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

// Аутентификация: логин и пароль из .env (AUTH_LOGIN, AUTH_PASSWORD)
const AUTH_LOGIN = (process.env.AUTH_LOGIN || '').trim()
const AUTH_PASSWORD = process.env.AUTH_PASSWORD == null ? '' : String(process.env.AUTH_PASSWORD)
const AUTH_ENABLED = AUTH_LOGIN !== ''

const SESSION_TTL_MS = 24 * 60 * 60 * 1000 // 24 часа
const sessions = new Map() // sessionId -> { expiresAt }

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
db.exec(`
  CREATE TABLE IF NOT EXISTS bump_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL,
    product_key TEXT NOT NULL,
    product_title TEXT NOT NULL,
    bumped_at INTEGER NOT NULL,
    price REAL NOT NULL DEFAULT 0
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
  INSERT INTO bump_history (token_hash, product_key, product_title, bumped_at, price)
  VALUES (?, ?, ?, ?, ?)
`)
const getBumpHistory = db.prepare(`
  SELECT product_key, product_title, bumped_at, price FROM bump_history
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

const getStoredToken = db.prepare(`
  SELECT token, updated_at FROM tokens WHERE id = 1
`)
const upsertStoredToken = db.prepare(`
  INSERT INTO tokens (id, token, updated_at)
  VALUES (1, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    token = excluded.token,
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

const AUTOLIST_LAST_CHAT_FRESH_SEC = 90

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
    const k = row.product_key
    if (!listingFeesByProduct[k]) listingFeesByProduct[k] = []
    listingFeesByProduct[k].push({ relistedAt: row.relisted_at, fee: Number(row.fee) || 0 })
  }
  for (const k of Object.keys(listingFeesByProduct)) {
    listingFeesByProduct[k].sort((a, b) => b.relistedAt - a.relistedAt)
  }

  const bumpsByProduct = {}
  for (const b of bumpsRows || []) {
    const k = b.product_key
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
    const soldAt = row.sold_at
    const salePrice = Number(row.price) || 0
    const isRefund = (row.is_refund || 0) === 1

    const s =
      settingsByKey[productKey] ||
      settingsByKey[normalizeProductKey(productKey)] ||
      {}
    const cost = typeof s.cost === 'number' ? s.cost : (parseFloat(s.cost) || 0)

    const productListingFees = listingFeesByProduct[productKey] || []
    const listingCost = productListingFees.find((lf) => lf.relistedAt < soldAt)?.fee ?? 0

    const prevSold = prevSoldByKey[productKey] || 0
    const productBumps = bumpsByProduct[productKey] || []
    let bumpCost = 0
    for (const b of productBumps) {
      if (b.bumpedAt > prevSold && b.bumpedAt <= soldAt) {
        bumpCost += b.price
      }
    }
    prevSoldByKey[productKey] = soldAt

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
          transactionProviderId: 'LOCAL',
          transactionProviderData: { paymentMethodId: null },
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

function requestUserChatsPage(token, userAgent, userId) {
  return new Promise((resolve, reject) => {
    const variables = {
      pagination: { first: 1, after: null },
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

/** Все сообщения чата по chatId или по dealId (если chatId не передан). Подгружаем все страницы. */
async function fetchDealChatMessagesFromPlayerok(token, userAgent, dealId, chatIdFromDeal) {
  let chatId = chatIdFromDeal || null
  if (!chatId && dealId) {
    const fullDeal = await requestDealById(token, userAgent, dealId)
    chatId = fullDeal?.chat?.id || fullDeal?.chatId || null
  }
  if (!chatId) {
    return { messages: [], buyerSupercellEmail: null }
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

  // Пытаемся определить сделку и вытащить почту Supercell ID из полей сделки
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
  if (effectiveDealId) {
    try {
      const fullDeal = await requestDealById(token, userAgent, effectiveDealId)
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

  return { messages: allMessages, buyerSupercellEmail }
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
      if (login !== AUTH_LOGIN || password !== AUTH_PASSWORD) {
        return sendJson(res, 401, { error: 'Неверный логин или пароль' })
      }
      const sessionId = createSession()
      res.setHeader('Set-Cookie', `session=${sessionId}; Path=/; HttpOnly; Max-Age=86400; SameSite=Lax`)
      return sendJson(res, 200, { ok: true, sessionToken: sessionId })
    })
    return
  }

  // Требуем сессию для всех остальных /api/* при включённой аутентификации
  if (AUTH_ENABLED && pathname.startsWith('/api/')) {
    const sessionId = getSessionIdFromRequest(req)
    if (!sessionId || !isSessionValid(sessionId)) {
      return sendJson(res, 401, { error: 'Unauthorized' })
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
      const row = getStoredToken.get()
      if (!row) {
        return sendJson(res, 200, { token: null, updated_at: null })
      }
      return sendJson(res, 200, { token: row.token, updated_at: row.updated_at })
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
          return sendJson(res, 200, { ok: true, token: null, updated_at: null })
        }
        upsertStoredToken.run(token, updatedAt)
        return sendJson(res, 200, { ok: true, token, updated_at: updatedAt })
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
    const token = query.token
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
    const token = query.token
    if (!token) {
      return sendJson(res, 400, { error: 'token is required' })
    }
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
    const token = query.token
    if (!token) {
      return sendJson(res, 400, { error: 'token is required' })
    }
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
      const token = payload.token
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
      const token = payload.token
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
      const token = payload.token
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

      const token = payload.token
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

  if (req.method === 'GET' && pathname === '/api/sales-history') {
    const token = query.token
    if (!token) {
      return sendJson(res, 400, { error: 'token is required' })
    }
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
      const token = payload.token
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
      const token = payload.token
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
      const token = payload.token
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
    const token = query.token
    if (!token) {
      return sendJson(res, 400, { error: 'token is required' })
    }
    try {
      const rows = getBumpHistory.all(hashToken(token))
      const list = rows.map((row) => ({
        productKey: row.product_key,
        productTitle: row.product_title,
        bumpedAt: row.bumped_at,
        price: row.price ?? 0,
      }))
      return sendJson(res, 200, { list })
    } catch (err) {
      return sendJson(res, 500, { error: 'Failed to load bump history', details: err.message })
    }
  }

  if (req.method === 'GET' && pathname === '/api/profit-analytics/meta') {
    const token = query.token
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
    const token = query.token
    if (!token) {
      return sendJson(res, 400, { error: 'token is required' })
    }
    try {
      const tokenHash = hashToken(token)
      const salesRows = getSalesHistoryAll.all(tokenHash)
      const bumpsRows = getBumpHistory.all(tokenHash)
      const settingsRows = getAllSettings.all(tokenHash)
      const listingFeesRows = getListingFees.all(tokenHash)
      const allList = computeProfitAnalyticsList({ salesRows, bumpsRows, settingsRows, listingFeesRows })

      const year = parseIntSafe(query.year, null)
      const month = parseIntSafe(query.month, null)
      const filtered =
        year == null
          ? allList
          : allList.filter((it) => {
            if (!it?.soldAt) return false
            const d = new Date(it.soldAt * 1000)
            const y = d.getFullYear()
            const m = d.getMonth() + 1
            if (y !== year) return false
            if (month != null && m !== month) return false
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
    const token = query.token
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
      const list =
        year == null
          ? allList
          : allList.filter((it) => {
            if (!it?.soldAt) return false
            const d = new Date(it.soldAt * 1000)
            const y = d.getFullYear()
            const m = d.getMonth() + 1
            if (y !== year) return false
            if (month != null && m !== month) return false
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
      const token = payload.token
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

        insertBump.run(tokenHash, String(productKey), String(productTitle), bumpedAt, Number(price) || 0)
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
      const token = payload.token
      const userAgent = payload.userAgent
      if (!token) return sendJson(res, 400, { error: 'Token is required' })

      const tokenHash = hashToken(token)
      try {
        const viewer = await getViewer(token, userAgent)

        const chatsData = await requestUserChatsPage(token, userAgent, viewer.id)
        const lastChat = chatsData?.edges?.[0]?.node || null
        if (!lastChat) {
          return sendJson(res, 200, { ok: true, skipped: 'no_last_chat' })
        }

        const lastMessage = lastChat.lastMessage || null
        const lastMessageId = lastMessage?.id || null
        const lastMessageCreatedAt = lastMessage?.createdAt || null
        const deal = lastMessage?.deal || null
        const dealId = deal?.id || null
        const dealDirection = deal?.direction || null
        const dealStatus = deal?.status || null
        const dealItemId = deal?.item?.id || null

        if (!dealItemId || (dealDirection && String(dealDirection) !== 'OUT')) {
          return sendJson(res, 200, { ok: true, skipped: 'no_recent_sale_in_last_chat' })
        }

        // Время продажи берём из сделки (deal.createdAt), а не из lastMessage — иначе при новом сообщении в чате (13:27) записали бы 13:27 вместо реального времени покупки (13:09)
        const fullDeal = await requestDealById(token, userAgent, dealId)
        const dealTs =
          fullDeal
            ? toUnixTs(fullDeal.createdAt) || toUnixTs(fullDeal.completedAt) || 0
            : toUnixTs(lastMessageCreatedAt)
        const ageSec = dealTs ? nowTs - dealTs : null

        if (!dealTs || (ageSec != null && ageSec > AUTOLIST_LAST_CHAT_FRESH_SEC)) {
          return sendJson(res, 200, { ok: true, skipped: 'old' })
        }

        // защита от повторной обработки одного и того же события
        global.__autolistLastProcessedByTokenHash = global.__autolistLastProcessedByTokenHash || {}
        const lastProcessedKey = String(tokenHash)
        const lastProcessed = global.__autolistLastProcessedByTokenHash[lastProcessedKey] || {}
        const eventKey = dealId || lastMessageId || dealItemId
        if (lastProcessed.eventKey === eventKey) {
          return sendJson(res, 200, { ok: true, skipped: 'already_processed' })
        }

        const item = await requestItemById(token, userAgent, dealItemId)
        if (!item) {
          return sendJson(res, 200, { ok: true, skipped: 'item_not_found' })
        }

        const itemStatus = item.status || null
        const title = normalizeKeyPart(item.name || '')
        const game = normalizeKeyPart(item.game?.name || '')
        const productKey = buildProductKey(game, title)

        // Записываем продажу в локальную историю, чтобы /history сразу показывал дату продажи из чата
        try {
          const salePrice =
            typeof item.price === 'number'
              ? item.price
              : typeof item.rawPrice === 'number'
                ? item.rawPrice
                : 0
          let buyerName = null
          try {
            const fullDeal = await requestDealById(token, userAgent, dealId)
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
        let autolistEnabled = false
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
          autolistEnabled = Boolean(s.autolist?.enabled)

          // Автосообщение: при покупке отправить сообщения покупателю в чат
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
                await createChatMessage(token, userAgent, lastChat.id, messages[i])
                if (i < messages.length - 1) {
                  await new Promise((r) => setTimeout(r, 800))
                }
              } catch (_) {
                // ignore single message failure
              }
            }
          }

          // Автовыдача: сообщение при покупке (если задано), затем первый код в чат и убрать его из списка
          if (s.autodelivery?.enabled && lastChat?.id) {
            const messageOnPurchase = (s.autodelivery.messageOnPurchase && String(s.autodelivery.messageOnPurchase).trim()) || ''
            if (messageOnPurchase) {
              try {
                await createChatMessage(token, userAgent, lastChat.id, messageOnPurchase)
              } catch (err) {
                console.warn('[autolist-tick] autodelivery messageOnPurchase failed', { error: err?.message })
              }
            }
            if (Array.isArray(s.autodelivery.codes) && s.autodelivery.codes.length > 0) {
            const codeToSend = String(s.autodelivery.codes[0]).trim()
            if (codeToSend) {
              try {
                await createChatMessage(token, userAgent, lastChat.id, codeToSend)
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

        if (!autolistEnabled) {
          global.__autolistLastProcessedByTokenHash[lastProcessedKey] = {
            eventKey,
            processedAt: nowTs,
            oldItemId: dealItemId,
            newItemId: null,
          }
          return sendJson(res, 200, { ok: true, skipped: 'disabled', productKey })
        }

        if (String(itemStatus) !== 'SOLD') {
          return sendJson(res, 200, { ok: true, skipped: 'not_completed_yet', itemStatus })
        }

        const relisted = await publishItem(token, userAgent, dealItemId, {})

        try {
          insertListingFee.run(tokenHash, String(productKey), Number(relisted.listingFee) || 0, nowTs)
        } catch (_) { }

        global.__autolistLastProcessedByTokenHash[lastProcessedKey] = {
          eventKey,
          processedAt: nowTs,
          oldItemId: dealItemId,
          newItemId: relisted.id,
        }

        return sendJson(res, 200, {
          ok: true,
          action: 'relisted',
          oldItemId: dealItemId,
          newItemId: relisted.id,
          productKey,
        })
      } catch (err) {
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
      const token = payload.token
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
      const token = payload.token
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

      const token = payload.token
      const userAgent = payload.userAgent

      if (!token) {
        return sendJson(res, 400, { error: 'Token is required' })
      }

      try {
        const result = await fetchCompletedItemsFromPlayerok(token, userAgent)
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
      const token = payload.token
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

          let supercellEmail = null
          try {
            const fullDeal = await requestDealById(token, userAgent, d.id)
            const fields =
              (fullDeal && Array.isArray(fullDeal.obtainingFields) && fullDeal.obtainingFields) ||
              (fullDeal &&
                fullDeal.item &&
                Array.isArray(fullDeal.item.dataFields) &&
                fullDeal.item.dataFields) ||
              []
            for (const f of fields) {
              const label = (f && typeof f.label === 'string' && f.label) || ''
              const value = (f && Object.prototype.hasOwnProperty.call(f, 'value') && f.value) || null
              if (!value) continue
              const normalized = label.toLowerCase()
              if (
                normalized.includes('supercell') ||
                normalized.includes('super cell') ||
                normalized.includes('super sell') ||
                normalized === 'почта supercell id' ||
                normalized === 'supercell id'
              ) {
                supercellEmail = String(value)
                break
              }
            }
          } catch (_) {
            // ignore details fetch errors
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
            buyerSupercellEmail: supercellEmail,
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
      const token = payload.token
      const userAgent = payload.userAgent
      const dealId = payload.dealId || null
      const chatId = payload.chatId || null
      if (!token || (!dealId && !chatId)) {
        return sendJson(res, 400, { error: 'token and (dealId or chatId) are required' })
      }
      try {
        const { messages, buyerSupercellEmail } = await fetchDealChatMessagesFromPlayerok(
          token,
          userAgent,
          dealId,
          chatId
        )
        return sendJson(res, 200, { list: messages, buyerSupercellEmail })
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
      const token = payload.token
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
      const token = payload.token
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
      const token = payload.token
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
})

