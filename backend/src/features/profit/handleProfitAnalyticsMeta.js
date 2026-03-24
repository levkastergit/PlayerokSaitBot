async function handleProfitAnalyticsMeta({ query, currentUserId, deps }) {
  const { getTokenFromQueryOrStored, getSalesYears, getSalesMonthsForYear, parseIntSafe } = deps
  const { token } = getTokenFromQueryOrStored(currentUserId, query)

  if (!token) return { statusCode: 400, data: { error: 'token is required' } }

  try {
    const years = getSalesYears.all(currentUserId).map((r) => r.year).filter((y) => y != null)
    const yearQ = parseIntSafe(query.year, null)
    const months =
      yearQ != null
        ? getSalesMonthsForYear.all(currentUserId, String(yearQ)).map((r) => r.month).filter((m) => m != null)
        : []

    return { statusCode: 200, data: { years, months } }
  } catch (err) {
    return { statusCode: 500, data: { error: err && err.message ? String(err.message) : 'Failed to load profit meta' } }
  }
}

module.exports = { handleProfitAnalyticsMeta }

