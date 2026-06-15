'use strict'

// Клиент к публичным API Roblox для автовыдачи доната методом game-pass (как swizzyer.com):
//  1) валидация cookie .ROBLOSECURITY → кто это (id/ник),
//  2) баланс Robux аккаунта,
//  3) данные гейм-пасса (цена/продавец/productId),
//  4) покупка гейм-пасса = перевод Robux покупателю (с 30% налогом Roblox).
//
// Запросы идут напрямую к Roblox (не через playerok.com-патч из server.js), обычным https.

const https = require('https')

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'

const REQUEST_TIMEOUT_MS = 20000

// Нормализуем вставленную пользователем cookie: убираем возможный префикс «.ROBLOSECURITY=».
function normalizeCookie(raw) {
  let value = String(raw || '').trim()
  if (!value) return ''
  if (value.toLowerCase().startsWith('.roblosecurity=')) {
    value = value.slice('.roblosecurity='.length)
  }
  // На случай, если вставили целиком заголовок Cookie с несколькими парами.
  const match = value.match(/_\|WARNING:[^;]*/)
  if (match) value = match[0]
  return value.trim()
}

function robloxRequest({ method = 'GET', url, cookie, csrfToken, body }) {
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(url)
    } catch (_) {
      reject(new Error(`Некорректный URL Roblox: ${url}`))
      return
    }

    const payload = body == null ? null : typeof body === 'string' ? body : JSON.stringify(body)
    const headers = {
      'User-Agent': DEFAULT_UA,
      Accept: 'application/json',
    }
    if (cookie) headers.Cookie = `.ROBLOSECURITY=${cookie}`
    if (csrfToken) headers['X-CSRF-TOKEN'] = csrfToken
    if (payload != null) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = Buffer.byteLength(payload)
    }

    const req = https.request(
      {
        method,
        hostname: u.hostname,
        path: u.pathname + (u.search || ''),
        headers,
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try {
            json = text ? JSON.parse(text) : null
          } catch (_) {
            json = null
          }
          resolve({
            status: res.statusCode || 0,
            headers: res.headers || {},
            text,
            json,
          })
        })
      }
    )

    req.on('error', reject)
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('Таймаут запроса к Roblox'))
    })
    if (payload != null) req.write(payload)
    req.end()
  })
}

// Кто залогинен под этой cookie. 401 → cookie невалидна/истекла.
async function getAuthenticatedUser(cookieRaw) {
  const cookie = normalizeCookie(cookieRaw)
  if (!cookie) {
    const err = new Error('Пустая cookie .ROBLOSECURITY')
    err.code = 'EMPTY_COOKIE'
    throw err
  }
  const res = await robloxRequest({ url: 'https://users.roblox.com/v1/users/authenticated', cookie })
  if (res.status === 200 && res.json && res.json.id) {
    return {
      id: Number(res.json.id),
      name: res.json.name || null,
      displayName: res.json.displayName || null,
    }
  }
  if (res.status === 401) {
    const err = new Error('Cookie невалидна или истекла (Roblox 401)')
    err.code = 'INVALID_COOKIE'
    throw err
  }
  throw new Error(`Roblox: не удалось проверить cookie (HTTP ${res.status})`)
}

// Баланс Robux (виден только владельцу cookie — userId должен совпадать с аккаунтом cookie).
async function getRobuxBalance(cookieRaw, userId) {
  const cookie = normalizeCookie(cookieRaw)
  const res = await robloxRequest({
    url: `https://economy.roblox.com/v1/users/${Number(userId)}/currency`,
    cookie,
  })
  if (res.status === 200 && res.json && res.json.robux != null) {
    return Number(res.json.robux) || 0
  }
  if (res.status === 401) {
    const err = new Error('Cookie невалидна или истекла (Roblox 401)')
    err.code = 'INVALID_COOKIE'
    throw err
  }
  throw new Error(`Roblox: не удалось получить баланс (HTTP ${res.status})`)
}

// Есть ли Premium (best-effort, не критично для выдачи).
async function getPremium(cookieRaw, userId) {
  try {
    const cookie = normalizeCookie(cookieRaw)
    const res = await robloxRequest({
      url: `https://premiumfeatures.roblox.com/v1/users/${Number(userId)}/validate-membership`,
      cookie,
    })
    if (res.status === 200) return res.json === true || res.text === 'true'
  } catch (_) {
    // ignore
  }
  return false
}

