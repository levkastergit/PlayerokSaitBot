'use strict'

function createFetchCompletedDealsFromPlayerok({ getViewer, requestDealsPage }) {
  if (typeof getViewer !== 'function') throw new Error('getViewer must be a function')
  if (typeof requestDealsPage !== 'function') {
    throw new Error('requestDealsPage must be a function')
  }

  return async function fetchCompletedDealsFromPlayerok(token, userAgent) {
    const viewer = await getViewer(token, userAgent)
    const statusList = ['SENT', 'CONFIRMED']
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
    } while (afterCursor)
    return { deals: allDeals }
  }
}

module.exports = { createFetchCompletedDealsFromPlayerok }

