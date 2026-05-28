'use strict'

const { resolveEffectiveDealIdForChat } = require('../../functions/supercellHelpers')
const { toUnixTs: defaultToUnixTs } = require('../../functions/toUnixTs')
const {
  buildPostPurchaseAutomessageEventKey,
  buildDealConfirmedAutomessageEventKey,
  tryBeginChatAutomessageSend,
  finishChatAutomessageSend,
  autolistMarkProcessed,
  CHAT_AUTOMESSAGE_MAX_TRIGGER_AGE_SEC,
} = require('./autolistState')

const ITEM_SENT_MARKER = '{{ITEM_SENT}}'
const DEAL_CONFIRMED_MARKERS = ['{{DEAL_CONFIRMED}}', '{{DEAL_CONFIRMED_AUTOMATICALLY}}']

function messageDealIdForMarkerMatch(m) {
  if (m?.dealId != null) return String(m.dealId).trim()
  if (m?.deal?.id != null) return String(m.deal.id).trim()
  return ''
}

function findLatestSystemMarkerMessage(messages, dealId, markers) {
  const targetDealId = dealId != null ? String(dealId).trim() : ''
  const markerList = Array.isArray(markers) ? markers : []
  if (markerList.length === 0) return null

  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i]
    const text = String(m?.text || '')
    if (!markerList.some((marker) => text.includes(marker))) continue
    if (targetDealId) {
      const msgDealId = messageDealIdForMarkerMatch(m)
      if (msgDealId && msgDealId !== targetDealId) continue
    }
    return m
  }
  return null
}

function hasSystemMarkerForDeal(messages, dealId, markers) {
  return findLatestSystemMarkerMessage(messages, dealId, markers) != null
}

function getSystemMarkerTriggerUnixTs(messages, dealId, markers, toUnixTsFn = defaultToUnixTs) {
  const tu = typeof toUnixTsFn === 'function' ? toUnixTsFn : defaultToUnixTs
  const m = findLatestSystemMarkerMessage(messages, dealId, markers)
  if (!m) return 0
  return tu(m.createdAt) || 0
}

function hasSellerMessageText(messages, text, _viewerUsername) {
  const expected = String(text || '').trim()
  if (!expected) return false
  const list = Array.isArray(messages) ? messages : []
  return list.some((msg) => String(msg?.text || '').trim() === expected)
}

function lastMessageHasAnyMarker(text, markers) {
  const value = String(text || '')
  return (Array.isArray(markers) ? markers : []).some((marker) => value.includes(marker))
}

