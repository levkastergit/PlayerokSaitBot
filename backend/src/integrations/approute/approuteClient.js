const { extractApprouteDeliveryText } = require('./extractApprouteDeliveryText')
const { logApprouteAutodelivery } = require('../../debug/approuteAutodeliveryLog')

const DEFAULT_BASE = 'https://approute.ru/api/v1'
const APPROUTE_POLL_MAX_MS = Math.max(5000, Number(process.env.APPROUTE_ORDER_POLL_MAX_MS) || 120000)
const APPROUTE_POLL_INTERVAL_MS = Math.max(500, Number(process.env.APPROUTE_ORDER_POLL_INTERVAL_MS) || 3000)
const APPROUTE_IN_PROGRESS_STATUSES = new Set([
  'IN_PROGRESS',
  'PENDING',
  'PROCESSING',
  'CREATED',
  'NEW',
  'QUEUED',
])
const APPROUTE_FAILED_STATUSES = new Set(['CANCELLED', 'FAILED', 'ERROR', 'REJECTED'])

function getBaseUrl() {
  const raw = process.env.APPROUTE_API_BASE || DEFAULT_BASE
  return String(raw).trim().replace(/\/+$/, '') || DEFAULT_BASE
}

// AppRoute стоит за DDoS-Guard, который отклоняет запросы без User-Agent (403).
const DEFAULT_BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'

function getApprouteUserAgent() {
  const raw =
    process.env.APPROUTE_USER_AGENT ||
    process.env.PLAYEROK_USER_AGENT ||
    DEFAULT_BROWSER_UA
  return String(raw).trim() || DEFAULT_BROWSER_UA
}

function formatApprouteErrorMessage(body, status) {
  const parts = []
  if (body?.statusMessage) parts.push(String(body.statusMessage))
  if (Array.isArray(body?.errors)) {
    for (const e of body.errors) {
      const bit = [e.field, e.code, e.message].filter(Boolean).join(': ')
      if (bit) parts.push(bit)
    }
  }
  if (parts.length) return parts.join(' | ')
  return `AppRoute HTTP ${status}`
}

function buildApprouteError(body, status) {
  const err = new Error(formatApprouteErrorMessage(body, status))
  err.approuteBody = body
  err.httpStatus = status
  return err
}

function isApprouteValidationError(err) {
  if (!err) return false
  if (err.approuteBody?.statusCode === 3) return true
  return /validation/i.test(String(err.message || ''))
}

function isApprouteSuccess(body) {
  if (!body || typeof body !== 'object') return false
  if (body.status === 'CANCELLED') return false
  if (body.statusCode === 4) return false
  if (body.statusCode === 3 && Array.isArray(body.errors) && body.errors.length > 0) return false
  return true
}

async function approuteFetch(apiKey, method, path, body) {
  const key = String(apiKey || '').trim()
  if (!key) throw new Error('AppRoute API key is not configured')

  const url = `${getBaseUrl()}/${String(path || '').replace(/^\/+/, '')}`
  const init = {
    method,
    headers: {
      'X-Api-Key': key,
      Accept: 'application/json',
      'User-Agent': getApprouteUserAgent(),
    },
  }
  if (body != null) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }

  const res = await fetch(url, init)
  let json = null
  try {
    json = await res.json()
  } catch {
    json = null
  }

  if (!res.ok || !isApprouteSuccess(json)) {
    throw buildApprouteError(json, res.status)
  }

  return json
}

function pickLabel(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return ''
}

function coerceServiceId(value) {
  const s = String(value ?? '').trim()
  if (!s) return null
  if (/^\d+$/.test(s)) return Number(s)
  return s
}

function normalizeServiceEntry(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = raw.id ?? raw.serviceId ?? raw.service_id
  if (id == null || id === '') return null
  const name = pickLabel(
    raw.name,
    raw.title,
    raw.serviceName,
    raw.service_name,
    raw.label
  ) || `Услуга #${id}`
  const price =
    typeof raw.price === 'number'
      ? raw.price
      : typeof raw.cost === 'number'
        ? raw.cost
        : typeof raw.amount === 'number'
          ? raw.amount
          : null
  const category = String(raw.category ?? raw.categoryName ?? raw.group ?? '').trim()
  // Тип услуги AppRoute: 'voucher' (shop/автовыдача) или 'direct_topup' (автопополнение).
  const serviceType = String(raw.type ?? raw.serviceType ?? raw.ordersType ?? '')
    .trim()
    .toLowerCase()
  return { id: String(id), name, price, category, serviceType: serviceType || null }
}

