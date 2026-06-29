'use strict'

const { setJobIntervalMs } = require('./jobsRegistry')

// Самоперепланирующийся цикл фоновой задачи. Интервал читается ЖИВЬЁМ перед планированием
// каждого следующего тика → его можно менять из /settings без рестарта. Перекрытие тиков
// невозможно (следующий планируется ПОСЛЕ завершения текущего) — это заменяет связку
// setInterval + tickInFlight-гард и не даёт очереди пухнуть при медленном upstream.
//
// opts: { getIntervalMs:()=>number, jobId?:string, minMs?:number }
function startAdaptiveLoop(opts, tick) {
  const getIntervalMs = opts && typeof opts.getIntervalMs === 'function' ? opts.getIntervalMs : null
  const jobIds = opts && opts.jobId ? (Array.isArray(opts.jobId) ? opts.jobId : [opts.jobId]) : []
  const minMs = opts && Number.isFinite(opts.minMs) ? opts.minMs : 100
  let stopped = false
  let timer = null

  function nextDelay() {
    let v = NaN
    try {
      v = Number(getIntervalMs ? getIntervalMs() : NaN)
    } catch (_) {
      v = NaN
    }
    const ms = Number.isFinite(v) && v > 0 ? v : minMs
    const clamped = Math.max(minMs, ms)
    for (const id of jobIds) {
      try { setJobIntervalMs(id, clamped) } catch (_) {}
    }
    return clamped
  }

  async function cycle() {
    if (stopped) return
    try {
      await tick()
    } catch (_) {
      // ошибки тика не должны останавливать цикл
    }
    if (stopped) return
    timer = setTimeout(cycle, nextDelay())
  }

  timer = setTimeout(cycle, nextDelay())
  return function stop() {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}

module.exports = { startAdaptiveLoop }
