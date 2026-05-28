function pickString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  }
  return ''
}

function isMaskedValue(value) {
  const s = String(value || '').trim()
  if (!s) return false
  return /[*•]/.test(s)
}

function fromObject(obj) {
  if (!obj || typeof obj !== 'object') return ''
  const direct = pickString(
    obj.deliveryText,
    obj.delivery,
    obj.content,
    obj.result,
    obj.activationCode,
    obj.activation_code,
    obj.giftCode,
    obj.gift_code,
    obj.cardCode,
    obj.card_code,
    obj.licenseKey,
    obj.license_key,
    obj.voucher,
    obj.voucherCode,
    obj.voucher_code,
    obj.code,
    obj.key,
    obj.secret,
    obj.password,
    obj.login,
    obj.link,
    obj.url,
    obj.message,
    obj.text,
    obj.value
  )
  if (direct && !isMaskedValue(direct)) return direct

  const pin = pickString(obj.pin, obj.pinCode, obj.pin_code)
  const serial = pickString(obj.serialNumber, obj.serial_number, obj.serial)
  const safePin = pin && !isMaskedValue(pin) ? pin : ''
  if (safePin || serial) {
    return [safePin ? `PIN: ${safePin}` : '', serial ? `SERIAL: ${serial}` : ''].filter(Boolean).join('\n')
  }
  return ''
}

function fromArray(arr) {
  if (!Array.isArray(arr)) return ''
  const parts = []
  for (const item of arr) {
    if (typeof item === 'string' && item.trim()) {
      parts.push(item.trim())
      continue
    }
    const t = fromObject(item)
    if (t) parts.push(t)
    if (item && typeof item === 'object') {
      const nested = fromArray(
        item.vouchers ||
          item.cards ||
          item.credentials ||
          item.codes ||
          item.keys ||
          item.items ||
          item.products ||
          item.page?.items ||
          item.page?.orders
      )
      if (nested) parts.push(nested)
    }
  }
  return parts.join('\n')
}

function extractApprouteDeliveryText(payload) {
  if (payload == null) return ''
  if (typeof payload === 'string') return payload.trim()
  if (Array.isArray(payload)) return fromArray(payload)

  const direct = fromObject(payload)
  if (direct) return direct

  for (const key of ['cards', 'credentials', 'vouchers', 'pins', 'serials', 'giftCards', 'gift_cards']) {
    const chunk = fromArray(payload[key])
    if (chunk) return chunk
  }

  const nestedKeys = [
    'data',
    'page',
    'order',
    'result',
    'delivery',
    'fulfillment',
    'fulfillmentData',
    'item',
    'items',
    'products',
    'codes',
    'keys',
    'orders',
    'pageItems',
    'denominations',
    'lines',
    'vouchers',
    'cards',
    'credentials',
  ]
  for (const key of nestedKeys) {
    const nested = payload[key]
    if (typeof nested === 'string' && nested.trim()) return nested.trim()
    if (Array.isArray(nested)) {
      const fromArr = fromArray(nested)
      if (fromArr) return fromArr
    }
    if (nested && typeof nested === 'object') {
      const fromObj = fromObject(nested)
      if (fromObj) return fromObj
      const fromInnerArr = fromArray(
        nested.items ||
          nested.page?.items ||
          nested.page?.orders ||
          nested.codes ||
          nested.keys ||
          nested.products ||
          nested.cards ||
          nested.credentials ||
          nested.denominations
      )
      if (fromInnerArr) return fromInnerArr
    }
  }

  const data = payload.data
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const key of ['shop', 'dtu', 'esim']) {
      const bucket = data[key]
      if (!bucket || typeof bucket !== 'object') continue
      const fromBucket = fromObject(bucket) || fromArray(bucket.items || bucket.orders || bucket.codes)
      if (fromBucket) return fromBucket
    }
  }

  return ''
}

module.exports = { extractApprouteDeliveryText }
