'use strict'

// ---------------------------------------------------------------------------
// Каталог номиналов Robux для автовыдачи через Swizzyer (rbcode.net).
//
// Каждый номинал раскрывается в массив items[] вида
//   { product_id, sku_id, availability_id, quantity, product_name }
// — ровно то, что требует POST /v1/orders. Идентификаторы пакетов Microsoft
// Store сняты из официальной документации Swizzyer (файл `swizzer` в корне).
//
// Стандартные одиночные SKU (80 / 500 / 1000 / 2000) комбинируются, чтобы
// набрать «готовые наборы» (240, 1740, 4500 …). Premium-пакеты (450 / 1000 /
// 2200 + Premium) дают месяц Roblox Premium плюс робуксы; Premium начисляется
// один раз на заказ, поэтому в премиум-наборах ровно один premium-SKU.
//
// id номинала стабилен (хранится в настройках лота): `r<robux>` для
// стандартных, `r<robux>p` для премиум. Менять id нельзя — сломает лоты.
// ---------------------------------------------------------------------------

// Базовые SKU Microsoft Store (cost-basis цены из доки).
const SKU = {
  R80:   { product_id: '9NH6SMMZQHM9', sku_id: '0010', availability_id: '9VH3WJX9DHDB', robux: 80,   priceUsd: 0.99,  name: '80 R$' },
  R500:  { product_id: '9PH0VHQ4CNFF', sku_id: '0010', availability_id: '9XL2GVHJGV0Z', robux: 500,  priceUsd: 4.99,  name: '500 R$' },
  R1000: { product_id: '9NRQLWSN0K89', sku_id: '0010', availability_id: '9VZ9ZH7Z8GBZ', robux: 1000, priceUsd: 9.99,  name: '1000 R$' },
  R2000: { product_id: '9NH22L8775FQ', sku_id: '0010', availability_id: '9XD28K6ZW97V', robux: 2000, priceUsd: 19.99, name: '2000 R$' },
  // Premium-пакеты (Roblox Premium на 1 месяц + робуксы).
  P450:  { product_id: '9NT8XD0WZ4JT', sku_id: '0010', availability_id: 'B3DC4QQRM2PJ', robux: 450,  priceUsd: 4.99,  name: '450 R$ + Premium',  premium: true },
  P1000: { product_id: '9PJSPHF65QVG', sku_id: '0010', availability_id: '9PXTFMW31KG0', robux: 1000, priceUsd: 9.99,  name: '1000 R$ + Premium', premium: true },
  P2200: { product_id: '9PJKVXL2N2LZ', sku_id: '0010', availability_id: '9SBR9RH761MB', robux: 2200, priceUsd: 19.99, name: '2200 R$ + Premium', premium: true },
}

