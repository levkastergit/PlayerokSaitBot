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

const DEFAULT_BASE = 'https://admin.rootchatgptplus.com/api/partner/v1'
const PARTNER_GPT_POLL_MAX_MS = Math.max(5000, Number(process.env.PARTNER_GPT_POLL_MAX_MS) || 90000)
const PARTNER_GPT_POLL_INTERVAL_MS = Math.max(500, Number(process.env.PARTNER_GPT_POLL_INTERVAL_MS) || 2500)
const PARTNER_GPT_FETCH_TIMEOUT_MS = Math.max(3000, Number(process.env.PARTNER_GPT_FETCH_TIMEOUT_MS) || 25000)

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

// Коды ошибок API, означающие проблему НАШЕГО card_code (не покупателя) —
// карта недействительна/использована/просрочена/нет в наличии. Такой код нужно
// вернуть/списать и попробовать следующий.
const CARD_FAULT_CODES = new Set([100101, 100102, 100103, 100501])
// Невалидный account_id/запрос — вина данных покупателя, переспросить ID.
const ACCOUNT_FAULT_CODES = new Set([40000])

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

function isPartnerGptCardFault(err) {
  if (!err) return false
  if (err.partnerCode != null && CARD_FAULT_CODES.has(Number(err.partnerCode))) return true
  return Number(err.httpStatus) === 422 || Number(err.httpStatus) === 503
}

function isPartnerGptAccountFault(err) {
  if (!err) return false
  if (err.partnerCode != null && ACCOUNT_FAULT_CODES.has(Number(err.partnerCode))) return true
  return Number(err.httpStatus) === 400
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

/** POST /redemptions. Возвращает { orderNo, status, raw }. */
async function createRedemption(apiKey, { cardCode, accountId, confirmOverwrite = true, idempotencyKey } = {}) {
  if (!idempotencyKey) throw new Error('createRedemption requires idempotencyKey')
  const body = {
    card_code: String(cardCode || '').trim(),
    account_id: String(accountId || '').trim(),
    confirm_overwrite: Boolean(confirmOverwrite),
  }
  const json = await partnerGptFetch(apiKey, 'POST', 'redemptions', { body, idempotencyKey })
  const data = json && json.data ? json.data : {}
  return {
    orderNo: data.order_no ? String(data.order_no) : '',
    status: data.status ? String(data.status) : 'pending',
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Создаёт погашение и дожидается терминального статуса.
 * succeeded -> { succeeded:true }; failed -> { failed:true, accountFault, failureCode };
 * таймаут опроса -> { inProgress:true }. Ошибки create пробрасываются вызывающему.
 */
async function redeemPartnerGptAndConfirm(apiKey, { cardCode, accountId, idempotencyKey } = {}) {
  const created = await createRedemption(apiKey, { cardCode, accountId, idempotencyKey })
  if (!created.orderNo) {
    const err = new Error('Partner GPT create-redemption did not return order_no')
    err.partnerBody = created.raw
    throw err
  }
  // Уже терминальный в ответе на create?
  if (created.status === 'succeeded') return { succeeded: true, failed: false, orderNo: created.orderNo }
  if (created.status === 'failed') return { succeeded: false, failed: true, orderNo: created.orderNo }

  const started = Date.now()
  let last = null
  while (Date.now() - started < PARTNER_GPT_POLL_MAX_MS) {
    await delay(PARTNER_GPT_POLL_INTERVAL_MS)
    try {
      last = await getRedemption(apiKey, created.orderNo)
    } catch (pollErr) {
      // Транзиентный сбой опроса — продолжаем.
      continue
    }
    if (last.status === 'succeeded') {
      return { succeeded: true, failed: false, orderNo: created.orderNo }
    }
    if (last.status === 'failed') {
      const codeNum = Number(last.failureCode)
      return {
        succeeded: false,
        failed: true,
        orderNo: created.orderNo,
        failureCode: last.failureCode,
        failureMessage: last.failureMessage,
        accountFault: Number.isFinite(codeNum) && ACCOUNT_FAULT_CODES.has(codeNum),
        cardFault: Number.isFinite(codeNum) && CARD_FAULT_CODES.has(codeNum),
      }
    }
    // pending | processing — продолжаем опрос.
  }
  return { succeeded: false, failed: false, inProgress: true, orderNo: created.orderNo }
}

module.exports = {
  getBaseUrl,
  extractAccountId,
  createRedemption,
  getRedemption,
  redeemPartnerGptAndConfirm,
  isPartnerGptCardFault,
  isPartnerGptAccountFault,
  isPartnerGptTransientError,
  buildPartnerGptError,
}
