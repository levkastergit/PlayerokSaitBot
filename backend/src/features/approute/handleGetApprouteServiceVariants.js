const { listApprouteServiceVariants } = require('../../integrations/approute/approuteClient')

async function handleGetApprouteServiceVariants({ serviceId, currentUserId, deps }) {
  const { loadApprouteApiKeyPlain } = deps
  if (typeof loadApprouteApiKeyPlain !== 'function') {
    return { statusCode: 500, data: { error: 'Server misconfiguration' } }
  }

  const id = String(serviceId || '').trim()
  if (!id) {
    return { statusCode: 400, data: { error: 'serviceId is required' } }
  }

  const apiKey = loadApprouteApiKeyPlain(currentUserId)
  if (!apiKey) {
    return { statusCode: 400, data: { error: 'AppRoute API key is not configured' } }
  }

  try {
    const { variants, ordersType } = await listApprouteServiceVariants(apiKey, id)
    return { statusCode: 200, data: { ok: true, serviceId: id, variants, ordersType } }
  } catch (err) {
    return {
      statusCode: 502,
      data: {
        error: err?.message || 'Failed to load AppRoute service variants',
      },
    }
  }
}

module.exports = { handleGetApprouteServiceVariants }
