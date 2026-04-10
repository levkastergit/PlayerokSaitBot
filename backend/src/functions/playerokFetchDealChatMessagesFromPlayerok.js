'use strict'

function categoryHintFromFullDeal(fullDeal) {
  if (!fullDeal || typeof fullDeal !== 'object') return null
  const item = fullDeal.item
  if (item && typeof item === 'object') {
    const game = item.game
    if (game && typeof game === 'object') {
      const n = String(game.name || game.title || '').trim()
      if (n) return n
    }
    const cat = item.category
    if (cat && typeof cat === 'object') {
      const n = String(cat.name || cat.title || '').trim()
      if (n) return n
    }
  }
  if (typeof fullDeal.category === 'string') {
    const c = fullDeal.category.trim()
    if (c) return c
  }
  if (typeof fullDeal.productKey === 'string') {
    const i = fullDeal.productKey.indexOf('::')
    if (i > 0) {
      const left = fullDeal.productKey.slice(0, i).trim()
      if (left) return left
    }
  }
  return null
}

const MESSAGE_INTERNAL_KEYS = ['dealItemTitle', 'dealItemImageUrl', 'itemCategory']

function stripInternalMessageFields(message) {
  if (!message || typeof message !== 'object') return message
  const out = { ...message }
  for (const k of MESSAGE_INTERNAL_KEYS) {
    if (k in out) delete out[k]
  }
  return out
}

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
        itemCategory: null,
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

    let hintTitle = null
    let hintImage = null
    let hintCategory = null
    for (const m of allMessages) {
      if (!hintTitle && m.dealItemTitle) hintTitle = m.dealItemTitle
      if (!hintImage && m.dealItemImageUrl) hintImage = m.dealItemImageUrl
      if (!hintCategory && m.itemCategory) hintCategory = m.itemCategory
    }

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
    let itemTitle = hintTitle || null
    let itemImageUrl = hintImage || null
    let itemCategory = hintCategory || null

    if (effectiveDealId) {
      try {
        const fullDeal = await requestDealById(token, userAgent, effectiveDealId)
        const item = fullDeal && fullDeal.item ? fullDeal.item : null
        itemTitle =
          (item && (item.title || item.name)) || fullDeal?.productTitle || itemTitle
        itemImageUrl = extractItemImageUrl(item) || itemImageUrl
        const fromDeal = categoryHintFromFullDeal(fullDeal)
        if (fromDeal) itemCategory = fromDeal

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

    const messages = allMessages.map(stripInternalMessageFields)

    return {
      messages,
      buyerSupercellEmail,
      dealBuyerSupercellEmail,
      buyerMessageSupercellEmail,
      itemTitle,
      itemImageUrl,
      itemCategory,
    }
  }
}

module.exports = { createFetchDealChatMessagesFromPlayerok }

