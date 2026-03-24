'use strict'

function createSendChatMessageToPlayerok({ requestDealById, createChatMessage }) {
  if (typeof requestDealById !== 'function') {
    throw new Error('requestDealById must be a function')
  }
  if (typeof createChatMessage !== 'function') {
    throw new Error('createChatMessage must be a function')
  }

  return async function sendChatMessageToPlayerok(
    token,
    userAgent,
    dealId,
    chatIdFromBody,
    text
  ) {
    const trimmed = String(text || '').trim()
    if (!trimmed) {
      throw new Error('Пустое сообщение')
    }

    let chatId = chatIdFromBody || null
    if (!chatId && dealId) {
      const fullDeal = await requestDealById(token, userAgent, dealId)
      chatId = fullDeal?.chat?.id || fullDeal?.chatId || null
    }

    if (!chatId) {
      throw new Error('Не удалось определить чат для отправки сообщения')
    }

    const msg = await createChatMessage(token, userAgent, chatId, trimmed)
    const nowIso = new Date().toISOString()

    return {
      id: msg?.id || null,
      text: msg?.text || trimmed,
      createdAt: nowIso,
    }
  }
}

module.exports = { createSendChatMessageToPlayerok }

