'use strict'

const https = require('https')
const { URLSearchParams } = require('url')
const { withPlayerokGate } = require('../infra/playerokRequestGate')
const { playerokHttpsExtraOptions } = require('../infra/playerokHttpsAgent')

function createRequestUserChatsPage({ AUTOLIST_MAX_CHATS_TO_SCAN, USER_CHATS_PERSISTED_HASH }) {
  if (!AUTOLIST_MAX_CHATS_TO_SCAN) throw new Error('AUTOLIST_MAX_CHATS_TO_SCAN is required')
  if (!USER_CHATS_PERSISTED_HASH) throw new Error('USER_CHATS_PERSISTED_HASH is required')

  return function requestUserChatsPage(token, userAgent, userId, opts) {
    const options = opts && typeof opts === 'object' ? opts : {}
    const firstRaw = options.first
    let first = Number.isFinite(firstRaw) ? Number(firstRaw) : null
    if (!first || first <= 0) first = AUTOLIST_MAX_CHATS_TO_SCAN
    if (first > 50) first = 50
    const after = options.after != null ? String(options.after) : null

    return withPlayerokGate(
      () =>
        new Promise((resolve, reject) => {
      const variables = {
        pagination: { first, after },
        filter: { userId, type: null, status: null },
        hasSupportAccess: false,
      }

      const params = new URLSearchParams({
        operationName: 'userChats',
        variables: JSON.stringify(variables),
        extensions: JSON.stringify({
          persistedQuery: { version: 1, sha256Hash: USER_CHATS_PERSISTED_HASH },
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
          referer: 'https://playerok.com/chats',
          'apollographql-client-name': 'web',
          'apollo-require-preflight': 'true',
          'x-gql-op': 'userChats',
          'x-gql-path': '/',
          'user-agent':
            userAgent ||
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        },
      }

      const req = https.request({ ...options, ...playerokHttpsExtraOptions('chats') }, (resp) => {
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
                `Playerok userChats: status ${resp.statusCode}` +
                  (preview ? `; ${preview}` : '')
              )
            )
          }

          let json
          try {
            json = JSON.parse(data)
          } catch (err) {
            return reject(new Error(`Invalid JSON from userChats: ${err.message}`))
          }

          if (json.errors && json.errors.length) {
            return reject(
              new Error(json.errors.map((e) => e.message || 'GraphQL error').join('; '))
            )
          }

          resolve(json?.data?.chats || null)
        })
      })

      req.on('error', reject)
      req.end()
        })
    )
  }
}

module.exports = { createRequestUserChatsPage }

