'use strict'

function createFetchDealChatMessagesFromPlayerok({
  requestDealById,
  requestChatMessagesPage,
  extractItemImageUrl,
  extractSupercellEmailFromFields,
  getLatestBuyerEmailFromMessages,
}) {
  if (typeof requestDealById !== 'function') throw new Error('requestDealById must be a function')
  if (typeof requestChatMessagesPage !== 'function') {
    throw new Error('requestChatMessagesPage must be a function')
  }
  if (typeof extractItemImageUrl !== 'function') {
    throw new Error('extractItemImageUrl must be a function')
  }
  if (typeof extractSupercellEmailFromFields !== 'function') {
    throw new Error('extractSupercellEmailFromFields must be a function')
  }
  if (typeof getLatestBuyerEmailFromMessages !== 'function') {
    throw new Error('getLatestBuyerEmailFromMessages must be a function')
  }

  return async function fetchDealChatMessagesFromPlayerok(
    token,
    userAgent,
    dealId,
    chatIdFromDeal,
    opts = {}
  ) {
    let chatId = chatIdFromDeal || null
    if (!chatId && dealId) {
      const fullDeal = await requestDealById(token, userAgent, dealId)
      chatId = fullDeal?.chat?.id || fullDeal?.chatId || null
    }

    if (!chatId) {
      return {
        messages: [],
        buyerSupercellEmail: null,
        dealBuyerSupercellEmail: null,
        buyerMessageSupercellEmail: null,
        itemTitle: null,
        itemImageUrl: null,
      }
    }

    const referer = dealId ? `https://playerok.com/deal/${dealId}` : undefined
    const allMessages = []
    let afterCursor = null
    const maxPages = 10
    let pageCount = 0

    do {
      const page = await requestChatMessagesPage(
        token,
        userAgent,
        chatId,
        afterCursor,
        24,
        { referer }
      )
      allMessages.push(...(page.messages || []))
      afterCursor = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null
      pageCount++
    } while (afterCursor && pageCount < maxPages)

    // Пытаемся определить сделку и вытащить почту Supercell ID и данные товара
    let effectiveDealId = dealId || null
    if (!effectiveDealId) {
      for (const m of allMessages) {
        if (m.dealId) {
          effectiveDealId = m.dealId
          break
        }
      }
    }

    let dealBuyerSupercellEmail = null
    let itemTitle = null
    let itemImageUrl = null

    if (effectiveDealId) {
      try {
        const fullDeal = await requestDealById(token, userAgent, effectiveDealId)
        const item = fullDeal && fullDeal.item ? fullDeal.item : null
        itemTitle =
          (item && (item.title || item.name)) || fullDeal?.productTitle || null
        itemImageUrl = extractItemImageUrl(item) || itemImageUrl

        // chat-image debug logging removed
        const fields =
          (fullDeal && Array.isArray(fullDeal.obtainingFields) && fullDeal.obtainingFields) ||
          (fullDeal &&
            fullDeal.item &&
            Array.isArray(fullDeal.item.dataFields) &&
            fullDeal.item.dataFields) ||
          []

        dealBuyerSupercellEmail = extractSupercellEmailFromFields(fields)
      } catch (_) {
        // ignore errors when fetching full deal
      }
    }

    const buyerMessageSupercellEmail = getLatestBuyerEmailFromMessages(
      allMessages,
      opts.viewerUsername || null
    )
    const buyerSupercellEmail =
      buyerMessageSupercellEmail || dealBuyerSupercellEmail || null

    return {
      messages: allMessages,
      buyerSupercellEmail,
      dealBuyerSupercellEmail,
      buyerMessageSupercellEmail,
      itemTitle,
      itemImageUrl,
    }
  }
}

module.exports = { createFetchDealChatMessagesFromPlayerok }

