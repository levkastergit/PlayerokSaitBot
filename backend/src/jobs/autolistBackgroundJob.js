function setupAutolistBackgroundJob({
  postLocal,
  getAllStoredTokens,
  loadStoredTokenPlain,
  isSupercellModuleEnabled,
  getUserAgent,
  intervalMs = 15000,
}) {
  // Важно: не допускаем наложения вызовов, иначе легко ловим rate limit Playerok.
  let autolistInFlight = false

  console.log('[autolist] фоновое задание запланировано (интервал: 15 с)')
  setInterval(async () => {
    if (autolistInFlight) return
    try {
      autolistInFlight = true
      const rows = getAllStoredTokens.all()
      if (!Array.isArray(rows) || rows.length === 0) return

      for (const row of rows) {
        const userId = Number(row?.user_id)
        if (!Number.isFinite(userId) || userId <= 0) continue
        if (!isSupercellModuleEnabled(userId)) continue

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

