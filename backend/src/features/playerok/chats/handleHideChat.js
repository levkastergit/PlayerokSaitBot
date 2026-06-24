const { playerokErrorResponse } = require('../../../infra/playerokErrorResponse')

async function handleHideChat({ payload, currentUserId, deps }) {
  const { getTokenFromBodyOrStored, upsertHiddenChat } = deps

  const { token } = getTokenFromBodyOrStored(currentUserId, payload)
  const chatId = payload.chatId

  if (!token || !chatId) {
    return { statusCode: 400, data: { error: 'token and chatId are required' } }
  }

  const nowTs = Math.floor(Date.now() / 1000)

  try {
    upsertHiddenChat.run(String(chatId), currentUserId, nowTs)
    return { statusCode: 200, data: { ok: true, chatId: String(chatId) } }
  } catch (err) {
    return playerokErrorResponse(err, 'Failed to hide chat')
  }
}

module.exports = { handleHideChat }

