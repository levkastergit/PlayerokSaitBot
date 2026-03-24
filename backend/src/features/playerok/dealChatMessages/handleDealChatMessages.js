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

    const { messages, buyerSupercellEmail, itemTitle, itemImageUrl } = await fetchDealChatMessagesFromPlayerok(
      token,
      userAgent,
      dealId,
      chatId,
      { viewerUsername: viewer?.username || null }
    )

    // Немедленная обработка Supercell flow для этого чата, если он активен
    if (chatId && isSupercellModuleEnabled(currentUserId)) {
      const tokenHash = token
      const flowMap = autolistGetSupercellFlowMap(tokenHash)
      const state = flowMap[String(chatId)]
      if (state && state.active) {
        const nowTs = Math.floor(Date.now() / 1000)
        processSingleSupercellFlow(chatId, token, userAgent, viewer?.username || null, nowTs).catch((err) => {
          console.warn('[deal-chat-messages] немедленная обработка supercell flow не удалась', {
            chatId,
            dealId,
            error: err?.message || String(err),
          })
        })
      }
    }

    return { statusCode: 200, data: { list: messages, buyerSupercellEmail, itemTitle, itemImageUrl } }
  } catch (err) {
    const message = err && err.message ? String(err.message) : 'Не удалось загрузить сообщения чата с Playerok'
    return { statusCode: 500, data: { error: message } }
  }
}

module.exports = { handleDealChatMessages }

