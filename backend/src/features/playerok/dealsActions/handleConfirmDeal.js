async function handleConfirmDeal({ payload, currentUserId, deps }) {
  const { getTokenFromBodyOrStored, updateDealStatus } = deps

  const { token } = getTokenFromBodyOrStored(currentUserId, payload)
  const userAgent = payload.userAgent
  const dealId = payload.dealId || payload.id || null

  if (!token || !dealId) {
    return { statusCode: 400, data: { error: 'token and dealId are required' } }
  }

  try {
    const deal = await updateDealStatus(token, userAgent, dealId, 'SENT')
    return { statusCode: 200, data: { ok: true, deal } }
  } catch (err) {
    return {
      statusCode: 500,
      data: {
        error: err && err.message ? String(err.message) : 'Не удалось подтвердить выполнение сделки на Playerok',
      },
    }
  }
}

module.exports = { handleConfirmDeal }

