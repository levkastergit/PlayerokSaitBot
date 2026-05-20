'use strict'

const { resolveEffectiveDealIdForChat } = require('../../functions/supercellHelpers')
const {
  buildPostPurchaseAutomessageEventKey,
  buildDealConfirmedAutomessageEventKey,
  tryBeginChatAutomessageSend,
  finishChatAutomessageSend,
} = require('./autolistState')

const ITEM_SENT_MARKER = '{{ITEM_SENT}}'
const DEAL_CONFIRMED_MARKERS = ['{{DEAL_CONFIRMED}}', '{{DEAL_CONFIRMED_AUTOMATICALLY}}']

function normalizeComparableUsername(value) {
  return String(value || '').trim().toLowerCase()
}

function hasSystemMarkerForDeal(messages, dealId, markers) {
  const targetDealId = dealId != null ? String(dealId).trim() : ''
  const markerList = Array.isArray(markers) ? markers : []
  if (markerList.length === 0) return false

  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i]
    const text = String(m?.text || '')
    if (!markerList.some((marker) => text.includes(marker))) continue
    if (!targetDealId) return true
    const msgDealId =
      m?.dealId != null
        ? String(m.dealId).trim()
        : m?.deal?.id != null
          ? String(m.deal.id).trim()
          : ''
    if (!msgDealId || msgDealId === targetDealId) return true
  }
  return false
}

function hasSellerMessageText(messages, text, viewerUsername) {
  const expected = String(text || '').trim()
  if (!expected) return false
  const normalizedViewer = normalizeComparableUsername(viewerUsername)
  const list = Array.isArray(messages) ? messages : []
  return list.some((msg) => {
    const msgText = String(msg?.text || '').trim()
    if (msgText !== expected) return false
    const username = normalizeComparableUsername(msg?.user?.username || msg?.user?.name || '')
    if (!normalizedViewer) return true
    return !username || username === normalizedViewer
  })
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
  hasSystemMarkerForDeal,
  lastMessageHasAnyMarker,
  ITEM_SENT_MARKER,
  DEAL_CONFIRMED_MARKERS,
}
