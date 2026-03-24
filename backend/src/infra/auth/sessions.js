const crypto = require('crypto')

const SESSION_TTL_MS = 24 * 60 * 60 * 1000 // 24 часа
// sessionId -> { userId, expiresAt }
const sessions = new Map()

function getSessionIdFromRequest(req) {
  const cookie = req.headers.cookie || ''
  const match = cookie.match(/\bsession=([a-f0-9]+)/i)
  if (match) return match[1]

  const auth = req.headers.authorization || ''
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim()
  return null
}

function isSessionValid(sessionId) {
  if (!sessionId) return false
  const s = sessions.get(sessionId)
  if (!s || Date.now() > s.expiresAt) {
    if (s) sessions.delete(sessionId)
    return false
  }
  return true
}

function getSessionUserId(sessionId) {
  if (!sessionId) return null
  const s = sessions.get(sessionId)
  if (!s || Date.now() > s.expiresAt) return null
  return s.userId || null
}

function createSession(userId) {
  const sessionId = crypto.randomBytes(32).toString('hex')
  sessions.set(sessionId, { userId, expiresAt: Date.now() + SESSION_TTL_MS })
  return sessionId
}

function destroySession(sessionId) {
  if (sessionId) sessions.delete(sessionId)
}

module.exports = {
  getSessionIdFromRequest,
  isSessionValid,
  getSessionUserId,
  createSession,
  destroySession,
}

