'use strict'

const https = require('https')

function createGetViewer({ VIEWER_QUERY, PLAYEROK_USER_AGENT }) {
  if (!VIEWER_QUERY) throw new Error('VIEWER_QUERY is required')
  return function getViewer(token, userAgent) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        operationName: 'viewer',
        query: VIEWER_QUERY,
        variables: {},
      })

      const options = {
        hostname: 'playerok.com',
        path: '/graphql',
        method: 'POST',
        headers: {
          accept: '*/*',
          'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
          'content-type': 'application/json',
          cookie: `token=${token}`,
          origin: 'https://playerok.com',
          referer: 'https://playerok.com/',
          'apollographql-client-name': 'web',
          'apollo-require-preflight': 'true',
          'user-agent':
            userAgent ||
            PLAYEROK_USER_AGENT ||
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
          'Content-Length': Buffer.byteLength(body, 'utf8'),
        },
      }

      const req = https.request(options, (resp) => {
        let data = ''
        resp.on('data', (chunk) => {
          data += chunk
        })
        resp.on('end', () => {
          if (resp.statusCode !== 200) {
            return reject(new Error(`Playerok viewer: status ${resp.statusCode}`))
          }

          let json
          try {
            json = JSON.parse(data)
          } catch (err) {
            return reject(new Error(`Invalid JSON: ${err.message}`))
          }

          if (json.errors && json.errors.length) {
            return reject(
              new Error(json.errors.map((e) => e.message || 'GraphQL error').join('; '))
            )
          }

          const viewer = json?.data?.viewer
          if (!viewer || !viewer.id) {
            const err = new Error('Не удалось получить данные аккаунта (токен неверный или истёк)')
            err.userContext = {
              tokenHash: token ? String(token).slice(0, 8) + '…' : null,
            }
            return reject(err)
          }

          resolve({
            id: viewer.id,
            username: viewer.username || 'me',
            email: viewer.email || null,
            role: viewer.role || null,
            hasFrozenBalance: Boolean(viewer.hasFrozenBalance),
          })
        })
      })

      req.on('error', reject)
      req.write(body)
      req.end()
    })
  }
}

module.exports = { createGetViewer }

