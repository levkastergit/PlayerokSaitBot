async function readJsonBody(req, { fallback = {}, maxBytes = 10_000_000 } = {}) {
  const body = await new Promise((resolve, reject) => {
    let raw = ''
    let total = 0

    req.on('data', (chunk) => {
      const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      total += str.length
      if (total > maxBytes) {
        // Не пытаться отправлять ответ отсюда: пусть обработчик решает.
        req.destroy && req.destroy()
        return reject(Object.assign(new Error('Body too large'), { statusCode: 413 }))
      }
      raw += str
    })

    req.on('end', () => resolve(raw))
    req.on('error', reject)
  })

  if (!body) return fallback
  try {
    return JSON.parse(body)
  } catch (_) {
    const err = new Error('Invalid JSON body')
    err.statusCode = 400
    throw err
  }
}

module.exports = { readJsonBody }

