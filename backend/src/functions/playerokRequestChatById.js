'use strict'

const https = require('https')
const { URLSearchParams } = require('url')
const { withPlayerokGate } = require('../infra/playerokRequestGate')

function createRequestChatById({ CHAT_PERSISTED_HASH }) {
  if (!CHAT_PERSISTED_HASH) throw new Error('CHAT_PERSISTED_HASH is required')

  return function requestChatById(token, userAgent, chatId, opts = {}) {
    const referer =
      (opts && typeof opts.referer === 'string' && opts.referer.trim()) ||
      'https://playerok.com/chats'
    return withPlayerokGate(
      () =>
        new Promise((resolve, reject) => {
      const variables = { id: String(chatId) }
      const params = new URLSearchParams({
        operationName: 'chat',
        variables: JSON.stringify(variables),
        extensions: JSON.stringify({
          persistedQuery: { version: 1, sha256Hash: CHAT_PERSISTED_HASH },
        }),
      })

      const options = {
        hostname: 'playerok.com',
        path: `/graphql?${params.toString()}`,
        method: 'GET',
        headers: {
          accept: '*/*',
          'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
          'content-type': 'application/json',
          cookie: `token=${token}`,
          origin: 'https://playerok.com',
          referer,
          'apollographql-client-name': 'web',
          'apollo-require-preflight': 'true',
          'user-agent':
            userAgent ||
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        },
      }

      const req = https.request(options, (resp) => {
        let data = ''
        resp.on('data', (chunk) => {
          data += chunk
        })
        resp.on('end', () => {
          if (resp.statusCode !== 200) {
            const preview = String(data || '').slice(0, 500)
            return reject(
              new Error(
                `Playerok chat: status ${resp.statusCode}` + (preview ? `; ${preview}` : '')
              )
            )
          }

          let json
          try {
            json = JSON.parse(data)
          } catch (err) {
            return reject(new Error(`Invalid JSON from chat: ${err.message}`))
          }

          if (json.errors && json.errors.length) {
            return reject(new Error(json.errors.map((e) => e.message || 'GraphQL error').join('; ')))
          }

          resolve(json?.data?.chat || null)
        })
      })

      req.on('error', reject)
      req.end()
        })
    )
  }
}

module.exports = { createRequestChatById }

