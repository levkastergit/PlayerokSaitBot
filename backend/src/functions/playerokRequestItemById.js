'use strict'

const https = require('https')
const { URLSearchParams } = require('url')
const { withPlayerokGate } = require('../infra/playerokRequestGate')
const { playerokHttpsExtraOptions } = require('../infra/playerokHttpsAgent')

function createRequestItemById({ ITEM_PERSISTED_HASH }) {
  if (!ITEM_PERSISTED_HASH) throw new Error('ITEM_PERSISTED_HASH is required')

  return function requestItemById(token, userAgent, itemId) {
    return withPlayerokGate(
      () =>
        new Promise((resolve, reject) => {
      const variables = {
        id: String(itemId),
        slug: null,
        hasSupportAccess: false,
        showForbiddenImage: true,
      }

      const params = new URLSearchParams({
        operationName: 'item',
        variables: JSON.stringify(variables),
        extensions: JSON.stringify({
          persistedQuery: { version: 1, sha256Hash: ITEM_PERSISTED_HASH },
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
          referer: 'https://playerok.com/profile/Levkaster/products',
          'apollographql-client-name': 'web',
          'apollo-require-preflight': 'true',
          'x-gql-op': 'item',
          'x-gql-path': '/',
          'user-agent':
            userAgent ||
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        },
      }

      const req = https.request({ ...options, ...playerokHttpsExtraOptions('lots') }, (resp) => {
        let data = ''
        resp.setEncoding('utf8')
        resp.on('data', (chunk) => {
          data += chunk
        })
        resp.on('end', () => {
          if (resp.statusCode !== 200) {
            const preview = String(data || '').slice(0, 500)
            return reject(
              new Error(
                `Playerok item: status ${resp.statusCode}` + (preview ? `; ${preview}` : '')
              )
            )
          }

          let json
          try {
            json = JSON.parse(data)
          } catch (err) {
            return reject(new Error(`Invalid JSON from item: ${err.message}`))
          }

          if (json.errors && json.errors.length) {
            return reject(new Error(json.errors.map((e) => e.message || 'GraphQL error').join('; ')))
          }

          resolve(json?.data?.item || null)
        })
      })

      req.on('error', reject)
      req.end()
        })
    )
  }
}

module.exports = { createRequestItemById }

