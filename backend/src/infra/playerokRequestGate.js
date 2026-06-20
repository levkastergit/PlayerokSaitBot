'use strict'

const { AsyncLocalStorage } = require('async_hooks')
const { PLAYEROK_REQUEST_TIMEOUT_MS } = require('./playerokRequestTimeout')

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const rawGap = process.env.PLAYEROK_MIN_REQUEST_GAP_MS
const parsedGap = rawGap != null && rawGap !== '' ? Number(rawGap) : NaN
const MIN_GAP_MS =
  Number.isFinite(parsedGap) && parsedGap >= 0 ? parsedGap : 280

// Бэкстоп на случай, если конкретная request-функция не навесила собственный
// сокет-таймаут: гарантирует, что цепочка gateChain всегда продвинется и
// очередь не зависнет навсегда (иначе — каскад 504 по всему сайту). Чуть больше
// сокет-таймаута, чтобы при штатной работе первым срабатывал req-таймаут с
// «настоящей» сетевой ошибкой, а не общий бэкстоп.
const rawGateTimeout = process.env.PLAYEROK_GATE_TIMEOUT_MS
const parsedGateTimeout =
  rawGateTimeout != null && rawGateTimeout !== '' ? Number(rawGateTimeout) : NaN
const GATE_TIMEOUT_MS =
  Number.isFinite(parsedGateTimeout) && parsedGateTimeout > 0
    ? parsedGateTimeout
    : PLAYEROK_REQUEST_TIMEOUT_MS + 5000

function withGateTimeout(fn) {
  let timer
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Playerok gate: таймаут ${GATE_TIMEOUT_MS}ms`)
      err.code = 'PLAYEROK_GATE_TIMEOUT'
      reject(err)
    }, GATE_TIMEOUT_MS)
    if (timer && typeof timer.unref === 'function') timer.unref()
  })
  return Promise.race([Promise.resolve().then(fn), guard]).finally(() => {
    clearTimeout(timer)
  })
}

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
    return withGateTimeout(fn)
  }
  const run = gateChain.then(async () => {
    const now = Date.now()
    const wait = Math.max(0, MIN_GAP_MS - (now - lastStartTime))
    if (wait > 0) await sleep(wait)
    lastStartTime = Date.now()
    return withGateTimeout(fn)
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
