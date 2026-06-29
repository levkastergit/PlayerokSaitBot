'use strict'

// Единый хелпер «повтори запрос к Playerok с ДРУГОГО IP при ошибке».
//
// Зачем: lim 429 у Playerok — ПО IP (когда один IP залочен, остальные тем же токеном
// отдают 200 — см. playerokOutboundRotation). Значит почти любую сетевую ошибку можно
// вылечить повтором с другого исходящего IP. Раньше это умел только withRetry, и то
// по согласию вызывающего (shouldRetry по умолчанию = ()=>false) → многие request-функции
// делали ОДИН запрос и падали на первом же плохом IP. Этот хелпер делает «попробуй другой
// IP» поведением по умолчанию для ВСЕХ запросов — но с разной агрессивностью по политике,
// чтобы не словить двойную отправку/двойное списание на немопотентных мутациях.
//
// Построен поверх withRetry (он владеет runWithOutboundAttempt → каждая попытка заходит в
// pickRotationIp с per-op tried-set → гарантированно ДРУГОЙ, не-залоченный IP). Не дублируем
// бэкофф/джиттер/обработку circuit-breaker — переиспользуем.

const {
  withRetry,
  isPlayerokRateLimitError,
  isPlayerokTransientServerError,
} = require('./withRetry')
const { hasOutboundAttemptContext } = require('../playerokOutboundRotation')

// Сетевые сбои вообще (соединение оборвалось/таймаут/DNS) — повторяемы для idempotent-чтений.
function isNetworkError(err) {
  const code = err && err.code ? String(err.code) : ''
  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'ENETUNREACH'].includes(code)) {
    return true
  }
  const msg = err && err.message ? String(err.message) : String(err || '')
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|network|таймаут|timeout/i.test(msg)
}

// Ошибка ДОКАЗЫВАЕТ, что запрос НЕ дошёл до сервера (можно безопасно повторить даже
// немопотентную мутацию: отправки/списания не было). Фаза установления соединения.
function isConnectPhaseError(err) {
  const code = err && err.code ? String(err.code) : ''
  if (['ECONNREFUSED', 'EAI_AGAIN', 'ENETUNREACH'].includes(code)) return true
  const msg = err && err.message ? String(err.message) : String(err || '')
  // 'connect ETIMEDOUT' / 'getaddrinfo EAI_AGAIN' — до отправки байтов.
  return /ECONNREFUSED|EAI_AGAIN|ENETUNREACH|connect ETIMEDOUT|getaddrinfo/i.test(msg)
}

// 401/403 от залоченного IP (Playerok так отдаёт на rate-limited IP). Для idempotent-чтений
// повтор с ДРУГОГО IP может вернуть 200. Если токен реально невалиден — 401 на всех IP,
// и мы просто исчерпаем (немного) попыток. Так уже делает requestChatMessagesPage.
function isAuthRotatable(err) {
  const sc = Number(err && err.statusCode)
  return sc === 401 || sc === 403
}

// Политики ретрая (по нарастанию опасности повтора):
const POLICIES = {
  // READ — идемпотентные GET-чтения. Повтор безопасен всегда.
  read: (err) =>
    isPlayerokRateLimitError(err) ||
    isPlayerokTransientServerError(err) ||
    isNetworkError(err) ||
    isAuthRotatable(err),
  // IDEMPOTENT-MUTATION — мутации, повтор которых не создаёт дубль (смена статуса сделки на
  // тот же, удаление по UUID, повышение приоритета лота, публикация лота). 429 + 5xx +
  // сетевые. Совпадает с isPlayerokPublishRetryable, но добавляем сетевые сбои.
  idempotentMutation: (err) =>
    isPlayerokRateLimitError(err) ||
    isPlayerokTransientServerError(err) ||
    isNetworkError(err),
  // UNSAFE — немопотентные мутации (отправка сообщения/картинки, ВЫВОД ДЕНЕГ). Повторяем
  // ТОЛЬКО на 429 и на ошибках, доказывающих что запрос НЕ дошёл (нет двойной отправки/
  // двойного списания). НИКОГДА на 5xx/таймаут после отправки — там сервер мог принять.
  unsafe: (err) => isPlayerokRateLimitError(err) || isConnectPhaseError(err),
}

const DEFAULT_ATTEMPTS = { read: 4, idempotentMutation: 3, unsafe: 3 }

/**
 * Обернуть выполнение запроса к Playerok ретраем со сменой IP.
 * @param {() => Promise<any>} fn — выполняет ОДИН запрос (внутри он сам резолвит IP через
 *   playerokHttpsExtraOptions → на каждый повтор берётся другой IP ротации).
 * @param {{policy?: 'read'|'idempotentMutation'|'unsafe', attempts?: number,
 *          baseDelayMs?: number, maxDelayMs?: number, label?: string}} opts
 */
function withPlayerokRotation(fn, opts = {}) {
  const policy = POLICIES[opts.policy] ? opts.policy : 'read'
  // Уже внутри внешнего ретрай-контекста (вызывающий обернул в withRetry/withPlayerokRotation):
  // НЕ заводим вложенный цикл (иначе попытки умножаются). Внешний владелец сам повторит с
  // новым IP — мы просто выполняем один раз.
  if (hasOutboundAttemptContext()) {
    return Promise.resolve().then(fn)
  }
  const attempts =
    Number.isFinite(opts.attempts) && opts.attempts > 0
      ? Math.floor(opts.attempts)
      : DEFAULT_ATTEMPTS[policy]
  let baseDelay = Number.isFinite(opts.baseDelayMs) ? opts.baseDelayMs : null
  if (baseDelay == null) {
    // Живая базовая задержка повтора из настроек /settings (дефолт 500).
    try {
      const { getSpeed } = require('../playerokSpeedSettings')
      const v = Number(getSpeed('retryBaseDelayMs'))
      baseDelay = Number.isFinite(v) && v > 0 ? v : 500
    } catch (_) {
      baseDelay = 500
    }
  }
  return withRetry(fn, {
    retries: Math.max(0, attempts - 1),
    baseDelayMs: baseDelay,
    maxDelayMs: Number.isFinite(opts.maxDelayMs) ? opts.maxDelayMs : 6000,
    shouldRetry: POLICIES[policy],
    label: opts.label || policy,
  })
}

module.exports = {
  withPlayerokRotation,
  isNetworkError,
  isConnectPhaseError,
}
