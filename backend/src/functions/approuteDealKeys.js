'use strict'

function dealPublishEventKey(dealId, dealItemId) {
  return `deal:${dealId || dealItemId || ''}`
}

function dealApprouteOrderEventKey(dealId, dealItemId) {
  return `approute-order:${dealId || dealItemId || ''}`
}

function dealApprouteChatEventKey(dealId, dealItemId) {
  return `approute-chat:${dealId || dealItemId || ''}`
}

/** @deprecated use dealApprouteChatEventKey */
function dealApprouteEventKey(dealId, dealItemId) {
  return dealApprouteChatEventKey(dealId, dealItemId)
}

module.exports = {
  dealPublishEventKey,
  dealApprouteEventKey,
  dealApprouteOrderEventKey,
  dealApprouteChatEventKey,
}
