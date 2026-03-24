async function handleClearSalesHistory({ payload, currentUserId, deps }) {
  const { getTokenFromBodyOrStored, deleteSalesHistoryByUser } = deps
  const { token } = getTokenFromBodyOrStored(currentUserId, payload)

  if (!token) {
    return { statusCode: 400, data: { error: 'token is required' } }
  }

  try {
    const result = deleteSalesHistoryByUser.run(currentUserId)
    return { statusCode: 200, data: { ok: true, deleted: result.changes } }
  } catch (err) {
    return {
      statusCode: 500,
      data: {
        error: err && err.message ? String(err.message) : 'Failed to clear sales history',
      },
    }
  }
}

module.exports = { handleClearSalesHistory }

