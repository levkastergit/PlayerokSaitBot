'use strict'

const https = require('https')
const { URLSearchParams } = require('url')

function createRequestItemsPage({ PAGE_SIZE, ITEMS_PERSISTED_HASH }) {
  if (!PAGE_SIZE) throw new Error('PAGE_SIZE is required')
  if (!ITEMS_PERSISTED_HASH) throw new Error('ITEMS_PERSISTED_HASH is required')

  return function requestItemsPage(
    token,
    userAgent,
    userId,
    afterCursor,
    statusList = ['APPROVED']
  ) {
    return new Promise((resolve, reject) => {
      const variables = {
        pagination: {
          first: PAGE_SIZE,
          after: afterCursor,
        },
        filter: {
          userId,
          status: statusList,
        },
        showForbiddenImage: false,
      }

      const params = new URLSearchParams({
        operationName: 'items',
        variables: JSON.stringify(variables),
        extensions: JSON.stringify({
          persistedQuery: { version: 1, sha256Hash: ITEMS_PERSISTED_HASH },
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
          referer: 'https://playerok.com/',
          'apollographql-client-name': 'web',
          'apollo-require-preflight': 'true',
          'x-gql-op': 'items',
          'x-gql-path': '/',
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
            let errMsg = `Playerok responded with status ${resp.statusCode}`
            try {
              const errJson = JSON.parse(data)
              if (errJson?.errors?.[0]?.message) errMsg = errJson.errors[0].message
              else if (errJson?.message) errMsg = errJson.message
            } catch (_) {
              if (data && data.length < 500) errMsg += `: ${data}`
            }
            return reject(new Error(errMsg))
          }

          let json
          try {
            json = JSON.parse(data)
          } catch (err) {
            return reject(new Error(`Invalid JSON from Playerok: ${err.message}`))
          }
          if (json.errors && json.errors.length) {
            return reject(
              new Error(json.errors.map((e) => e.message || 'GraphQL error').join('; '))
            )
          }

          const itemsData = json?.data?.items
          const edges = itemsData?.edges || []
          const pageInfo = itemsData?.pageInfo || {}
          const items = edges
            .map((edge) => edge && edge.node)
            .filter(Boolean)
            .map((node) => {
              const attachment = node.attachment || (node.attachments && node.attachments[0])
              const imageUrl = attachment?.url || null
              const price = node.price ?? node.rawPrice ?? 0
              const rawPrice = node.rawPrice != null ? Number(node.rawPrice) : null
              const discount =
                rawPrice != null && rawPrice > 0 && price < rawPrice
                  ? Math.round(((rawPrice - price) / rawPrice) * 100)
                  : null
              return {
                id: node.id,
                title: node.name,
                game: node.game?.name || '',
                price,
                currency: '₽',
                status: node.status,
                imageUrl,
                url: `https://playerok.com/profile/${node.user?.username || 'me'}/products`,
                updatedAt: node.updatedAt != null ? node.updatedAt : null,
                createdAt: node.createdAt != null ? node.createdAt : null,
                ...(rawPrice != null && rawPrice > 0 && { oldPrice: rawPrice }),
                ...(discount != null && discount > 0 && { discount }),
              }
            })
          resolve({
            items,
            totalCount: itemsData?.totalCount,
            hasNextPage: pageInfo.hasNextPage === true,
            endCursor: pageInfo.endCursor || null,
          })
        })
      })

      req.on('error', reject)
      req.end()
    })
  }
}

module.exports = { createRequestItemsPage }

