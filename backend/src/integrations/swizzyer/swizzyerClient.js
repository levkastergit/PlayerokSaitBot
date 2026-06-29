'use strict'

const crypto = require('crypto')

// ---------------------------------------------------------------------------
// Клиент Swizzyer Public API (https://rbcode.net/v1) — headless-выдача Roblox
// Robux. Используем Режим B (диалоговый): создаём заказ с credentials
// покупателя, ведём 2FA по REST через next_action / respond, опрашиваем статус.
//
// Аутентификация: заголовок `Authorization: Bearer swz_live_...`.
// POST /orders и POST /orders/:id/verification/respond ОБЯЗАТЕЛЬНО требуют
// заголовок Idempotency-Key (иначе 400 idempotency_key_required).
//
// Документация — файл `swizzer` в корне репозитория.
// ---------------------------------------------------------------------------

const DEFAULT_BASE = 'https://rbcode.net/v1'
const SWIZZYER_FETCH_TIMEOUT_MS = Math.max(3000, Number(process.env.SWIZZYER_FETCH_TIMEOUT_MS) || 30000)

// Терминальные статусы заказа.
const SWIZZYER_TERMINAL_STATUSES = new Set([
  'completed',
  'partially_delivered',
  'failed',
  'cancelled',
  'expired',
])
// Статусы, означающие хотя бы частичную успешную доставку.
const SWIZZYER_SUCCESS_STATUSES = new Set(['completed', 'partially_delivered'])

function getBaseUrl() {
  const raw = process.env.SWIZZYER_API_BASE || DEFAULT_BASE
  return String(raw).trim().replace(/\/+$/, '') || DEFAULT_BASE
}

// --- i18n -------------------------------------------------------------------

/** Достаёт строку из i18n-объекта { en, ru, zh } (или возвращает строку как есть). */
function pickI18n(value, lang = 'ru') {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object') {
    return String(value[lang] || value.ru || value.en || Object.values(value)[0] || '')
  }
  return String(value)
}

// --- Ошибки -----------------------------------------------------------------

function buildSwizzyerError(json, status) {
  const errObj = json && typeof json === 'object' ? json.error : null
  const code = errObj && errObj.code ? String(errObj.code) : ''
  const message = errObj ? pickI18n(errObj.message, 'ru') : ''
  const err = new Error(message || code || `Swizzyer HTTP ${status}`)
  err.swizzyerCode = code
  err.httpStatus = status
  err.swizzyerBody = json
  err.requestId = errObj && errObj.request_id ? String(errObj.request_id) : null
  return err
}

/** Проверка кода ошибки Swizzyer (error.code), устойчивая к null. */
function isSwizzyerErrorCode(err, ...codes) {
  if (!err) return false
  const code = String(err.swizzyerCode || '')
  return codes.some((c) => c === code)
}

/** Транзиентная ошибка — безопасно повторить тот же запрос (с тем же Idempotency-Key). */
function isSwizzyerTransientError(err) {
  if (!err) return false
  if (isSwizzyerErrorCode(err, 'service_unavailable', 'rate_limit_exceeded')) return true
  const status = Number(err.httpStatus || 0)
  if (status === 429 || status === 503) return true
  return /таймаут|timeout|ECONNRESET|ETIMEDOUT|fetch failed/i.test(String(err.message || ''))
}

// --- HTTP -------------------------------------------------------------------

async function swizzyerFetch(apiKey, method, path, { body, idempotencyKey } = {}) {
  const key = String(apiKey || '').trim()
  if (!key) throw new Error('Swizzyer API key is not configured')

  const url = `${getBaseUrl()}/${String(path || '').replace(/^\/+/, '')}`
  const headers = {
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
  }
  const init = { method, headers }
  if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey).slice(0, 255)
  if (body != null) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }

  let res
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(SWIZZYER_FETCH_TIMEOUT_MS) })
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      const err = new Error(`Swizzyer: таймаут запроса ${SWIZZYER_FETCH_TIMEOUT_MS}ms (${method} ${String(path || '')})`)
      err.swizzyerTimeout = true
      throw err
    }
    throw e
  }

  let json = null
  try {
    json = await res.json()
  } catch {
    json = null
  }

  if (!res.ok) throw buildSwizzyerError(json, res.status)
  return json
}

// --- Заказы -----------------------------------------------------------------

/**
 * POST /v1/orders. Для Режима B передаём mode:'conversational' и credentials.
 * Возвращает объект заказа с первым next_action.
 */
async function createSwizzyerOrder(apiKey, {
  mode = 'conversational',
  credentials,
  robloxUsername,
  items,
  language = 'ru',
  metadata,
  idempotencyKey,
} = {}) {
  if (!idempotencyKey) throw new Error('createSwizzyerOrder requires idempotencyKey')
  const body = { mode, items: Array.isArray(items) ? items : [] }
  if (credentials && credentials.username) {
    body.credentials = {
      username: String(credentials.username || ''),
      password: String(credentials.password || ''),
    }
  } else if (robloxUsername) {
    body.roblox_username = String(robloxUsername)
  }
  if (language) body.language = language
  if (metadata && typeof metadata === 'object') body.metadata = metadata
  return swizzyerFetch(apiKey, 'POST', 'orders', { body, idempotencyKey })
}

