async function handleRelistItem({ payload, currentUserId, deps }) {
  const { getTokenFromBodyOrStored, publishItem } = deps

  const { token } = getTokenFromBodyOrStored(currentUserId, payload)
  const itemId = payload.itemId
  const priorityStatusId = payload.priorityStatusId || null
  const userAgent = payload.userAgent

  if (!token || !itemId) {
    return { statusCode: 400, data: { error: 'token and itemId are required' } }
  }

  try {
    const item = await publishItem(token, userAgent, itemId, {
      priorityStatusId: priorityStatusId || undefined,
    })
    return { statusCode: 200, data: { ok: true, itemId: item.id } }
  } catch (err) {
    return {
      statusCode: 500,
      data: { error: err && err.message ? String(err.message) : 'Failed to relist item' },
    }
  }
}

module.exports = { handleRelistItem }

