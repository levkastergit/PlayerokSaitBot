'use strict'

const {
  getSupercellGameByCategory,
  pickSupercellCategoryFromDeal,
  extractSupercellEmailFromFields,
  pickBuyerEmailFromFieldsForSupercellDeal,
  collectDeepScanEmailCandidates,
  isEmailValid,
} = require('./supercellHelpers')

function asFieldRowArray(raw) {
  if (raw == null) return []
  if (Array.isArray(raw)) {
    if (
      raw.length > 0 &&
      raw[0] &&
      typeof raw[0] === 'object' &&
      Object.prototype.hasOwnProperty.call(raw[0], 'node')
    ) {
      return raw.map((e) => e && e.node).filter(Boolean)
    }
    return raw
  }
  if (typeof raw === 'object' && Array.isArray(raw.edges)) {
    return raw.edges.map((e) => e && e.node).filter(Boolean)
  }
  return []
}

function gatherDealFields(fullDeal) {
  const item = fullDeal?.item || null
  const fieldArrays = []
  const pushFieldArr = (a) => {
    const list = asFieldRowArray(a)
    if (list.length) fieldArrays.push(list)
  }
  pushFieldArr(fullDeal?.obtainingFields)
  pushFieldArr(fullDeal?.dataFields)
  pushFieldArr(fullDeal?.obtainingFieldValues)
  pushFieldArr(fullDeal?.formFields)
  pushFieldArr(fullDeal?.userInputs)
  if (fullDeal?.obtaining && typeof fullDeal.obtaining === 'object') {
    pushFieldArr(fullDeal.obtaining.fields)
    pushFieldArr(fullDeal.obtaining.values)
  }
  pushFieldArr(item?.dataFields)
  pushFieldArr(item?.obtainingFields)
  pushFieldArr(item?.fields)
  pushFieldArr(item?.templateFields)
  if (item?.obtaining && typeof item.obtaining === 'object') {
    pushFieldArr(item.obtaining.fields)
    pushFieldArr(item.obtaining.values)
  }
  return fieldArrays.length > 0 ? fieldArrays.flat() : []
}

// Извлекает почту Supercell из УЖЕ загруженной сделки (без сети). Вынесено отдельно, чтобы
// фоновый бэкфилл мог одним запросом сделки достать и почту, и отзыв (см. supercellEmailBackfill).
function extractSupercellEmailFromDealObject(fullDeal, categoryHint) {
  if (!fullDeal || typeof fullDeal !== 'object') return null
  const itemCategory =
    pickSupercellCategoryFromDeal(fullDeal) ||
    (categoryHint != null ? String(categoryHint).trim() : '') ||
    null
  const supercellGame = getSupercellGameByCategory(itemCategory)
  if (!supercellGame) return null

  const fields = gatherDealFields(fullDeal)
  let email = extractSupercellEmailFromFields(fields)
  if (!email) {
    email = pickBuyerEmailFromFieldsForSupercellDeal(fields)
  }
  if (!email) {
    for (const k of ['buyerEmail', 'buyerSupercellEmail', 'contactEmail', 'email']) {
      const v = fullDeal[k]
      if (typeof v === 'string' && isEmailValid(v)) {
        email = String(v).trim()
        break
      }
    }
  }
  if (!email) {
    const deep = collectDeepScanEmailCandidates(fullDeal)
    if (deep.candidates.length > 0) {
      email = deep.candidates[0].email
    }
  }
  const trimmed = email != null ? String(email).trim() : ''
  return trimmed && isEmailValid(trimmed) ? trimmed : null
}

async function resolveBuyerSupercellEmailFromDeal({
  requestDealById,
  token,
  userAgent,
  dealId,
  categoryHint,
}) {
  const id = dealId != null ? String(dealId).trim() : ''
  if (!id || typeof requestDealById !== 'function' || !token) return null
  try {
    // БЕЗ ретрая: вызывается на front-polled /api/chat-db/messages — ретрай умножал бы
    // нагрузку на каждый поллинг и усиливал 429-шторм (регрессия v90).
    const fullDeal = await requestDealById(token, userAgent, id)
    return extractSupercellEmailFromDealObject(fullDeal, categoryHint)
  } catch (_) {
    return null
  }
}

module.exports = { resolveBuyerSupercellEmailFromDeal, extractSupercellEmailFromDealObject }