/** GET /v1/orders/:id — текущее состояние заказа (status, current_step, next_action, …). */
async function getSwizzyerOrder(apiKey, orderId) {
  const id = String(orderId || '').trim()
  if (!id) throw new Error('getSwizzyerOrder requires orderId')
  return swizzyerFetch(apiKey, 'GET', `orders/${encodeURIComponent(id)}`)
}

/**
 * POST /v1/orders/:id/verification/respond. body — одна из форм:
 *   { if_version, input }                         — provide_input (digits / recovery_code)
 *   { if_version, choice_id }                     — choose_one
 *   { if_version, choice_ids: [...] }             — choose_many
 *   { if_version, credentials: { username, password } } — credentials_retry
 *   { if_version, action: 'cancel' }              — отмена
 */
async function respondSwizzyerVerification(apiKey, orderId, body, idempotencyKey) {
  const id = String(orderId || '').trim()
  if (!id) throw new Error('respondSwizzyerVerification requires orderId')
  if (!idempotencyKey) throw new Error('respondSwizzyerVerification requires idempotencyKey')
  return swizzyerFetch(apiKey, 'POST', `orders/${encodeURIComponent(id)}/verification/respond`, {
    body,
    idempotencyKey,
  })
}

/** GET /v1/subscription — остаток квоты (каждый заказ = 2 транзакции). */
async function getSwizzyerSubscription(apiKey) {
  return swizzyerFetch(apiKey, 'GET', 'subscription')
}

/** POST /v1/orders/:id/relink — довыдать недоставленный остаток оплаченного частичного заказа. */
async function relinkSwizzyerOrder(apiKey, orderId, body, idempotencyKey) {
  const id = String(orderId || '').trim()
  if (!id) throw new Error('relinkSwizzyerOrder requires orderId')
  if (!idempotencyKey) throw new Error('relinkSwizzyerOrder requires idempotencyKey')
  return swizzyerFetch(apiKey, 'POST', `orders/${encodeURIComponent(id)}/relink`, { body: body || {}, idempotencyKey })
}

// --- Разбор ответов ---------------------------------------------------------

/** Достаёт next_action из ответа create/respond или из объекта заказа (GET). */
function extractSwizzyerNextAction(payload) {
  if (!payload || typeof payload !== 'object') return null
  if (payload.next_action && typeof payload.next_action === 'object') return payload.next_action
  const v = payload.verification
  if (v && typeof v === 'object' && v.next_action && typeof v.next_action === 'object') {
    return v.next_action
  }
  return null
}

function extractSwizzyerStatus(payload) {
  if (!payload || typeof payload !== 'object') return ''
  // status есть на верхнем уровне и в ответе create, и в GET-объекте заказа.
  if (payload.status != null) return String(payload.status).trim()
  if (payload.data && typeof payload.data === 'object' && payload.data.status != null) {
    return String(payload.data.status).trim()
  }
  return ''
}

function isSwizzyerTerminalStatus(status) {
  return SWIZZYER_TERMINAL_STATUSES.has(String(status || '').trim().toLowerCase())
}

function isSwizzyerSuccessStatus(status) {
  return SWIZZYER_SUCCESS_STATUSES.has(String(status || '').trim().toLowerCase())
}

// --- Проверка подписи вебхука ----------------------------------------------

/**
 * Проверка подписи входящего вебхука Swizzyer.
 * Заголовок X-Auth-Donat-Signature: "t=<unix_seconds>,v1=<hex HMAC-SHA256>".
 * Подписываемая строка: `${t}.${rawBody}` (rawBody — СЫРЫЕ байты тела).
 * Возвращает { ok, reason }. Постоянное время сравнения.
 */
function verifySwizzyerWebhook(rawBody, signatureHeader, signingSecret, { toleranceSec = 300 } = {}) {
  const secret = String(signingSecret || '')
  if (!secret) return { ok: false, reason: 'no_secret' }

  const header = String(signatureHeader || '')
  let t = NaN
  let v1 = ''
  for (const part of header.split(',')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const k = part.slice(0, idx).trim()
    const val = part.slice(idx + 1).trim()
    if (k === 't') t = parseInt(val, 10)
    else if (k === 'v1') v1 = val
  }
  if (!Number.isFinite(t) || !v1) return { ok: false, reason: 'bad_header' }

  const nowSec = Math.floor(Date.now() / 1000)
  if (t < nowSec - toleranceSec || t > nowSec + 600) return { ok: false, reason: 'stale_timestamp' }

  const bodyBuf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody == null ? '' : rawBody), 'utf8')
  const payload = Buffer.concat([Buffer.from(`${t}.`, 'utf8'), bodyBuf])
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex')

  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(String(v1), 'utf8')
  if (a.length !== b.length) return { ok: false, reason: 'signature_mismatch' }
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'signature_mismatch' }
  return { ok: true, reason: 'verified', t }
}

module.exports = {
  getBaseUrl,
  pickI18n,
  swizzyerFetch,
  createSwizzyerOrder,
  getSwizzyerOrder,
  respondSwizzyerVerification,
  getSwizzyerSubscription,
  relinkSwizzyerOrder,
  extractSwizzyerNextAction,
  extractSwizzyerStatus,
  isSwizzyerTerminalStatus,
  isSwizzyerSuccessStatus,
  isSwizzyerErrorCode,
  isSwizzyerTransientError,
  buildSwizzyerError,
  verifySwizzyerWebhook,
  SWIZZYER_TERMINAL_STATUSES,
  SWIZZYER_SUCCESS_STATUSES,
}
