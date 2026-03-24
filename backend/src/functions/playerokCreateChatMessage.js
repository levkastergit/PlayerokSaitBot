'use strict'

const https = require('https')

function createCreateChatMessage() {
  return function createChatMessage(token, userAgent, chatId, text) {
    return new Promise((resolve, reject) => {
      const bodyJson = {
        operationName: 'createChatMessage',
        variables: {
          input: {
            chatId: String(chatId),
            text: String(text || ''),
          },
        },
        query: `mutation createChatMessage($input: CreateChatMessageInput!) {
  createChatMessage(input: $input) {
    id
    text
    __typename
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
          'content-type': 'application/json',
          cookie: `token=${token}`,
          origin: 'https://playerok.com',
          referer: 'https://playerok.com/chats',
          'apollographql-client-name': 'web',
          'apollo-require-preflight': 'true',
          'user-agent':
            userAgent ||
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
  }
}

module.exports = { createCreateChatMessage }

