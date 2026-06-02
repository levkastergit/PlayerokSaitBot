'use strict'

const fs = require('fs')
const https = require('https')
const crypto = require('crypto')
const { withPlayerokGate } = require('../infra/playerokRequestGate')
const { playerokHttpsExtraOptions } = require('../infra/playerokHttpsAgent')

const CREATE_CHAT_MESSAGE_QUERY = `mutation createChatMessage($input: CreateChatMessageInput!, $file: Upload, $showForbiddenImage: Boolean!) {
  createChatMessage(input: $input, file: $file) {
    id
    text
    createdAt
    __typename
    _showForbiddenImageScope: __typename @skip(if: $showForbiddenImage)
  }
}
`

/**
 * Отправка картинки в чат Playerok через GraphQL multipart upload
 * (спецификация graphql-multipart-request). Текст пустой — отправляется только файл.
 */
function createSendChatImage() {
  return function sendChatImage(token, userAgent, chatId, { filePath, filename, mime } = {}) {
    return withPlayerokGate(
      () =>
        new Promise((resolve, reject) => {
          let fileBuffer
          try {
            fileBuffer = fs.readFileSync(filePath)
          } catch (err) {
            return reject(new Error(`sendChatImage: не удалось прочитать файл: ${err.message}`))
          }

          const safeName = String(filename || 'image').replace(/[\r\n"]/g, '') || 'image'
          const contentType = String(mime || 'image/png')

          const operations = JSON.stringify({
            operationName: 'createChatMessage',
            variables: {
              input: { chatId: String(chatId), text: '' },
              file: null,
              showForbiddenImage: false,
            },
            query: CREATE_CHAT_MESSAGE_QUERY,
          })
          const map = JSON.stringify({ '1': ['variables.file'] })

          const boundary =
            '----PlayerokFormBoundary' + crypto.randomBytes(16).toString('hex')
          const CRLF = '\r\n'

          const preamble =
            `--${boundary}${CRLF}` +
            `Content-Disposition: form-data; name="operations"${CRLF}${CRLF}` +
            `${operations}${CRLF}` +
            `--${boundary}${CRLF}` +
            `Content-Disposition: form-data; name="map"${CRLF}${CRLF}` +
            `${map}${CRLF}` +
            `--${boundary}${CRLF}` +
            `Content-Disposition: form-data; name="1"; filename="${safeName}"${CRLF}` +
            `Content-Type: ${contentType}${CRLF}${CRLF}`
          const epilogue = `${CRLF}--${boundary}--${CRLF}`

          const body = Buffer.concat([
            Buffer.from(preamble, 'utf8'),
            fileBuffer,
            Buffer.from(epilogue, 'utf8'),
          ])

          const referer = chatId
            ? `https://playerok.com/chats/${String(chatId)}`
            : 'https://playerok.com/chats'

          const options = {
            hostname: 'playerok.com',
            path: '/graphql',
            method: 'POST',
            headers: {
              accept: '*/*',
              'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
              'content-type': `multipart/form-data; boundary=${boundary}`,
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
              'Content-Length': body.length,
            },
          }

          const req = https.request({ ...options, ...playerokHttpsExtraOptions('chats') }, (resp) => {
            let data = ''
            resp.setEncoding('utf8')
            resp.on('data', (chunk) => {
              data += chunk
            })
            resp.on('end', () => {
              if (resp.statusCode !== 200) {
                const preview = String(data || '').slice(0, 600)
                return reject(
                  new Error(
                    `Playerok sendChatImage: status ${resp.statusCode}` +
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
                return reject(new Error(json.errors.map((e) => e.message || 'GraphQL error').join('; ')))
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

module.exports = { createSendChatImage }
