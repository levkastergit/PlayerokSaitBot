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
    return {
      statusCode: 500,
      data: { error: 'Failed to unhide chat', details: err && err.message ? String(err.message) : String(err) },
    }
  }
}

module.exports = { handleUnhideChat }