async function runChatAutomessage({
  kind,
  settingsField,
  systemMarkers,
  buildEventKey,
  logLabel,
  currentUserId,
  tokenHash,
  token,
  userAgent,
  nowTs,
  chatId,
  dealId,
  dealItemId,
  messages,
  itemTitle,
  itemCategory,
  viewerUsername,
  withRetry,
  isPlayerokRateLimitError,
  requestDealById,
  requestItemById,
  resolveEffectiveProductSettings,
  createChatMessage,
  normalizeKeyPart,
  buildProductKey,
  toUnixTs = defaultToUnixTs,
}) {
  if (!token || !chatId) return { sent: false, reason: 'missing_chat' }

  const effectiveDealId = resolveEffectiveDealIdForChat({
    dealIdFromRequest: dealId,
    messages,
  })
  const eventKey = buildEventKey(chatId, effectiveDealId)
  if (!eventKey) return { sent: false, reason: 'no_event_key' }

  if (!hasSystemMarkerForDeal(messages, effectiveDealId || null, systemMarkers)) {
    return { sent: false, reason: 'no_system_marker' }
  }

  const effectiveNowTs = Number(nowTs) > 0 ? Number(nowTs) : Math.floor(Date.now() / 1000)
  const triggerTs = getSystemMarkerTriggerUnixTs(
    messages,
    effectiveDealId || null,
    systemMarkers,
    toUnixTs
  )
  if (
    triggerTs > 0 &&
    effectiveNowTs - triggerTs > CHAT_AUTOMESSAGE_MAX_TRIGGER_AGE_SEC
  ) {
    autolistMarkProcessed(tokenHash, eventKey, effectiveNowTs)
    return { sent: false, reason: 'trigger_expired' }
  }

  if (!tryBeginChatAutomessageSend(tokenHash, eventKey)) {
    return { sent: false, reason: 'locked_or_processed' }
  }

  let finishSuccess = false

  try {
    let rawTitle = typeof itemTitle === 'string' ? itemTitle.trim() : ''
    let rawGame = typeof itemCategory === 'string' ? itemCategory.trim() : ''

    if (dealItemId || effectiveDealId) {
      try {
        if (dealItemId) {
          const item = await withRetry(() => requestItemById(token, userAgent, dealItemId), {
            label: `itemById(${logLabel})`,
            retries: 2,
            shouldRetry: isPlayerokRateLimitError,
          })
          if (item) {
            rawTitle = rawTitle || item.title || item.name || ''
            if (!rawGame) {
              rawGame =
                typeof item?.game === 'string'
                  ? item.game
                  : (item?.game?.name && typeof item.game.name === 'string' ? item.game.name : '') ||
                    item?.game_name ||
                    ''
            }
          }
        } else if (effectiveDealId) {
          const fullDeal = await withRetry(() => requestDealById(token, userAgent, effectiveDealId), {
            label: `dealById(${logLabel})`,
            retries: 2,
            shouldRetry: isPlayerokRateLimitError,
          })
          const dealItem = fullDeal?.item || null
          if (dealItem) {
            rawTitle = rawTitle || dealItem.title || dealItem.name || ''
            if (!rawGame) {
              rawGame =
                typeof dealItem?.game === 'string'
                  ? dealItem.game
                  : (dealItem?.game?.name && typeof dealItem.game.name === 'string'
                      ? dealItem.game.name
                      : '') || ''
            }
          }
          if (!rawGame && fullDeal && typeof fullDeal.productKey === 'string') {
            const sep = fullDeal.productKey.indexOf('::')
            if (sep > 0) rawGame = fullDeal.productKey.slice(0, sep).trim()
          }
        }
      } catch (err) {
        console.warn(`[${logLabel}] не удалось загрузить товар/сделку`, {
          dealId: effectiveDealId || null,
          dealItemId: dealItemId || null,
          error: err?.message || String(err),
        })
      }
    }

    const title = normalizeKeyPart(rawTitle)
    const game = normalizeKeyPart(rawGame)
    const productKey = buildProductKey(game, title)
    if (!productKey) {
      return { sent: false, reason: 'no_product_key' }
    }

    const { effectiveSettings } = resolveEffectiveProductSettings(currentUserId, productKey)
    const cfg =
      effectiveSettings?.[settingsField] && typeof effectiveSettings[settingsField] === 'object'
        ? effectiveSettings[settingsField]
        : null

    if (!cfg?.enabled) {
      return { sent: false, reason: 'disabled' }
    }

    const text = String(cfg.message || '').trim()
    if (!text) {
      return { sent: false, reason: 'empty_message' }
    }

    if (hasSellerMessageText(messages, text, viewerUsername)) {
      finishSuccess = true
      return { sent: false, reason: 'already_in_chat' }
    }

    await withRetry(
      () => createChatMessage(token, userAgent, String(chatId), text),
      { label: `createChatMessage(${logLabel})`, retries: 3, shouldRetry: isPlayerokRateLimitError }
    )
    finishSuccess = true
    return { sent: true, kind }
  } catch (err) {
    console.warn(`[${logLabel}] отправка не удалась`, {
      chatId,
      dealId: effectiveDealId || null,
      error: err?.message || String(err),
    })
    return { sent: false, reason: 'send_failed' }
  } finally {
    finishChatAutomessageSend(tokenHash, eventKey, {
      success: finishSuccess,
      nowTs,
    })
  }
}

async function handlePostPurchaseAutomessage(params) {
  return runChatAutomessage({
    ...params,
    kind: 'post_purchase',
    settingsField: 'postPurchaseAutomessage',
    systemMarkers: [ITEM_SENT_MARKER],
    buildEventKey: buildPostPurchaseAutomessageEventKey,
    logLabel: 'post-purchase-automessage',
  })
}

async function handleDealConfirmedAutomessage(params) {
  return runChatAutomessage({
    ...params,
    kind: 'deal_confirmed',
    settingsField: 'dealConfirmedAutomessage',
    systemMarkers: DEAL_CONFIRMED_MARKERS,
    buildEventKey: buildDealConfirmedAutomessageEventKey,
    logLabel: 'deal-confirmed-automessage',
  })
}

module.exports = {
  handlePostPurchaseAutomessage,
  handleDealConfirmedAutomessage,
  hasSellerMessageText,
  hasSystemMarkerForDeal,
  getSystemMarkerTriggerUnixTs,
  lastMessageHasAnyMarker,
  ITEM_SENT_MARKER,
  DEAL_CONFIRMED_MARKERS,
}
