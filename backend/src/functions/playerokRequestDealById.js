'use strict'

const https = require('https')
const { URLSearchParams } = require('url')
const { withPlayerokGate } = require('../infra/playerokRequestGate')

function createRequestDealById({ DEAL_PERSISTED_HASH }) {
  if (!DEAL_PERSISTED_HASH) throw new Error('DEAL_PERSISTED_HASH is required')

  return function requestDealById(token, userAgent, dealId) {
    return withPlayerokGate(
      () =>
        new Promise((resolve, reject) => {
      const variables = {
        id: String(dealId),
        hasSupportAccess: false,
        showForbiddenImage: true,
      }

      const params = new URLSearchParams({
        operationName: 'deal',
        variables: JSON.stringify(variables),
        extensions: JSON.stringify({
          persistedQuery: { version: 1, sha256Hash: DEAL_PERSISTED_HASH },
        }),
      })

      const options = {
        hostname: 'playerok.com',
        path: `/graphql?${params.toString()}`,
        method: 'GET',
        headers: {
          accept: '*/*',
          'content-type': 'application/json',
          cookie: `token=${token}`,
          origin: 'https://playerok.com',
          referer: 'https://playerok.com/chats',
          'apollographql-client-name': 'web',
          'apollo-require-preflight': 'true',
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
            const preview = String(data || '').slice(0, 500)
            return reject(
              new Error(
                `Playerok deal: status ${resp.statusCode}` + (preview ? `; ${preview}` : '')
              )
            )
          }

          let json
          try {
            json = JSON.parse(data)
          } catch (err) {
            return reject(new Error(`Invalid JSON from deal: ${err.message}`))
          }

          if (json.errors && json.errors.length) {
            return reject(new Error(json.errors.map((e) => e.message || 'GraphQL error').join('; ')))
          }

          resolve(json?.data?.deal || null)
        })
      })

      req.on('error', reject)
      req.end()
        })
    )
  }
}

module.exports = { createRequestDealById }

