'use strict'

const https = require('https')
const { URLSearchParams } = require('url')
const { withPlayerokGate } = require('../infra/playerokRequestGate')
const { playerokHttpsExtraOptions } = require('../infra/playerokHttpsAgent')
const { attachPlayerokTimeout } = require('../infra/playerokRequestTimeout')
const { reportIpResult } = require('../infra/playerokOutboundRotation')
const { normalizeKeyPart, buildProductKey } = require('./keyUtils')
const { dealPurchaseUnixTs } = require('./dealPurchaseUnixTs')

function createRequestDealsPage({ PAGE_SIZE, DEALS_PERSISTED_HASH }) {
  if (!PAGE_SIZE) throw new Error('PAGE_SIZE is required')
  if (!DEALS_PERSISTED_HASH) throw new Error('DEALS_PERSISTED_HASH is required')

  return function requestDealsPage(
    token,
    userAgent,
    userId,
    afterCursor,
    statusList,
    direction = 'OUT'
  ) {
    return withPlayerokGate(
      () =>
        new Promise((resolve, reject) => {
      const variables = {
        pagination: { first: PAGE_SIZE, after: afterCursor },
        filter: {
          userId,
          direction,
          status: statusList,
        },
        showForbiddenImage: false,
      }

      const params = new URLSearchParams({
        operationName: 'deals',
        variables: JSON.stringify(variables),
        extensions: JSON.stringify({
          persistedQuery: { version: 1, sha256Hash: DEALS_PERSISTED_HASH },
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
          referer: 'https://playerok.com/profile/Levkaster/sales',
          'apollographql-client-name': 'web',
          'apollo-require-preflight': 'true',
          'x-gql-op': 'deals',
          'x-gql-path': '/',
          'user-agent':
            userAgent ||
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        },
      }

      const extra = playerokHttpsExtraOptions('deals')
      const req = https.request({ ...options, ...extra }, (resp) => {
        let data = ''
        resp.setEncoding('utf8')
        resp.on('data', (chunk) => {
          data += chunk
        })
        resp.on('end', () => {
          // Отчёт ротации: 429 на этом IP → эскалация блока, 200 → снятие.
          reportIpResult(extra.localAddress, resp.statusCode)
          if (resp.statusCode !== 200) {
            let errMsg = `Playerok deals: status ${resp.statusCode}`
            try {
              const errJson = JSON.parse(data)
              if (errJson?.errors?.[0]?.message) errMsg = errJson.errors[0].message
            } catch (_) {
              if (data && data.length < 500) errMsg += `: ${data}`
            }
            return reject(new Error(errMsg))
          }

          let json
          try {
            json = JSON.parse(data)
          } catch (err) {
            return reject(new Error(`Invalid JSON from Playerok deals: ${err.message}`))
          }

          if (json.errors && json.errors.length) {
            return reject(
              new Error(json.errors.map((e) => e.message || 'GraphQL error').join('; '))
            )
          }

          const dealsData = json?.data?.deals
          const edges = dealsData?.edges || []
          const pageInfo = dealsData?.pageInfo || {}

          const toTs = (v) => {
            if (v == null) return 0
            if (typeof v === 'number') {
              if (v < 1e12) return v
              return Math.floor(v / 1000)
            }
            const d = new Date(v)
            return isNaN(d.getTime()) ? 0 : Math.floor(d.getTime() / 1000)
          }

          const deals = edges
            .map((edge) => edge && edge.node)
            .filter(Boolean)
            .map((node) => {
              const item = node.item || {}
              const buyerName =
                (node.user && node.user.username) ||
                (item.buyer && item.buyer.username) ||
                null
              const game = item.game?.name || ''
              const title = item.name || item.title || 'Товар'
              const price = node.transaction?.value ?? item.price ?? node.price ?? 0
              const soldAt = dealPurchaseUnixTs(node, toTs) || 0

              // Определение категории с fallback
              let category = normalizeKeyPart(game)

              // Если категория не определена, пытаемся извлечь из названия товара
              if (!category || (typeof category === 'string' && !category.trim())) {
                const normalizedTitle = normalizeKeyPart(title)
                if (normalizedTitle && normalizedTitle.trim()) {
                  const titleLower = normalizedTitle.toLowerCase()
                  // Список известных игр для поиска в названии
                  const commonGames = [
                    'Clash of Clans',
                    'Clash Royale',
                    'Brawl Stars',
                    'Hay Day',
                    'Boom Beach',
                    'PUBG',
                    'PUBG Mobile',
                    'Call of Duty',
                    'Free Fire',
                    'Fortnite',
                    'CS:GO',
                    'CS2',
                    'Counter-Strike',
                    'Dota 2',
                    'League of Legends',
                    'Valorant',
                    'Apex Legends',
                    'Genshin Impact',
                    'Honkai',
                    'Star Rail',
                    'World of Tanks',
                    'World of Warships',
                    'War Thunder',
                    'Minecraft',
                    'Roblox',
                    'Among Us',
                    'Fall Guys',
                    'Mobile Legends',
                    'Wild Rift',
                    'Arena of Valor',
                    'Heroes of the Storm',
                    'Overwatch',
                    'YouTube',
                    'Claude',
                    'ChatGPT',
                    'ЧатГПТ',
                    'Telegram',
                    'Discord',
                  ]

                  for (const gameName of commonGames) {
                    if (titleLower.includes(gameName.toLowerCase())) {
                      category = gameName
                      break
                    }
                  }

                  // Если не нашли известную игру, используем первые слова названия
                  if (!category || (typeof category === 'string' && !category.trim())) {
                    const words = normalizedTitle.split(/\s+/).filter((w) => w.length > 0)
                    if (words.length > 0) {
                      let candidate = words.slice(0, 3).join(' ')
                      if (candidate.length > 50)
                        candidate = candidate.substring(0, 50).trim()
                      if (candidate) category = candidate
                    }
                  }
                }

                // Если всё ещё нет категории, используем "Общий чат"
                if (!category || (typeof category === 'string' && !category.trim())) {
                  category = 'Общий чат'
                }
              }

              return {
                id: node.id,
                itemId: item.id || null,
                status: node.status,
                productKey: buildProductKey(game, title),
                productTitle: normalizeKeyPart(title) || 'Товар',
                category: category, // Гарантируем, что категория всегда определена
                soldAt,
                price: Number(price) || 0,
                buyerName,
                chatId: node.chat?.id || node.chatId || null,
              }
            })

          resolve({
            deals,
            totalCount: dealsData?.totalCount,
            hasNextPage: pageInfo.hasNextPage === true,
            endCursor: pageInfo.endCursor || null,
          })
        })
      })

      req.on('error', reject)
      attachPlayerokTimeout(req, 'Playerok deals')
      req.end()
        })
    )
  }
}

module.exports = { createRequestDealsPage }

