async function handleSendChatMessage({ payload, currentUserId, deps }) {
  const { getTokenFromBodyOrStored, sendChatMessageToPlayerok } = deps

  const { token } = getTokenFromBodyOrStored(currentUserId, payload)
  const userAgent = payload.userAgent
  const dealId = payload.dealId || null
  const chatId = payload.chatId || null
  const text = payload.text

  if (!token) {
    return { statusCode: 400, data: { error: 'token is required' } }
  }
  if (!dealId && !chatId) {
    return { statusCode: 400, data: { error: 'dealId or chatId is required' } }
  }

  try {
    const message = await sendChatMessageToPlayerok(token, userAgent, dealId, chatId, text)
    return { statusCode: 200, data: { ok: true, message } }
  } catch (err) {
    const message =
      err && err.message ? String(err.message) : 'Не удалось отправить сообщение в чат Playerok'
    return { statusCode: 500, data: { error: message } }
  }
}

module.exports = { handleSendChatMessage }

