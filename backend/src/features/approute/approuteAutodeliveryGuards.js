'use strict'

const { ITEM_SENT_MARKER, DEAL_CONFIRMED_MARKERS } = require('../autolist/handleChatAutomessage')

const DEAL_FINISHED_STATUSES = new Set(['CONFIRMED', 'ROLLED_BACK'])
const DEAL_ITEM_SENT_STATUSES = new Set(['SENT', 'CONFIRMED'])

function lastMessageHasDeliveryMarker(text) {
  const value = String(text || '')
  if (value.includes(ITEM_SENT_MARKER)) return true
  return DEAL_CONFIRMED_MARKERS.some((marker) => value.includes(marker))
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
}
