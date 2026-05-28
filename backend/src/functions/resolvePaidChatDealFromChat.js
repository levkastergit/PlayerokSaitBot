'use strict'

const { extractDealItemId } = require('./extractDealItemId')
const { pickLatestDealIdFromMessages, resolveEffectiveDealIdForChat } = require('./supercellHelpers')

function pickDealItemIdFromMessages(messages) {
  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const fromDeal = extractDealItemId(list[i]?.deal)
    if (fromDeal) return fromDeal
  }
  return null
}

async function resolvePaidChatDealFromChat({
  token,
  userAgent,
  chatNode,
  withRetry,
  isPlayerokRateLimitError,
  requestDealById,
  requestChatDealIdPost,
  requestChatById,
  dealIdHint,
  messages = null,
}) {
  const chatId = chatNode?.id != null ? String(chatNode.id) : null
  const lm = chatNode?.lastMessage || null
  const messageList = Array.isArray(messages) ? messages : []
  let d = lm?.deal || chatNode?.deal || null
  let candidateDealId =
    d?.id != null ? String(d.id) : dealIdHint != null && String(dealIdHint).trim() ? String(dealIdHint).trim() : null
  let dItemId = extractDealItemId(d)

  if (!candidateDealId && messageList.length > 0) {
    candidateDealId =
      resolveEffectiveDealIdForChat({
        dealIdFromRequest: dealIdHint,
        messages: messageList,
      }) || pickLatestDealIdFromMessages(messageList)
  }

  if (!dItemId && messageList.length > 0) {
    dItemId = pickDealItemIdFromMessages(messageList)
  }

  if (!candidateDealId && chatId && typeof requestChatById === 'function') {
    try {
      const chat = await withRetry(() => requestChatById(token, userAgent, chatId), {
        label: 'chatById(resolvePaidChatDealFromChat)',
        retries: 2,
        shouldRetry: isPlayerokRateLimitError,
      })
      if (chat?.deal?.id != null) candidateDealId = String(chat.deal.id)
      if (chat?.deal && !d) d = chat.deal
      if (!dItemId) dItemId = extractDealItemId(chat.deal)
    } catch (_) {
      // ignore
    }
  }

  if (!candidateDealId && chatId && typeof requestChatDealIdPost === 'function') {
    try {
      const fromPost = await withRetry(() => requestChatDealIdPost(token, userAgent, chatId), {
        label: 'chatDealBootstrap(resolvePaidChatDealFromChat)',
        retries: 2,
        shouldRetry: isPlayerokRateLimitError,
      })
      if (fromPost) candidateDealId = String(fromPost)
    } catch (_) {
      // ignore
    }
  }

  if (candidateDealId && !dItemId && typeof requestDealById === 'function') {
    try {
      const fullDeal = await withRetry(
        () => requestDealById(token, userAgent, candidateDealId),
        {
          label: 'dealById(resolvePaidChatDealFromChat)',
          retries: 1,
          shouldRetry: isPlayerokRateLimitError,
        }
      )
      const fromDeal = extractDealItemId(fullDeal)
      if (fromDeal) dItemId = fromDeal
      if (fullDeal && !d) d = fullDeal
    } catch (_) {
      // ignore
    }
  }

  return {
    chatId,
    lastMessage: lm,
    deal: d,
    dealId: candidateDealId,
    dealItemId: dItemId,
  }
}

module.exports = { resolvePaidChatDealFromChat }
