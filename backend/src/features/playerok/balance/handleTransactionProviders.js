const { playerokErrorResponse } = require('../../../infra/playerokErrorResponse')

async function handleTransactionProviders({ payload, currentUserId, deps }) {
  const { getTokenFromBodyOrStored, fetchTransactionProviders } = deps
  const { token } = getTokenFromBodyOrStored(currentUserId, payload)
  const userAgent = payload.userAgent
  const direction = payload.direction || 'OUT'

  if (!token) return { statusCode: 400, data: { error: 'token is required' } }

  try {
    const data = await fetchTransactionProviders(token, userAgent, direction)
    return { statusCode: 200, data: { ok: true, list: data.list || [] } }
  } catch (err) {
    return playerokErrorResponse(err, 'Не удалось загрузить провайдеров')
  }
}

module.exports = { handleTransactionProviders }
