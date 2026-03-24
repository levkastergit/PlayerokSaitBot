async function handleVerifiedCards({ payload, currentUserId, deps }) {
  const { getTokenFromBodyOrStored, fetchVerifiedCards } = deps
  const { token } = getTokenFromBodyOrStored(currentUserId, payload)
  const userAgent = payload.userAgent

  if (!token) return { statusCode: 400, data: { error: 'token is required' } }

  try {
    const data = await fetchVerifiedCards(token, userAgent, {
      count: payload.count,
      direction: payload.direction,
      afterCursor: payload.afterCursor,
    })
    return { statusCode: 200, data: { ok: true, ...data } }
  } catch (err) {
    return { statusCode: 500, data: { error: err?.message || 'Не удалось загрузить карты' } }
  }
}

module.exports = { handleVerifiedCards }
