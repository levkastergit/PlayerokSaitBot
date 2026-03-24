async function handleActionsHistory({ query, currentUserId, deps }) {
  const { getTokenFromQueryOrStored, getBumpHistory, getListingFees } = deps
  const { token } = getTokenFromQueryOrStored(currentUserId, query)

  if (!token) return { statusCode: 400, data: { error: 'token is required' } }

  try {
    const bumps = getBumpHistory.all(currentUserId).map((row) => ({
      actionType: 'bump',
      productKey: row.product_key,
      productTitle: row.product_title,
      itemId: row.item_id || null,
      amount: Number(row.price) || 0,
      createdAt: row.bumped_at,
    }))
    const relists = getListingFees.all(currentUserId).map((row) => ({
      actionType: 'autolist',
      productKey: row.product_key,
      productTitle: row.product_title || row.product_key || 'Товар',
      itemId: row.item_id || null,
      amount: Number(row.fee) || 0,
      createdAt: row.relisted_at,
    }))
    const list = [...bumps, ...relists]
      .sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0))
      .slice(0, 1000)
    return { statusCode: 200, data: { list } }
  } catch (err) {
    return { statusCode: 500, data: { error: 'Failed to load actions history', details: err.message } }
  }
}

module.exports = { handleActionsHistory }
