'use strict'

// Слияние массивов под-шагов (steps) от нескольких пользователей в один список
// для карточки на /execution: суммируем длительность и счётчики, эскалируем статус
// по приоритету, сохраняем порядок первого появления под-шага.

const STEP_STATUS_RANK = { err: 5, run: 4, ok: 3, idle: 2, skip: 1 }

function mergeJobSteps(stepArrays) {
  const order = []
  const byId = new Map()
  for (const arr of stepArrays) {
    if (!Array.isArray(arr)) continue
    for (const s of arr) {
      if (!s || !s.id) continue
      let m = byId.get(s.id)
      if (!m) {
        m = { id: s.id, label: s.label || s.id, status: 'idle', ms: 0, count: 0, note: null }
        if (s.parallel) m.parallel = true
        byId.set(s.id, m)
        order.push(s.id)
      }
      m.ms += Number(s.ms) || 0
      m.count += Number(s.count) || 0
      if (s.label) m.label = s.label
      if (s.parallel) m.parallel = true
      const incoming = String(s.status || 'idle')
      if ((STEP_STATUS_RANK[incoming] || 0) > (STEP_STATUS_RANK[m.status] || 0)) {
        m.status = incoming
      }
      if (s.note != null && String(s.note).trim() !== '') m.note = String(s.note).slice(0, 200)
    }
  }
  return order.map((id) => byId.get(id))
}

module.exports = { mergeJobSteps, STEP_STATUS_RANK }
