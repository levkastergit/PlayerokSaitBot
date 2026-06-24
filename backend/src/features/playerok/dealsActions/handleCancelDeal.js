const { playerokErrorResponse } = require('../../../infra/playerokErrorResponse')

async function handleCancelDeal({ payload, currentUserId, deps }) {
  const { getTokenFromBodyOrStored, updateDealStatus } = deps

  const { token } = getTokenFromBodyOrStored(currentUserId, payload)
  const userAgent = payload.userAgent
  const dealId = payload.dealId || payload.id || null

  if (!token || !dealId) {
    return { statusCode: 400, data: { error: 'token and dealId are required' } }
  }

  try {
    const deal = await updateDealStatus(token, userAgent, dealId, 'ROLLED_BACK')
    return { statusCode: 200, data: { ok: true, deal } }
  } catch (err) {
    return playerokErrorResponse(err, 'Не удалось отменить сделку на Playerok')
  }
}

module.exports = { handleCancelDeal }

