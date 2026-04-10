'use strict'

const https = require('https')
const { URLSearchParams } = require('url')
const { withPlayerokGate } = require('../infra/playerokRequestGate')

function createFetchItemPriorityStatuses({ ITEM_PRIORITY_STATUSES_PERSISTED_HASH }) {
  if (!ITEM_PRIORITY_STATUSES_PERSISTED_HASH) {
    throw new Error('ITEM_PRIORITY_STATUSES_PERSISTED_HASH is required')
  }

  return function fetchItemPriorityStatuses(token, userAgent, itemId, price) {
    return withPlayerokGate(
      () =>
        new Promise((resolve, reject) => {
      const variables = {
        itemId: String(itemId),
        price: Number(price) || 0,
      }

      const params = new URLSearchParams({
        operationName: 'itemPriorityStatuses',
        variables: JSON.stringify(variables),
        extensions: JSON.stringify({
          persistedQuery: { version: 1, sha256Hash: ITEM_PRIORITY_STATUSES_PERSISTED_HASH },
        }),
      })

      const options = {
        hostname: 'playerok.com',
        path: `/graphql?${params.toString()}`,
        method: 'GET',
        headers: {
          accept: '*/*',
          'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
          'access-control-allow-headers': 'sentry-trace, baggage',
          'content-type': 'application/json',
          cookie: `token=${token}`,
          origin: 'https://playerok.com',
          priority: 'u=1, i',
          referer: `https://playerok.com/products/${String(itemId)}`,
          'apollographql-client-name': 'web',
          'apollo-require-preflight': 'true',
          'x-timezone-offset': String(new Date().getTimezoneOffset()),
          'x-gql-op': 'itemPriorityStatuses',
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
            const bodyPreview = String(data || '').slice(0, 800)
            return reject(
              new Error(
                `Playerok itemPriorityStatuses: status ${resp.statusCode}` +
                  (bodyPreview ? `; body: ${bodyPreview}` : '')
              )
            )
          }

          let json
          try {
            json = JSON.parse(data)
          } catch (err) {
            return reject(
              new Error(`Invalid JSON from Playerok itemPriorityStatuses: ${err.message}`)
            )
          }

          if (json.errors && json.errors.length) {
            return reject(
              new Error(json.errors.map((e) => e.message || 'GraphQL error').join('; '))
            )
          }

          resolve(json?.data?.itemPriorityStatuses || [])
        })
      })

      req.on('error', reject)
      req.end()
        })
    )
  }
}

module.exports = { createFetchItemPriorityStatuses }

