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
    const statusCode = Number(err && err.statusCode)
    const responseBody = err && typeof err.responseBody === 'string' ? err.responseBody : ''
    const isDdosGuard =
      statusCode === 403 &&
      /ddos-guard|js-challenge/i.test(responseBody)

    const message = err && err.message ? String(err.message) : 'Не удалось загрузить лоты с Playerok'
    if (isDdosGuard) {
      return {
        statusCode: 403,
        data: {
          error: message,
          challengeHtml: responseBody,
          challengeType: 'ddos-guard-js-challenge',
        },
      }
    }
    // Брейкер: весь пул IP в cooldown — быстрая 503 (не 504), фронт покажет «временно
    // перегружено» вместо красной ошибки/спиннера. Срабатывает лишь когда нет даже stale-кэша.
    if ((err && err.code === 'PLAYEROK_CIRCUIT_OPEN') || statusCode === 503) {
      return {
        statusCode: 503,
        data: { error: message, circuitOpen: true, soft: true },
      }
    }
    return { statusCode: 500, data: { error: message } }
  }
}

module.exports = { handleActiveLots }

