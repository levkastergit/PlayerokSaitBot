async function handleAuthChangePassword({ req, payload, deps }) {
  const {
    db,
    hashPassword,
    verifyPassword,
    getSessionIdFromRequest,
    isSessionValid,
    getSessionUserId,
    destroyUserSessions,
  } = deps

  const sessionId = getSessionIdFromRequest(req)
  if (!sessionId || !isSessionValid(sessionId)) {
    return { statusCode: 401, data: { error: 'Unauthorized' } }
  }

  const uidRaw = getSessionUserId(sessionId)
  const uid = uidRaw != null ? Number(uidRaw) : null
  if (uid == null || !Number.isFinite(uid)) {
    return { statusCode: 401, data: { error: 'Unauthorized' } }
  }

  const currentPassword = payload.currentPassword != null ? String(payload.currentPassword) : ''
  const newPassword = payload.newPassword != null ? String(payload.newPassword) : ''

  if (!currentPassword || !newPassword) {
    return { statusCode: 400, data: { error: 'Укажите текущий и новый пароль' } }
  }

  if (newPassword.length < 6) {
    return { statusCode: 400, data: { error: 'Новый пароль не короче 6 символов' } }
  }

  const userRow = db.prepare('SELECT id, password_hash FROM users WHERE id = ?').get(uid)
  if (!userRow) {
    return { statusCode: 404, data: { error: 'Учётная запись в базе не найдена' } }
  }

  const passOk = verifyPassword(currentPassword, userRow.password_hash)

  if (!passOk) {
    return { statusCode: 401, data: { error: 'Неверный текущий пароль' } }
  }

  const nextHash = hashPassword(newPassword)
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(nextHash, uid)

  // Смена пароля инвалидирует ВСЕ другие сессии этого пользователя (текущую оставляем).
  if (typeof destroyUserSessions === 'function') {
    try {
      destroyUserSessions(uid, sessionId)
    } catch (_) {}
  }

  return { statusCode: 200, data: { ok: true } }
}

module.exports = { handleAuthChangePassword }
