'use strict'

const SUPERCELL_CODE_MESSAGE_TEMPLATE =
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
}

function getSupercellGameByCategory(category) {
  return SUPERCELL_CATEGORY_TO_GAME.get(normalizeCategoryName(category)) || null
}

function formatSupercellCodeRequestedMessage(gameName) {
  return SUPERCELL_CODE_MESSAGE_TEMPLATE.replace('$game_name', gameName || 'игры')
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

function extractSupercellEmailFromFields(fields) {
  const list = Array.isArray(fields) ? fields : []
  for (const f of list) {
    const label = (f && typeof f.label === 'string' && f.label) || ''
    const value =
      f && Object.prototype.hasOwnProperty.call(f, 'value') ? f.value : null
    if (!value) continue
    const normalized = label.toLowerCase()
    if (
      normalized.includes('supercell') ||
      normalized.includes('super cell') ||
      normalized.includes('super sell') ||
      normalized === 'почта supercell id' ||
      normalized === 'supercell id'
    ) {
      return String(value).trim()
    }
  }
  return null
}

function getLatestBuyerEmailFromMessages(messages, viewerUsername) {
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
    if (extracted) return extracted
  }
  return null
}

function hasSupercellCodeRequestedMessage(messages, viewerUsername, gameName) {
  const expectedText = formatSupercellCodeRequestedMessage(gameName)
  const normalizedViewer = normalizeComparableUsername(viewerUsername)
  const list = Array.isArray(messages) ? messages : []
  return list.some((msg) => {
    const text = String(msg?.text || '').trim()
    if (text !== expectedText) return false
    const username = normalizeComparableUsername(msg?.user?.username || msg?.user?.name || '')
    if (!normalizedViewer) return true
    return !username || username === normalizedViewer
  })
}

module.exports = {
  getSupercellGameByCategory,
  formatSupercellCodeRequestedMessage,
  extractSupercellEmailFromFields,
  getLatestBuyerEmailFromMessages,
  hasSupercellCodeRequestedMessage,
  isEmailValid,
}

