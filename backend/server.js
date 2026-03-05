const http = require('http')
const https = require('https')
const { URLSearchParams } = require('url')

const PORT = process.env.PORT || 3000

function sendJson(res, statusCode, data) {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(data))
}

const PAGE_SIZE = 24
const ITEMS_PERSISTED_HASH =
  '63eefcfd813442882ad846360d925279bc376e8bc85a577ebefbee0f9c78b557'

const VIEWER_QUERY =
  'query viewer { viewer { ...Viewer __typename } } fragment Viewer on User { id username email role __typename }'

function getViewer(token, userAgent) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      operationName: 'viewer',
      query: VIEWER_QUERY,
      variables: {},
    })
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
      resp.on('data', (chunk) => { data += chunk })
      resp.on('end', () => {
        if (resp.statusCode !== 200) {
          return reject(new Error(`Playerok viewer: status ${resp.statusCode}`))
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
        const viewer = json?.data?.viewer
        if (!viewer || !viewer.id) {
          return reject(new Error('Не удалось получить данные аккаунта (токен неверный или истёк)'))
        }
        resolve({ id: viewer.id, username: viewer.username || 'me' })
      })
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function requestItemsPage(token, userAgent, userId, afterCursor) {
  return new Promise((resolve, reject) => {
    const variables = {
      pagination: {
        first: PAGE_SIZE,
        after: afterCursor,
      },
      filter: {
        userId,
        status: ['APPROVED'],
      },
      showForbiddenImage: false,
    }

    const params = new URLSearchParams({
      operationName: 'items',
      variables: JSON.stringify(variables),
      extensions: JSON.stringify({
        persistedQuery: { version: 1, sha256Hash: ITEMS_PERSISTED_HASH },
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
        referer: 'https://playerok.com/',
        'apollographql-client-name': 'web',
        'apollo-require-preflight': 'true',
        'x-gql-op': 'items',
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
          return reject(new Error(`Playerok responded with status ${resp.statusCode}`))
        }
        let json
        try {
          json = JSON.parse(data)
        } catch (err) {
          return reject(new Error(`Invalid JSON from Playerok: ${err.message}`))
        }
        if (json.errors && json.errors.length) {
          return reject(
            new Error(json.errors.map((e) => e.message || 'GraphQL error').join('; '))
          )
        }
        const itemsData = json?.data?.items
        const edges = itemsData?.edges || []
        const pageInfo = itemsData?.pageInfo || {}
        const items = edges
          .map((edge) => edge && edge.node)
          .filter(Boolean)
          .map((node) => {
            const attachment = node.attachment || (node.attachments && node.attachments[0])
            const imageUrl = attachment?.url || null
            return {
              id: node.id,
              title: node.name,
              game: node.game?.name || '',
              price: node.price ?? node.rawPrice ?? 0,
              currency: '₽',
              status: node.status,
              imageUrl,
              url: `https://playerok.com/profile/${node.user?.username || 'me'}/products`,
            }
          })
        resolve({
          items,
          totalCount: itemsData?.totalCount,
          hasNextPage: pageInfo.hasNextPage === true,
          endCursor: pageInfo.endCursor || null,
        })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

async function fetchActiveItemsFromPlayerok(token, userAgent) {
  const viewer = await getViewer(token, userAgent)

  const allItems = []
  let afterCursor = null
  let totalCount = 0

  do {
    const page = await requestItemsPage(token, userAgent, viewer.id, afterCursor)
    allItems.push(...page.items)
    if (page.totalCount != null) totalCount = page.totalCount
    afterCursor = page.hasNextPage ? page.endCursor : null
  } while (afterCursor)

  return {
    items: allItems,
    totalCount: totalCount || allItems.length,
  }
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    return res.end()
  }

  if (req.method === 'GET' && req.url === '/') {
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    return res.end('OK\n')
  }

  if (req.method === 'POST' && req.url === '/api/playerok/active-lots') {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1e6) {
        req.connection.destroy()
      }
    })

    req.on('end', async () => {
      let payload
      try {
        payload = body ? JSON.parse(body) : {}
      } catch (err) {
        return sendJson(res, 400, { error: 'Invalid JSON body' })
      }

      const token = payload.token
      const userAgent = payload.userAgent

      if (!token) {
        return sendJson(res, 400, { error: 'Token is required' })
      }

      try {
        const result = await fetchActiveItemsFromPlayerok(token, userAgent)
        return sendJson(res, 200, result)
      } catch (err) {
        return sendJson(res, 500, {
          error: 'Failed to fetch active items from Playerok',
          details: err.message,
        })
      }
    })

    return
  }

  sendJson(res, 404, { error: 'Not found' })
})

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`)
})

