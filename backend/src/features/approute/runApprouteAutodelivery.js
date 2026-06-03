const { createApprouteOrderAndGetDelivery, isApprouteValidationError } = require('../../integrations/approute/approuteClient')

const { logApprouteAutodelivery } = require('../../debug/approuteAutodeliveryLog')

const { shouldSkipApprouteAutodelivery } = require('./approuteAutodeliveryGuards')
const { hasSellerMessageText } = require('../autolist/handleChatAutomessage')
const { scopeMessagesToDeal } = require('../../functions/supercellHelpers')



function isMaskedPinValue(value) {
  const s = String(value || '').trim()
  if (!s) return false
  return /[*•]/.test(s)
}

function normalizePinValue(value) {
  const pin = String(value || '').trim()
  if (!pin) return ''
  if (isMaskedPinValue(pin)) return ''
  return pin
}

function extractPinCodeFromPayload(payload, seen = new Set()) {
  if (!payload || typeof payload !== 'object') return ''
  if (seen.has(payload)) return ''
  seen.add(payload)

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const pin = extractPinCodeFromPayload(item, seen)
      if (pin) return pin
    }
    return ''
  }

  const directPin = normalizePinValue(payload.pin ?? payload.pinCode ?? payload.pin_code)
  if (directPin) return directPin

  const nestedKeys = [
    'data',
    'page',
    'items',
    'orders',
    'order',
    'vouchers',
    'cards',
    'credentials',
    'lines',
    'products',
    'result',
    'delivery',
    'fulfillment',
    'fulfillmentData',
  ]
  for (const key of nestedKeys) {
    if (!Object.prototype.hasOwnProperty.call(payload, key)) continue
    const pin = extractPinCodeFromPayload(payload[key], seen)
    if (pin) return pin
  }

  for (const value of Object.values(payload)) {
    if (!value || typeof value !== 'object') continue
    const pin = extractPinCodeFromPayload(value, seen)
    if (pin) return pin
  }

  return ''
}

