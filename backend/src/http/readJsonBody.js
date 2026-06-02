async function readJsonBody(req, { fallback = {}, maxBytes = 10_000_000 } = {}) {
  const body = await new Promise((resolve, reject) => {
    const chunks = []
    let total = 0

    req.on('data', (chunk) => {
      // Накапливаем байты и декодируем UTF-8 один раз в конце — иначе многобайтовый
      // символ, разбитый между чанками, превращается в «�» (символ замены).
      const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      total += buf.length
      if (total > maxBytes) {
        // Не пытаться отправлять ответ отсюда: пусть обработчик решает.
        req.destroy && req.destroy()
        return reject(Object.assign(new Error('Body too large'), { statusCode: 413 }))
      }
      chunks.push(buf)
    })

    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
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

