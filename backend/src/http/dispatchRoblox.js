const { sendJson } = require('./sendJson')
const { readJsonBody } = require('./readJsonBody')
const {
  handleRobloxAccountsList,
  handleRobloxAccountAdd,
  handleRobloxAccountRefresh,
  handleRobloxAccountDelete,
} = require('../features/roblox/handleRobloxAccounts')
const {
  handleRobloxGamepassInfo,
  handleRobloxDeliverTest,
} = require('../features/roblox/handleRobloxDelivery')
const {
  handleMsAccountsList,
  handleMsAccountAdd,
  handleMsAccountUpdate,
  handleMsAccountDelete,
} = require('../features/roblox/handleMicrosoftAccounts')
const {
  handleOrdersList,
  handleOrderCreate,
  handleOrderCancel,
  handleOrderLogin,
  handleTwofaPage,
  handleTwofaSubmit,
} = require('../features/roblox/handleRobloxOrders')
const { handleWorkerPoll, handleWorkerReport } = require('../features/roblox/handleRobloxWorker')

function readRawBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

function parseFormOrJson(raw) {
  if (!raw) return {}
  const trimmed = String(raw).trim()
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed)
    } catch (_) {
      return {}
    }
  }
  const out = {}
  for (const pair of trimmed.split('&')) {
    if (!pair) continue
    const idx = pair.indexOf('=')
    const k = idx >= 0 ? pair.slice(0, idx) : pair
    const v = idx >= 0 ? pair.slice(idx + 1) : ''
    try {
      out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '))
    } catch (_) {
      out[k] = v
    }
  }
  return out
}

function sendHtml(res, statusCode, html) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.end(html)
  return true
}

// Эндпоинты вкладки «Роблокс»:
//   /api/roblox/*  — приватные (владелец, по сессии): аккаунты, MS-аккаунты, заказы, game-pass тест.
//   /roblox/2fa/*  — публичные: hosted-страница 2FA для покупателя (без сессии сайта).
//   /roblox/worker/* — Windows-воркер (аутентификация по X-Worker-Token).
async function dispatchRoblox({ req, res, pathname, currentUserId, deps }) {
  const isApi = pathname.startsWith('/api/roblox/')
  const isPublic = pathname.startsWith('/roblox/')
  if (!isApi && !isPublic) return false

  // ── Публичная hosted-страница 2FA ────────────────────────────────────────
  if (isPublic && /^\/roblox\/2fa\/[a-f0-9]+$/i.test(pathname)) {
    const token = pathname.split('/').pop()
    if (req.method === 'GET') {
      const result = await handleTwofaPage({ token, deps })
      return sendHtml(res, result.statusCode, result.html)
    }
    if (req.method === 'POST') {
      const raw = await readRawBody(req)
      const body = parseFormOrJson(raw)
      const result = await handleTwofaSubmit({ token, code: body.code, deps })
      return sendHtml(res, result.statusCode, result.html)
    }
  }

  // ── Windows-воркер (X-Worker-Token) ─────────────────────────────────────
  if (isPublic && pathname.startsWith('/roblox/worker/')) {
    const expected = String(process.env.ROBLOX_WORKER_TOKEN || '').trim()
    const provided = String(req.headers['x-worker-token'] || '').trim()
    if (!expected || !provided || provided !== expected) {
      return sendJson(res, 401, { ok: false, error: 'worker unauthorized' }) || true
    }
    if (req.method === 'POST' && pathname === '/roblox/worker/poll') {
      const body = await readJsonBody(req, { fallback: {} })
      const result = await handleWorkerPoll({ workerId: body && body.workerId, deps })
      return sendJson(res, result.statusCode, result.data) || true
    }
    if (req.method === 'POST' && pathname === '/roblox/worker/report') {
      const body = await readJsonBody(req, { fallback: {} })
      const result = await handleWorkerReport({ payload: body, deps })
      return sendJson(res, result.statusCode, result.data) || true
    }
    return sendJson(res, 404, { ok: false, error: 'unknown worker route' }) || true
  }

  if (!isApi) return false

  // ── Игровые (game-pass) аккаунты ─────────────────────────────────────────
  const apiRoutes = [
    ['GET', '/api/roblox/accounts', () => handleRobloxAccountsList({ currentUserId, deps })],
    ['POST', '/api/roblox/accounts/add', (p) => handleRobloxAccountAdd({ payload: p, currentUserId, deps })],
    ['POST', '/api/roblox/accounts/refresh', (p) => handleRobloxAccountRefresh({ payload: p, currentUserId, deps })],
    ['POST', '/api/roblox/accounts/delete', (p) => handleRobloxAccountDelete({ payload: p, currentUserId, deps })],
    ['POST', '/api/roblox/gamepass-info', (p) => handleRobloxGamepassInfo({ payload: p })],
    ['POST', '/api/roblox/deliver-test', (p) => handleRobloxDeliverTest({ payload: p, currentUserId, deps })],
    // Microsoft-аккаунты
    ['GET', '/api/roblox/ms-accounts', () => handleMsAccountsList({ currentUserId, deps })],
    ['POST', '/api/roblox/ms-accounts/add', (p) => handleMsAccountAdd({ payload: p, currentUserId, deps })],
    ['POST', '/api/roblox/ms-accounts/update', (p) => handleMsAccountUpdate({ payload: p, currentUserId, deps })],
    ['POST', '/api/roblox/ms-accounts/delete', (p) => handleMsAccountDelete({ payload: p, currentUserId, deps })],
    // Заказы
    ['GET', '/api/roblox/orders', () => handleOrdersList({ currentUserId, deps })],
    ['POST', '/api/roblox/orders/create', (p) => handleOrderCreate({ payload: p, currentUserId, deps })],
    ['POST', '/api/roblox/orders/login', (p) => handleOrderLogin({ payload: p, currentUserId, deps })],
    ['POST', '/api/roblox/orders/cancel', (p) => handleOrderCancel({ payload: p, currentUserId, deps })],
  ]

  for (const [method, route, handler] of apiRoutes) {
    if (req.method === method && pathname === route) {
      try {
        const payload = method === 'POST' ? await readJsonBody(req, { fallback: {} }) : null
        const result = await handler(payload)
        return sendJson(res, result.statusCode, result.data) || true
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err && err.message ? String(err.message) : 'roblox request failed' }) || true
      }
    }
  }

  return false
}

module.exports = { dispatchRoblox }
