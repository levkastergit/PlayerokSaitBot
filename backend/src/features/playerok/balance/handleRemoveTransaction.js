const { playerokErrorResponse } = require('../../../infra/playerokErrorResponse')

async function handleRemoveTransaction({ payload, currentUserId, deps }) {
  const { getTokenFromBodyOrStored, removeTransaction } = deps
  const { token } = getTokenFromBodyOrStored(currentUserId, payload)
  const userAgent = payload.userAgent
  const transactionId = payload.transactionId || payload.id

  if (!token || !transactionId) {
    return { statusCode: 400, data: { error: 'token and transactionId are required' } }
  }

  try {
    const transaction = await removeTransaction(token, userAgent, transactionId)
    return { statusCode: 200, data: { ok: true, transaction } }
  } catch (err) {
    return playerokErrorResponse(err, 'Не удалось отменить транзакцию')
  }
}

module.exports = { handleRemoveTransaction }
