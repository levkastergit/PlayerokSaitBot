'use strict'

const { logApprouteAutodelivery } = require('../../debug/approuteAutodeliveryLog')
const { extractDealItemId } = require('../../functions/extractDealItemId')
const { resolveEffectiveDealIdForChat } = require('../../functions/supercellHelpers')
const { resolvePaidChatDealFromChat } = require('../../functions/resolvePaidChatDealFromChat')
const {
  dealApprouteOrderEventKey,
  dealApprouteChatEventKey,
} = require('../../functions/approuteDealKeys')
const { runApprouteAutodelivery } = require('./runApprouteAutodelivery')
const { describeApprouteFailure } = require('./formatApprouteFailure')

function productKeyFromItemHints(item, deal, normalizeKeyPart, buildProductKey) {
  const rawTitle =
    (item && (item.title || item.name)) ||
    (deal && (deal.productTitle || deal.title)) ||
    ''
  const rawGame =
    typeof item?.game === 'string'
      ? item.game
      : (item?.game?.name && typeof item.game.name === 'string' ? item.game.name : '') ||
        item?.game_name ||
        (typeof deal?.category === 'string' ? deal.category : '') ||
        ''
  const pk = buildProductKey(normalizeKeyPart(rawGame), normalizeKeyPart(rawTitle))
  const titlePart = normalizeKeyPart(rawTitle)
  return pk && titlePart ? pk : ''
}

