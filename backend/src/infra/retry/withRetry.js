function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isPlayerokRateLimitError(err) {
  const msg = err && err.message ? String(err.message) : String(err || '')
  return (
    msg.includes('Слишком много попыток') ||
    msg.toLowerCase().includes('too many attempts') ||
    msg.toLowerCase().includes('rate limit') ||
    msg.toLowerCase().includes('status 429') ||
    msg.toLowerCase().includes('status 403')
  )
}

async function withRetry(fn, opts = {}) {
  const {
    retries = 3,
    baseDelayMs = 700,
    maxDelayMs = 8000,
    shouldRetry = () => false,
    label = 'op',
  } = opts

  let lastErr = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const retryable = attempt < retries && shouldRetry(err)
      if (!retryable) break

      const exp = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt))
      const jitter = Math.floor(Math.random() * 250)
      const delay = exp + jitter
      console.warn(`[retry] ${label} не удалось, повтор`, {
        attempt: attempt + 1,
        delayMs: delay,
        error: err?.message,
      })
      await sleep(delay)
    }
  }
  throw lastErr
}

module.exports = { isPlayerokRateLimitError, withRetry, sleep }

