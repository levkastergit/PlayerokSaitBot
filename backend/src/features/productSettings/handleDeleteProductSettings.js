async function handleDeleteProductSettings({ payload, currentUserId, deps }) {
  const { getTokenFromBodyOrStored, deleteSettings } = deps
  const { token } = getTokenFromBodyOrStored(currentUserId, payload)
  const productKey = payload.productKey

  if (!token || productKey == null || productKey === '') {
    return { statusCode: 400, data: { error: 'token and productKey are required' } }
  }

  try {
    const tokenHash = token
    const key = String(productKey)
    const result = deleteSettings.run(currentUserId, key)
    console.info('[settings:delete]', { tokenHash, productKey: key, deleted: result.changes || 0 })
    return { statusCode: 200, data: { ok: true, deleted: result.changes || 0 } }
  } catch (err) {
    return { statusCode: 500, data: { error: 'Failed to delete settings', details: err.message } }
  }
}

module.exports = { handleDeleteProductSettings }