// Состав каждого номинала: [ключ SKU, количество].
const DEFS = [
  // --- Стандартные одиночные ---
  { id: 'r80',    group: 'standard', parts: [['R80', 1]] },
  { id: 'r500',   group: 'standard', parts: [['R500', 1]] },
  { id: 'r1000',  group: 'standard', parts: [['R1000', 1]] },
  { id: 'r2000',  group: 'standard', parts: [['R2000', 1]] },
  // --- Готовые наборы из стандартных SKU ---
  { id: 'r160',   group: 'standard', parts: [['R80', 2]] },
  { id: 'r240',   group: 'standard', parts: [['R80', 3]] },
  { id: 'r320',   group: 'standard', parts: [['R80', 4]] },
  { id: 'r660',   group: 'standard', parts: [['R500', 1], ['R80', 2]] },
  { id: 'r740',   group: 'standard', parts: [['R500', 1], ['R80', 3]] },
  { id: 'r820',   group: 'standard', parts: [['R500', 1], ['R80', 4]] },
  { id: 'r1240',  group: 'standard', parts: [['R1000', 1], ['R80', 3]] },
  { id: 'r1660',  group: 'standard', parts: [['R1000', 1], ['R500', 1], ['R80', 2]] },
  { id: 'r1740',  group: 'standard', parts: [['R1000', 1], ['R500', 1], ['R80', 3]] },
  { id: 'r2500',  group: 'standard', parts: [['R2000', 1], ['R500', 1]] },
  { id: 'r2740',  group: 'standard', parts: [['R2000', 1], ['R500', 1], ['R80', 3]] },
  { id: 'r3240',  group: 'standard', parts: [['R2000', 1], ['R1000', 1], ['R80', 3]] },
  { id: 'r3660',  group: 'standard', parts: [['R2000', 1], ['R1000', 1], ['R500', 1], ['R80', 2]] },
  { id: 'r4000',  group: 'standard', parts: [['R2000', 2]] },
  { id: 'r4500',  group: 'standard', parts: [['R2000', 2], ['R500', 1]] },
  { id: 'r5000',  group: 'standard', parts: [['R2000', 2], ['R1000', 1]] },
  { id: 'r6000',  group: 'standard', parts: [['R2000', 3]] },
  { id: 'r7000',  group: 'standard', parts: [['R2000', 3], ['R1000', 1]] },
  { id: 'r10000', group: 'standard', parts: [['R2000', 5]] },
  { id: 'r13000', group: 'standard', parts: [['R2000', 6], ['R1000', 1]] },
  { id: 'r22500', group: 'standard', parts: [['R2000', 11], ['R500', 1]] },
  // --- Premium одиночные ---
  { id: 'r450p',   group: 'premium', parts: [['P450', 1]] },
  { id: 'r1000p',  group: 'premium', parts: [['P1000', 1]] },
  { id: 'r2200p',  group: 'premium', parts: [['P2200', 1]] },
  // --- Premium-наборы (один P2200 + стандартные) ---
  { id: 'r2700p',  group: 'premium', parts: [['P2200', 1], ['R500', 1]] },
  { id: 'r3200p',  group: 'premium', parts: [['P2200', 1], ['R1000', 1]] },
  { id: 'r4200p',  group: 'premium', parts: [['P2200', 1], ['R2000', 1]] },
  { id: 'r5200p',  group: 'premium', parts: [['P2200', 1], ['R2000', 1], ['R1000', 1]] },
  { id: 'r6200p',  group: 'premium', parts: [['P2200', 1], ['R2000', 2]] },
  { id: 'r8200p',  group: 'premium', parts: [['P2200', 1], ['R2000', 3]] },
  { id: 'r12200p', group: 'premium', parts: [['P2200', 1], ['R2000', 5]] },
]

function round2(n) {
  return Math.round(Number(n) * 100) / 100
}

function buildEntry(def) {
  const parts = def.parts.map(([key, qty]) => {
    const sku = SKU[key]
    if (!sku) throw new Error(`swizzyerCatalog: unknown SKU ${key} in ${def.id}`)
    return { sku, qty: Math.max(1, Math.floor(qty)) }
  })
  const robux = parts.reduce((sum, p) => sum + p.sku.robux * p.qty, 0)
  const priceUsd = round2(parts.reduce((sum, p) => sum + p.sku.priceUsd * p.qty, 0))
  const premium = parts.some((p) => p.sku.premium)
  const items = parts.map((p) => ({
    product_id: p.sku.product_id,
    sku_id: p.sku.sku_id,
    availability_id: p.sku.availability_id,
    quantity: p.qty,
    product_name: p.sku.name,
  }))
  const label = premium ? `${robux} R$ + Premium` : `${robux} R$`
  return { id: def.id, group: def.group, robux, premium, priceUsd, label, items }
}

const DENOMINATIONS = DEFS.map(buildEntry)
const BY_ID = new Map(DENOMINATIONS.map((d) => [d.id, d]))

function cloneItems(items) {
  return items.map((i) => ({ ...i }))
}

function cloneEntry(d) {
  return { ...d, items: cloneItems(d.items) }
}

/** Полный список номиналов для выпадающего списка лота (стандарт сначала, по возрастанию робуксов). */
function listSwizzyerDenominations() {
  const order = { standard: 0, premium: 1 }
  return DENOMINATIONS.slice()
    .sort((a, b) => (order[a.group] - order[b.group]) || (a.robux - b.robux))
    .map(cloneEntry)
}

/** Номинал по id (или null). Возвращает копию — мутации вызывающего не портят каталог. */
function getSwizzyerDenomination(id) {
  const d = BY_ID.get(String(id == null ? '' : id).trim())
  return d ? cloneEntry(d) : null
}

/** items[] для POST /v1/orders по id номинала (или null, если id неизвестен). */
function getSwizzyerItems(id) {
  const d = BY_ID.get(String(id == null ? '' : id).trim())
  return d ? cloneItems(d.items) : null
}

module.exports = {
  listSwizzyerDenominations,
  getSwizzyerDenomination,
  getSwizzyerItems,
}
