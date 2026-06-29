const { registerJob, markTickStart, markTickEnd, setJobDetails } = require('../infra/jobsRegistry')
const { isOutboundCircuitOpen } = require('../infra/playerokOutboundIp')
const { mergeJobSteps } = require('./mergeJobSteps')
const { startAdaptiveLoop } = require('../infra/adaptiveLoop')
const { getSpeed } = require('../infra/playerokSpeedSettings')

const JOB_ID = 'relist'

// Отдельный цикл «Перевыставление» (Автовыставление): медленный периодический скан
// завершённых товаров и их перевыставление. Вынесен из общего autolist-тика в свой
// фоновый цикл со своим (бóльшим) интервалом — чтобы не задерживать быстрые задачи
// выдачи/2FA. HTTP всё равно сериализуется общим gate Playerok (429 не ловим).
function setupRelistBackgroundJob({
  postLocal,
  getAllStoredTokens,
  loadStoredTokenPlain,
  getUserAgent,
  isAllActionsStopped = () => false,
  intervalMs = 120000,
}) {
  registerJob({
    id: JOB_ID,
    label: 'Перевыставление',
    description: 'Сканирует завершённые (SOLD) товары и перевыставляет их (скан → статус → публикация)',
    intervalMs,
  })

  let inFlight = false

  startAdaptiveLoop({ jobId: JOB_ID, getIntervalMs: () => getSpeed('relistTickMs'), minMs: 30000 }, async () => {
    if (isAllActionsStopped()) return
    if (isOutboundCircuitOpen()) return
    if (inFlight) return
    let tickError = null
    let tickStarted = false
    let tickStartedAt = 0
    const perUser = []
    const allUserSteps = []
    try {
      inFlight = true
      const rows = getAllStoredTokens.all()
      if (!Array.isArray(rows) || rows.length === 0) return

      markTickStart(JOB_ID)
      tickStarted = true
      tickStartedAt = Date.now()
      for (const row of rows) {
        const userId = Number(row?.user_id)
        if (!Number.isFinite(userId) || userId <= 0) continue
        const stored = loadStoredTokenPlain(userId)
        if (!stored || !stored.token) continue

        const t0 = Date.now()
        let outcome = 'ok'
        try {
          const result = await postLocal('/api/playerok/relist-tick', {
            userId,
            token: stored.token,
            userAgent: getUserAgent(),
          })
          outcome = result?.action || (result && result.ok ? 'ok' : 'err')
          if (Array.isArray(result?.steps)) allUserSteps.push(result.steps)
        } catch (e) {
          outcome = 'error'
          throw e
        } finally {
          perUser.push({ userId, ms: Date.now() - t0, outcome })
        }
      }
    } catch (err) {
      tickError = err
    } finally {
      inFlight = false
      if (tickStarted) {
        setJobDetails(JOB_ID, {
          updatedAt: Math.floor(tickStartedAt / 1000),
          totalMs: Date.now() - tickStartedAt,
          intervalMs: getSpeed('relistTickMs'),
          users: perUser.slice(0, 50),
          steps: mergeJobSteps(allUserSteps),
        })
        markTickEnd(JOB_ID, tickError)
      }
    }
  })
}

module.exports = { setupRelistBackgroundJob }