function normalizeVariantEntry(raw, parentServiceId) {
  if (!raw || typeof raw !== 'object') return null
  const id =
    raw.id ??
    raw.variantId ??
    raw.variant_id ??
    raw.offerId ??
    raw.offer_id ??
    raw.nominalId ??
    raw.nominal_id ??
    raw.skuId ??
    raw.sku_id ??
    raw.productId ??
    raw.product_id ??
    raw.itemId ??
    raw.item_id
  if (id == null || id === '') return null
  const parentId = String(parentServiceId || '').trim()
  if (parentId && String(id) === parentId) return null

  const name =
    pickLabel(
      raw.name,
      raw.title,
      raw.label,
      raw.denomination,
      raw.nominal,
      raw.nominalName,
      raw.nominal_name,
      raw.faceValue,
      raw.face_value,
      raw.value,
      raw.amount != null ? `${raw.amount}` : '',
      raw.price != null ? `${raw.price}` : ''
    ) || `Номинал #${id}`

  const price =
    typeof raw.price === 'number'
      ? raw.price
      : typeof raw.cost === 'number'
        ? raw.cost
        : typeof raw.amount === 'number'
          ? raw.amount
          : null
  const currency = pickLabel(raw.currency, raw.currencyCode, raw.currency_code)

  const displayId = String(id)
  const denominationId = String(
    raw.denominationId ?? raw.denomination_id ?? raw.nominalId ?? raw.nominal_id ?? displayId
  ).trim()
  const orderServiceId =
    raw.serviceId != null && String(raw.serviceId).trim() && String(raw.serviceId) !== displayId
      ? String(raw.serviceId).trim()
      : raw.orderServiceId != null && String(raw.orderServiceId).trim()
        ? String(raw.orderServiceId).trim()
        : displayId

  return {
    id: displayId,
    denominationId: denominationId || displayId,
    orderServiceId,
    name,
    price,
    currency,
    parentServiceId: parentId || null,
  }
}

const VARIANT_ARRAY_KEYS = [
  'variants',
  'nominals',
  'denominations',
  'offers',
  'skus',
  'items',
  'products',
  'prices',
  'options',
  'subServices',
  'sub_services',
  'children',
  'serviceItems',
  'service_items',
  'nominalVariants',
  'nominal_variants',
  'serviceVariants',
  'service_variants',
]

function collectVariantsFromPayload(payload, parentServiceId, out, seen) {
  if (!payload) return
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const norm = normalizeVariantEntry(item, parentServiceId)
      if (norm && !seen.has(norm.id)) {
        seen.add(norm.id)
        out.push(norm)
      }
      if (item && typeof item === 'object') {
        for (const key of VARIANT_ARRAY_KEYS) {
          if (item[key] != null) collectVariantsFromPayload(item[key], parentServiceId, out, seen)
        }
      }
    }
    return
  }
  if (typeof payload !== 'object') return

  for (const key of VARIANT_ARRAY_KEYS) {
    if (payload[key] != null) collectVariantsFromPayload(payload[key], parentServiceId, out, seen)
  }

  if (payload.data != null && payload.data !== payload) {
    collectVariantsFromPayload(payload.data, parentServiceId, out, seen)
  }
}

function collectServicesFromPayload(payload, out, seen) {
  if (!payload) return
  if (Array.isArray(payload)) {
    for (const item of payload) {
      const norm = normalizeServiceEntry(item)
      if (norm && !seen.has(norm.id)) {
        seen.add(norm.id)
        out.push(norm)
      }
    }
    return
  }
  if (typeof payload !== 'object') return

  const direct = normalizeServiceEntry(payload)
  if (direct && !seen.has(direct.id)) {
    seen.add(direct.id)
    out.push(direct)
  }

  const keys = ['data', 'services', 'items', 'list', 'content', 'results', 'records', 'rows']
  for (const key of keys) {
    if (payload[key] != null) collectServicesFromPayload(payload[key], out, seen)
  }
}

async function listApprouteServices(apiKey) {
  const body = await approuteFetch(apiKey, 'GET', 'services')
  const out = []
  const seen = new Set()
  collectServicesFromPayload(body, out, seen)
  collectServicesFromPayload(body?.data, out, seen)
  out.sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  return out
}

