async function handleBumpHistory({ query, currentUserId, deps }) {
  const { getTokenFromQueryOrStored, getBumpHistory } = deps
  const { token } = getTokenFromQueryOrStored(currentUserId, query)

  if (!token) return { statusCode: 400, data: { error: 'token is required' } }

  try {
    const rows = getBumpHistory.all(currentUserId)
    const list = rows.map((row) => ({
      productKey: row.product_key,
      productTitle: row.product_title,
      bumpedAt: row.bumped_at,
      price: row.price ?? 0,
      itemId: row.item_id || null,
    }))
    return { statusCode: 200, data: { list } }
  } catch (err) {
    return { statusCode: 500, data: { error: 'Failed to load bump history', details: err.message } }
  }
}

module.exports = { handleBumpHistory }

