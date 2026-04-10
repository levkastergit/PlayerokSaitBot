'use strict'

const https = require('https')
const { withPlayerokGate } = require('../infra/playerokRequestGate')

function createUpdateDealStatus() {
  return function updateDealStatus(token, userAgent, dealId, newStatus) {
    return withPlayerokGate(
      () =>
        new Promise((resolve, reject) => {
      const bodyJson = {
        operationName: 'updateDeal',
        variables: {
          input: {
            id: String(dealId),
            status: String(newStatus),
          },
        },
        query: `mutation updateDeal($input: UpdateItemDealInput!) {
  updateDeal(input: $input) {
    id
    status
    statusDescription
    __typename
  }
}
`,
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
          referer: `https://playerok.com/deal/${String(dealId)}`,
          'apollographql-client-name': 'web',
          'apollo-require-preflight': 'true',
          'x-timezone-offset': String(new Date().getTimezoneOffset()),
          'x-gql-op': 'updateDeal',
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
            const preview = String(data || '').slice(0, 800)
            return reject(
              new Error(
                `Playerok updateDeal: status ${resp.statusCode}` +
                  (preview ? `; ${preview}` : '')
              )
            )
          }

          let json
          try {
            json = JSON.parse(data)
          } catch (err) {
            return reject(new Error(`Invalid JSON from updateDeal: ${err.message}`))
          }

          if (json.errors && json.errors.length) {
            return reject(new Error(json.errors.map((e) => e.message || 'GraphQL error').join('; ')))
          }

          const deal = json?.data?.updateDeal || null
          if (!deal || !deal.id) {
            return reject(new Error('Playerok updateDeal: empty response'))
          }

          resolve(deal)
        })
      })

      req.on('error', reject)
      req.write(body)
      req.end()
        })
    )
  }
}

module.exports = { createUpdateDealStatus }

