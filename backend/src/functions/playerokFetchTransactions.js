'use strict'

const https = require('https')
const { URLSearchParams } = require('url')
const { withPlayerokGate } = require('../infra/playerokRequestGate')
const { playerokHttpsExtraOptions } = require('../infra/playerokHttpsAgent')

function createFetchTransactions({ TRANSACTIONS_PERSISTED_HASH }) {
  if (!TRANSACTIONS_PERSISTED_HASH) throw new Error('TRANSACTIONS_PERSISTED_HASH is required')

  return function fetchTransactions(token, userAgent, opts = {}) {
    return withPlayerokGate(
      () =>
        new Promise((resolve, reject) => {
      const countRaw = Number(opts.count)
      const count = Number.isFinite(countRaw) && countRaw > 0 ? Math.min(24, Math.floor(countRaw)) : 24

      const filter = {}
      if (opts.userId) filter.userId = String(opts.userId)
      if (opts.operation) filter.operation = String(opts.operation)
      if (opts.providerId) filter.providerId = String(opts.providerId)
      if (opts.status) filter.status = String(opts.status)
      if (opts.minValue != null) filter.minValue = Number(opts.minValue) || 0
      if (opts.maxValue != null) filter.maxValue = Number(opts.maxValue) || 0

      const variables = {
        pagination: { first: count, after: opts.afterCursor ? String(opts.afterCursor) : null },
        filter,
        hasSupportAccess: false,
      }

      const params = new URLSearchParams({
        operationName: 'transactions',
        variables: JSON.stringify(variables),
        extensions: JSON.stringify({
          persistedQuery: { version: 1, sha256Hash: TRANSACTIONS_PERSISTED_HASH },
        }),
      })

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
            referer: 'https://playerok.com/wallet/transactions',
            'apollographql-client-name': 'web',
            'apollo-require-preflight': 'true',
            'x-gql-op': 'transactions',
            'x-gql-path': '/',
            'user-agent':
              userAgent ||
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
          },
          ...playerokHttpsExtraOptions(),
        },
        (resp) => {
          let data = ''
          resp.on('data', (chunk) => { data += chunk })
          resp.on('end', () => {
            if (resp.statusCode !== 200) {
              return reject(new Error(`Playerok transactions: status ${resp.statusCode}`))
            }
            let json
            try {
              json = JSON.parse(data)
            } catch (err) {
              return reject(new Error(`Invalid JSON from transactions: ${err.message}`))
            }
            if (json.errors && json.errors.length) {
              return reject(new Error(json.errors.map((e) => e.message || 'GraphQL error').join('; ')))
            }
            const node = json?.data?.transactions || {}
            const list = Array.isArray(node.edges) ? node.edges.map((e) => e && e.node).filter(Boolean) : []
            const pageInfo = node.pageInfo || {}
            resolve({
              list,
              pageInfo: {
                hasNextPage: pageInfo.hasNextPage === true,
                endCursor: pageInfo.endCursor || null,
              },
              totalCount: Number(node.totalCount) || list.length,
            })
          })
        }
      )

      req.on('error', reject)
      req.end()
        })
    )
  }
}

module.exports = { createFetchTransactions }
