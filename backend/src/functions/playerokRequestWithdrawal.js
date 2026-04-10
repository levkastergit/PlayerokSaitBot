'use strict'

const https = require('https')
const { withPlayerokGate } = require('../infra/playerokRequestGate')

function createRequestWithdrawal() {
  return function requestWithdrawal(token, userAgent, payload) {
    return withPlayerokGate(
      () =>
        new Promise((resolve, reject) => {
      const bodyJson = {
        operationName: 'requestWithdrawal',
        variables: {
          input: {
            providerId: String(payload.providerId),
            account: String(payload.account),
            value: Number(payload.value) || 0,
            paymentMethodId: payload.paymentMethodId ? String(payload.paymentMethodId) : null,
            sbpBankMemberId: payload.sbpBankMemberId ? String(payload.sbpBankMemberId) : null,
          },
        },
        query: `mutation requestWithdrawal($input: CreateWithdrawalTransactionInput!) {
  requestWithdrawal(input: $input) {
    id
    operation
    direction
    providerId
    status
    statusDescription
    value
    fee
    createdAt
    props {
      paymentURL
      successURL
      __typename
    }
    __typename
  }
}`,
      }

      const body = JSON.stringify(bodyJson)
      const req = https.request(
        {
          hostname: 'playerok.com',
          path: '/graphql',
          method: 'POST',
          headers: {
            accept: '*/*',
            'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
            'content-type': 'application/json',
            cookie: `token=${token}`,
            origin: 'https://playerok.com',
            referer: 'https://playerok.com/wallet/withdrawal',
            'apollographql-client-name': 'web',
            'apollo-require-preflight': 'true',
            'x-gql-op': 'requestWithdrawal',
            'x-gql-path': '/',
            'x-timezone-offset': String(new Date().getTimezoneOffset()),
            'user-agent':
              userAgent ||
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
            'Content-Length': Buffer.byteLength(body, 'utf8'),
          },
        },
        (resp) => {
          let data = ''
          resp.on('data', (chunk) => { data += chunk })
          resp.on('end', () => {
            if (resp.statusCode !== 200) {
              return reject(new Error(`Playerok requestWithdrawal: status ${resp.statusCode}`))
            }
            let json
            try {
              json = JSON.parse(data)
            } catch (err) {
              return reject(new Error(`Invalid JSON from requestWithdrawal: ${err.message}`))
            }
            if (json.errors && json.errors.length) {
              return reject(new Error(json.errors.map((e) => e.message || 'GraphQL error').join('; ')))
            }
            resolve(json?.data?.requestWithdrawal || null)
          })
        }
      )

      req.on('error', reject)
      req.write(body)
      req.end()
        })
    )
  }
}

module.exports = { createRequestWithdrawal }
