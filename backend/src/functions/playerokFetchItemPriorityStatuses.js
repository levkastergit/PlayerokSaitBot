'use strict'

const https = require('https')
const { URLSearchParams } = require('url')
const { withPlayerokGate } = require('../infra/playerokRequestGate')
const { playerokHttpsExtraOptions, playerokEgressKey } = require('../infra/playerokHttpsAgent')
const { attachPlayerokTimeout } = require('../infra/playerokRequestTimeout')
const { reportIpResult } = require('../infra/playerokOutboundRotation')

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

      const extra = playerokHttpsExtraOptions('lots')
      const req = https.request({ ...options, ...extra }, (resp) => {
        let data = ''
        resp.setEncoding('utf8')
        resp.on('data', (chunk) => {
          data += chunk
        })
        resp.on('end', () => {
          reportIpResult(playerokEgressKey(extra), resp.statusCode)
          if (resp.statusCode !== 200) {
            const bodyPreview = String(data || '').slice(0, 800)
            const err = new Error(
              `Playerok itemPriorityStatuses: status ${resp.statusCode}` +
                (bodyPreview ? `; body: ${bodyPreview}` : '')
            )
            err.statusCode = resp.statusCode
            return reject(err)
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
      attachPlayerokTimeout(req, 'Playerok itemPriorityStatuses')
      req.end()
        })
    )
  }
}

module.exports = { createFetchItemPriorityStatuses }

