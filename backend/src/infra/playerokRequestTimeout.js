'use strict'

// Таймаут исходящих HTTP-запросов к Playerok. Без него зависшее соединение
// (Playerok принял сокет, но не отвечает — типично при rate-limit / DDoS-Guard)
// висит бесконечно и блокирует глобальную очередь withPlayerokGate, из-за чего
// nginx отдаёт 504 на загрузку лотов и прочие запросы. См. playerokRequestGate.js.
const rawRequestTimeout = process.env.PLAYEROK_REQUEST_TIMEOUT_MS
const parsedRequestTimeout =
  rawRequestTimeout != null && rawRequestTimeout !== '' ? Number(rawRequestTimeout) : NaN
const PLAYEROK_REQUEST_TIMEOUT_MS =
  Number.isFinite(parsedRequestTimeout) && parsedRequestTimeout > 0
    ? parsedRequestTimeout
    : 25000

/**
 * Навешивает таймаут на исходящий https-запрос к Playerok: если ответ не пришёл
 * за PLAYEROK_REQUEST_TIMEOUT_MS, сокет уничтожается, и reject прилетает через
 * стандартный req.on('error', reject).
 * @param {import('http').ClientRequest} req
 * @param {string} [label] человекочитаемая метка для текста ошибки
 */
function attachPlayerokTimeout(req, label = 'Playerok request') {
  req.setTimeout(PLAYEROK_REQUEST_TIMEOUT_MS, () => {
    req.destroy(new Error(`${label}: таймаут ${PLAYEROK_REQUEST_TIMEOUT_MS}ms`))
  })
}

module.exports = { attachPlayerokTimeout, PLAYEROK_REQUEST_TIMEOUT_MS }
