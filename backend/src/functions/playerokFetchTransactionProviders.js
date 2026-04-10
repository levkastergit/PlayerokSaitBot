'use strict'

const https = require('https')
const { URLSearchParams } = require('url')
const { withPlayerokGate } = require('../infra/playerokRequestGate')

function createFetchTransactionProviders({ TRANSACTION_PROVIDERS_PERSISTED_HASH }) {
  if (!TRANSACTION_PROVIDERS_PERSISTED_HASH) {
    throw new Error('TRANSACTION_PROVIDERS_PERSISTED_HASH is required')
  }

  return function fetchTransactionProviders(token, userAgent, direction = 'OUT') {
    return withPlayerokGate(
      () =>
        new Promise((resolve, reject) => {
      const variables = {
        filter: {
          direction: String(direction || 'OUT').toUpperCase(),
        },
      }
      const params = new URLSearchParams({
        operationName: 'transactionProviders',
        variables: JSON.stringify(variables),
        extensions: JSON.stringify({
          persistedQuery: { version: 1, sha256Hash: TRANSACTION_PROVIDERS_PERSISTED_HASH },
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
          referer: 'https://playerok.com/wallet',
          'apollographql-client-name': 'web',
          'apollo-require-preflight': 'true',
          'x-gql-op': 'transactionProviders',
          'x-gql-path': '/',
          'user-agent':
            userAgent ||
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        },
      }

      const req = https.request(options, (resp) => {
        let data = ''
        resp.on('data', (chunk) => { data += chunk })
        resp.on('end', () => {
          if (resp.statusCode !== 200) {
            return reject(new Error(`Playerok transactionProviders: status ${resp.statusCode}`))
          }
          let json
          try {
            json = JSON.parse(data)
          } catch (err) {
            return reject(new Error(`Invalid JSON from transactionProviders: ${err.message}`))
          }
          if (json.errors && json.errors.length) {
            return reject(new Error(json.errors.map((e) => e.message || 'GraphQL error').join('; ')))
          }
          const list = Array.isArray(json?.data?.transactionProviders) ? json.data.transactionProviders : []
          resolve({ list })
        })
      })

      req.on('error', reject)
      req.end()
        })
    )
  }
}

module.exports = { createFetchTransactionProviders }
