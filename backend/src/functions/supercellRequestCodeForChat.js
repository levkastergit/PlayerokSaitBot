'use strict'

const {
  getSupercellGameByCategory,
  formatSupercellCodeRequestedMessage,
} = require('./supercellHelpers')

const { runSupercellRequestCode } = require('./supercellBridge')
const { withRetry, isPlayerokRateLimitError } = require('../infra/retry/withRetry')

function createRequestSupercellCodeForChat({ sendChatMessageToPlayerok }) {
  if (typeof sendChatMessageToPlayerok !== 'function') {
    throw new Error('sendChatMessageToPlayerok must be a function')
  }

  return async function requestSupercellCodeForChat({
    token,
    userAgent,
    dealId,
    chatId,
    email,
    category,
    requestCodeMessageTemplate,
  }) {
    const trimmedEmail = String(email || '').trim()
    const trimmedCategory = String(category || '').trim()
    if (!token) throw new Error('token is required')
    if (!dealId && !chatId) throw new Error('dealId or chatId is required')
    if (!trimmedEmail) throw new Error('email is required')
    const game = getSupercellGameByCategory(trimmedCategory)
    if (!game) {
      throw new Error('Категория не поддерживает запрос кода Supercell')
    }

    const supercell = await runSupercellRequestCode({
      email: trimmedEmail,
      gameKey: game.gameKey,
    })

    const chatMessage = formatSupercellCodeRequestedMessage(
      game.gameName,
      requestCodeMessageTemplate
    )
    // ВАЖНО: сам запрос кода (runSupercellRequestCode) уже выполнен и НЕ ретраится (иначе
    // покупатель получит два кода). Ретраим на 429 только ОТПРАВКУ сообщения в чат Playerok —
    // чтобы уведомление о запросе кода надёжно дошло даже при всплеске лимита.
    const message = await withRetry(
      () => sendChatMessageToPlayerok(token, userAgent, dealId, chatId, chatMessage),
      { retries: 3, shouldRetry: isPlayerokRateLimitError, label: 'supercellRequestCode:sendMessage' }
    )

    return {
      ok: true,
      gameKey: game.gameKey,
      gameName: game.gameName,
      email: trimmedEmail,
      chatMessage: message?.text || chatMessage,
      message,
      supercell,
    }
  }
}

module.exports = { createRequestSupercellCodeForChat }

