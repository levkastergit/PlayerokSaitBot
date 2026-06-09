'use strict'

const { ITEM_SENT_MARKER, DEAL_CONFIRMED_MARKERS } = require('../autolist/handleChatAutomessage')

const DEAL_FINISHED_STATUSES = new Set(['CONFIRMED', 'ROLLED_BACK'])
const DEAL_ITEM_SENT_STATUSES = new Set(['SENT', 'CONFIRMED'])
// Возврат/откат сделки на Playerok (статус «Возврат»). По такой сделке НЕЛЬЗЯ
// выполнять никакую автовыдачу (коды, активации clode/gpt, пополнения, supercell):
// сделка отменена и деньги покупателю возвращены.
const DEAL_REFUND_STATUSES = new Set(['ROLLED_BACK'])

function lastMessageHasDeliveryMarker(text) {
  const value = String(text || '')
  if (value.includes(ITEM_SENT_MARKER)) return true
  return DEAL_CONFIRMED_MARKERS.some((marker) => value.includes(marker))
}

/**
 * Сделка уже доведена до выдачи: товар отправлен (SENT), сделка подтверждена
 * (CONFIRMED) или откатана (ROLLED_BACK). В этих состояниях интерактивная
 * автовыдача (clode/gpt) не должна ничего запрашивать у покупателя.
 */
function isDealDeliveredOrFinished(dealStatus) {
  const status = String(dealStatus || '')
    .trim()
    .toUpperCase()
  if (!status) return false
  return DEAL_FINISHED_STATUSES.has(status) || DEAL_ITEM_SENT_STATUSES.has(status)
}

/**
 * Сделка возвращена/откатана (статус «Возврат» / ROLLED_BACK). В этом случае любая
 * автоматика выдачи должна быть полностью остановлена.
 */
function isDealRefunded(dealStatus) {
  const status = String(dealStatus || '')
    .trim()
    .toUpperCase()
  if (!status) return false
  return DEAL_REFUND_STATUSES.has(status)
}

function shouldSkipApprouteAutodelivery({ dealStatus, lastMessageText } = {}) {
  const status = String(dealStatus || '')
    .trim()
    .toUpperCase()

  if (DEAL_FINISHED_STATUSES.has(status)) {
    return { skip: true, reason: 'deal_finished', dealStatus: status }
  }

  if (DEAL_ITEM_SENT_STATUSES.has(status)) {
    return { skip: true, reason: 'item_sent', dealStatus: status }
  }

  if (lastMessageHasDeliveryMarker(lastMessageText)) {
    return { skip: true, reason: 'delivery_marker', dealStatus: status || null }
  }

  return { skip: false, reason: null, dealStatus: status || null }
}

module.exports = {
  shouldSkipApprouteAutodelivery,
  lastMessageHasDeliveryMarker,
  isDealDeliveredOrFinished,
  isDealRefunded,
}
