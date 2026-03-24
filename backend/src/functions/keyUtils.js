'use strict'

function parseIntSafe(v, fallback = null) {
  if (v == null || v === '') return fallback
  const n = parseInt(String(v), 10)
  return Number.isFinite(n) ? n : fallback
}

function clampInt(n, min, max) {
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

function normalizeKeyPart(v) {
  return String(v == null ? '' : v)
    .trim()
    .replace(/\s+/g, ' ')
}

function normalizeProductKey(productKey) {
  const raw = String(productKey == null ? '' : productKey)
  const sepIndex = raw.indexOf('::')
  if (sepIndex === -1) return normalizeKeyPart(raw)
  const game = raw.slice(0, sepIndex)
  const title = raw.slice(sepIndex + 2)
  return `${normalizeKeyPart(game)}::${normalizeKeyPart(title)}`
}

function buildProductKey(game, title) {
  const g = normalizeKeyPart(game)
  const t = normalizeKeyPart(title)
  return g ? `${g}::${t}` : t
}

module.exports = {
  parseIntSafe,
  clampInt,
  normalizeKeyPart,
  normalizeProductKey,
  buildProductKey,
}