async function listApprouteServiceVariants(apiKey, serviceId) {
  const parentId = String(serviceId || '').trim()
  if (!parentId) return { variants: [], ordersType: null }

  const body = await approuteFetch(apiKey, 'GET', `services/${encodeURIComponent(parentId)}`)
  const ordersType = extractOrdersTypeHint(body)
  const out = []
  const seen = new Set()
  collectVariantsFromPayload(body, parentId, out, seen)
  collectVariantsFromPayload(body?.data, parentId, out, seen)

  if (out.length === 0) {
    const flat = []
    const flatSeen = new Set()
    collectServicesFromPayload(body, flat, flatSeen)
    collectServicesFromPayload(body?.data, flat, flatSeen)
    for (const entry of flat) {
      if (entry && String(entry.id) !== parentId) {
        const norm = normalizeVariantEntry(
          {
            id: entry.id,
            name: entry.name,
            price: entry.price,
          },
          parentId
        )
        if (norm && !seen.has(norm.id)) {
          seen.add(norm.id)
          out.push(norm)
        }
      }
    }
  }

  out.sort((a, b) => {
    const pa = typeof a.price === 'number' ? a.price : NaN
    const pb = typeof b.price === 'number' ? b.price : NaN
    if (Number.isFinite(pa) && Number.isFinite(pb) && pa !== pb) return pa - pb
    return a.name.localeCompare(b.name, 'ru')
  })
  return { variants: out, ordersType }
}

const APPROUTE_ORDER_TYPES = ['shop', 'dtu', 'esim']
const APPROUTE_REFERENCE_ID_MAX_LEN = 40

function normalizeApprouteOrdersType(value) {
  const s = String(value || '')
    .trim()
    .toLowerCase()
  if (APPROUTE_ORDER_TYPES.includes(s)) return s
  return null
}

function extractOrdersTypeHint(payload) {
  if (!payload || typeof payload !== 'object') return null
  const direct = normalizeApprouteOrdersType(
    payload.ordersType ?? payload.orderType ?? payload.type ?? payload.serviceType
  )
  if (direct) return direct
  if (payload.data != null && payload.data !== payload) {
    return extractOrdersTypeHint(payload.data)
  }
  return null
}

function resolveApprouteReferenceId({ referenceId, dealId }) {
  const raw = String(referenceId || dealId || '').trim()
  if (!raw) return ''
  if (raw.length <= APPROUTE_REFERENCE_ID_MAX_LEN) return raw
  return raw.slice(0, APPROUTE_REFERENCE_ID_MAX_LEN)
}

function buildOrderBodyCandidates({
  serviceId,
  variantId,
  denominationId,
  variantOrderServiceId,
  quantity,
  ordersType,
  dealId,
  referenceId,
}) {
  const variant = String(variantId || '').trim()
  const variantOrder = String(variantOrderServiceId || '').trim()
  const denomExplicit = String(denominationId || '').trim()
  const denominationIdValue = denomExplicit || variant || variantOrder
  const referenceIdValue = resolveApprouteReferenceId({ referenceId, dealId })
  if (!denominationIdValue || !referenceIdValue) return []

  const qty = Math.max(1, Math.min(99, Math.floor(Number(quantity) || 1)))
  const line = { denominationId: denominationIdValue, quantity: qty }

  const ordersTypes = []
  const hint = normalizeApprouteOrdersType(ordersType)
  if (hint) ordersTypes.push(hint)
  for (const t of APPROUTE_ORDER_TYPES) {
    if (!ordersTypes.includes(t)) ordersTypes.push(t)
  }

  return ordersTypes.map((typeVal) => ({
    ordersType: typeVal,
    referenceId: referenceIdValue,
    orders: [line],
  }))
}

async function createApprouteOrder(apiKey, orderInput) {
  const candidates = buildOrderBodyCandidates(orderInput)
  if (!candidates.length) throw new Error('Invalid AppRoute serviceId')

  let lastErr = null
  for (let i = 0; i < candidates.length; i++) {
    try {
      const result = await approuteFetch(apiKey, 'POST', 'orders', candidates[i])
      if (i > 0) {
        logApprouteAutodelivery('order body variant ok', { attempt: i, body: candidates[i] })
      }
      return result
    } catch (err) {
      lastErr = err
      if (!isApprouteValidationError(err)) throw err
    }
  }

  const fail = buildApprouteError(lastErr?.approuteBody, lastErr?.httpStatus || 422)
  fail.triedBodies = candidates.slice(0, 5)
  throw fail
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeDeliveryText(rawValue) {
  const raw = String(rawValue || '').trim()
  if (!raw) return { text: '', masked: false }
  const masked = /\*{2,}|•{2,}/.test(raw) || /PIN:\s*[*•]/i.test(raw)
  return { text: masked ? '' : raw, masked }
}

function extractApprouteOrderStatus(body) {
  if (!body || typeof body !== 'object') return ''
  const data = body.data
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return String(data.status ?? data.state ?? '').trim()
  }
  if (Array.isArray(data) && data[0] && typeof data[0] === 'object') {
    return String(data[0].status ?? data[0].state ?? '').trim()
  }
  return String(body.status ?? body.state ?? '').trim()
}

