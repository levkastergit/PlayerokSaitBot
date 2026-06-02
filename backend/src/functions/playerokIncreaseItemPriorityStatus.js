'use strict'

const https = require('https')
const { withPlayerokGate } = require('../infra/playerokRequestGate')
const { playerokHttpsExtraOptions } = require('../infra/playerokHttpsAgent')

function createIncreaseItemPriorityStatus({ AUTOBUMP_PRIORITY_STATUS_ID }) {
  if (!AUTOBUMP_PRIORITY_STATUS_ID) {
    throw new Error('AUTOBUMP_PRIORITY_STATUS_ID is required')
  }

  return function increaseItemPriorityStatus(token, userAgent, itemId, opts = {}) {
    return withPlayerokGate(
      () =>
        new Promise((resolve, reject) => {
      const priorityStatusId = opts.priorityStatusId || AUTOBUMP_PRIORITY_STATUS_ID
      const transactionProviderId = opts.transactionProviderId || 'LOCAL'
      const paymentMethodId =
        Object.prototype.hasOwnProperty.call(opts, 'paymentMethodId')
          ? opts.paymentMethodId
          : null

      const bodyJson = {
        operationName: 'increaseItemPriorityStatus',
        variables: {
          input: {
            priorityStatuses: [String(priorityStatusId)],
            transactionProviderId: String(transactionProviderId),
            transactionProviderData: { paymentMethodId: paymentMethodId ?? null },
            itemId: String(itemId),
          },
        },
        // Важно: используем реальные переводы строк, а не литералы "\\n",
        // иначе Playerok GraphQL парсер падает с GRAPHQL_PARSE_FAILED.
        query: `mutation increaseItemPriorityStatus($input: PublishItemInput!) {
  increaseItemPriorityStatus(input: $input) {
    id
    __typename
    ... on MyItem {
      priorityPrice
      statusPayment {
        id
        status
        statusDescription
        value
        props {
          paymentURL
          __typename
        }
        __typename
      }
    }
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
          'access-control-allow-headers': 'sentry-trace, baggage',
          'content-type': 'application/json',
          cookie: `token=${token}`,
          origin: 'https://playerok.com',
          priority: 'u=1, i',
          referer: 'https://playerok.com/',
          'apollographql-client-name': 'web',
          'apollo-require-preflight': 'true',
          'x-timezone-offset': String(new Date().getTimezoneOffset()),
          'x-gql-op': 'increaseItemPriorityStatus',
          'x-gql-path': '/',
          'user-agent':
            userAgent ||
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
          'Content-Length': Buffer.byteLength(body, 'utf8'),
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
            const bodyPreview = String(data || '').slice(0, 800)
            return reject(
              new Error(
                `Playerok bump: status ${resp.statusCode}` +
                  (bodyPreview ? `; body: ${bodyPreview}` : '')
              )
            )
          }

          let json
          try {
            json = JSON.parse(data)
          } catch (err) {
            return reject(new Error(`Invalid JSON from Playerok bump: ${err.message}`))
          }

          if (json.errors && json.errors.length) {
            return reject(new Error(json.errors.map((e) => e.message || 'GraphQL error').join('; ')))
          }

          const item = json?.data?.increaseItemPriorityStatus
          if (!item || !item.id) {
            return reject(new Error('Playerok bump: empty response'))
          }

          resolve(item)
        })
      })

      req.on('error', reject)
      req.write(body)
      req.end()
        })
    )
  }
}

module.exports = { createIncreaseItemPriorityStatus }

