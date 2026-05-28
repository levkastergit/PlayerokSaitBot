'use strict'

function extractDealItemId(deal) {
  if (!deal || typeof deal !== 'object') return null
  const item = deal.item
  if (item && item.id != null && String(item.id).trim()) return String(item.id).trim()
  if (deal.itemId != null && String(deal.itemId).trim()) return String(deal.itemId).trim()
  if (deal.item_id != null && String(deal.item_id).trim()) return String(deal.item_id).trim()
  return null
}

module.exports = { extractDealItemId }