function extractPinCodeFromDeliveryText(deliveryText) {
  const text = String(deliveryText || '').trim()
  if (!text) return ''

  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  for (const line of lines) {
    const m = line.match(/^pin\s*:\s*(.+)$/i)
    if (m && m[1]) {
      const pin = normalizePinValue(m[1])
      if (pin) return pin
    }
  }

  if (lines.length === 1) {
    const single = lines[0].replace(/^["']|["']$/g, '').trim()
    if (!single.includes(':')) {
      const pin = normalizePinValue(single)
      if (pin) return pin
    }
  }

  return ''
}

function formatDeliveryMessage(template, deliveryText, kodValue = '') {

  const tpl = String(template || '').trim()

  const delivery = String(deliveryText || '').trim()

  const kod = String(kodValue || '').trim()

  if (!tpl) return delivery

  if (!delivery && !kod) return ''

  return tpl
    .split('{delivery}')
    .join(delivery)
    .split('{Kod}')
    .join(kod)
    .split('{kod}')
    .join(kod)

}



async function runApprouteAutodelivery({

  currentUserId,

  loadApprouteApiKeyPlain,

  settings,

  lastChat,

  dealId,

  dealStatus,

  lastMessageText,

  productKey,

  token,

  userAgent,

  createChatMessage,

  withRetry,

  isPlayerokRateLimitError,

  sleep,

  orderAlreadyPlaced = false,

  forceRescan = false,

  onApprouteOrderPlaced,

  updateDealStatus,

  chatMessages = null,

  viewerUsername = null,

}) {

  const cfg = settings?.autodeliveryApi

  if (!cfg?.enabled || !lastChat?.id) {

    logApprouteAutodelivery('skip: disabled', {

      productKey,

      dealId: dealId || null,

      hasChat: Boolean(lastChat?.id),

    })

    return { ok: false, skipped: true, markApprouteChatDone: false }

  }



  const apiKey = typeof loadApprouteApiKeyPlain === 'function' ? loadApprouteApiKeyPlain(currentUserId) : ''

  if (!apiKey) {

    logApprouteAutodelivery('skip: no_api_key', { productKey, dealId: dealId || null })

    return { ok: false, reason: 'no_api_key', markApprouteChatDone: false }

  }



  const serviceId = cfg.serviceId ?? cfg.service_id

  if (serviceId == null || String(serviceId).trim() === '') {

    logApprouteAutodelivery('skip: no_service_id', { productKey, dealId: dealId || null })

    return { ok: false, reason: 'no_service_id', markApprouteChatDone: true }

  }



  const variantId = cfg.variantId ?? cfg.variant_id ?? cfg.nominalId ?? cfg.nominal_id

  const variantRequired = Boolean(cfg.variantRequired)

  if (variantRequired && (variantId == null || String(variantId).trim() === '')) {

    logApprouteAutodelivery('skip: no_variant_id', { productKey, dealId: dealId || null, serviceId: String(serviceId) })

    return { ok: false, reason: 'no_variant_id', markApprouteChatDone: true }

  }



  const guard = shouldSkipApprouteAutodelivery({

    dealStatus,

    lastMessageText: lastMessageText ?? lastChat?.lastMessage?.text,

  })

  const deliveryOnly = Boolean(orderAlreadyPlaced)



  const blockNewOrder =
    !forceRescan &&
    guard.skip &&
    !deliveryOnly &&
    guard.reason !== 'item_sent' &&
    guard.reason !== 'delivery_marker'

  if (blockNewOrder) {

    logApprouteAutodelivery('skip: deal_state (no order)', {

      productKey,

      dealId: dealId || null,

      reason: guard.reason,

      dealStatus: guard.dealStatus,

    })

    return { ok: false, skipped: true, reason: guard.reason, markApprouteChatDone: true }

  }



  const quantity = Math.max(1, Math.min(99, Math.floor(Number(cfg.quantity) || 1)))

  const autoCompleteDealEnabled = Boolean(cfg.autoCompleteDeal)

  const referenceId = dealId ? String(dealId).trim() : undefined



  logApprouteAutodelivery(deliveryOnly ? 'delivery_only' : 'start', {

    productKey,

    dealId: dealId || null,

    referenceId: referenceId || null,

    serviceId: String(serviceId),

    variantId: variantId != null ? String(variantId) : null,

    ordersType: cfg.ordersType ?? cfg.orders_type ?? 'shop',

    dealStatus: guard.dealStatus || dealStatus || null,

  })



  const messageOnPurchase =

    (cfg.messageOnPurchase && String(cfg.messageOnPurchase).trim()) || ''



  // Сообщение при покупке отправляем при любом запуске автовыдачи (в т.ч. delivery-only
  // и после перезапуска), а не только при первичном размещении заказа. Дубль исключён
  // дедупом в рамках текущей сделки — иначе у повторных покупок/после перезапуска оно
  // не уходило, если первичный цикл его пропустил.
  if (messageOnPurchase) {
    const history = scopeMessagesToDeal(Array.isArray(chatMessages) ? chatMessages : [], dealId)
    const alreadySent = history.length > 0 && hasSellerMessageText(history, messageOnPurchase, viewerUsername)
    if (alreadySent) {
      logApprouteAutodelivery('messageOnPurchase already in chat', {
        chatId: lastChat.id,
        dealId: dealId || null,
      })
    } else {

      try {

        await withRetry(

          () => createChatMessage(token, userAgent, lastChat.id, messageOnPurchase),

          { label: 'createChatMessage(approute messageOnPurchase)', retries: 3, shouldRetry: isPlayerokRateLimitError }

        )

      } catch (err) {

        logApprouteAutodelivery('messageOnPurchase failed', {

          chatId: lastChat.id,

          dealId: dealId || null,

          error: err?.message || String(err),

        })

      }
    }
  }



  try {

    const orderResult = await createApprouteOrderAndGetDelivery(apiKey, {

      serviceId,

      variantId: variantId != null && String(variantId).trim() ? variantId : undefined,

      denominationId:

        cfg.denominationId != null && String(cfg.denominationId).trim()

          ? cfg.denominationId

          : undefined,

      variantOrderServiceId:

        cfg.variantOrderServiceId != null && String(cfg.variantOrderServiceId).trim()

          ? cfg.variantOrderServiceId

          : undefined,

      ordersType: cfg.ordersType ?? cfg.orders_type,

      quantity,

      dealId: dealId || undefined,

      referenceId,

      skipCreate: deliveryOnly,

    })



    const {
      deliveryText,
      orderBody,
      approuteSubmitted,
      inProgress,
      orderStatus,
      fromExisting,
      reason,
      maskedDelivery,
    } =

      orderResult



    if (approuteSubmitted && typeof onApprouteOrderPlaced === 'function') {

      onApprouteOrderPlaced()

    }



    logApprouteAutodelivery(deliveryText ? 'order ready' : 'order created', {

      productKey,

      dealId: dealId || null,

      serviceId: String(serviceId),

      variantId: variantId != null ? String(variantId) : null,

      referenceId: referenceId || null,

      hasDelivery: Boolean(deliveryText),

      status: orderStatus || orderBody?.status || null,

      fromExisting: Boolean(fromExisting),

      inProgress: Boolean(inProgress),

      deliveryOnly,

      reason: reason || null,

    })



    const kodValue = extractPinCodeFromPayload(orderBody) || extractPinCodeFromDeliveryText(deliveryText)

    const deliveryMessage = formatDeliveryMessage(cfg.deliveryMessage, deliveryText, kodValue)

    const hasDeliveryTemplate = String(cfg.deliveryMessage || '').trim().length > 0
    const textToSend = hasDeliveryTemplate ? deliveryMessage : deliveryText



    if (!textToSend) {

      logApprouteAutodelivery('no delivery text in response', {

        productKey,

        dealId: dealId || null,

        referenceId: referenceId || null,

        inProgress: Boolean(inProgress),

        orderStatus: orderStatus || null,

        deliveryOnly,

      })

      return {

        ok: false,

        reason: reason || (maskedDelivery ? 'masked_delivery' : inProgress ? 'delivery_pending' : 'empty_delivery'),

        markApprouteOrderDone: Boolean(approuteSubmitted),

        markApprouteChatDone: false,

      }

    }

    // Текст выдачи (код) уникален для каждой сделки, поэтому дубль ищем по ВСЕЙ
    // истории чата (надёжнее: переживает перезапуск/повторную обработку и не
    // зависит от корректного вычисления границ сделки). Это предотвращает повторную
    // отправку «Ваш код: …» при повторной обработке уже выданной сделки.
    const history = Array.isArray(chatMessages) ? chatMessages : []
    if (history.length > 0 && hasSellerMessageText(history, textToSend, viewerUsername)) {
      logApprouteAutodelivery('chat already has delivery text', {
        productKey,
        dealId: dealId || null,
      })
      return {

        ok: true,

        deliveryText: textToSend,

        markApprouteOrderDone: Boolean(approuteSubmitted),

        markApprouteChatDone: true,

      }
    }



    await withRetry(

      () => createChatMessage(token, userAgent, lastChat.id, textToSend),

      { label: 'createChatMessage(approute delivery)', retries: 3, shouldRetry: isPlayerokRateLimitError }

    )



    logApprouteAutodelivery('chat sent', {

      productKey,

      dealId: dealId || null,

      referenceId: referenceId || null,

      textLen: textToSend.length,

    })

    let autoCompleteDealDone = false
    if (autoCompleteDealEnabled && dealId && typeof updateDealStatus === 'function') {
      const statusNorm = String(dealStatus || '').trim().toUpperCase()
      const skipAutoComplete = statusNorm === 'SENT' || statusNorm === 'CONFIRMED'
      if (!skipAutoComplete) {
        try {
          await withRetry(
            () => updateDealStatus(token, userAgent, dealId, 'SENT'),
            {
              label: 'updateDealStatus(approute autoCompleteDeal)',
              retries: 2,
              shouldRetry: isPlayerokRateLimitError,
            }
          )
          autoCompleteDealDone = true
          logApprouteAutodelivery('deal auto-completed', {
            productKey,
            dealId: dealId || null,
          })
        } catch (err) {
          logApprouteAutodelivery('deal auto-complete failed', {
            productKey,
            dealId: dealId || null,
            error: err?.message || String(err),
          })
        }
      }
    }



    return {

      ok: true,

      deliveryText: textToSend,

      markApprouteOrderDone: Boolean(approuteSubmitted),

      markApprouteChatDone: true,

      autoCompleteDealDone,

    }

  } catch (err) {

    logApprouteAutodelivery('order failed', {

      productKey,

      dealId: dealId || null,

      serviceId: String(serviceId),

      variantId: variantId != null ? String(variantId) : null,

      error: err?.message || String(err),

      approuteErrors: err?.approuteBody?.errors || null,

      triedBodies: err?.triedBodies || null,

    })

    const validation = isApprouteValidationError(err)

    return {

      ok: false,

      reason: 'order_failed',

      error: err?.message || String(err),

      markApprouteOrderDone: !validation,

      markApprouteChatDone: false,

    }

  }

}



module.exports = { runApprouteAutodelivery }