async function handleApprouteChatRescan({ payload, currentUserId, deps }) {
  const {
    getTokenFromBodyOrStored,
    withRetry,
    isPlayerokRateLimitError,
    requestDealById,
    requestChatDealIdPost,
    requestChatById,
    requestItemById,
    resolveEffectiveProductSettings,
    fetchDealChatMessagesFromPlayerok,
    loadApprouteApiKeyPlain,
    updateDealStatus,
    createChatMessage,
    autolistClearProcessed,
    autolistMarkProcessed,
    normalizeKeyPart,
    buildProductKey,
    sleep,
  } = deps

  const { token } = getTokenFromBodyOrStored(currentUserId, payload)
  const userAgent = payload.userAgent
  const chatId = payload.chatId != null ? String(payload.chatId).trim() : ''
  let dealId = payload.dealId != null ? String(payload.dealId).trim() : ''
  let dealItemId =
    payload.dealItemId != null
      ? String(payload.dealItemId).trim()
      : payload.itemId != null
        ? String(payload.itemId).trim()
        : ''

  if (!token) {
    return { statusCode: 400, data: { error: 'Token is required', ok: false } }
  }
  if (!chatId) {
    return { statusCode: 400, data: { error: 'chatId is required', ok: false } }
  }

  const tokenHash = token
  const nowTs = Math.floor(Date.now() / 1000)

  const chatNode = { id: chatId, lastMessage: null }
  let messages = []

  try {
    const fetched = await fetchDealChatMessagesFromPlayerok(token, userAgent, dealId || null, chatId, {})
    messages = Array.isArray(fetched?.messages) ? fetched.messages : []
    if (messages.length > 0) {
      const last = messages[messages.length - 1]
      chatNode.lastMessage = last && typeof last === 'object' ? last : null
    }
  } catch (err) {
    logApprouteAutodelivery('rescan: fetch messages failed', {
      chatId,
      error: err?.message || String(err),
    })
    return {
      statusCode: 502,
      data: { ok: false, error: err?.message || 'Не удалось загрузить чат', reason: 'fetch_messages_failed' },
    }
  }

  if (!dealId && messages.length > 0) {
    const fromMessages = resolveEffectiveDealIdForChat({
      dealIdFromRequest: payload.dealId,
      messages,
    })
    if (fromMessages) dealId = fromMessages
  }

  const resolved = await resolvePaidChatDealFromChat({
    token,
    userAgent,
    chatNode,
    withRetry,
    isPlayerokRateLimitError,
    requestDealById,
    requestChatDealIdPost,
    requestChatById,
    dealIdHint: dealId || null,
    messages,
  })
  if (!dealId && resolved.dealId) dealId = resolved.dealId
  if (!dealItemId && resolved.dealItemId) dealItemId = resolved.dealItemId
  if (resolved.deal && !chatNode.deal) chatNode.deal = resolved.deal

  let fullDealSnapshot = null
  let dealStatus = null

  if (dealId && typeof requestDealById === 'function') {
    try {
      fullDealSnapshot = await withRetry(() => requestDealById(token, userAgent, dealId), {
        label: 'dealById(approuteRescan)',
        retries: 2,
        shouldRetry: isPlayerokRateLimitError,
      })
      if (!dealItemId) dealItemId = extractDealItemId(fullDealSnapshot) || dealItemId
      dealStatus = fullDealSnapshot?.status || null
    } catch (err) {
      logApprouteAutodelivery('rescan: dealById failed', {
        chatId,
        dealId: dealId || null,
        error: err?.message || String(err),
      })
    }
  }

  if (!dealId || !dealItemId) {
    return {
      statusCode: 400,
      data: {
        ok: false,
        error: 'Не удалось определить сделку для чата',
        reason: 'no_deal_context',
        chatId,
      },
    }
  }

  const approuteOrderKey = dealApprouteOrderEventKey(dealId, dealItemId)
  const approuteChatKey = dealApprouteChatEventKey(dealId, dealItemId)
  const legacyApprouteKey = `approute:${dealId || dealItemId}`

  if (typeof autolistClearProcessed === 'function') {
    autolistClearProcessed(tokenHash, approuteOrderKey)
    autolistClearProcessed(tokenHash, approuteChatKey)
    autolistClearProcessed(tokenHash, legacyApprouteKey)
  }

  logApprouteAutodelivery('rescan: cleared keys', {
    chatId,
    dealId,
    dealItemId,
    approuteOrderKey,
    approuteChatKey,
  })

  const dealItem = fullDealSnapshot?.item || resolved.deal?.item || null
  let productKey = productKeyFromItemHints(
    dealItem,
    fullDealSnapshot || resolved.deal,
    normalizeKeyPart,
    buildProductKey
  )

  let item = dealItem || null
  if (!productKey) {
    try {
      item = await withRetry(() => requestItemById(token, userAgent, dealItemId), {
        label: 'itemById(approuteRescan)',
        retries: 3,
        shouldRetry: isPlayerokRateLimitError,
      })
      productKey = productKeyFromItemHints(item, fullDealSnapshot, normalizeKeyPart, buildProductKey)
    } catch (err) {
      const is429 = /429|TOO_MANY_REQUESTS|слишком много попыток/i.test(String(err?.message || ''))
      return {
        statusCode: is429 ? 429 : 502,
        data: {
          ok: false,
          error: is429
            ? 'Playerok ограничил запросы. Подождите минуту и нажмите «Рескан Api» снова.'
            : err?.message || 'Не удалось загрузить товар',
          reason: is429 ? 'playerok_rate_limit' : 'item_fetch_failed',
          dealId,
          dealItemId,
        },
      }
    }
  }

  if (!productKey) {
    return {
      statusCode: 404,
      data: { ok: false, error: 'Товар не найден', reason: 'item_not_found', dealId, dealItemId },
    }
  }

  const { effectiveSettings, effectiveKey } = resolveEffectiveProductSettings(currentUserId, productKey)

  if (!effectiveSettings?.autodeliveryApi?.enabled) {
    return {
      statusCode: 400,
      data: {
        ok: false,
        error: 'Автовыдача Api не включена для этого товара',
        reason: 'autodelivery_api_disabled',
        productKey: effectiveKey || productKey,
      },
    }
  }

  const lastMessageText = chatNode?.lastMessage?.text ?? null

  const approuteResult = await runApprouteAutodelivery({
    currentUserId,
    loadApprouteApiKeyPlain,
    settings: effectiveSettings,
    lastChat: chatNode,
    dealId,
    dealStatus,
    lastMessageText,
    productKey: effectiveKey || productKey,
    token,
    userAgent,
    createChatMessage,
    withRetry,
    isPlayerokRateLimitError,
    sleep,
    orderAlreadyPlaced: false,
    forceRescan: true,
    onApprouteOrderPlaced: () => {
      if (typeof autolistMarkProcessed === 'function') {
        autolistMarkProcessed(tokenHash, approuteOrderKey, nowTs)
      }
    },
    updateDealStatus,
  })

  if (approuteResult?.markApprouteOrderDone && typeof autolistMarkProcessed === 'function') {
    autolistMarkProcessed(tokenHash, approuteOrderKey, nowTs)
  }
  if (approuteResult?.markApprouteChatDone && typeof autolistMarkProcessed === 'function') {
    autolistMarkProcessed(tokenHash, approuteChatKey, nowTs)
  }

  logApprouteAutodelivery('rescan: done', {
    chatId,
    dealId,
    dealItemId,
    ok: Boolean(approuteResult?.ok),
    reason: approuteResult?.reason || null,
  })

  const failureText = describeApprouteFailure(approuteResult)
  const pending = !approuteResult?.ok && approuteResult?.reason === 'delivery_pending'
  const statusCode = approuteResult?.ok ? 200 : pending ? 200 : 422

  return {
    statusCode,
    data: {
      ok: Boolean(approuteResult?.ok),
      pending,
      reason: approuteResult?.reason || null,
      error: approuteResult?.ok ? null : failureText,
      skipped: Boolean(approuteResult?.skipped),
      dealId,
      dealItemId,
      chatId,
      productKey: effectiveKey || productKey,
    },
  }
}

module.exports = { handleApprouteChatRescan }
