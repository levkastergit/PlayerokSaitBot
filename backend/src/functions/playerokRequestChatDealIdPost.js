'use strict'

const https = require('https')
const { withPlayerokGate } = require('../infra/playerokRequestGate')

function postChatDealBootstrap(token, userAgent, chatId, idType) {
  const referer = 'https://playerok.com/chats'
  const query = `query chatDealBootstrap($id: ${idType}) {
  chat(id: $id) {
    id
    deal {
      id
    }
  }
}`
  const bodyJson = {
    operationName: 'chatDealBootstrap',
    query,
    variables: { id: String(chatId) },
  }
  const body = JSON.stringify(bodyJson)

  return new Promise((resolve) => {
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
        'x-gql-op': 'chatDealBootstrap',
        'x-gql-path': '/',
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
          resolve(null)
          return
        }
        let json
        try {
          json = JSON.parse(data)
        } catch (_) {
          resolve(null)
          return
        }
        if (json.errors && json.errors.length) {
          resolve(null)
          return
        }
        const dealId = json?.data?.chat?.deal?.id
        resolve(dealId != null ? String(dealId) : null)
      })
    })

    req.on('error', () => resolve(null))
    req.write(body)
    req.end()
  })
}

/**
 * Явный POST GraphQL: persisted GET `chat` не всегда содержит deal, из‑за этого теряется dealId при загрузке почты.
 */
function createRequestChatDealIdPost() {
  return function requestChatDealIdPost(token, userAgent, chatId) {
    return withPlayerokGate(async () => {
      let r = await postChatDealBootstrap(token, userAgent, chatId, 'ID!')
      if (r) return r
      r = await postChatDealBootstrap(token, userAgent, chatId, 'String!')
      return r || null
    })
  }
}

module.exports = { createRequestChatDealIdPost }
