const { logSupercellDebug } = require('../../../functions/supercellHelpers')

async function handleDealChatMessages({ payload, currentUserId, deps }) {
  const {
    getTokenFromBodyOrStored,
    withRetry,
    isPlayerokRateLimitError,
    getViewer,
    fetchDealChatMessagesFromPlayerok,
    autolistGetSupercellFlowMap,
    processSingleSupercellFlow,
    isSupercellModuleEnabled,
    handlePostPurchaseAutomessage: handlePostPurchaseAutomessageFn,
    handleDealConfirmedAutomessage: handleDealConfirmedAutomessageFn,
    requestDealById,
    requestItemById,
    resolveEffectiveProductSettings,
    createChatMessage,
    normalizeKeyPart,
    buildProductKey,
  } = deps

  const { token } = getTokenFromBodyOrStored(currentUserId, payload)
  const userAgent = payload.userAgent
  const dealId = payload.dealId || null
  const chatId = payload.chatId || null

  if (!token || (!dealId && !chatId)) {
    return { statusCode: 400, data: { error: 'token and (dealId or chatId) are required' } }
  }

  try {
    let viewer = null
    try {
      viewer = await withRetry(() => getViewer(token, userAgent), {
        label: 'getViewer(deal-chat-messages)',
        retries: 2,
        shouldRetry: isPlayerokRateLimitError,
      })
    } catch (_) {
      viewer = null
    }

    const buyerUsername =
      typeof payload.buyerName === 'string' && payload.buyerName.trim()
        ? payload.buyerName.trim()
        : typeof payload.buyerUsername === 'string' && payload.buyerUsername.trim()
          ? payload.buyerUsername.trim()
          : null

    const categoryHint =
      typeof payload.category === 'string' && payload.category.trim()
        ? payload.category.trim()
        : typeof payload.itemCategory === 'string' && payload.itemCategory.trim()
          ? payload.itemCategory.trim()
          : null

    const { messages, buyerSupercellEmail, itemTitle, itemImageUrl, itemCategory } =
      await fetchDealChatMessagesFromPlayerok(token, userAgent, dealId, chatId, {
        viewerUsername: viewer?.username || null,
        buyerUsername,
        categoryHint,
      })

    const effectiveChatId = chatId || payload.chatId || null
    const dealItemId =
      payload.dealItemId != null
        ? String(payload.dealItemId).trim()
        : payload.itemId != null
          ? String(payload.itemId).trim()
          : null

    const automessageHandlers = [
      { fn: handlePostPurchaseAutomessageFn, logLabel: 'post-purchase-automessage' },
      { fn: handleDealConfirmedAutomessageFn, logLabel: 'deal-confirmed-automessage' },
    ]

    if (effectiveChatId) {
      const nowTs = Math.floor(Date.now() / 1000)
      const automessageParams = {
        currentUserId,
        tokenHash: token,
        token,
        userAgent,
        nowTs,
        chatId: String(effectiveChatId),
        dealId,
        dealItemId: dealItemId || null,
        messages,
        itemTitle,
        itemCategory,
        viewerUsername: viewer?.username || null,
        withRetry,
        isPlayerokRateLimitError,
        requestDealById,
        requestItemById,
        resolveEffectiveProductSettings,
        createChatMessage,
        normalizeKeyPart,
        buildProductKey,
      }

      for (const { fn, logLabel } of automessageHandlers) {
        if (!fn) continue
        try {
          await fn(automessageParams)
        } catch (err) {
          console.warn(`[deal-chat-messages] ${logLabel} не удалась`, {
            chatId: effectiveChatId,
            dealId,
            error: err?.message || String(err),
          })
        }
      }
    }

    // Немедленная обработка Supercell flow для этого чата, если он активен
    if (chatId && isSupercellModuleEnabled(currentUserId)) {
      const tokenHash = token
      const flowMap = autolistGetSupercellFlowMap(tokenHash)
      const state = flowMap[String(chatId)]
      logSupercellDebug('dealChatMessages:supercellFlowCheck', {
        chatId,
        dealIdFromRequest: dealId || null,
        categoryHint: categoryHint || null,
        flowActive: Boolean(state?.active),
        flowCategory: state?.category || null,
        flowDealId: state?.dealId || null,
        requestCodeRequested: Boolean(state?.requestCodeRequested),
        itemCategoryFromFetch: itemCategory || null,
        hasBuyerEmail: Boolean(buyerSupercellEmail),
      })
      if (state && state.active) {
        const nowTs = Math.floor(Date.now() / 1000)
        processSingleSupercellFlow(chatId, token, userAgent, viewer?.username || null, nowTs).catch((err) => {
          console.warn('[deal-chat-messages] немедленная обработка supercell flow не удалась', {
            chatId,
            dealId,
            error: err?.message || String(err),
          })
        })
      } else if (state && !state.active) {
        logSupercellDebug('dealChatMessages:flowInactive', {
          chatId,
          requestCodeRequested: Boolean(state.requestCodeRequested),
          category: state.category || null,
        })
      }
    }

    return {
      statusCode: 200,
      data: { list: messages, buyerSupercellEmail, itemTitle, itemImageUrl, itemCategory },
    }
  } catch (err) {
    const message = err && err.message ? String(err.message) : 'Не удалось загрузить сообщения чата с Playerok'
    return { statusCode: 500, data: { error: message } }
  }
}

module.exports = { handleDealChatMessages }