function extractApprouteOrderId(body) {
  if (!body || typeof body !== 'object') return null
  const data = body.data
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const id = data.id ?? data.orderId ?? data.order_id
    if (id != null) return String(id)
  }
  if (Array.isArray(data) && data[0]) {
    const id = data[0].id ?? data[0].orderId ?? data[0].order_id
    if (id != null) return String(id)
  }
  if (body.id != null) return String(body.id)
  return null
}

function pickOrderFromListBody(listBody, referenceId) {
  if (!listBody || typeof listBody !== 'object') return null
  const data = listBody.data
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data?.orders)
      ? data.orders
      : Array.isArray(data?.items)
        ? data.items
        : Array.isArray(data?.page?.items)
          ? data.page.items
          : Array.isArray(data?.page?.orders)
            ? data.page.orders
            : null
  if (!list || list.length === 0) return null
  const ref = String(referenceId || '').trim()
  if (!ref) return list[0]
  return (
    list.find(
      (o) =>
        String(
          o?.referenceId ??
            o?.reference_id ??
            o?.reference ??
            o?.partnerOrderId ??
            o?.partner_order_id ??
            ''
        ).trim() === ref
    ) || null
  )
}

function bodyFromOrderEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  return { data: entry, status: entry.status }
}

async function fetchApprouteOrderSnapshot(apiKey, { orderId, referenceId }) {
  if (orderId) {
    try {
      return await approuteFetch(apiKey, 'GET', `orders/${encodeURIComponent(String(orderId))}`)
    } catch {
      // ignore
    }
  }
  if (referenceId) {
    try {
      const listed = await listApprouteOrders(apiKey, { referenceId })
      const entry = pickOrderFromListBody(listed, referenceId)
      if (entry) return bodyFromOrderEntry(entry) || listed
      return null
    } catch {
      // ignore
    }
  }
  return null
}

async function pollApprouteOrderDelivery(apiKey, { orderId, referenceId, initialBody }) {
  const started = Date.now()
  let lastBody = initialBody || null
  let lastStatus = extractApprouteOrderStatus(lastBody)
  let maskedDeliverySeen = false

  while (Date.now() - started < APPROUTE_POLL_MAX_MS) {
    if (lastBody) {
      const extracted = extractApprouteDeliveryText(lastBody?.data ?? lastBody)
      const { text: deliveryText, masked } = normalizeDeliveryText(extracted)
      if (masked) maskedDeliverySeen = true
      if (deliveryText) {
        return { deliveryText, orderBody: lastBody, orderStatus: lastStatus, maskedDelivery: false }
      }
    }

    const statusUpper = String(lastStatus || '').toUpperCase()
    if (APPROUTE_FAILED_STATUSES.has(statusUpper)) {
      return {
        deliveryText: '',
        orderBody: lastBody,
        orderStatus: lastStatus,
        failed: true,
        maskedDelivery: maskedDeliverySeen,
      }
    }

    await delay(APPROUTE_POLL_INTERVAL_MS)

    const oid = orderId || extractApprouteOrderId(lastBody)
    lastBody = await fetchApprouteOrderSnapshot(apiKey, {
      orderId: oid,
      referenceId,
    })
    if (!lastBody) continue
    lastStatus = extractApprouteOrderStatus(lastBody)
    logApprouteAutodelivery('poll: status', {
      referenceId: referenceId || null,
      orderId: oid || null,
      status: lastStatus || null,
      elapsedMs: Date.now() - started,
    })
  }

  const extractedFinal = extractApprouteDeliveryText(lastBody?.data ?? lastBody)
  const { text: deliveryText, masked: maskedFinal } = normalizeDeliveryText(extractedFinal)
  if (maskedFinal) maskedDeliverySeen = true
  const statusUpper = String(lastStatus || '').toUpperCase()
  if (!deliveryText && lastBody) {
    const data = lastBody.data ?? lastBody
    const keys =
      data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data).slice(0, 20) : []
    logApprouteAutodelivery('poll: empty delivery', {
      referenceId: referenceId || null,
      status: lastStatus || null,
      dataKeys: keys,
    })
  }
  return {
    deliveryText,
    orderBody: lastBody,
    orderStatus: lastStatus,
    maskedDelivery: maskedDeliverySeen,
    inProgress:
      !deliveryText &&
      (APPROUTE_IN_PROGRESS_STATUSES.has(statusUpper) ||
        statusUpper === 'IN_PROGRESS' ||
        !statusUpper),
  }
}

