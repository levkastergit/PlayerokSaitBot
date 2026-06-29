'use strict'

const https = require('https')
const { URLSearchParams } = require('url')
const { withPlayerokGate } = require('../infra/playerokRequestGate')
const { playerokHttpsExtraOptions, playerokEgressKey } = require('../infra/playerokHttpsAgent')
const { attachPlayerokTimeout } = require('../infra/playerokRequestTimeout')
const { reportIpResult } = require('../infra/playerokOutboundRotation')
const { withPlayerokRotation } = require('../infra/retry/withPlayerokRotation')

function createFetchVerifiedCards({ VERIFIED_CARDS_PERSISTED_HASH }) {
  if (!VERIFIED_CARDS_PERSISTED_HASH) throw new Error('VERIFIED_CARDS_PERSISTED_HASH is required')

  function __fetchVerifiedCardsOnce(token, userAgent, opts = {}) {
    return withPlayerokGate(
      () =>
        new Promise((resolve, reject) => {
      const countRaw = Number(opts.count)
      const count = Number.isFinite(countRaw) && countRaw > 0 ? Math.min(24, Math.floor(countRaw)) : 24
      const direction = String(opts.direction || 'ASC').toUpperCase()
      const variables = {
        pagination: { first: count, after: opts.afterCursor ? String(opts.afterCursor) : null },
        direction,
      }

      const params = new URLSearchParams({
        operationName: 'verifiedCards',
        variables: JSON.stringify(variables),
        extensions: JSON.stringify({
          persistedQuery: { version: 1, sha256Hash: VERIFIED_CARDS_PERSISTED_HASH },
        }),
      })

      const extra = playerokHttpsExtraOptions('finance')
      const req = https.request(
        {
          hostname: 'playerok.com',
          path: `/graphql?${params.toString()}`,
          method: 'GET',
          headers: {
            accept: '*/*',
            'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
            'content-type': 'application/json',
            cookie: `token=${token}`,
            origin: 'https://playerok.com',
            referer: 'https://playerok.com/wallet/cards',
            'apollographql-client-name': 'web',
            'apollo-require-preflight': 'true',
            'x-gql-op': 'verifiedCards',
            'x-gql-path': '/',
            'user-agent':
              userAgent ||
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
          },
          ...extra,
        },
        (resp) => {
          let data = ''
          resp.setEncoding('utf8')
          resp.on('data', (chunk) => { data += chunk })
          resp.on('end', () => {
            reportIpResult(playerokEgressKey(extra), resp.statusCode)
            if (resp.statusCode !== 200) {
              const err = new Error(`Playerok verifiedCards: status ${resp.statusCode}`)
              err.statusCode = resp.statusCode
              return reject(err)
            }
            let json
            try {
              json = JSON.parse(data)
            } catch (err) {
              return reject(new Error(`Invalid JSON from verifiedCards: ${err.message}`))
            }
            if (json.errors && json.errors.length) {
              return reject(new Error(json.errors.map((e) => e.message || 'GraphQL error').join('; ')))
            }
            const node = json?.data?.verifiedCards || {}
            const list = Array.isArray(node.edges) ? node.edges.map((e) => e && e.node).filter(Boolean) : []
            const pageInfo = node.pageInfo || {}
            resolve({
              list,
              pageInfo: {
                hasNextPage: pageInfo.hasNextPage === true,
                endCursor: pageInfo.endCursor || null,
              },
            })
          })
        }
      )

      req.on('error', reject)
      attachPlayerokTimeout(req, 'Playerok verifiedCards')
      req.end()
        })
    )
  }

  return function fetchVerifiedCards(token, userAgent, opts = {}) {
    return withPlayerokRotation(() => __fetchVerifiedCardsOnce(token, userAgent, opts), { policy: 'read', label: 'fetchVerifiedCards' })
  }
}

module.exports = { createFetchVerifiedCards }
