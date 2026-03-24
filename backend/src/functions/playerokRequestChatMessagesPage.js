'use strict'

const https = require('https')

function createRequestChatMessagesPage() {
  return function requestChatMessagesPage(
    token,
    userAgent,
    chatId,
    afterCursor = null,
    count = 24,
    opts = {}
  ) {
    const referer = opts.referer || 'https://playerok.com/chats'

    return new Promise((resolve, reject) => {
      const bodyJson = {
        operationName: 'chatMessages',
        // Используем обычный текстовый запрос вместо persistedQuery,
        // чтобы не зависеть от хеша Playerok.
        query: `query chatMessages {
  chatMessages(
    pagination: { first: ${Number(count) || 24}, after: ${
      afterCursor ? `"${String(afterCursor)}"` : 'null'
    } },
    filter: { chatId: "${String(chatId)}" }
  ) {
    edges {
      node {
        __typename
        id
        text
        createdAt
        user {
          id
          username
        }
        file {
          id
          url
        }
        deal {
          id
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
  }
}
`,
        variables: {},
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
                `Playerok chatMessages: status ${resp.statusCode}` +
                  (preview ? `; ${preview}` : '')
              )
            )
          }

          let json
          try {
            json = JSON.parse(data)
          } catch (err) {
            return reject(new Error(`Invalid JSON from chatMessages: ${err.message}`))
          }

          if (json.errors && json.errors.length) {
            return reject(
              new Error(json.errors.map((e) => e.message || 'GraphQL error').join('; '))
            )
          }

          const cm = json?.data?.chatMessages
          if (!cm) {
            return resolve({ messages: [], pageInfo: { hasNextPage: false, endCursor: null } })
          }

          const edges = Array.isArray(cm.edges) ? cm.edges : []
          const messages = edges
            .map((edge) => edge && edge.node)
            .filter(Boolean)
            .map((node) => {
              const file = node.file || node.attachment || node.image
              const fileUrl = file && (file.url || file.link || file.src)
              const imageUrl =
                fileUrl ||
                (node.attachments &&
                  node.attachments[0] &&
                  (node.attachments[0].url || node.attachments[0].link)) ||
                null

              return {
                id: node.id,
                text: node.text || '',
                createdAt: node.createdAt || null,
                imageUrl,
                dealId: node.deal && node.deal.id ? node.deal.id : null,
                user: node.user
                  ? {
                      id: node.user.id || null,
                      username: node.user.username || '',
                    }
                  : null,
              }
            })

          const pageInfo = cm.pageInfo || {}
          resolve({
            messages,
            pageInfo: {
              hasNextPage: !!pageInfo.hasNextPage,
              endCursor: pageInfo.endCursor || null,
            },
          })
        })
      })

      req.on('error', reject)
      req.write(body)
      req.end()
    })
  }
}

module.exports = { createRequestChatMessagesPage }

