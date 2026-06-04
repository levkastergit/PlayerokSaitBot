'use strict'

const DEFAULT_SUPERCELL_CODE_MESSAGE_TEMPLATE =
  'Запросил код на вашу почту для $game_name, скиньте его пожалуйста сюда в чат, как придет'

const SUPERCELL_EMAIL_CANDIDATE_REGEX =
  /([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[^\s<>"'`]+)/i

const SUPERCELL_CATEGORY_TO_GAME = new Map([
  ['brawl stars', { gameKey: 'laser', gameName: 'Brawl Stars' }],
  ['brawlstars', { gameKey: 'laser', gameName: 'Brawl Stars' }],
  ['бравл старс', { gameKey: 'laser', gameName: 'Brawl Stars' }],
  ['бравл старк', { gameKey: 'laser', gameName: 'Brawl Stars' }],
  ['clash royale', { gameKey: 'scroll', gameName: 'Clash Royale' }],
  ['clashroyale', { gameKey: 'scroll', gameName: 'Clash Royale' }],
  ['клеш рояль', { gameKey: 'scroll', gameName: 'Clash Royale' }],
  ['clash of clans', { gameKey: 'magic', gameName: 'Clash of Clans' }],
  ['clashofclans', { gameKey: 'magic', gameName: 'Clash of Clans' }],
  ['клеш оф кланс', { gameKey: 'magic', gameName: 'Clash of Clans' }],
  ['клеш оф кленс', { gameKey: 'magic', gameName: 'Clash of Clans' }],
])

function normalizeCategoryName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/ё/g, 'е')
}

function getSupercellGameByCategory(category) {
  return SUPERCELL_CATEGORY_TO_GAME.get(normalizeCategoryName(category)) || null
}

/** Раздел PlayerOK «Суперселл»: в item.game приходит он, а не Brawl/Clash. */
function isSuperSellMarketplaceLabel(name) {
  const n = normalizeCategoryName(name)
  if (!n) return false
  const markers = [
    'super sell',
    'supersell',
    'super-sell',
    'суперселл',
    'супер селл',
    'супер-селл',
  ]
  return markers.some((m) => n === m || n.includes(m))
}

const SUPERCELL_TITLE_PATTERNS = [
  { re: /brawl\s*stars|brawlstars|бравл\s*стар/i, key: 'brawl stars' },
  { re: /clash\s*royale|clashroyale|клеш\s*роял|клеш\s*рояль/i, key: 'clash royale' },
  {
    re: /clash\s*of\s*clans|clashofclans|\bcoc\b|клеш\s*оф\s*клан|клеш\s*кланс|клеш\s*кленс/i,
    key: 'clash of clans',
  },
]

/**
 * Выбирает строку категории для getSupercellGameByCategory: при обёртке «Суперселл»
 * сначала дочерняя категория / productKey / название лота.
 */
function pickSupercellCategoryFromItemHints({ gameName, categoryName, productKeyGamePart, itemTitle }) {
  const g = String(gameName || '').trim()
  const c = String(categoryName || '').trim()
  const pk = String(productKeyGamePart || '').trim()
  const candidates = []

  if (g && isSuperSellMarketplaceLabel(g)) {
    if (c) candidates.push(c)
    if (pk && !isSuperSellMarketplaceLabel(pk)) candidates.push(pk)
    candidates.push(g)
  } else {
    if (g) candidates.push(g)
    if (c) candidates.push(c)
    if (pk) candidates.push(pk)
  }

  for (const cand of candidates) {
    if (getSupercellGameByCategory(cand)) return cand
  }

  const title = String(itemTitle || '').trim()
  if (title) {
    for (const { re, key } of SUPERCELL_TITLE_PATTERNS) {
      if (re.test(title) && getSupercellGameByCategory(key)) return key
    }
  }

  return g || c || pk || ''
}

function pickSupercellCategoryFromDeal(fullDeal) {
  if (!fullDeal || typeof fullDeal !== 'object') return ''
  const item = fullDeal.item && typeof fullDeal.item === 'object' ? fullDeal.item : null
  const gameName = item?.game ? String(item.game.name || item.game.title || '').trim() : ''
  const categoryName = item?.category ? String(item.category.name || item.category.title || '').trim() : ''
  let productKeyGamePart = ''
  if (typeof fullDeal.productKey === 'string') {
    const i = fullDeal.productKey.indexOf('::')
    if (i > 0) productKeyGamePart = fullDeal.productKey.slice(0, i).trim()
  }
  const itemTitle =
    (item && (item.title || item.name)) ||
    fullDeal.productTitle ||
    ''
  const fromHints = pickSupercellCategoryFromItemHints({ gameName, categoryName, productKeyGamePart, itemTitle })
  if (fromHints) return fromHints
  const dealCat = typeof fullDeal.category === 'string' ? fullDeal.category.trim() : ''
  return dealCat || ''
}

function getSupercellCodeMessageTemplate(settings) {
  const raw = settings?.supercellAutoRequestCode?.requestCodeMessage
  const trimmed = typeof raw === 'string' ? raw.trim() : ''
  return trimmed || DEFAULT_SUPERCELL_CODE_MESSAGE_TEMPLATE
}

function formatSupercellCodeRequestedMessage(gameName, template) {
  const tpl =
    typeof template === 'string' && template.trim()
      ? template.trim()
      : DEFAULT_SUPERCELL_CODE_MESSAGE_TEMPLATE
  return tpl.replace(/\$game_name/g, gameName || 'игры')
}

function normalizeComparableUsername(value) {
  return String(value || '').trim().toLowerCase()
}

function isEmailValid(email) {
  const value = String(email || '').trim()
  if (!value) return false
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
}

function extractEmailFromText(text) {
  const value = String(text || '').trim()
  if (!value) return null
  const match = value.match(SUPERCELL_EMAIL_CANDIDATE_REGEX)
  if (!match || !match[1]) return null
  return String(match[1])
    .trim()
    .replace(/^[<("'`\[{]+/, '')
    .replace(/[>"')`\]},!?;:]+$/, '')
}

const FIELD_LABEL_KEYS = [
  'label',
  'title',
  'name',
  'placeholder',
  'fieldLabel',
  'key',
  'slug',
  'fieldKey',
  'code',
  'hint',
]

function mergeFieldLabelStrings(node, labelParts) {
  if (!node || typeof node !== 'object') return
  for (const k of FIELD_LABEL_KEYS) {
    if (typeof node[k] === 'string' && node[k].trim()) labelParts.push(node[k].trim())
  }
}

function buildFieldLabelNormalized(f) {
  if (!f || typeof f !== 'object') return ''
  const labelParts = []
  mergeFieldLabelStrings(f, labelParts)
  // PlayerOK часто кладёт подпись вложенного поля в node.field / obtainingField.
  mergeFieldLabelStrings(f.field, labelParts)
  mergeFieldLabelStrings(f.obtainingField, labelParts)
  mergeFieldLabelStrings(f.dataField, labelParts)
  return labelParts.join(' ').toLowerCase().replace(/ё/g, 'е')
}

function primitiveAsTrimmedString(v) {
  if (v == null) return null
  if (typeof v === 'string') {
    const t = v.trim()
    return t || null
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v).trim() || null
  return null
}

function fieldStringValueInner(f, depth) {
  if (!f || typeof f !== 'object' || depth > 3) return null
  // Важно: «text» / «content» часто подсказка поля; ответ покупателя — в value / enteredValue.
  const directKeys = [
    'value',
    'answer',
    'enteredValue',
    'userValue',
    'displayValue',
    'stringValue',
    'input',
    'raw',
    'response',
    'text',
    'content',
  ]
  for (const k of directKeys) {
    if (!Object.prototype.hasOwnProperty.call(f, k)) continue
    const raw = f[k]
    const s = primitiveAsTrimmedString(raw)
    if (s) return s
    if (raw && typeof raw === 'object') {
      if (typeof raw.text === 'string' && raw.text.trim()) return raw.text.trim()
      if (typeof raw.value === 'string' && raw.value.trim()) return raw.value.trim()
      if (typeof raw.answer === 'string' && raw.answer.trim()) return raw.answer.trim()
    }
  }
  if (f.data && typeof f.data === 'object') {
    for (const k of ['value', 'text', 'answer', 'content']) {
      const s = primitiveAsTrimmedString(f.data[k])
      if (s) return s
    }
  }
  for (const nk of ['field', 'obtainingField', 'dataField']) {
    if (f[nk] && typeof f[nk] === 'object') {
      const nested = fieldStringValueInner(f[nk], depth + 1)
      if (nested) return nested
    }
  }
  return null
}

function fieldStringValue(f) {
  return fieldStringValueInner(f, 0)
}

function extractSupercellEmailFromFields(fields) {
  const list = Array.isArray(fields) ? fields : []
  for (const f of list) {
    if (!f || typeof f !== 'object') continue
    const normalized = buildFieldLabelNormalized(f)
    const value = fieldStringValue(f)
    if (!value) continue
    if (
      normalized.includes('supercell') ||
      normalized.includes('super cell') ||
      normalized.includes('super sell') ||
      normalized.includes('суперселл') ||
      normalized.includes('супер селл') ||
      normalized.includes('супер-селл') ||
      normalized.includes('supercell id') ||
      normalized === 'почта supercell id' ||
      normalized === 'supercell id'
    ) {
      return value
    }
  }
  return null
}

/**
 * Если в подписи поля нет «supercell», но сделка точно Supercell (Brawl/Clash),
 * ищем валидный email среди ответов покупателя (часто одно текстовое поле).
 */
const DEEP_SCAN_PATH_HINTS_POS = [
  'buyer',
  'покуп',
  'obtain',
  'получ',
  'datafield',
  'supercell',
  'почт',
  'mail',
  'email',
  'contact',
  'answer',
  'value',
  'entered',
  'response',
  'field',
  'form',
  'input',
  'custom',
  'order',
  'deal',
  'item',
]
const DEEP_SCAN_PATH_HINTS_NEG = ['seller', 'продав', 'support', 'system', 'notif', 'template', 'image', 'url', 'avatar']

function scoreKeyPathForBuyerEmail(pathLower) {
  let s = 0
  for (const h of DEEP_SCAN_PATH_HINTS_POS) {
    if (pathLower.includes(h)) s += 3
  }
  for (const h of DEEP_SCAN_PATH_HINTS_NEG) {
    if (pathLower.includes(h)) s -= 6
  }
  return s
}

function isLikelyBuyerEmailNotPlatform(email) {
  const lower = String(email || '').trim().toLowerCase()
  if (!lower.includes('@')) return false
  const domain = lower.slice(lower.lastIndexOf('@') + 1)
  if (!domain) return false
  if (domain === 'playerok.com' || domain.endsWith('.playerok.com')) return false
  if (domain === 'playerok.ru' || domain.endsWith('.playerok.ru')) return false
  if (/^no-?reply\.|^bounce\.|^mailer-daemon/i.test(domain)) return false
  return true
}

/**
 * Persisted GraphQL «deal» / «chat» иногда кладёт ответы покупателя в нестандартные ветки.
 * Обходим JSON с ограничением глубины и выбираем email с лучшим скором по пути ключей.
 */
function collectDeepScanEmailCandidates(root, opts = {}) {
  const out = { candidates: [], visitedNodes: 0, truncatedByNodes: false, truncatedByDepth: false }
  if (root == null || typeof root !== 'object') return out
  const maxDepth = typeof opts.maxDepth === 'number' ? opts.maxDepth : 12
  const maxNodes = typeof opts.maxNodes === 'number' ? opts.maxNodes : 2500
  let visited = 0
  const scored = []

  function visit(node, depth, pathSegs) {
    if (visited >= maxNodes) {
      out.truncatedByNodes = true
      return
    }
    if (depth > maxDepth) {
      out.truncatedByDepth = true
      return
    }
    visited += 1
    if (node == null) return
    const pathStr = pathSegs.length ? pathSegs.join('.') : '(root)'
    const pathLower = pathStr.toLowerCase()

    if (typeof node === 'string') {
      const t = node.trim()
      if (!t) return
      let email = null
      if (isEmailValid(t)) email = t
      else {
        const ex = extractEmailFromText(t)
        if (ex && isEmailValid(ex)) email = ex
      }
      if (email && isLikelyBuyerEmailNotPlatform(email)) {
        scored.push({
          email,
          score: scoreKeyPathForBuyerEmail(pathLower),
          path: pathStr,
        })
      }
      return
    }
    if (typeof node !== 'object') return

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        visit(node[i], depth + 1, pathSegs)
      }
      return
    }
    for (const k of Object.keys(node)) {
      if (k === '__typename') continue
      visit(node[k], depth + 1, [...pathSegs, k])
    }
  }

  visit(root, 0, [])
  out.visitedNodes = visited
  scored.sort((a, b) => b.score - a.score || b.email.length - a.email.length)
  out.candidates = scored
  return out
}

function pickBuyerEmailFromDeepGraphqlScan(root, opts = {}) {
  const { candidates } = collectDeepScanEmailCandidates(root, opts)
  if (!candidates.length) return null
  return candidates[0].email
}

function pickBuyerEmailFromFieldsForSupercellDeal(fields) {
  const list = Array.isArray(fields) ? fields : []
  const candidates = []
  for (const f of list) {
    if (!f || typeof f !== 'object') continue
    let value = fieldStringValue(f)
    if (value && !isEmailValid(value)) {
      const extracted = extractEmailFromText(value)
      if (extracted) value = extracted
    }
    if (!value || !isEmailValid(value)) continue
    candidates.push({ value, normalized: buildFieldLabelNormalized(f) })
  }
  if (candidates.length === 0) return null

  const prefers = (n) =>
    n.includes('почт') ||
    n.includes('mail') ||
    n.includes('email') ||
    n.includes('e-mail') ||
    n.includes('электронн') ||
    n.includes('supercell') ||
    n.includes('суперселл') ||
    n.includes('логин') ||
    n.includes('login') ||
    n.includes('аккаунт')

  const preferred = candidates.filter((c) => prefers(c.normalized))
  if (preferred.length >= 1) return preferred[0].value
  return candidates[0].value
}

function getLatestBuyerEmailFromMessages(messages, viewerUsername, buyerUsername = null) {
  const normalizedViewer = normalizeComparableUsername(viewerUsername)
  const normalizedBuyer = normalizeComparableUsername(buyerUsername)
  const list = Array.isArray(messages)
    ? [...messages].sort((a, b) => {
        const ta = a?.createdAt ? new Date(a.createdAt).getTime() : 0
        const tb = b?.createdAt ? new Date(b.createdAt).getTime() : 0
        return ta - tb
      })
    : []

  for (let i = list.length - 1; i >= 0; i -= 1) {
    const msg = list[i]
    const username = normalizeComparableUsername(msg?.user?.username || msg?.user?.name || '')
    if (normalizedViewer && username && username === normalizedViewer) continue
    if (normalizedBuyer) {
      if (!username || username !== normalizedBuyer) continue
    }
    const extracted = extractEmailFromText(msg?.text || '')
    if (extracted) return extracted
  }
  if (normalizedBuyer) {
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const msg = list[i]
      const username = normalizeComparableUsername(msg?.user?.username || msg?.user?.name || '')
      if (normalizedViewer && username && username === normalizedViewer) continue
      if (username) continue
      const extracted = extractEmailFromText(msg?.text || '')
      if (extracted) return extracted
    }
  }
  return null
}

/** Если ник покупателя в API не совпал с автором сообщения, но в чате есть email любого не-продавца. */
function getLatestPlausibleEmailFromNonViewerMessages(messages, viewerUsername) {
  const normalizedViewer = normalizeComparableUsername(viewerUsername)
  const list = Array.isArray(messages)
    ? [...messages].sort((a, b) => {
        const ta = a?.createdAt ? new Date(a.createdAt).getTime() : 0
        const tb = b?.createdAt ? new Date(b.createdAt).getTime() : 0
        return ta - tb
      })
    : []

  for (let i = list.length - 1; i >= 0; i -= 1) {
    const msg = list[i]
    const username = normalizeComparableUsername(msg?.user?.username || msg?.user?.name || '')
    if (normalizedViewer && username && username === normalizedViewer) continue
    const extracted = extractEmailFromText(msg?.text || '')
    if (extracted && isEmailValid(extracted) && isLikelyBuyerEmailNotPlatform(extracted)) return extracted
  }
  return null
}

const ITEM_PAID_MARKER = '{{ITEM_PAID}}'

function messageDealId(msg) {
  if (!msg || typeof msg !== 'object') return ''
  if (msg.dealId != null) return String(msg.dealId).trim()
  if (msg.deal && msg.deal.id != null) return String(msg.deal.id).trim()
  return ''
}

/**
 * Ограничивает историю текущей сделкой (повторные покупки в одном чате).
 * Сначала якорь {{ITEM_PAID}} для dealId, иначе сообщения с тем же dealId.
 */
function scopeMessagesToDeal(messages, dealId) {
  const list = Array.isArray(messages) ? messages : []
  const wantDeal = dealId != null ? String(dealId).trim() : ''
  if (!wantDeal) return list

  const sorted = [...list].sort((a, b) => {
    const ta = a?.createdAt ? new Date(a.createdAt).getTime() : 0
    const tb = b?.createdAt ? new Date(b.createdAt).getTime() : 0
    return ta - tb
  })

  let paidAnchorIndex = -1
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const m = sorted[i]
    if (!String(m?.text || '').includes(ITEM_PAID_MARKER)) continue
    if (messageDealId(m) === wantDeal) {
      paidAnchorIndex = i
      break
    }
  }
  if (paidAnchorIndex < 0) {
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      const m = sorted[i]
      if (!String(m?.text || '').includes(ITEM_PAID_MARKER)) continue
      if (messageDealId(m)) continue
      paidAnchorIndex = i
      break
    }
  }
  if (paidAnchorIndex >= 0) return sorted.slice(paidAnchorIndex)

  const filtered = sorted.filter((m) => {
    const mid = messageDealId(m)
    return !mid || mid === wantDeal
  })
  return filtered.length > 0 ? filtered : list
}

function isSupercellDebugEnabled() {
  const v = String(process.env.PLAYEROK_SUPERCELL_DEBUG || '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

function logSupercellDebug(label, payload) {
  if (!isSupercellDebugEnabled()) return
  const ts = new Date().toISOString()
  if (payload !== undefined) {
    console.log(`[PLAYEROK_SUPERCELL_DEBUG] ${ts} ${label}`, payload)
  } else {
    console.log(`[PLAYEROK_SUPERCELL_DEBUG] ${ts} ${label}`)
  }
}

/**
 * Самый свежий dealId в чате: сначала по маркеру оплаты, иначе по createdAt сообщения.
 * Нужен при нескольких сделках с одним покупателем в одном чате.
 */
function pickLatestDealIdFromMessages(messages) {
  const list = Array.isArray(messages) ? messages : []
  if (list.length === 0) return null

  const sorted = [...list].sort((a, b) => {
    const ta = a?.createdAt ? new Date(a.createdAt).getTime() : 0
    const tb = b?.createdAt ? new Date(b.createdAt).getTime() : 0
    return ta - tb
  })

  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const m = sorted[i]
    const id =
      m?.dealId != null
        ? String(m.dealId).trim()
        : m?.deal?.id != null
          ? String(m.deal.id).trim()
          : ''
    if (!id) continue
    if (String(m?.text || '').includes(ITEM_PAID_MARKER)) return id
  }

  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const m = sorted[i]
    const id =
      m?.dealId != null
        ? String(m.dealId).trim()
        : m?.deal?.id != null
          ? String(m.deal.id).trim()
          : ''
    if (id) return id
  }

  return null
}

function dealIdAppearsInMessages(messages, dealId) {
  const want = dealId != null ? String(dealId).trim() : ''
  if (!want) return false
  const list = Array.isArray(messages) ? messages : []
  for (const m of list) {
    if (messageDealId(m) === want) return true
  }
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i]
    if (messageDealId(m) !== want) continue
    if (String(m?.text || '').includes(ITEM_PAID_MARKER)) return true
  }
  return false
}