// URL аватарки-хедшота (публичный эндпоинт, cookie не нужна).
async function getAvatarHeadshotUrl(userId) {
  try {
    const res = await robloxRequest({
      url: `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${Number(
        userId
      )}&size=150x150&format=Png&isCircular=false`,
    })
    const item = res.json && Array.isArray(res.json.data) ? res.json.data[0] : null
    if (item && item.imageUrl) return String(item.imageUrl)
  } catch (_) {
    // ignore
  }
  return null
}

// CSRF-токен для платёжных POST-запросов: любой state-changing эндпоинт без токена
// возвращает 403 + заголовок x-csrf-token (само действие при этом НЕ выполняется).
async function getCsrfToken(cookieRaw) {
  const cookie = normalizeCookie(cookieRaw)
  const res = await robloxRequest({ method: 'POST', url: 'https://auth.roblox.com/v2/logout', cookie })
  const token = res.headers['x-csrf-token'] || res.headers['X-CSRF-TOKEN']
  if (token) return String(token)
  throw new Error('Roblox: не удалось получить CSRF-токен')
}

// Данные гейм-пасса по его id: цена, продавец, productId (нужны для покупки).
async function getGamePassProductInfo(gamePassId) {
  const id = Number(gamePassId)
  if (!Number.isFinite(id) || id <= 0) {
    const err = new Error('Некорректный ID гейм-пасса')
    err.code = 'BAD_GAMEPASS'
    throw err
  }
  const res = await robloxRequest({
    url: `https://apis.roblox.com/game-passes/v1/game-passes/${id}/product-info`,
  })
  if (res.status === 200 && res.json) {
    const j = res.json
    const creator = j.Creator || j.creator || {}
    const price = j.PriceInRobux != null ? j.PriceInRobux : j.priceInRobux
    return {
      gamePassId: id,
      name: j.Name || j.name || null,
      productId: j.ProductId != null ? Number(j.ProductId) : j.productId != null ? Number(j.productId) : null,
      priceInRobux: price != null ? Number(price) : null,
      sellerId:
        creator.Id != null ? Number(creator.Id) : creator.id != null ? Number(creator.id) : null,
      sellerName: creator.Name || creator.name || null,
      isForSale: j.IsForSale != null ? Boolean(j.IsForSale) : j.isForSale != null ? Boolean(j.isForSale) : null,
    }
  }
  if (res.status === 404) {
    const err = new Error('Гейм-пасс не найден')
    err.code = 'GAMEPASS_NOT_FOUND'
    throw err
  }
  throw new Error(`Roblox: не удалось получить данные гейм-пасса (HTTP ${res.status})`)
}

// Покупка гейм-пасса по productId = перевод Robux продавцу (покупателю доната).
// expectedPrice/expectedSellerId защищают от подмены цены/продавца на стороне Roblox.
async function purchaseProduct(cookieRaw, { productId, expectedPrice, expectedSellerId }) {
  const cookie = normalizeCookie(cookieRaw)
  const csrfToken = await getCsrfToken(cookie)
  const res = await robloxRequest({
    method: 'POST',
    url: `https://economy.roblox.com/v1/purchases/products/${Number(productId)}`,
    cookie,
    csrfToken,
    body: {
      expectedCurrency: 1, // 1 = Robux
      expectedPrice: Number(expectedPrice),
      expectedSellerId: Number(expectedSellerId),
    },
  })

  const j = res.json || {}
  const purchased = j.purchased === true
  return {
    httpStatus: res.status,
    purchased,
    // Roblox при отказе кладёт причину в reason/errorMsg/title.
    reason: j.reason || j.errorMsg || j.title || (purchased ? null : `HTTP ${res.status}`),
    price: j.price != null ? Number(j.price) : null,
    raw: j,
  }
}

module.exports = {
  normalizeCookie,
  getAuthenticatedUser,
  getRobuxBalance,
  getPremium,
  getAvatarHeadshotUrl,
  getCsrfToken,
  getGamePassProductInfo,
  purchaseProduct,
}
