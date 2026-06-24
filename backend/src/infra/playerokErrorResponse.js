'use strict'

// Единая классификация ошибок запроса к Playerok в HTTP-ответ { statusCode, data }.
// Раньше большинство хендлеров отдавали generic 500 на 429/circuit-open — фронт не
// понимал, что надо притормозить, и сразу ретраил, усиливая 429. Теперь:
//   429  — лимит запросов Playerok       → фронт делает backoff;
//   503  — брейкер/канал отключён/пул IP  → «временно недоступно», мягкий ретрай позже;
//   403  — DDoS-Guard JS-челлендж         → UI рисует челлендж;
//   500  — всё остальное (как раньше).
// Логика 403/503 повторяет эталон handleActiveLots.

function isRateLimit(err) {
  if (err && err.statusCode === 429) return true
  const m = err && err.message ? String(err.message) : String(err || '')
  return (
    m.includes('Слишком много попыток') ||
    m.toLowerCase().includes('too many attempts') ||
    m.toLowerCase().includes('rate limit') ||
    m.includes('status 429') ||
    m.includes('TOO_MANY_REQUESTS')
  )
}

function playerokErrorResponse(err, fallbackMessage = 'Ошибка запроса к Playerok') {
  const message = err && err.message ? String(err.message) : fallbackMessage
  const statusCode = Number(err && err.statusCode)
  const responseBody = err && typeof err.responseBody === 'string' ? err.responseBody : ''

  // DDoS-Guard JS-челлендж (403) — отдаём тело, чтобы UI отрисовал челлендж.
  if (statusCode === 403 && /ddos-guard|js-challenge/i.test(responseBody)) {
    return {
      statusCode: 403,
      data: { error: message, challengeHtml: responseBody, challengeType: 'ddos-guard-js-challenge' },
    }
  }

  // Брейкер (весь пул IP на cooldown) / отключённый канал — мягкая 503, не 500/504.
  if (
    (err && (err.code === 'PLAYEROK_CIRCUIT_OPEN' || err.code === 'PLAYEROK_CHANNEL_DISABLED')) ||
    statusCode === 503
  ) {
    return {
      statusCode: 503,
      data: {
        error: message,
        circuitOpen: Boolean(err && err.code === 'PLAYEROK_CIRCUIT_OPEN'),
        soft: true,
        retryable: true,
      },
    }
  }

  // 429 — фронт должен сделать backoff, а не мгновенный ретрай.
  if (isRateLimit(err)) {
    return { statusCode: 429, data: { error: message, rateLimited: true, retryable: true } }
  }

  return { statusCode: 500, data: { error: message } }
}

module.exports = { playerokErrorResponse }
