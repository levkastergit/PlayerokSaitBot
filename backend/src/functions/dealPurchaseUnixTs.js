'use strict'

const { toUnixTs: defaultToUnixTs } = require('./toUnixTs')

/**
 * Unix-время «покупки / оплаты» для сделки Playerok.
 * Не использует completedAt раньше transaction/deal/item полей — иначе в sold_at попадает
 * момент подтверждения продавцом, а не оплаты (ломает автоподнятие: Math.max(lastBump, lastSale)).
 */
function dealPurchaseUnixTs(deal, toUnixTsFn = defaultToUnixTs) {
  if (!deal || typeof deal !== 'object') return 0
  const tu = typeof toUnixTsFn === 'function' ? toUnixTsFn : defaultToUnixTs
  const tx = deal.transaction && typeof deal.transaction === 'object' ? deal.transaction : null
  const item = deal.item && typeof deal.item === 'object' ? deal.item : null

  const pick = (obj, keys) => {
    if (!obj) return 0
    for (const k of keys) {
      const u = tu(obj[k])
      if (u) return u
    }
    return 0
  }

  let u = pick(tx, ['createdAt', 'created_at'])
  if (u) return u
  u = pick(deal, ['paidAt', 'paid_at'])
  if (u) return u
  u = pick(deal, ['createdAt', 'created_at'])
  if (u) return u
  u = pick(item, ['soldAt', 'sold_at'])
  if (u) return u
  u = pick(tx, ['completedAt', 'completed_at'])
  if (u) return u
  u = pick(deal, ['completedAt', 'completed_at'])
  return u
}

module.exports = { dealPurchaseUnixTs }
