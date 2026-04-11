'use strict'

const https = require('https')
const { URLSearchParams } = require('url')
const { withPlayerokGate } = require('../infra/playerokRequestGate')

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'

function parseDealJsonBody(data, statusCode, label) {
  if (statusCode !== 200) {
    const preview = String(data || '').slice(0, 600)
    throw new Error(`Playerok deal ${label}: status ${statusCode}` + (preview ? `; ${preview}` : ''))
  }
  let json
  try {
    json = JSON.parse(data)
  } catch (err) {
    throw new Error(`Invalid JSON from deal ${label}: ${err.message}`)
  }
  if (json.errors && json.errors.length) {
    const msg = json.errors.map((e) => e.message || 'GraphQL error').join('; ')
    throw new Error(`Playerok deal ${label}: ${msg}`)
  }
  return json?.data?.deal || null
}

function createRequestDealById({ DEAL_PERSISTED_HASH }) {
  if (!DEAL_PERSISTED_HASH) throw new Error('DEAL_PERSISTED_HASH is required')

  return function requestDealById(token, userAgent, dealId) {
    const variables = {
      id: String(dealId),
      hasSupportAccess: false,
      showForbiddenImage: true,
    }
    const extensions = {
      persistedQuery: { version: 1, sha256Hash: DEAL_PERSISTED_HASH },
    }
    const ua = userAgent || DEFAULT_UA

    const tryGet = (referer) =>
      new Promise((resolve, reject) => {
        const params = new URLSearchParams({
          operationName: 'deal',
          variables: JSON.stringify(variables),
          extensions: JSON.stringify(extensions),
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
            referer,
            'apollographql-client-name': 'web',
            'apollo-require-preflight': 'true',
            'user-agent': ua,
          },
        }
        const req = https.request(options, (resp) => {
          let data = ''
          resp.on('data', (chunk) => {
            data += chunk
          })
          resp.on('end', () => {
            try {
              resolve(parseDealJsonBody(data, resp.statusCode, 'GET'))
            } catch (err) {
              reject(err)
            }
          })
        })
        req.on('error', reject)
        req.end()
      })

    const tryPost = (referer) =>
      new Promise((resolve, reject) => {
        const bodyJson = {
          operationName: 'deal',
          variables,
          extensions,
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
            referer,
            'apollographql-client-name': 'web',
            'apollo-require-preflight': 'true',
            'x-gql-op': 'deal',
            'x-gql-path': '/',
            'user-agent': ua,
            'Content-Length': Buffer.byteLength(body, 'utf8'),
          },
        }
        const req = https.request(options, (resp) => {
          let data = ''
          resp.on('data', (chunk) => {
            data += chunk
          })
          resp.on('end', () => {
            try {
              resolve(parseDealJsonBody(data, resp.statusCode, 'POST'))
            } catch (err) {
              reject(err)
            }
          })
        })
        req.on('error', reject)
        req.write(body)
        req.end()
      })

    return withPlayerokGate(async () => {
      const id = String(dealId)
      const refererDeal = `https://playerok.com/deal/${id}`
      const refererChats = 'https://playerok.com/chats'

      const attempts = [
        { name: 'GET+referer(chats)', fn: () => tryGet(refererChats) },
        { name: 'POST+referer(deal)', fn: () => tryPost(refererDeal) },
        { name: 'POST+referer(chats)', fn: () => tryPost(refererChats) },
        { name: 'GET+referer(deal)', fn: () => tryGet(refererDeal) },
      ]

      let lastErr = null
      for (const { name, fn } of attempts) {
        try {
          const deal = await fn()
          if (deal != null) return deal
        } catch (err) {
          lastErr = err
        }
      }
      if (lastErr) throw lastErr
      return null
    })
  }
}

module.exports = { createRequestDealById }
