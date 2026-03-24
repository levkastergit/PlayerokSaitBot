'use strict'

function createFetchDealsFromPlayerok({ SALES_HISTORY_LIMIT, getViewer, requestDealsPage }) {
  if (!Number.isFinite(SALES_HISTORY_LIMIT)) {
    throw new Error('SALES_HISTORY_LIMIT is required')
  }
  if (typeof getViewer !== 'function') {
    throw new Error('getViewer must be a function')
  }
  if (typeof requestDealsPage !== 'function') {
    throw new Error('requestDealsPage must be a function')
  }

  return async function fetchDealsFromPlayerok(token, userAgent) {
    const viewer = await getViewer(token, userAgent)
    const statusList = ['PAID', 'PENDING', 'SENT', 'CONFIRMED', 'ROLLED_BACK']
    const allDeals = []
    let afterCursor = null

    do {
      const page = await requestDealsPage(
        token,
        userAgent,
        viewer.id,
        afterCursor,
        statusList,
        'OUT'
      )
      allDeals.push(...page.deals)
      afterCursor = page.hasNextPage ? page.endCursor : null
    } while (afterCursor && allDeals.length < SALES_HISTORY_LIMIT)

    return { deals: allDeals }
  }
}

module.exports = { createFetchDealsFromPlayerok }

