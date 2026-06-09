const { registerJob, markTickStart, markTickEnd, setJobDetails } = require('../infra/jobsRegistry')

const JOB_ID = 'autolist'
// Порог «медленного» прохода по одному пользователю — выше пишем предупреждение в лог.
const SLOW_USER_MS = 8000

// Приоритет статусов при слиянии подзадач по нескольким пользователям:
// если хоть у кого-то ошибка — показываем ошибку; затем «выполняется», «готово» и т.д.
const STEP_STATUS_RANK = { err: 5, run: 4, ok: 3, idle: 2, skip: 1 }

// Сливаем массивы подзадач (steps) от каждого пользователя в один общий список
// для плитки «Список выполнения»: суммируем длительность и счётчики, эскалируем
// статус по приоритету, сохраняем порядок первого появления подзадачи.
function mergeAutolistSteps(stepArrays) {
  const order = []
  const byId = new Map()
  for (const arr of stepArrays) {
    if (!Array.isArray(arr)) continue
    for (const s of arr) {
      if (!s || !s.id) continue
      let m = byId.get(s.id)
      if (!m) {
        m = { id: s.id, label: s.label || s.id, status: 'idle', ms: 0, count: 0, note: null }
        byId.set(s.id, m)
        order.push(s.id)
      }
      m.ms += Number(s.ms) || 0
      m.count += Number(s.count) || 0
      if (s.label) m.label = s.label
      const incoming = String(s.status || 'idle')
      if ((STEP_STATUS_RANK[incoming] || 0) > (STEP_STATUS_RANK[m.status] || 0)) {
        m.status = incoming
      }
      if (s.note != null && String(s.note).trim() !== '') m.note = String(s.note).slice(0, 200)
    }
  }
  return order.map((id) => byId.get(id))
}

function setupAutolistBackgroundJob({
  postLocal,
  getAllStoredTokens,
  loadStoredTokenPlain,
  getUserAgent,
  isAllActionsStopped = () => false,
  intervalMs = 15000,
}) {
  registerJob({
    id: JOB_ID,
    label: 'Автовыставление',
    description: 'Сканирует оплаченные чаты и запускает автовыдачу товара',
    intervalMs,
  })

  // Важно: не допускаем наложения вызовов, иначе легко ловим rate limit Playerok.
  let autolistInFlight = false

  setInterval(async () => {
    if (isAllActionsStopped()) return
    if (autolistInFlight) return
    let tickError = null
    let tickStarted = false
    let tickStartedAt = 0
    const perUser = []
    const allUserSteps = []
    try {
      autolistInFlight = true
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

        // Замеряем длительность прохода по каждому пользователю — чтобы было видно,
        // что именно (и насколько) удлиняет общий цикл; пишем в лог при превышении.
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
      autolistInFlight = false
      if (tickStarted) {
        const totalMs = Date.now() - tickStartedAt
        if (totalMs > Math.max(intervalMs * 2, 20000)) {
          console.warn(
            `[autolist] проход занял ${(totalMs / 1000).toFixed(1)} с при интервале ${Math.round(intervalMs / 1000)} с — ` +
              'новый цикл стартует только после завершения текущего (наложения нет). Разбивка по пользователям:',
            perUser
          )
        }
        setJobDetails(JOB_ID, {
          updatedAt: Math.floor(tickStartedAt / 1000),
          totalMs,
          intervalMs,
          users: perUser.slice(0, 50),
          steps: mergeAutolistSteps(allUserSteps),
        })
        markTickEnd(JOB_ID, tickError)
      }
    }
  }, intervalMs)
}

module.exports = { setupAutolistBackgroundJob }

