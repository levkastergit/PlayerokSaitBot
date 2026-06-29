'use strict'

// ---------------------------------------------------------------------------
// Клиент Partner Redemption API (https://admin.rootchatgptplus.com/api/partner/v1)
// — выдача ChatGPT-аккаунтов: один card_code погашается на один account_id.
//
// Поток: POST /redemptions { card_code, account_id, confirm_overwrite } -> 202
//   { data: { order_no, status:'pending' } } -> опрашиваем GET /redemptions/:order_no
//   каждые 2-3 c до терминального статуса (succeeded|failed), максимум ~90 c.
//
// Аутентификация: заголовок Authorization: Bearer ogp_live_...
// Idempotency-Key ОБЯЗАТЕЛЕН и уникален на каждое погашение (повтор с тем же
// ключом и теми же данными возвращает исходный заказ; с другими данными -> 409).
//
// Документация — файл partner-api.md в корне репозитория.
// ---------------------------------------------------------------------------

// Рекомендованный базовый URL (новая дока 含ClaudePro). Легаси
// admin.rootchatgptplus.com тоже работает — переопределяется env PARTNER_GPT_API_BASE.
const DEFAULT_BASE = 'https://rootchatgptplus.com/api/partner/v1'
const PARTNER_GPT_POLL_MAX_MS = Math.max(5000, Number(process.env.PARTNER_GPT_POLL_MAX_MS) || 90000)
const PARTNER_GPT_POLL_INTERVAL_MS = Math.max(500, Number(process.env.PARTNER_GPT_POLL_INTERVAL_MS) || 2500)
const PARTNER_GPT_FETCH_TIMEOUT_MS = Math.max(3000, Number(process.env.PARTNER_GPT_FETCH_TIMEOUT_MS) || 25000)

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

// Плохая карта (наша) — недействительна/использована/просрочена. Такую карту
// помечаем использованной (skip) и берём следующую — НЕ возвращаем в пул.
const BAD_CARD_CODES = new Set([100101, 100102, 100103])
// Нет стока на стороне поставщика — карта норм, вернуть в пул и повторить позже.
const STOCK_FAULT_CODES = new Set([100501])
// Невалидный account_id/organization_id — вина данных покупателя, переспросить.
const ACCOUNT_FAULT_CODES = new Set([40000])
// Терминальные статусы заказа.
const PARTNER_GPT_TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'review'])

function getBaseUrl() {
  const raw = process.env.PARTNER_GPT_API_BASE || DEFAULT_BASE
  return String(raw).trim().replace(/\/+$/, '') || DEFAULT_BASE
}

/** Достаёт ChatGPT account_id (UUID) из произвольного текста покупателя. '' если нет. */
function extractAccountId(text) {
  const m = String(text == null ? '' : text).match(UUID_RE)
  return m ? m[0].toLowerCase() : ''
}

function buildPartnerGptError(json, status) {
  const code = json && (json.code != null) ? Number(json.code) : null
  const message = json && json.message ? String(json.message) : ''
  const err = new Error(message || (code != null ? `code ${code}` : `Partner GPT HTTP ${status}`))
  err.partnerCode = code
  err.httpStatus = status
  err.partnerBody = json
  err.traceId = json && json.trace_id ? String(json.trace_id) : null
  return err
}

/** Плохая карта (недействительна/использована/просрочена) — пометить used, взять следующую. */
function isPartnerGptBadCard(err) {
  if (!err) return false
  if (err.partnerCode != null && BAD_CARD_CODES.has(Number(err.partnerCode))) return true
  // Без явного кода: 422 — почти всегда невалидная/просроченная карта.
  return !err.partnerCode && Number(err.httpStatus) === 422
}

/** Нет стока у поставщика — карту в пул, повторить позже. */
function isPartnerGptStockFault(err) {
  if (!err) return false
  if (err.partnerCode != null && STOCK_FAULT_CODES.has(Number(err.partnerCode))) return true
  return Number(err.httpStatus) === 503
}

function isPartnerGptAccountFault(err) {
  if (!err) return false
  if (err.partnerCode != null && ACCOUNT_FAULT_CODES.has(Number(err.partnerCode))) return true
  return !err.partnerCode && Number(err.httpStatus) === 400
}

function isPartnerGptTerminalStatus(status) {
  return PARTNER_GPT_TERMINAL_STATUSES.has(String(status || '').trim().toLowerCase())
}

