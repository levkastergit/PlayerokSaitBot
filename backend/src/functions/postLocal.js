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
      req.write(data)
      req.end()
    })
  }
}

module.exports = { createPostLocal }

