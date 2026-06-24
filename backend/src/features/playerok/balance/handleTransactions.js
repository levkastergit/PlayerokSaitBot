const { playerokErrorResponse } = require('../../../infra/playerokErrorResponse')

async function handleTransactions({ payload, currentUserId, deps }) {
  const { getTokenFromBodyOrStored, fetchTransactions, getViewer } = deps
  const { token } = getTokenFromBodyOrStored(currentUserId, payload)
  const userAgent = payload.userAgent

  if (!token) return { statusCode: 400, data: { error: 'token is required' } }

  try {
    const viewer = await getViewer(token, userAgent)
    const data = await fetchTransactions(token, userAgent, {
      userId: viewer?.id,
      count: payload.count,
      operation: payload.operation,
      minValue: payload.minValue,
      maxValue: payload.maxValue,
      providerId: payload.providerId,
      status: payload.status,
      afterCursor: payload.afterCursor,
    })
    return { statusCode: 200, data: { ok: true, ...data } }
  } catch (err) {
    return playerokErrorResponse(err, 'Не удалось загрузить транзакции')
  }
}

module.exports = { handleTransactions }
