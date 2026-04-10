'use strict'

/** Сообщение об ошибке Playerok из Error или строки */
function autolistErrorMessage(err) {
  return err && err.message ? String(err.message) : String(err || '')
}

function isPlayerokRateLimitMessage(msg) {
  const m = String(msg || '')
  return (
    m.includes('Слишком много попыток') ||
    m.toLowerCase().includes('too many attempts') ||
    m.toLowerCase().includes('rate limit') ||
    m.includes('status 429') ||
    m.includes('TOO_MANY_REQUESTS')
  )
}

/**
 * Временные сбои: имеет смысл повторить позже (429, 5xx, внутренняя ошибка API).
 * Не использовать подстроку "priorityStatuses" — она входит в "itemPriorityStatuses" и давала ложное «500» при 429.
 */
function isAutolistRetryableMessage(msg) {
  const m = String(msg || '')
  if (isPlayerokRateLimitMessage(m)) return true
  if (/\bstatus 5\d\d\b/.test(m)) return true
  if (/INTERNAL_SERVER_ERROR/i.test(m)) return true
  if (/Playerok itemPriorityStatuses: status 5\d\d/.test(m)) return true
  return false
}

/** Короткая причина для сводки [autolist-tick] */
function autolistReasonShort(msg) {
  const m = String(msg || '')
  if (isPlayerokRateLimitMessage(m)) return 'лимит запросов Playerok (429), повторите позже'
  const pub = m.match(/Playerok publishItem: status (\d+)/)
  if (pub && pub[1] && pub[1] !== '200') {
    return pub[1] === '500' ? 'публикация: HTTP 500 от Playerok' : `публикация: HTTP ${pub[1]}`
  }
  if (m.includes('status 500') || /INTERNAL_SERVER_ERROR/i.test(m)) return 'ошибка HTTP 500 от Playerok'
  const ips = m.match(/Playerok itemPriorityStatuses: status (\d+)/)
  if (ips && ips[1]) return `статусы поднятия: HTTP ${ips[1]}`
  return m.length > 120 ? `${m.slice(0, 117)}...` : m
}

module.exports = {
  autolistErrorMessage,
  isPlayerokRateLimitMessage,
  isAutolistRetryableMessage,
  autolistReasonShort,
}

