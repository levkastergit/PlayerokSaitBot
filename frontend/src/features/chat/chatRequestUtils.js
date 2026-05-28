/** Сообщение/текст ошибки — лимит Playerok (429). */
export function isPlayerokRateLimitMessage(message) {
  const m = String(message || '')
  return (
    /\b429\b/.test(m) ||
    /слишком много попыток/i.test(m) ||
    /too many attempts/i.test(m) ||
    /rate limit/i.test(m)
  )
}

/** Интервал опроса с экспоненциальным backoff при ошибках (мс). */
export function pollDelayAfterErrors(baseMs, errorCount) {
  const base = Number(baseMs) > 0 ? Number(baseMs) : 5000
  const capped = Math.min(Math.max(0, Number(errorCount) || 0), 6)
  return Math.min(120000, base * 2 ** capped)
}
