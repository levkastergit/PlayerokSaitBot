'use strict'

const { getInternalSecret } = require('../infra/internalAuth')

function createPostLocal({ PORT, http }) {
  if (typeof PORT !== 'number') throw new Error('PORT must be a number')
  if (!http || typeof http.request !== 'function') {
    throw new Error('http with request() must be provided')
  }

  return function postLocal(pathname, body) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(body)

      const req = http.request(
        {
          hostname: '127.0.0.1',
          port: PORT,
          path: pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
            // Метка доверенного внутреннего self-call: только с ней сервер доверяет
            // userId/token из тела (фоновые задачи работают за конкретного пользователя).
            'X-Internal-Secret': getInternalSecret(),
          },
        },
        (res) => {
          let chunks = ''
          res.setEncoding('utf8')
          res.on('data', (c) => {
            chunks += c
          })
          res.on('end', () => {
            try {
              const json = chunks ? JSON.parse(chunks) : {}
              if (res.statusCode >= 400) {
                resolve({ ok: false, error: json.error || res.statusCode })
              } else {
                resolve(json)
              }
            } catch {
              resolve({ ok: false, error: 'parse error' })
            }
          })
        }
      )

      req.on('error', reject)
      // Таймаут на локальный self-call: страховка от ИСТИННО зависшего обработчика.
      // ВАЖНО: он должен быть ЗАВЕДОМО ВЫШЕ максимальной легитимной длительности тика
      // (autolist-tick: бюджет 75с + один синхронный флоу-полл до ~120с ≈ до ~195с). Иначе
      // postLocal рвёт ещё работающий тик, job снимает inFlight, а серверный обработчик
      // продолжает крутиться → НАЛОЖЕНИЕ тиков → удвоение запросов → 429-спираль и затор
      // гейта. 300с покрывает легитимный максимум и всё ещё ограничивает реальные зависания.
      const timeoutMs = Number(process.env.POSTLOCAL_TIMEOUT_MS) || 300000
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`postLocal ${pathname}: таймаут ${timeoutMs}ms`))
      })
      req.write(data)
      req.end()
    })
  }
}

module.exports = { createPostLocal }

