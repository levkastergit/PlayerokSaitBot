const { playerokErrorResponse } = require('../../../infra/playerokErrorResponse')

async function handleBalanceOverview({ payload, currentUserId, deps }) {
  const { getTokenFromBodyOrStored, getViewer } = deps
  const { token } = getTokenFromBodyOrStored(currentUserId, payload)
  const userAgent = payload.userAgent

  if (!token) return { statusCode: 400, data: { error: 'token is required' } }

  try {
    const viewer = await getViewer(token, userAgent)
    return {
      statusCode: 200,
      data: {
        ok: true,
        viewer: {
          id: viewer.id,
          username: viewer.username || null,
          email: viewer.email || null,
          role: viewer.role || null,
          hasFrozenBalance: Boolean(viewer.hasFrozenBalance),
        },
      },
    }
  } catch (err) {
    return playerokErrorResponse(err, 'Не удалось загрузить данные баланса')
  }
}

module.exports = { handleBalanceOverview }
