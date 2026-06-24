const { playerokErrorResponse } = require('../../../infra/playerokErrorResponse')

async function handleUnhideChat({ payload, currentUserId, deps }) {
  const { getTokenFromBodyOrStored, deleteHiddenChat } = deps

  const { token } = getTokenFromBodyOrStored(currentUserId, payload)
  const chatId = payload.chatId

  if (!token || !chatId) {
    return { statusCode: 400, data: { error: 'token and chatId are required' } }
  }

  try {
    deleteHiddenChat.run(String(chatId), currentUserId)
    return { statusCode: 200, data: { ok: true, chatId: String(chatId) } }
  } catch (err) {
    return playerokErrorResponse(err, 'Failed to unhide chat')
  }
}

module.exports = { handleUnhideChat }

