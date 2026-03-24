async function handleAuthLogout({ req, deps, res }) {
  const { getSessionIdFromRequest, destroySession } = deps

  const sessionId = getSessionIdFromRequest(req)
  destroySession(sessionId)

  // В исходном коде cookie сбрасывался явно через Set-Cookie.
  return {
    statusCode: 200,
    data: { ok: true },
    setCookie: 'session=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax',
  }
}

module.exports = { handleAuthLogout }

