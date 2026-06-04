'use strict'

const {
  getSupercellGameByCategory,
  formatSupercellCodeRequestedMessage,
} = require('./supercellHelpers')

const { runSupercellRequestCode } = require('./supercellBridge')

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
    const message = await sendChatMessageToPlayerok(
      token,
      userAgent,
      dealId,
      chatId,
      chatMessage
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

