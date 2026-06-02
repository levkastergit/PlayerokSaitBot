'use strict'

const { logApprouteAutodelivery } = require('../../debug/approuteAutodeliveryLog')
const { dealPurchaseUnixTs } = require('../../functions/dealPurchaseUnixTs')
const { extractDealItemId } = require('../../functions/extractDealItemId')
const { resolvePaidChatDealFromChat } = require('../../functions/resolvePaidChatDealFromChat')

async function runApprouteFromDealChat({
  currentUserId,
  token,
  userAgent,
  chatId,
  dealId: dealIdFromPayload,
  dealItemId: dealItemIdFromPayload,
  messages,
  viewerUsername = null,
  deps,
}) {
  const {
    withRetry,
    isPlayerokRateLimitError,
    requestDealById,
    requestChatDealIdPost,
    requestChatById,
    handlePaidChat,
    toUnixTs,
  } = deps

  if (!token || !chatId || typeof handlePaidChat !== 'function') return { ok: false, reason: 'missing_deps' }

  const chatNode = { id: String(chatId), lastMessage: null }
  const list = Array.isArray(messages) ? messages : []
  if (list.length > 0) {
    const last = list[list.length - 1]
    chatNode.lastMessage = last && typeof last === 'object' ? last : null
  }

  let dealId = dealIdFromPayload != null ? String(dealIdFromPayload).trim() : ''
  let dealItemId = dealItemIdFromPayload != null ? String(dealItemIdFromPayload).trim() : ''

  if (!dealId || !dealItemId) {
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
      messages: list,
    })
    if (!dealId && resolved.dealId) dealId = resolved.dealId
    if (!dealItemId && resolved.dealItemId) dealItemId = resolved.dealItemId
    if (resolved.deal && !chatNode.deal) chatNode.deal = resolved.deal
  }

  let fullDealSnapshot = null
  let dealStatus = null
  let dealTs = 0

  if (dealId && !dealItemId && typeof requestDealById === 'function') {
    try {
      fullDealSnapshot = await withRetry(() => requestDealById(token, userAgent, dealId), {
        label: 'dealById(approuteFromDealChat-itemId)',
        retries: 2,
        shouldRetry: isPlayerokRateLimitError,
      })
      dealItemId = extractDealItemId(fullDealSnapshot) || dealItemId
      dealStatus = fullDealSnapshot?.status || null
      dealTs = dealPurchaseUnixTs(fullDealSnapshot, toUnixTs) || 0
    } catch (err) {
      logApprouteAutodelivery('deal_chat: dealById for itemId failed', {
        chatId: String(chatId),
        dealId,
        error: err?.message || String(err),
      })
    }
  }

  if (!dealId) {
    logApprouteAutodelivery('deal_chat: no deal context', {
      chatId: String(chatId),
      dealId: dealId || null,
      dealItemId: dealItemId || null,
    })
    return { ok: false, reason: 'no_deal_context' }
  }

  if (!dealItemId) {
    logApprouteAutodelivery('deal_chat: no item id, continue delivery_only', {
      chatId: String(chatId),
      dealId,
    })
  }

  if (!fullDealSnapshot && typeof requestDealById === 'function') {
    try {
      fullDealSnapshot = await withRetry(() => requestDealById(token, userAgent, dealId), {
        label: 'dealById(approuteFromDealChat)',
        retries: 2,
        shouldRetry: isPlayerokRateLimitError,
      })
      dealStatus = fullDealSnapshot?.status || dealStatus
      dealTs = dealPurchaseUnixTs(fullDealSnapshot, toUnixTs) || dealTs
    } catch (err) {
      logApprouteAutodelivery('deal_chat: dealById failed', {
        chatId: String(chatId),
        dealId,
        error: err?.message || String(err),
      })
    }
  }

  const nowTs = Math.floor(Date.now() / 1000)
  const tokenHash = token

  logApprouteAutodelivery('deal_chat: handlePaidChat', {
    chatId: String(chatId),
    dealId,
    dealItemId,
  })

  await handlePaidChat({
    ...deps,
    currentUserId,
    tokenHash,
    token,
    userAgent,
    nowTs,
    dealId,
    dealItemId,
    dealTs,
    dealStatus,
    lastChat: chatNode,
    fullDealSnapshot,
    relistedByScanIds: [],
    deliveryOnly: false,
    skipRelist: true,
    chatMessages: list,
    viewerUsername: viewerUsername != null ? String(viewerUsername) : null,
  })

  return { ok: true, dealId, dealItemId }
}

module.exports = { runApprouteFromDealChat }
