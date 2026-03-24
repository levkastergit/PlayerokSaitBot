function normalizeUserId(uid) {
  if (uid == null) return null
  const n = Number(uid)
  return Number.isFinite(n) ? n : uid
}

async function handleAuthMe({ req, deps }) {
  const { db, getSessionIdFromRequest, isSessionValid, getSessionUserId } = deps

  const sessionId = getSessionIdFromRequest(req)
  const sessionValid = Boolean(sessionId && isSessionValid(sessionId))
  const sessionUidRaw = sessionValid ? getSessionUserId(sessionId) : null
  const sessionUid = normalizeUserId(sessionUidRaw)

  if (!sessionValid || sessionUid == null) {
    return { statusCode: 401, data: { error: 'Unauthorized' } }
  }

  const row = db.prepare('SELECT login, module_supercell FROM users WHERE id = ?').get(sessionUid)
  const login =
    row && row.login != null ? String(row.login).trim() || null : null
  const moduleSupercell = row ? Number(row.module_supercell || 0) === 1 : true

  return {
    statusCode: 200,
    data: {
      ok: true,
      userId: sessionUid,
      login,
      moduleSupercell,
    },
  }
}

module.exports = { handleAuthMe }
