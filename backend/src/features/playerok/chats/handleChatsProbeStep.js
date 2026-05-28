'use strict'

function mapChatNode(node) {
  const lastMessage = node.lastMessage || null
  const deal = lastMessage?.deal || node.deal || null
  const item = deal?.item || null
  const itemTitle = (item && (item.title || item.name)) || (deal && deal.productTitle) || null
  const rawText = lastMessage?.text ?? lastMessage?.content ?? lastMessage?.message ?? null
  const lastMessageText =
    typeof rawText === 'string' ? rawText.trim() : rawText != null ? String(rawText) : null

  let buyerName = null
  const buyer = deal?.buyer || node.buyer || null
  if (buyer) buyerName = buyer.username || buyer.name || null
  if (!buyerName && lastMessage?.user) {
    const u = lastMessage.user
    buyerName = u.username || u.name || null
  }

  const unreadRaw = node.unreadMessagesCount ?? node.unreadCount ?? node.unreadMessages
  const unreadCount =
    unreadRaw != null && Number.isFinite(Number(unreadRaw)) ? Math.trunc(Number(unreadRaw)) : null

  return {
    id: node.id != null ? String(node.id) : null,
    buyerName: buyerName ? String(buyerName).trim() : null,
    itemTitle: itemTitle ? String(itemTitle).trim() : null,
    lastMessageText: lastMessageText ? lastMessageText.slice(0, 200) : null,
    unreadCount,
    status: node.status != null ? String(node.status) : null,
  }
}

async function handleChatsProbeStep({ payload, currentUserId, deps }) {
  const { getTokenFromBodyOrStored, getViewer, requestUserChatsPage, isPlayerokRateLimitError } = deps
  const { token } = getTokenFromBodyOrStored(currentUserId, payload)
  const userAgent = payload && payload.userAgent
  const limitRaw = payload && payload.limit
  let limit = Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 24
  if (!limit || limit <= 0) limit = 24
  if (limit > 50) limit = 50

  if (!token) {
    return { statusCode: 400, data: { error: 'Token is required' } }
  }

  let userId =
    payload && payload.userId != null && String(payload.userId).trim()
      ? String(payload.userId).trim()
      : null

  if (!userId) {
    try {
      const viewer = await getViewer(token, userAgent)
      userId = viewer.id
    } catch (err) {
      return {
        statusCode: 502,
        data: {
          error: err && err.message ? String(err.message) : 'Не удалось получить viewer',
        },
      }
    }
  }

  try {
    const chatsData = await requestUserChatsPage(token, userAgent, userId, { first: limit })
    const edges = Array.isArray(chatsData?.edges) ? chatsData.edges : []
    const chats = edges
      .map((edge) => edge && edge.node)
      .filter(Boolean)
      .map(mapChatNode)

    const pageInfo = chatsData && chatsData.pageInfo ? chatsData.pageInfo : null

    return {
      statusCode: 200,
      data: {
        ok: true,
        userId,
        chatCount: chats.length,
        chats,
        pageInfo: pageInfo
          ? {
              hasNextPage: Boolean(pageInfo.hasNextPage),
              endCursor: pageInfo.endCursor || null,
            }
          : null,
      },
    }
  } catch (err) {
    const message = err && err.message ? String(err.message) : String(err)
    if (isPlayerokRateLimitError(err)) {
      return {
        statusCode: 200,
        data: {
          ok: false,
          rateLimited: true,
          userId,
          error: message,
        },
      }
    }
    return {
      statusCode: 502,
      data: { error: message, userId },
    }
  }
}

module.exports = { handleChatsProbeStep }
