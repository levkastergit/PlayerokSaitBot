'use strict'

const https = require('https')
const { withPlayerokGate } = require('../infra/playerokRequestGate')
const { playerokHttpsExtraOptions } = require('../infra/playerokHttpsAgent')

function createCreateChatMessage() {
  return function createChatMessage(token, userAgent, chatId, text, opts = {}) {
    return withPlayerokGate(
      () =>
        new Promise((resolve, reject) => {
      const referer =
        (opts && typeof opts.referer === 'string' && opts.referer.trim()) ||
        (chatId ? `https://playerok.com/chats/${String(chatId)}` : 'https://playerok.com/chats')

      // Как в бандле _app: createChatMessage(input, file); плюс $showForbiddenImage — только в директиве,
      // иначе GraphQL_VALIDATION_FAILED («variable never used»), если не тянуть фрагмент RegularChatMessage.
      const bodyJson = {
        operationName: 'createChatMessage',
        variables: {
          input: {
            chatId: String(chatId),
            text: String(text || ''),
          },
          file: null,
          showForbiddenImage: false,
        },
        query: `mutation createChatMessage($input: CreateChatMessageInput!, $file: Upload, $showForbiddenImage: Boolean!) {
  createChatMessage(input: $input, file: $file) {
    id
    text
    createdAt
    __typename
    _showForbiddenImageScope: __typename @skip(if: $showForbiddenImage)
  }
}
`,
      }

      const body = JSON.stringify(bodyJson)
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
          referer,
          'apollographql-client-name': 'web',
          'apollo-require-preflight': 'true',
          'x-gql-op': 'createChatMessage',
          'x-gql-path': '/',
          'user-agent':
            userAgent ||
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
          'Content-Length': Buffer.byteLength(body, 'utf8'),
        },
      }

      const req = https.request({ ...options, ...playerokHttpsExtraOptions('chats') }, (resp) => {
        let data = ''
        resp.on('data', (chunk) => {
          data += chunk
        })
        resp.on('end', () => {
          if (resp.statusCode !== 200) {
            const preview = String(data || '').slice(0, 600)
            return reject(
              new Error(
                `Playerok createChatMessage: status ${resp.statusCode}` +
                  (preview ? `; ${preview}` : '')
              )
            )
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

          resolve(json?.data?.createChatMessage || {})
        })
      })

      req.on('error', reject)
      req.write(body)
      req.end()
        })
    )
  }
}

module.exports = { createCreateChatMessage }

