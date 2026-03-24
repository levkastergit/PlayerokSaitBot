async function handleAuthLogin({ payload, deps }) {
  const { createSession, db, verifyPassword } = deps

  const login = (payload.login != null ? String(payload.login) : '').trim()
  const password = payload.password != null ? String(payload.password) : ''

  if (!login || !password) {
    return { statusCode: 400, data: { error: 'Login and password are required' } }
  }

  const userRow = db.prepare('SELECT id, login, password_hash FROM users WHERE login = ?').get(login)
  if (!userRow) {
    return { statusCode: 401, data: { error: 'Неверный логин или пароль' } }
  }

  const passOk = verifyPassword(password, userRow.password_hash)

  if (!passOk) {
    return { statusCode: 401, data: { error: 'Неверный логин или пароль' } }
  }

  const sessionId = createSession(userRow.id)
  return {
    statusCode: 200,
    data: { ok: true, sessionToken: sessionId },
    setCookie: `session=${sessionId}; Path=/; HttpOnly; Max-Age=86400; SameSite=Lax`,
  }
}

module.exports = { handleAuthLogin }