/**
 * dealId из списка чатов может указывать на старую сделку без следов в истории —
 * тогда берём самую свежую из сообщений. Если по запрошенной сделке есть история,
 * не подменять на другую (несколько покупок в одном чате).
 */
function resolveEffectiveDealIdForChat({ dealIdFromRequest, messages }) {
  const requested = dealIdFromRequest != null ? String(dealIdFromRequest).trim() : ''
  const fromMessages = pickLatestDealIdFromMessages(messages)
  if (!requested) return fromMessages || null
  if (!fromMessages) return requested
  if (requested === fromMessages) return requested
  if (dealIdAppearsInMessages(messages, requested)) return requested
  return fromMessages
}

function hasSupercellCodeRequestedMessage(
  messages,
  viewerUsername,
  gameName,
  dealId = null,
  messageTemplate = null
) {
  const expectedText = formatSupercellCodeRequestedMessage(gameName, messageTemplate)
  const normalizedViewer = normalizeComparableUsername(viewerUsername)
  const list = scopeMessagesToDeal(messages, dealId)
  return list.some((msg) => {
    const text = String(msg?.text || '').trim()
    if (text !== expectedText) return false
    const username = normalizeComparableUsername(msg?.user?.username || msg?.user?.name || '')
    if (!normalizedViewer) return true
    return !username || username === normalizedViewer
  })
}