function isPartnerGptTransientError(err) {
  if (!err) return false
  const status = Number(err.httpStatus || 0)
  if (status === 429) return true
  return /таймаут|timeout|ECONNRESET|ETIMEDOUT|fetch failed/i.test(String(err.message || ''))
}

async function partnerGptFetch(apiKey, method, path, { body, idempotencyKey } = {}) {
  const key = String(apiKey || '').trim()
  if (!key) throw new Error('Partner GPT API key is not configured')

  const url = `${getBaseUrl()}/${String(path || '').replace(/^\/+/, '')}`
  const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' }
  const init = { method, headers }
  if (idempotencyKey) headers['Idempotency-Key'] = String(idempotencyKey).slice(0, 255)
  if (body != null) {
    headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }

  let res
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(PARTNER_GPT_FETCH_TIMEOUT_MS) })
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new Error(`Partner GPT: таймаут запроса ${PARTNER_GPT_FETCH_TIMEOUT_MS}ms (${method} ${String(path || '')})`)
    }
    throw e
  }
  let json = null
  try {
    json = await res.json()
  } catch {
    json = null
  }
  // Успех: HTTP 2xx и code == 0 (или отсутствует).
  const codeOk = !json || json.code == null || Number(json.code) === 0
  if (!res.ok || !codeOk) throw buildPartnerGptError(json, res.status)
  return json
}

// Idempotency-Key: 8–128 символов из [A-Za-z0-9._:-]. Чистим запрещённые символы.
function sanitizeIdempotencyKey(raw) {
  let k = String(raw || '').replace(/[^A-Za-z0-9._:-]/g, '-')
  if (k.length > 128) k = k.slice(0, 128)
  if (k.length < 8) k = (k + '-00000000').slice(0, 8)
  return k
}

/**
 * POST /redemptions. Цель зависит от продукта карты:
 *   ChatGPT (plus/pro5x/pro20x/plusyear) -> account_id (UUID);
 *   Claude Pro (claude_pro)              -> organization_id (UUID).
 * Передавайте РОВНО одно из accountId / organizationId.
 * Возвращает { orderNo, status, productCode, raw }.
 */
async function createRedemption(apiKey, { cardCode, accountId, organizationId, confirmOverwrite = true, idempotencyKey } = {}) {
  if (!idempotencyKey) throw new Error('createRedemption requires idempotencyKey')
  const body = {
    card_code: String(cardCode || '').trim(),
    confirm_overwrite: Boolean(confirmOverwrite),
  }
  if (organizationId) body.organization_id = String(organizationId).trim()
  else body.account_id = String(accountId || '').trim()
  const json = await partnerGptFetch(apiKey, 'POST', 'redemptions', {
    body,
    idempotencyKey: sanitizeIdempotencyKey(idempotencyKey),
  })
  const data = json && json.data ? json.data : {}
  return {
    orderNo: data.order_no ? String(data.order_no) : '',
    status: data.status ? String(data.status) : 'pending',
    productCode: data.product_code ? String(data.product_code) : '',
    raw: json,
  }
}

/** GET /redemptions/:orderNo. status: pending|processing|succeeded|failed. */
async function getRedemption(apiKey, orderNo) {
  const id = String(orderNo || '').trim()
  if (!id) throw new Error('getRedemption requires orderNo')
  const json = await partnerGptFetch(apiKey, 'GET', `redemptions/${encodeURIComponent(id)}`)
  const data = json && json.data ? json.data : json || {}
  return {
    status: String(data.status || '').trim().toLowerCase(),
    failureCode: data.failure_code != null ? String(data.failure_code) : '',
    failureMessage: data.failure_message != null ? String(data.failure_message) : '',
    raw: json,
  }
}

// Поллинг статуса заказа ведёт сам чат-флоу по тикам (по order_no), чтобы НЕ
// пересоздавать заказ и не списывать карту повторно (дока запрещает resubmit).
// PARTNER_GPT_POLL_* оставлены как ENV-настройки таймаутов одиночных запросов.
void PARTNER_GPT_POLL_MAX_MS
void PARTNER_GPT_POLL_INTERVAL_MS

module.exports = {
  getBaseUrl,
  extractAccountId,
  createRedemption,
  getRedemption,
  isPartnerGptBadCard,
  isPartnerGptStockFault,
  isPartnerGptAccountFault,
  isPartnerGptTransientError,
  isPartnerGptTerminalStatus,
  sanitizeIdempotencyKey,
  buildPartnerGptError,
}
