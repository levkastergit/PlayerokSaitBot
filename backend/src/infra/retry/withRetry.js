const { runWithOutboundAttempt, reportOutboundResult } = require('../playerokOutboundRotation')

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isPlayerokRateLimitError(err) {
  const msg = err && err.message ? String(err.message) : String(err || '')
  return (
    msg.includes('Слишком много попыток') ||
    msg.toLowerCase().includes('too many attempts') ||
    msg.toLowerCase().includes('rate limit') ||
    msg.toLowerCase().includes('status 429')
  )
}

/** Кратковременные сбои Playerok / прокси: имеет смысл повторить publishItem */
function isPlayerokTransientServerError(err) {
  const msg = err && err.message ? String(err.message) : String(err || '')
  return (
    /\bstatus 50[023]\b/.test(msg) ||
    msg.includes('INTERNAL_SERVER_ERROR') ||
    msg.includes('Internal server error') ||
    msg.toLowerCase().includes('bad gateway') ||
    msg.toLowerCase().includes('service unavailable') ||
    msg.toLowerCase().includes('gateway timeout')
  )
}

function isPlayerokPublishRetryable(err) {
  return isPlayerokRateLimitError(err) || isPlayerokTransientServerError(err)
}

async function withRetry(fn, opts = {}) {
  const {
    retries = 3,
    baseDelayMs = 700,
    maxDelayMs = 8000,
    shouldRetry = () => false,
    label = 'op',
  } = opts

  // Все попытки выполняем в одном контексте ротации IP: при 429 повтор берёт
  // IP, отличный от уже опробованного (см. playerokOutboundRotation).
  return runWithOutboundAttempt(async () => {
    let lastErr = null
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const result = await fn()
        // Успех на использованном исходящем IP — снимаем с него штраф ротации.
        reportOutboundResult(true)
        return result
      } catch (err) {
        lastErr = err
        // 429 на использованном IP — эскалируем его блок в ротации (по лестнице).
        if (isPlayerokRateLimitError(err)) reportOutboundResult(false)
        const retryable = attempt < retries && shouldRetry(err)
        if (!retryable) break

        const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt))
        const jitter = Math.floor(Math.random() * 250)
        const delay = exp + jitter
        await sleep(delay)
      }
    }
    throw lastErr
  })
}

module.exports = {
  isPlayerokRateLimitError,
  isPlayerokTransientServerError,
  isPlayerokPublishRetryable,
  withRetry,
  sleep,
}

