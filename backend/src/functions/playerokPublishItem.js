'use strict'

const https = require('https')

function createPublishItem({ AUTOBUMP_PRIORITY_STATUS_ID }) {
  if (!AUTOBUMP_PRIORITY_STATUS_ID) {
    throw new Error('AUTOBUMP_PRIORITY_STATUS_ID is required')
  }

  return function publishItem(token, userAgent, itemId, opts = {}) {
    return new Promise((resolve, reject) => {
      // Если priorityStatusId явно передан (включая null), используем его; иначе используем значение по умолчанию
      // Используем hasOwnProperty чтобы различать "не передан" и "передан как null"
      let priorityStatusId = Object.prototype.hasOwnProperty.call(opts, 'priorityStatusId')
        ? opts.priorityStatusId
        : AUTOBUMP_PRIORITY_STATUS_ID

      const input = {
        itemId: String(itemId),
        // В соответствии с неофициальным PlayerokAPI: только provider и статус приоритета
        transactionProviderId: 'LOCAL',
        // priorityStatuses: если priorityStatusId null, передаем пустой массив (для завершенных товаров)
        priorityStatuses:
          priorityStatusId != null && String(priorityStatusId).trim() !== ''
            ? [String(priorityStatusId)]
            : [], // Пустой массив для товаров без статуса поднятия
      }

      const bodyJson = {
        operationName: 'publishItem',
        variables: {
          input,
        },
        query: `mutation publishItem($input: PublishItemInput!) {
  publishItem(input: $input) {
    id
    __typename
    ... on MyItem {
      id
      name
      price
      status
      statusPayment {
        value
        fee
        __typename
      }
      __typename
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
          'content-type': 'application/json',
          cookie: `token=${token}`,
          origin: 'https://playerok.com',
          referer: 'https://playerok.com/',
          'apollographql-client-name': 'web',
          'apollo-require-preflight': 'true',
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
            const preview = String(data || '').slice(0, 600)
            return reject(
              new Error(
                `Playerok publishItem: status ${resp.statusCode}` +
                (preview ? `; ${preview}` : '')
              )
            )
          }
          let json
          try {
            json = JSON.parse(data)
          } catch (err) {
            return reject(new Error(`Invalid JSON: ${err.message}`))
          }
          if (json.errors && json.errors.length) {
            return reject(
              new Error(json.errors.map((e) => e.message || 'GraphQL error').join('; '))
            )
          }
          const item = json?.data?.publishItem
          if (!item || !item.id) {
            return reject(new Error('Playerok publishItem: empty response'))
          }
          const sp = item.statusPayment || {}
          const listingFee = Number(sp.value) || Number(sp.fee) || 0
          resolve({ ...item, listingFee })
        })
      })
      req.on('error', reject)
      req.write(body)
      req.end()
    })
  }
}

module.exports = { createPublishItem }

