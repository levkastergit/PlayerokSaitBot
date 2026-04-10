'use strict'

const https = require('https')
const { withPlayerokGate } = require('../infra/playerokRequestGate')
const { extractItemImageUrl } = require('./extractItemImageUrl')

function dealCategoryHintFromNode(deal) {
  if (!deal || typeof deal !== 'object') return null
  const item = deal.item
  if (item && typeof item === 'object') {
    const game = item.game
    if (game && typeof game === 'object') {
      const n = String(game.name || '').trim()
      if (n) return n
    }
    const cat = item.category
    if (cat && typeof cat === 'object') {
      const n = String(cat.name || '').trim()
      if (n) return n
    }
  }
  // В chatMessages вложенный deal имеет тип ItemDeal — без productKey / productTitle.
  return null
}

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

    return withPlayerokGate(
      () =>
        new Promise((resolve, reject) => {
      const first = Math.min(50, Math.max(1, Number(count) || 24))
      // $hasSupportAccess / $showForbiddenImage должны фигурировать в документе (как у веб-клиента),
      // иначе GraphQL_VALIDATION_FAILED. Вложенный deal.item нужен для превью товара и категории,
      // если отдельный запрос deal недоступен; images — для вложений в сообщениях (не только file).
      const bodyJson = {
        operationName: 'chatMessages',
        query: `query chatMessages($pagination: Pagination, $filter: ChatMessageFilter, $hasSupportAccess: Boolean!, $showForbiddenImage: Boolean!) {
  chatMessages(pagination: $pagination, filter: $filter) {
    edges {
      cursor
      node {
        __typename
        _supportMarker: __typename @include(if: $hasSupportAccess)
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
        images {
          id
          url
        }
        deal {
          id
          item {
            id
            name
            game {
              name
            }
            category {
              name
            }
            attachments(showForbiddenImage: $showForbiddenImage) {
              id
              url
            }
          }
        }
      }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
    totalCount
  }
}
`,
        variables: {
          hasSupportAccess: false,
          showForbiddenImage: true,
          pagination: {
            first,
            after: afterCursor ? String(afterCursor) : null,
          },
          filter: {
            chatId: String(chatId),
          },
        },
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
          'x-gql-op': 'chatMessages',
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
              let imageUrl =
                fileUrl ||
                (node.attachments &&
                  node.attachments[0] &&
                  (node.attachments[0].url || node.attachments[0].link)) ||
                null
              if (!imageUrl && Array.isArray(node.images) && node.images.length > 0) {
                for (const im of node.images) {
                  if (!im) continue
                  const u = im.url || im.link || im.src
                  if (u) {
                    imageUrl = u
                    break
                  }
                }
              }

              const deal = node.deal || null
              const dealId = deal && deal.id ? deal.id : null
              let dealItemTitle = null
              let dealItemImageUrl = null
              let itemCategory = null
              if (deal) {
                itemCategory = dealCategoryHintFromNode(deal)
                const dItem = deal.item
                if (dItem && typeof dItem === 'object') {
                  dealItemTitle = String(dItem.name || '').trim() || null
                  dealItemImageUrl = extractItemImageUrl(dItem)
                }
              }

              return {
                id: node.id,
                text: node.text || '',
                createdAt: node.createdAt || null,
                imageUrl,
                dealId,
                dealItemTitle,
                dealItemImageUrl,
                itemCategory,
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
    )
  }
}

module.exports = { createRequestChatMessagesPage }

