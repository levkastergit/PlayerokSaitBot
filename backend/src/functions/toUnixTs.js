'use strict'

function toUnixTs(v) {
  if (v == null) return 0
  if (typeof v === 'number') {
    if (v < 1e12) return v
    return Math.floor(v / 1000)
  }
  const d = new Date(v)
  return isNaN(d.getTime()) ? 0 : Math.floor(d.getTime() / 1000)
}

module.exports = { toUnixTs }

