function setupAutolistBackgroundJob({
  postLocal,
  getAllStoredTokens,
  loadStoredTokenPlain,
  getUserAgent,
  intervalMs = 15000,
}) {
  // Важно: не допускаем наложения вызовов, иначе легко ловим rate limit Playerok.
  let autolistInFlight = false

  setInterval(async () => {
    if (autolistInFlight) return
    try {
      autolistInFlight = true
      const rows = getAllStoredTokens.all()
      if (!Array.isArray(rows) || rows.length === 0) return

      for (const row of rows) {
        const userId = Number(row?.user_id)
        if (!Number.isFinite(userId) || userId <= 0) continue

        const stored = loadStoredTokenPlain(userId)
        if (!stored || !stored.token) continue

        await postLocal('/api/playerok/autolist-tick', {
          userId,
          token: stored.token,
          userAgent: getUserAgent(),
        })
      }
    } catch (_) {
      /* ignore */
    } finally {
      autolistInFlight = false
    }
  }, intervalMs)
}

module.exports = { setupAutolistBackgroundJob }

