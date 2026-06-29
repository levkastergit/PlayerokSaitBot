'use strict'

// Реестр фоновых задач (background jobs) для вкладки «Список выполнения».
// Каждая периодическая задача регистрируется один раз при старте и отмечает
// начало/конец каждого РЕАЛЬНОГО тика (markTickStart / markTickEnd). Отсюда фронт
// получает живые данные: интервал цикла, момент старта последнего тика, число
// запусков/ошибок — и рисует «полосочку выполнения», синхронную реальному циклу.

const { isAllActionsStopped } = require('./runtimeControl')

/** @type {Map<string, object>} id -> состояние задачи */
const jobs = new Map()

function registerJob({ id, label, description = '', intervalMs }) {
  const key = String(id || '').trim()
  if (!key) return
  const prev = jobs.get(key)
  jobs.set(key, {
    id: key,
    label: String(label || key),
    description: String(description || ''),
    intervalMs: Number(intervalMs) > 0 ? Number(intervalMs) : 0,
    inFlight: prev ? prev.inFlight : false,
    lastTickStartAt: prev ? prev.lastTickStartAt : null,
    lastTickEndAt: prev ? prev.lastTickEndAt : null,
    lastDurationMs: prev ? prev.lastDurationMs : null,
    totalRuns: prev ? prev.totalRuns : 0,
    totalErrors: prev ? prev.totalErrors : 0,
    lastError: prev ? prev.lastError : null,
    lastErrorAt: prev ? prev.lastErrorAt : null,
    lastOkAt: prev ? prev.lastOkAt : null,
    details: prev ? prev.details : null,
    detailsAt: prev ? prev.detailsAt : null,
  })
}

// Подробные «живые» данные конкретной задачи (например, очередь лотов на поднятие
// или список сделок/флоу в работе) — для разворачивающейся плитки на фронте.
// Снимок (getJobsSnapshot) их НЕ включает, чтобы частый поллинг оставался лёгким;
// детали отдаются отдельным эндпоинтом по требованию.
function setJobDetails(id, details) {
  const job = jobs.get(String(id || ''))
  if (!job) return
  job.details = details && typeof details === 'object' ? details : null
  job.detailsAt = Date.now()
}

function getJobDetails(id) {
  const job = jobs.get(String(id || ''))
  if (!job) return { ok: false }
  return {
    ok: true,
    id: job.id,
    label: job.label,
    detailsAt: job.detailsAt,
    serverNow: Date.now(),
    details: job.details || null,
  }
}

// Обновить отображаемый интервал задачи (когда он меняется живьём из /settings), сохранив
// счётчики/метки. Нужно адаптивному циклу, чтобы «полоска выполнения» совпадала с реальным темпом.
function setJobIntervalMs(id, intervalMs) {
  const job = jobs.get(String(id || ''))
  if (!job) return
  const v = Number(intervalMs)
  if (Number.isFinite(v) && v > 0) job.intervalMs = v
}

function markTickStart(id) {
  const job = jobs.get(String(id || ''))
  if (!job) return
  job.inFlight = true
  job.lastTickStartAt = Date.now()
  job.totalRuns += 1
}

function markTickEnd(id, error = null) {
  const job = jobs.get(String(id || ''))
  if (!job) return
  const now = Date.now()
  job.inFlight = false
  job.lastTickEndAt = now
  if (Number.isFinite(job.lastTickStartAt)) {
    job.lastDurationMs = Math.max(0, now - job.lastTickStartAt)
  }
  if (error) {
    job.totalErrors += 1
    job.lastError =
      typeof error === 'string'
        ? error
        : error && error.message
          ? String(error.message)
          : String(error)
    job.lastErrorAt = now
  } else {
    job.lastOkAt = now
  }
}

function getJobsSnapshot() {
  let stoppedAll = false
  try {
    stoppedAll = isAllActionsStopped()
  } catch (_) {
    stoppedAll = false
  }
  const list = [...jobs.values()].map((j) => ({
    id: j.id,
    label: j.label,
    description: j.description,
    intervalMs: j.intervalMs,
    looped: j.intervalMs > 0,
    hasDetails: Boolean(j.details),
    inFlight: Boolean(j.inFlight),
    lastTickStartAt: j.lastTickStartAt,
    lastTickEndAt: j.lastTickEndAt,
    lastDurationMs: j.lastDurationMs,
    totalRuns: j.totalRuns,
    totalErrors: j.totalErrors,
    lastError: j.lastError,
    lastErrorAt: j.lastErrorAt,
    lastOkAt: j.lastOkAt,
  }))
  return { ok: true, stoppedAll, serverNow: Date.now(), jobs: list }
}

module.exports = {
  registerJob,
  markTickStart,
  markTickEnd,
  setJobDetails,
  setJobIntervalMs,
  getJobDetails,
  getJobsSnapshot,
}