function isSupercellAutoRequestCodeEnabled(settings) {
  if (!settings || typeof settings !== 'object') return true
  const cfg = settings.supercellAutoRequestCode
  if (!cfg || typeof cfg !== 'object') return true
  return Boolean(cfg.enabled)
}

module.exports = {
  DEFAULT_SUPERCELL_CODE_MESSAGE_TEMPLATE,
  isSupercellAutoRequestCodeEnabled,
  getSupercellCodeMessageTemplate,
  getSupercellGameByCategory,
  formatSupercellCodeRequestedMessage,
  extractSupercellEmailFromFields,
  pickBuyerEmailFromFieldsForSupercellDeal,
  pickBuyerEmailFromDeepGraphqlScan,
  collectDeepScanEmailCandidates,
  getLatestBuyerEmailFromMessages,
  getLatestPlausibleEmailFromNonViewerMessages,
  hasSupercellCodeRequestedMessage,
  isEmailValid,
  isLikelyBuyerEmailNotPlatform,
  isSuperSellMarketplaceLabel,
  pickSupercellCategoryFromItemHints,
  pickSupercellCategoryFromDeal,
  pickLatestDealIdFromMessages,
  dealIdAppearsInMessages,
  resolveEffectiveDealIdForChat,
  scopeMessagesToDeal,
  messageDealId,
  isSupercellDebugEnabled,
  logSupercellDebug,
}

