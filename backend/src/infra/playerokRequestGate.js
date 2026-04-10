'use strict'

const { AsyncLocalStorage } = require('async_hooks')

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const rawGap = process.env.PLAYEROK_MIN_REQUEST_GAP_MS
const parsedGap = rawGap != null && rawGap !== '' ? Number(rawGap) : NaN
const MIN_GAP_MS =
  Number.isFinite(parsedGap) && parsedGap >= 0 ? parsedGap : 280

const interactiveAls = new AsyncLocalStorage()

/**
 * Выполнить обработчик UI чата: исходящие запросы к Playerok без глобальной очереди
 * (моментальный ответ; риск 429 выше, чем у фоновых задач).
 */
function runPlayerokInteractive(fn) {
  return interactiveAls.run({ skipGate: true }, fn)
}

function shouldSkipPlayerokGate() {
  const s = interactiveAls.getStore()
  return Boolean(s && s.skipGate)
}

let gateChain = Promise.resolve()
let lastStartTime = 0

/**
 * Глобальная очередь: один исходящий HTTP-запрос к Playerok за раз
 * и минимальный интервал между стартами соседних запросов.
 */
function withPlayerokGate(fn) {
  if (shouldSkipPlayerokGate()) {
    return fn()
  }
  const run = gateChain.then(async () => {
    const now = Date.now()
    const wait = Math.max(0, MIN_GAP_MS - (now - lastStartTime))
    if (wait > 0) await sleep(wait)
    lastStartTime = Date.now()
    return fn()
  })
  gateChain = run.then(
    () => {},
    () => {}
  )
  return run
}

function getPlayerokMinRequestGapMs() {
  return MIN_GAP_MS
}

module.exports = {
  withPlayerokGate,
  getPlayerokMinRequestGapMs,
  runPlayerokInteractive,
}
