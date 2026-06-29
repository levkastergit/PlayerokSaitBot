const { sendJson } = require('./sendJson')
const { readJsonBody } = require('./readJsonBody')
const { listSwizzyerDenominations } = require('../integrations/swizzyer/swizzyerCatalog')
const {
  verifySwizzyerWebhook,
  getSwizzyerSubscription,
} = require('../integrations/swizzyer/swizzyerClient')
const { logApprouteAutodelivery } = require('../debug/approuteAutodeliveryLog')

function readRawBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', () => resolve(Buffer.alloc(0)))
  })
}

// Маршруты Swizzyer (автовыдача Roblox):
//   /api/swizzyer/settings      — приватные (по сессии): сохранить/прочитать ключ+секрет
//   /api/swizzyer/catalog       — приватные: номиналы для выпадающего списка лота
//   /api/swizzyer/subscription  — приватные: остаток квоты (для UI)
//   /swizzyer/webhook/:userId   — публичный приёмник вебхуков (подпись HMAC, без сессии)
async function dispatchSwizzyer({ req, res, pathname, currentUserId, deps = {} }) {
  // ── Публичный вебхук ─────────────────────────────────────────────────────
  const wh = pathname.match(/^\/swizzyer\/webhook\/(\d+)$/)
  if (wh) {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false }) || true
    const userId = Number(wh[1])
    const raw = await readRawBody(req)
    // Всегда отвечаем 2xx (как в примерах доки) — чтобы намеренный дроп не вызывал шторм ретраев.
    try {
      const secret =
        typeof deps.loadSwizzyerWebhookSecretPlain === 'function'
          ? deps.loadSwizzyerWebhookSecretPlain(userId)
          : ''
      if (!secret) {
        return sendJson(res, 200, { ok: true, ignored: 'no_secret' }) || true
      }
      const sig = req.headers['x-auth-donat-signature'] || ''
      const verdict = verifySwizzyerWebhook(raw, sig, secret)
      if (!verdict.ok) {
        logApprouteAutodelivery('swizzyer webhook: rejected', { userId, reason: verdict.reason })
        return sendJson(res, 200, { ok: true, ignored: verdict.reason }) || true
      }
      let event = null
      try {
        event = JSON.parse(raw.toString('utf8'))
      } catch {
        event = null
      }
      const order = event?.data?.object || null
      const orderId = order?.id ? String(order.id) : ''
      const status = order?.status ? String(order.status) : ''
      if (orderId && typeof deps.getSwizzyerOrderByOrderId === 'function') {
        const tracked = deps.getSwizzyerOrderByOrderId(orderId)
        if (tracked && typeof deps.upsertSwizzyerOrder === 'function') {
          deps.upsertSwizzyerOrder(tracked.user_id, tracked.deal_id, {
            orderId,
            status: status || tracked.status || null,
          })
        }
      }
      logApprouteAutodelivery('swizzyer webhook: ok', {
        userId,
        type: event?.type || null,
        orderId: orderId || null,
        status: status || null,
      })
      return sendJson(res, 200, { ok: true }) || true
    } catch (err) {
      logApprouteAutodelivery('swizzyer webhook: error', { userId, error: err?.message || String(err) })
      return sendJson(res, 200, { ok: true, ignored: 'error' }) || true
    }
  }

  if (!pathname.startsWith('/api/swizzyer/')) return false

  // ── Приватные маршруты (currentUserId уже проверен сессией) ───────────────

  // Номиналы для выпадающего списка в настройках лота.
  if (req.method === 'GET' && pathname === '/api/swizzyer/catalog') {
    return sendJson(res, 200, { denominations: listSwizzyerDenominations() }) || true
  }

  // Метаданные настроек (что сконфигурировано) + готовый URL вебхука для дашборда Swizzyer.
  if (req.method === 'GET' && pathname === '/api/swizzyer/settings') {
    const meta =
      typeof deps.getSwizzyerSettingsMeta === 'function'
        ? deps.getSwizzyerSettingsMeta(currentUserId)
        : { apiKeyConfigured: false, webhookConfigured: false, updatedAt: null }
    const base = String(deps.publicBaseUrl || '').replace(/\/+$/, '')
    return (
      sendJson(res, 200, {
        ...meta,
        webhookUrl: base ? `${base}/swizzyer/webhook/${currentUserId}` : null,
      }) || true
    )
  }

  // Сохранить/очистить ключ и/или секрет вебхука.
  if (req.method === 'POST' && pathname === '/api/swizzyer/settings') {
    if (typeof deps.saveSwizzyerSettings !== 'function') {
      return sendJson(res, 500, { error: 'Server misconfiguration' }) || true
    }
    const payload = await readJsonBody(req, { fallback: {} })
    const clear = payload && payload.clear === true
    const args = {}
    if (clear) {
      args.apiKey = ''
      args.webhookSecret = ''
    } else {
      if (Object.prototype.hasOwnProperty.call(payload, 'apiKey')) args.apiKey = String(payload.apiKey || '')
      if (Object.prototype.hasOwnProperty.call(payload, 'webhookSecret')) {
        args.webhookSecret = String(payload.webhookSecret || '')
      }
    }
    if (args.apiKey === undefined && args.webhookSecret === undefined) {
      return sendJson(res, 400, { error: 'apiKey or webhookSecret is required (or clear: true)' }) || true
    }
    try {
      const saved = deps.saveSwizzyerSettings(currentUserId, args)
      return sendJson(res, 200, { ok: true, ...saved, updated_at: saved.updatedAt ?? null }) || true
    } catch (err) {
      return sendJson(res, 500, { error: 'Failed to save Swizzyer settings', details: err?.message || String(err) }) || true
    }
  }

  // Остаток квоты подписки (для отображения в UI).
  if (req.method === 'GET' && pathname === '/api/swizzyer/subscription') {
    const apiKey =
      typeof deps.loadSwizzyerApiKeyPlain === 'function' ? deps.loadSwizzyerApiKeyPlain(currentUserId) : ''
    if (!apiKey) return sendJson(res, 200, { configured: false }) || true
    try {
      const sub = await getSwizzyerSubscription(apiKey)
      return sendJson(res, 200, { configured: true, subscription: sub }) || true
    } catch (err) {
      return sendJson(res, 200, { configured: true, error: err?.swizzyerCode || err?.message || 'request_failed' }) || true
    }
  }

  return false
}

module.exports = { dispatchSwizzyer }
