async function handleLogs({ query, currentUserId, deps }) {
  const { getTokenFromQueryOrStored, getLogsBuffer, parseIntSafe } = deps
  const { token } = getTokenFromQueryOrStored(currentUserId, query)

  if (!token) return { statusCode: 400, data: { error: 'token is required' } }

  try {
    const limit = parseIntSafe(query.limit, 1000)
    const logs = getLogsBuffer(limit)
    return { statusCode: 200, data: { logs } }
  } catch (err) {
    return { statusCode: 500, data: { error: 'Failed to load logs', details: err.message } }
  }
}

module.exports = { handleLogs }

