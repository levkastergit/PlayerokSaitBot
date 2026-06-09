const { registerJob, markTickStart, markTickEnd } = require('../infra/jobsRegistry')

const JOB_ID = 'chats-warmup'

function setupChatsWarmupBackgroundJob({
  postLocal,
  getAllStoredTokens,
  loadStoredTokenPlain,
  getUserAgent,
  isAllActionsStopped = () => false,
  intervalMs = 60000,
  pageLimit = 24,
  maxPagesPerUser = 6,
  pageDelayMs = 0,
}) {
  registerJob({
    id: JOB_ID,
    label: 'Прогрев чатов',
    description: 'Фоновая загрузка списка чатов в кэш для быстрых ответов',
    intervalMs,
  })

  let inFlight = false

  setInterval(async () => {
    if (isAllActionsStopped()) return
    if (inFlight) return
    let tickError = null
    let tickStarted = false
    try {
      inFlight = true
      const rows = getAllStoredTokens.all()
      if (!Array.isArray(rows) || rows.length === 0) return

      markTickStart(JOB_ID)
      tickStarted = true
      for (const row of rows) {
        const userId = Number(row?.user_id)
        if (!Number.isFinite(userId) || userId <= 0) continue

        const stored = loadStoredTokenPlain(userId)
        if (!stored || !stored.token) continue

        let afterCursor = null
        const maxPages = Number(maxPagesPerUser) > 0 ? Number(maxPagesPerUser) : 1
        const limit = Number(pageLimit) > 0 ? Number(pageLimit) : 24

        for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
          const response = await postLocal('/api/playerok/chats', {
            userId,
            token: stored.token,
            userAgent: getUserAgent(),
            limit,
            ...(afterCursor ? { afterCursor } : {}),
            preferCache: false,
            warmup: true,
          })

          const pageInfo = response && typeof response.pageInfo === 'object' ? response.pageInfo : null
          const hasNext = Boolean(pageInfo?.hasNextPage)
          afterCursor = hasNext ? (pageInfo?.endCursor || null) : null
          if (!afterCursor) break

          if (pageDelayMs > 0 && pageIndex + 1 < maxPages) {
            await new Promise((resolve) => setTimeout(resolve, pageDelayMs))
          }
        }
      }
    } catch (err) {
      tickError = err
      // ignore errors in warmup cycle
    } finally {
      inFlight = false
      if (tickStarted) markTickEnd(JOB_ID, tickError)
    }
  }, intervalMs)
}

module.exports = { setupChatsWarmupBackgroundJob }

