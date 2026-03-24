async function handleGetSalesHistory({ query, currentUserId, deps }) {
  const { getTokenFromQueryOrStored, getSalesHistory } = deps
  const { token } = getTokenFromQueryOrStored(currentUserId, query)

  if (!token) return { statusCode: 400, data: { error: 'token is required' } }

  try {
    const rows = getSalesHistory.all(currentUserId)
    const list = rows.map((row) => ({
      productKey: row.product_key,
      productTitle: row.product_title,
      soldAt: row.sold_at,
      price: row.price ?? 0,
      status: row.status || null,
      buyerName: row.buyer_name || null,
    }))
    return { statusCode: 200, data: { list } }
  } catch (err) {
    return {
      statusCode: 500,
      data: {
        error: err && err.message ? String(err.message) : 'Failed to load sales history',
      },
    }
  }
}

module.exports = { handleGetSalesHistory }

