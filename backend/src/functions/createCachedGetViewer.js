'use strict'

// Кэш результата getViewer на короткий TTL.
//
// viewer.id / username стабильны для конкретного токена, поэтому частым фоновым
// опросам (chatsSync — каждые 500 мс, dealStatusWatch — каждые 6 с) незачем
// дёргать POST /graphql operationName=viewer на КАЖДОМ тике: это и есть основной
// источник «постоянных запросов» к Playerok при простое.
//
// Безопасность: кэшируем ТОЛЬКО успешный ответ (с непустым id) и только на
// короткое время. Любую ошибку (битый/протухший токен, challenge/DDoS-Guard,
// rate limit) всегда пробрасываем «живьём» — её НЕ кэшируем, чтобы фоновые циклы
// корректно ловили проблему и уходили в backoff. Если токен умрёт в середине TTL,
// следующий же authed-запрос (userChats/deals) всё равно упадёт и переведёт цикл
// в backoff, поэтому короткий кэш viewer не маскирует деградацию.
function createCachedGetViewer({ getViewer, ttlMs = 60000, maxEntries = 256 }) {
  if (typeof getViewer !== 'function') throw new Error('getViewer must be a function')
  const ttl = Number(ttlMs) > 0 ? Number(ttlMs) : 60000
  const cap = Number(maxEntries) > 0 ? Number(maxEntries) : 256

  /** token -> { value, expiresAt } */
  const cache = new Map()
  /** token -> Promise — дедуп параллельных промахов по одному токену */
  const inFlight = new Map()

  function prune(now) {
    for (const [k, e] of cache) {
      if (!e || e.expiresAt <= now) cache.delete(k)
    }
    // Жёсткий потолок размера: при переполнении удаляем самые старые записи
    // (Map сохраняет порядок вставки).
    if (cache.size > cap) {
      let overflow = cache.size - cap
      for (const k of cache.keys()) {
        cache.delete(k)
        if (--overflow <= 0) break
      }
    }
  }

  async function cachedGetViewer(token, userAgent) {
    const key = String(token == null ? '' : token)
    // Без токена кэшировать нечем — отдаём прямой вызов (он же выдаст ошибку).
    if (!key) return getViewer(token, userAgent)

    const now = Date.now()
    const hit = cache.get(key)
    if (hit && hit.expiresAt > now) return hit.value

    const pending = inFlight.get(key)
    if (pending) return pending

    const p = Promise.resolve()
      .then(() => getViewer(token, userAgent))
      .then((value) => {
        if (value && value.id) {
          cache.set(key, { value, expiresAt: Date.now() + ttl })
          prune(Date.now())
        }
        return value
      })
      .finally(() => {
        inFlight.delete(key)
      })

    inFlight.set(key, p)
    return p
  }

  // Точечный сброс (на случай logout / смены токена) — кэш и так token-keyed,
  // так что прямой необходимости нет, но даём явный хук на будущее.
  cachedGetViewer.invalidate = (token) => {
    const key = String(token == null ? '' : token)
    cache.delete(key)
    inFlight.delete(key)
  }
  cachedGetViewer.clear = () => {
    cache.clear()
    inFlight.clear()
  }

  return cachedGetViewer
}

module.exports = { createCachedGetViewer }
