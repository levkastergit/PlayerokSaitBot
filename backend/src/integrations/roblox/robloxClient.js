'use strict'

// Клиент к публичным API Roblox для метода MS Store: общие операции над аккаунтом по
// cookie .ROBLOSECURITY:
//  1) валидация cookie → кто это (id/ник),
//  2) баланс Robux аккаунта,
//  3) Premium / аватарка для отображения.
// Используется при добавлении аккаунта по cookie и при сохранении сессии покупателя
// (handleRobloxOrders.finalizeBuyerSession). Запросы идут напрямую к Roblox, обычным https.

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

module.exports = {
  normalizeCookie,
  getAuthenticatedUser,
  getRobuxBalance,
  getPremium,
  getAvatarHeadshotUrl,
}
