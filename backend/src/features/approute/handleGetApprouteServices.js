const { listApprouteServices } = require('../../integrations/approute/approuteClient')

async function handleGetApprouteServices({ currentUserId, deps }) {
  const { loadApprouteApiKeyPlain } = deps
  if (typeof loadApprouteApiKeyPlain !== 'function') {
    return { statusCode: 500, data: { error: 'Server misconfiguration' } }
  }

  const apiKey = loadApprouteApiKeyPlain(currentUserId)
  if (!apiKey) {
    return { statusCode: 400, data: { error: 'AppRoute API key is not configured' } }
  }

  try {
    const services = await listApprouteServices(apiKey)
    return { statusCode: 200, data: { ok: true, services } }
  } catch (err) {
    return {
      statusCode: 502,
      data: {
        error: err?.message || 'Failed to load AppRoute services',
      },
    }
  }
}

module.exports = { handleGetApprouteServices }
