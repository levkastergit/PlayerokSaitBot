async function handleActiveLots({ payload, currentUserId, deps }) {
  const { getTokenFromBodyOrStored, fetchActiveItemsFromPlayerok } = deps

  const { token } = getTokenFromBodyOrStored(currentUserId, payload)
  const userAgent = payload.userAgent

  if (!token) {
    return { statusCode: 400, data: { error: 'Token is required' } }
  }

  try {
    const result = await fetchActiveItemsFromPlayerok(token, userAgent)
    return { statusCode: 200, data: result }
  } catch (err) {
    const message = err && err.message ? String(err.message) : 'Не удалось загрузить лоты с Playerok'
    return { statusCode: 500, data: { error: message } }
  }
}

module.exports = { handleActiveLots }

