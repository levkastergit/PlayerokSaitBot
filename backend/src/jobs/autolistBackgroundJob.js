const { registerJob, markTickStart, markTickEnd, setJobDetails } = require('../infra/jobsRegistry')
const { isOutboundCircuitOpen } = require('../infra/playerokOutboundIp')
const { mergeJobSteps } = require('./mergeJobSteps')
const { startAdaptiveLoop } = require('../infra/adaptiveLoop')
const { getSpeed } = require('../infra/playerokSpeedSettings')

// Быстрый цикл обработки чатов. Делится на ТРИ карточки на /execution (по одному
// fetch чатов на проход — без дублей). «Перевыставление» вынесено в отдельный
// медленный цикл (job 'relist'), чтобы не задерживать выдачу/2FA.
const JOB_PAID = 'paid-delivery'
const JOB_AUTOMSG = 'automessages'
const JOB_FLOWS = 'delivery-flows'

const SLOW_USER_MS = 8000

// Какие под-шаги тика идут в какую карточку. flow-* помечены parallel:true (рендерятся
// отдельными мини-карточками внутри «Выдача»).
const GROUPS = {
  [JOB_PAID]: { label: 'Оплаченные чаты и автовыдача', stepIds: ['chats', 'paid-chats'] },
  [JOB_AUTOMSG]: { label: 'Автосообщения по стадиям', stepIds: ['automessages'] },
  [JOB_FLOWS]: {
    label: 'Выдача (флоу)',
    stepIds: ['flow-supercell', 'flow-topup', 'flow-clode', 'flow-gpt', 'flow-swizzyer', 'flow-pgpt'],
  },
}

function setupAutolistBackgroundJob({
  postLocal,
  getAllStoredTokens,
  loadStoredTokenPlain,
  getUserAgent,
  isAllActionsStopped = () => false,
  intervalMs = 15000,
}) {
  registerJob({ id: JOB_PAID, label: GROUPS[JOB_PAID].label, description: 'Обрабатывает оплаченные чаты и запускает автовыдачу/AppRoute', intervalMs })
  registerJob({ id: JOB_AUTOMSG, label: GROUPS[JOB_AUTOMSG].label, description: 'Отправляет автосообщения по стадиям сделки', intervalMs })
  registerJob({ id: JOB_FLOWS, label: GROUPS[JOB_FLOWS].label, description: 'Интерактивные флоу выдачи (Supercell/Topup/Clode/GPT/Swizzyer/Partner) — параллельно', intervalMs })

  const JOB_IDS = [JOB_PAID, JOB_AUTOMSG, JOB_FLOWS]

  // Важно: не допускаем наложения вызовов, иначе легко ловим rate limit Playerok.
  let inFlight = false

  startAdaptiveLoop({ jobId: JOB_IDS, getIntervalMs: () => getSpeed('autolistTickMs'), minMs: 2000 }, async () => {
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

      for (const id of JOB_IDS) markTickStart(id)
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
          const result = await postLocal('/api/playerok/autolist-tick', {
            userId,
            token: stored.token,
            userAgent: getUserAgent(),
          })
          outcome = result?.from || result?.skipped || (result && result.ok ? 'ok' : 'err')
          if (Array.isArray(result?.steps)) allUserSteps.push(result.steps)
        } catch (e) {
          outcome = 'error'
          throw e
        } finally {
          const ms = Date.now() - t0
          perUser.push({ userId, ms, outcome })
          if (ms > SLOW_USER_MS) {
            console.warn(
              `[autolist] медленный проход: user=${userId} занял ${(ms / 1000).toFixed(1)} с (${outcome}). ` +
                'Обычная причина — лимитер запросов Playerok и большое число чатов/активных выдач.'
            )
          }
        }
      }
    } catch (err) {
      tickError = err
    } finally {
      inFlight = false
      if (tickStarted) {
        const totalMs = Date.now() - tickStartedAt
        const merged = mergeJobSteps(allUserSteps)
        const updatedAt = Math.floor(tickStartedAt / 1000)
        // Раскладываем под-шаги по трём карточкам.
        for (const id of JOB_IDS) {
          const wanted = new Set(GROUPS[id].stepIds)
          const groupSteps = merged.filter((s) => wanted.has(s.id))
          setJobDetails(id, { updatedAt, totalMs, intervalMs: getSpeed('autolistTickMs'), users: perUser.slice(0, 50), steps: groupSteps })
          markTickEnd(id, tickError)
        }
      }
    }
  })
}

module.exports = { setupAutolistBackgroundJob }
