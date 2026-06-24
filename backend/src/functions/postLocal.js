'use strict'

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
      // Таймаут на локальный self-call: без него зависший gated-обработчик (за общим
      // последовательным гейтом) держит тик фоновой задачи бесконечно — флаг inFlight
      // не снимается, задача перестаёт тикать навсегда. Чуть больше gate-бэкстопа.
      const timeoutMs = Number(process.env.POSTLOCAL_TIMEOUT_MS) || 35000
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`postLocal ${pathname}: таймаут ${timeoutMs}ms`))
      })
      req.write(data)
      req.end()
    })
  }
}

module.exports = { createPostLocal }

