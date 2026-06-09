const crypto = require('crypto')

const SESSION_TTL_MS = 24 * 60 * 60 * 1000 // 24 часа

// Сессии хранятся в SQLite (таблица sessions), чтобы переживать перезапуск
// контейнера/процесса и не разлогинивать пользователя при деплое.
// До вызова initSessions(db) (или если БД недоступна) — fallback в память.
let db = null
let stmts = null
// sessionId -> { userId, expiresAt }
const memorySessions = new Map()

function initSessions(database) {
  db = database
  stmts = {
    insert: db.prepare(
      'INSERT OR REPLACE INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)'
    ),
    get: db.prepare('SELECT user_id AS userId, expires_at AS expiresAt FROM sessions WHERE id = ?'),
    delete: db.prepare('DELETE FROM sessions WHERE id = ?'),
    pruneExpired: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
  }
  // Чистим протухшие сессии на старте.
  try {
    stmts.pruneExpired.run(Date.now())
  } catch (_) {}
}

function getSessionIdFromRequest(req) {
  const cookie = req.headers.cookie || ''
  const match = cookie.match(/\bsession=([a-f0-9]+)/i)
  if (match) return match[1]

  const auth = req.headers.authorization || ''
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim()
  return null
}

function readSession(sessionId) {
  if (stmts) {
    const row = stmts.get.get(sessionId)
    return row || null
  }
  return memorySessions.get(sessionId) || null
}

function isSessionValid(sessionId) {
  if (!sessionId) return false
  const s = readSession(sessionId)
  if (!s || Date.now() > s.expiresAt) {
    if (s) destroySession(sessionId)
    return false
  }
  return true
}

function getSessionUserId(sessionId) {
  if (!sessionId) return null
  const s = readSession(sessionId)
  if (!s || Date.now() > s.expiresAt) return null
  return s.userId || null
}

function createSession(userId) {
  const sessionId = crypto.randomBytes(32).toString('hex')
  const expiresAt = Date.now() + SESSION_TTL_MS
  if (stmts) {
    stmts.insert.run(sessionId, userId, expiresAt)
  } else {
    memorySessions.set(sessionId, { userId, expiresAt })
  }
  return sessionId
}

function destroySession(sessionId) {
  if (!sessionId) return
  if (stmts) {
    stmts.delete.run(sessionId)
  } else {
    memorySessions.delete(sessionId)
  }
}

module.exports = {
  initSessions,
  getSessionIdFromRequest,
  isSessionValid,
  getSessionUserId,
  createSession,
  destroySession,
}