async function listApprouteOrders(apiKey, query = {}) {
  const params = new URLSearchParams()
  if (query.referenceId) params.set('referenceId', String(query.referenceId))
  if (query.partnerOrderId) params.set('partnerOrderId', String(query.partnerOrderId))
  if (query.externalId) params.set('externalId', String(query.externalId))
  const unhideValue =
    query.unhide !== undefined && query.unhide !== null
      ? String(query.unhide).trim()
      : 'True'
  if (unhideValue) params.set('unhide', unhideValue)
  const qs = params.toString()
  const path = qs ? `orders?${qs}` : 'orders'
  return approuteFetch(apiKey, 'GET', path)
}

async function createApprouteOrderAndGetDelivery(apiKey, orderInput) {
  const skipCreate = Boolean(orderInput?.skipCreate)
  const referenceId = resolveApprouteReferenceId({
    referenceId: orderInput?.referenceId,
    dealId: orderInput?.dealId,
  })

  let approuteSubmitted = false
  let orderBody = null

  if (referenceId) {
    const existing = await fetchApprouteOrderSnapshot(apiKey, { referenceId })
    if (existing) {
      orderBody = existing
      approuteSubmitted = true
      const existingExtracted = extractApprouteDeliveryText(existing?.data ?? existing)
      const { text: existingDelivery, masked: existingMasked } = normalizeDeliveryText(existingExtracted)
      if (existingDelivery) {
        return {
          deliveryText: existingDelivery,
          orderBody,
          fromExisting: true,
          approuteSubmitted: true,
          maskedDelivery: false,
        }
      }
      logApprouteAutodelivery('poll: existing order', {
        referenceId,
        status: extractApprouteOrderStatus(existing),
        skipCreate,
      })
      const polled = await pollApprouteOrderDelivery(apiKey, {
        orderId: extractApprouteOrderId(existing),
        referenceId,
        initialBody: existing,
      })
      return {
        ...polled,
        fromExisting: true,
        approuteSubmitted: true,
        maskedDelivery: Boolean(polled?.maskedDelivery || existingMasked),
      }
    }
  }

  if (skipCreate) {
    return {
      deliveryText: '',
      orderBody: null,
      approuteSubmitted: false,
      inProgress: false,
      reason: 'no_existing_order',
    }
  }

  const created = await createApprouteOrder(apiKey, orderInput)
  approuteSubmitted = true
  orderBody = created

  const createdExtracted = extractApprouteDeliveryText(created?.data ?? created)
  let { text: deliveryText, masked: maskedOnCreate } = normalizeDeliveryText(createdExtracted)
  if (deliveryText) {
    return { deliveryText, orderBody, approuteSubmitted, maskedDelivery: false }
  }

  const orderId = extractApprouteOrderId(created)
  logApprouteAutodelivery('poll: after create', {
    referenceId: referenceId || null,
    orderId,
    status: extractApprouteOrderStatus(created),
  })

  const polled = await pollApprouteOrderDelivery(apiKey, {
    orderId,
    referenceId,
    initialBody: created,
  })
  return { ...polled, approuteSubmitted, maskedDelivery: Boolean(polled?.maskedDelivery || maskedOnCreate) }
}

// ---------------------------------------------------------------------------
// Прямое пополнение (Direct Top-Up, ordersType: 'dtu').
// В отличие от shop-заказа здесь не возвращается код для выдачи — средства идут
// напрямую на аккаунт игрока. Поэтому в строку заказа передаётся идентификатор
// аккаунта покупателя (поле account_reference) и опционально сумма (поле amount).
// ---------------------------------------------------------------------------
const APPROUTE_DTU_SUCCESS_STATUSES = new Set([
  'COMPLETED',
  'COMPLETE',
  'SUCCESS',
  'SUCCEEDED',
  'DONE',
  'DELIVERED',
  'FULFILLED',
  'PAID',
  'OK',
])

