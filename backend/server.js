const http = require('http')
const https = require('https')
const crypto = require('crypto')
const path = require('path')
const fs = require('fs')
const { URLSearchParams } = require('url')

const PORT = process.env.PORT || 3000

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
    UNIQUE(token_hash, deal_id)
  )
`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_history_token ON sales_history(token_hash)`)
db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_history_sold_at ON sales_history(sold_at DESC)`)

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

const insertBump = db.prepare(`
  INSERT INTO bump_history (token_hash, product_key, product_title, bumped_at, price)
  VALUES (?, ?, ?, ?, ?)
`)
const getBumpHistory = db.prepare(`
  SELECT product_key, product_title, bumped_at, price FROM bump_history
  WHERE token_hash = ? ORDER BY bumped_at DESC LIMIT 500
`)

const insertSale = db.prepare(`
  INSERT OR IGNORE INTO sales_history
    (token_hash, product_key, product_title, sold_at, price, status, deal_id, item_id)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`)
const getSalesHistory = db.prepare(`
  SELECT product_key, product_title, sold_at, price, status
  FROM sales_history
  WHERE token_hash = ?
  ORDER BY sold_at DESC
  LIMIT 500
`)

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

const AUTOLIST_LAST_CHAT_FRESH_SEC = 90

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
        resolve(item)
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
        const deals = edges
          .map((edge) => edge && edge.node)
          .filter(Boolean)
          .map((node) => {
            const item = node.item || {}
            const game = item.game?.name || ''
            const title = item.name || item.title || 'Товар'
            const price = node.transaction?.value ?? item.price ?? node.price ?? 0
            const toTs = (v) => {
              if (v == null) return 0
              if (typeof v === 'number') return v
              const d = new Date(v)
              return isNaN(d.getTime()) ? 0 : Math.floor(d.getTime() / 1000)
            }
            return {
              id: node.id,
              status: node.status,
              productKey: game ? `${game}::${title}` : title,
              productTitle: title,
              soldAt: toTs(node.completedAt) || toTs(node.createdAt) || 0,
              price: Number(price) || 0,
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
  if (typeof v === 'number') return v
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
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    return res.end()
  }

  if (req.method === 'GET' && req.url === '/') {
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    return res.end('OK\n')
  }

  const parsedUrl = new URL(req.url || '/', `http://localhost:${PORT}`)
  const pathname = parsedUrl.pathname
  const query = Object.fromEntries(parsedUrl.searchParams)
  const nowTs = Math.floor(Date.now() / 1000)

  if (req.method === 'GET' && pathname === '/api/product-settings') {
    const token = query.token
    const productKey = query.productKey
    if (!token || productKey == null || productKey === '') {
      return sendJson(res, 400, { error: 'token and productKey are required' })
    }
    try {
      const row = getSettings.get(hashToken(token), String(productKey))
      if (!row) {
        return sendJson(res, 200, { settings: null })
      }
      let settings
      try {
        settings = JSON.parse(row.settings)
      } catch {
        settings = null
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
      const settingsStr = typeof settings === 'object' && settings !== null
        ? JSON.stringify(settings)
        : '{}'
      const updatedAt = Math.floor(Date.now() / 1000)
      try {
        upsertSettings.run(hashToken(token), String(productKey), settingsStr, updatedAt)
        return sendJson(res, 200, { ok: true, updated_at: updatedAt })
      } catch (err) {
        return sendJson(res, 500, { error: 'Failed to save settings', details: err.message })
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
      }))
      return sendJson(res, 200, { list })
    } catch (err) {
      return sendJson(res, 500, {
        error: err && err.message ? String(err.message) : 'Failed to load sales history',
      })
    }
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
        const title = (item.name || '').trim()
        const game = (item.game?.name || '').trim()
        const productKey = `${game}::${title}`

        // Записываем продажу в локальную историю, чтобы /history сразу показывал дату продажи из чата
        try {
          const salePrice =
            typeof item.price === 'number'
              ? item.price
              : typeof item.rawPrice === 'number'
                ? item.rawPrice
                : 0
          insertSale.run(
            tokenHash,
            productKey,
            title || 'Товар',
            dealTs || nowTs,
            Number(salePrice) || 0,
            dealStatus || null,
            dealId || null,
            dealItemId || null
          )
        } catch (e) {
          // ignore sale record failure
        }

        // проверяем настройку автовыставления для товара
        let autolistEnabled = false
        try {
          const row = getSettings.get(hashToken(token), String(productKey))
          if (row?.settings) {
            const s = JSON.parse(row.settings)
            autolistEnabled = Boolean(s?.autolist?.enabled)
          }
        } catch (_) {
          // ignore
        }
        if (!autolistEnabled) {
          return sendJson(res, 200, { ok: true, skipped: 'disabled', productKey })
        }

        if (String(itemStatus) !== 'SOLD') {
          return sendJson(res, 200, { ok: true, skipped: 'not_completed_yet', itemStatus })
        }

        const relisted = await publishItem(token, userAgent, dealItemId, {})

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

  sendJson(res, 404, { error: 'Not found' })
})

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`)
})

