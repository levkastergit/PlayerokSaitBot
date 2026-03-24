async function handleAuthRegister({ payload, deps }) {
  const { db, hashPassword } = deps

  const login = (payload.login != null ? String(payload.login) : '').trim()
  const password = payload.password != null ? String(payload.password) : ''

  if (!login || !password) {
    return { statusCode: 400, data: { error: 'Login and password are required' } }
  }

  try {
    const existing = db.prepare('SELECT id FROM users WHERE login = ?').get(login)
    if (existing) {
      return { statusCode: 409, data: { error: 'Пользователь с таким логином уже существует' } }
    }

    const now = Math.floor(Date.now() / 1000)
    const passwordHash = hashPassword(password)
    const result = db
      .prepare('INSERT INTO users (login, password_hash, created_at, module_supercell) VALUES (?, ?, ?, ?)')
      .run(login, passwordHash, now, 0)

    return { statusCode: 200, data: { ok: true, userId: result.lastInsertRowid } }
  } catch (err) {
    return {
      statusCode: 500,
      data: {
        error: 'Failed to register user',
        details: err && err.message ? String(err.message) : String(err),
      },
    }
  }
}

module.exports = { handleAuthRegister }

