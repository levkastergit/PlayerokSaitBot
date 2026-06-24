const { playerokErrorResponse } = require('../../../infra/playerokErrorResponse')

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
    return playerokErrorResponse(err, 'Не удалось отправить сообщение в чат Playerok')
  }
}

module.exports = { handleSendChatMessage }