function buildDtuOrderLine({ denominationId, quantity, amountCurrencyCode, accountReference, amount }) {
  const fields = [
    { key: 'account_reference', value: String(accountReference == null ? '' : accountReference).trim() },
  ]
  const amountStr = amount == null ? '' : String(amount).trim()
  if (amountStr) fields.push({ key: 'amount', value: amountStr })

  const line = {
    denominationId: String(denominationId || '').trim(),
    quantity: Math.max(1, Math.min(99, Math.floor(Number(quantity) || 1))),
    fields,
  }
  // Валюту/сумму передаём только если задана сумма; при фиксированном номинале
  // сумма определяется самим номиналом и эти поля не нужны.
  if (amountStr) {
    const currency = String(amountCurrencyCode || '').trim()
    if (currency) line.amountCurrencyCode = currency
  }
  return line
}

function buildDtuOrderBody(input, { checkOnly = false } = {}) {
  const body = { ordersType: 'dtu', orders: [buildDtuOrderLine(input)] }
  if (checkOnly) {
    body.checkOnly = true
  } else {
    const referenceId = resolveApprouteReferenceId({ referenceId: input.referenceId, dealId: input.dealId })
    if (referenceId) body.referenceId = referenceId
  }
  return body
}

/** Проверка DTU-заказа без списания (checkOnly). Бросает ошибку при невалидном account_reference/номинале. */
async function checkApprouteDtuOrder(apiKey, input) {
  const body = buildDtuOrderBody(input, { checkOnly: true })
  const result = await approuteFetch(apiKey, 'POST', 'orders', body)
  return { ok: true, body: result }
}

function isApprouteDtuCompleted(body) {
  const status = String(extractApprouteOrderStatus(body) || '').toUpperCase()
  if (!status) return false
  return APPROUTE_DTU_SUCCESS_STATUSES.has(status)
}

async function pollApprouteDtuCompletion(apiKey, { orderId, referenceId, initialBody }) {
  const started = Date.now()
  let lastBody = initialBody || null
  let lastStatus = extractApprouteOrderStatus(lastBody)

  while (Date.now() - started < APPROUTE_POLL_MAX_MS) {
    const up = String(lastStatus || '').toUpperCase()
    if (APPROUTE_DTU_SUCCESS_STATUSES.has(up)) {
      return { completed: true, failed: false, orderBody: lastBody, orderStatus: lastStatus }
    }
    if (APPROUTE_FAILED_STATUSES.has(up)) {
      return { completed: false, failed: true, orderBody: lastBody, orderStatus: lastStatus }
    }

    await delay(APPROUTE_POLL_INTERVAL_MS)
    const oid = orderId || extractApprouteOrderId(lastBody)
    const snap = await fetchApprouteOrderSnapshot(apiKey, { orderId: oid, referenceId })
    if (!snap) continue
    lastBody = snap
    lastStatus = extractApprouteOrderStatus(snap)
    logApprouteAutodelivery('dtu poll: status', {
      referenceId: referenceId || null,
      orderId: oid || null,
      status: lastStatus || null,
      elapsedMs: Date.now() - started,
    })
  }

  const up = String(lastStatus || '').toUpperCase()
  return {
    completed: APPROUTE_DTU_SUCCESS_STATUSES.has(up),
    failed: false,
    inProgress: true,
    orderBody: lastBody,
    orderStatus: lastStatus,
  }
}

/**
 * Создаёт реальный DTU-заказ и дожидается терминального статуса.
 * Идемпотентно по referenceId (= dealId): повторный вызов не списывает повторно.
 */
async function createApprouteDtuOrderAndConfirm(apiKey, input) {
  const created = await approuteFetch(apiKey, 'POST', 'orders', buildDtuOrderBody(input, { checkOnly: false }))
  if (isApprouteDtuCompleted(created)) {
    return { completed: true, failed: false, orderBody: created, orderStatus: extractApprouteOrderStatus(created) }
  }
  const orderId = extractApprouteOrderId(created)
  const referenceId = resolveApprouteReferenceId({ referenceId: input.referenceId, dealId: input.dealId })
  const polled = await pollApprouteDtuCompletion(apiKey, { orderId, referenceId, initialBody: created })
  return { ...polled, orderBody: polled.orderBody || created }
}

module.exports = {
  listApprouteServices,
  listApprouteServiceVariants,
  createApprouteOrder,
  createApprouteOrderAndGetDelivery,
  checkApprouteDtuOrder,
  createApprouteDtuOrderAndConfirm,
  isApprouteDtuCompleted,
  extractApprouteDeliveryText,
  formatApprouteErrorMessage,
  isApprouteValidationError,
  resolveApprouteReferenceId,
}
