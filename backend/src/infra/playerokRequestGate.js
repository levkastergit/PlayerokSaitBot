'use strict'

const { AsyncLocalStorage } = require('async_hooks')
const { PLAYEROK_REQUEST_TIMEOUT_MS } = require('./playerokRequestTimeout')
const { listRotationPool, loadRotationForCurrentUser } = require('./playerokOutboundIp')
const {
  areAllPoolIpsOnCooldown,
  allowCircuitProbe,
  earliestCooldownUntil,
} = require('./playerokOutboundRotation')

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const rawGap = process.env.PLAYEROK_MIN_REQUEST_GAP_MS
const parsedGap = rawGap != null && rawGap !== '' ? Number(rawGap) : NaN
const MIN_GAP_MS =
  Number.isFinite(parsedGap) && parsedGap >= 0 ? parsedGap : 280

// Серийный (ФОНОВЫЙ) gate пейсим МЕДЛЕННЕЕ операторского skipGate. autolist/sync/dealWatch
// генерят высокочастотный трафик и забивают 429-лимит Playerok (по аккаунту/токену, не только
// по IP — поэтому ротация IP не спасает). Больший интервал держит фоновую частоту запросов
// НИЖЕ лимита → меньше 429 → circuit-breaker не закрывается → оператор и резолв почты работают.
// Операторский skipGate остаётся быстрым (MIN_GAP_MS). Тюнится без пересборки через env.
const rawSerialGap = process.env.PLAYEROK_SERIAL_REQUEST_GAP_MS
const parsedSerialGap = rawSerialGap != null && rawSerialGap !== '' ? Number(rawSerialGap) : NaN
const SERIAL_GAP_MS =
  Number.isFinite(parsedSerialGap) && parsedSerialGap >= 0
    ? parsedSerialGap
    : Math.max(MIN_GAP_MS, 600)

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

// Лёгкий троттлинг интерактивного (skipGate) пути. Это НЕ строгая очередь (интерактив
// должен отвечать быстро), но с минимальным интервалом между стартами и лимитом
// параллельности — иначе веер запросов (например, загрузка списка чатов с десятками
// dealById/itemById) уходит залпом и ловит 429. Серийный гейт (фон) — отдельно.
const SKIP_MAX_CONCURRENCY = (() => {
  const v = Number(process.env.PLAYEROK_SKIP_MAX_CONCURRENCY)
  return Number.isFinite(v) && v > 0 ? v : 3
})()
let skipInFlight = 0
let skipLastStart = 0
const skipWaiters = []

async function withSkipThrottle(fn) {
  while (skipInFlight >= SKIP_MAX_CONCURRENCY) {
    await new Promise((resolve) => skipWaiters.push(resolve))
  }
  skipInFlight += 1
  try {
    // Синхронный участок без await: соседние вызовы корректно сериализуют расчёт паузы
    // (нет гонок по skipLastStart на однопоточном event loop).
    const now = Date.now()
    const wait = Math.max(0, MIN_GAP_MS - (now - skipLastStart))
    skipLastStart = now + wait
    if (wait > 0) await sleep(wait)
    return await withGateTimeout(fn)
  } finally {
    skipInFlight -= 1
    const next = skipWaiters.shift()
    if (next) next()
  }
}

// Снимок пула ротации кэшируем на 3с: listRotationPool читает os.networkInterfaces() —
// не дёргаем на каждом входе в гейт на 1-CPU боксе.
let __poolSnapAt = 0
let __poolSnap = []
function poolSnapshot() {
  const now = Date.now()
  if (now - __poolSnapAt < 3000) return __poolSnap
  try {
    const rotation = loadRotationForCurrentUser()
    __poolSnap = listRotationPool(rotation && rotation.excludedIps) || []
  } catch (_) {
    __poolSnap = []
  }
  __poolSnapAt = now
  return __poolSnap
}

let __circuitOpen = false
let __lastCircuitLogAt = 0
function logCircuit(open, pool) {
  const now = Date.now()
  if (open === __circuitOpen && now - __lastCircuitLogAt < 30000) return
  __lastCircuitLogAt = now
  if (open) {
    const until = earliestCooldownUntil(pool)
    const leftMin = Number.isFinite(until) ? Math.round(Math.max(0, until - now) / 60000) : null
    console.warn(
      `[outbound-ip] CIRCUIT OPEN: все ${pool.length} IP в блоке — отдаём устаревшие данные` +
        (leftMin != null ? `, ближайшее восстановление ~${leftMin} мин` : '')
    )
  } else if (__circuitOpen) {
    console.warn('[outbound-ip] CIRCUIT CLOSED: появился живой IP, обычная работа')
  }
  __circuitOpen = open
}

function circuitOpenError() {
  const e = new Error('Playerok временно недоступен: все исходящие IP на cooldown')
  e.code = 'PLAYEROK_CIRCUIT_OPEN'
  e.statusCode = 503
  e.nonRetryable = true
  e.soft = true
  return e
}

// Брейкер: если весь пул IP в cooldown — быстро падаем (или пропускаем одну half-open
// пробу), не занимая серийный гейт обречёнными запросами. Единый вызов allowCircuitProbe
// на запрос (без двойного списания бюджета). Возвращает true, если запрос надо пропустить.
function circuitAllowsRequest() {
  const pool = poolSnapshot()
  if (pool.length === 0 || !areAllPoolIpsOnCooldown(pool)) {
    if (pool.length > 0) logCircuit(false, pool)
    return true
  }
  if (allowCircuitProbe()) return true // half-open: пропускаем одну пробу
  logCircuit(true, pool)
  return false
}

/**
 * Глобальная очередь: один исходящий HTTP-запрос к Playerok за раз
 * и минимальный интервал между стартами соседних запросов.
 */
function withPlayerokGate(fn) {
  if (shouldSkipPlayerokGate()) {
    // Операторский (интерактивный) трафик НЕ гейтим circuit-breaker'ом: он низкочастотный
    // и user-facing (открытие чата, резолв почты, действия в UI). Брейкер нужен против
    // ХАММЕРА — это про высокочастотный ФОН (autolist/sync на серийном gate). Иначе фоновый
    // 429-шторм (все IP в cooldown) закрывает брейкер и блокирует оператора, хотя пара его
    // запросов по надёжному IP проходит (доказано пробой/бэкафиллом). Троттлинг skipGate
    // (3 конкурентных + MIN_GAP) сохраняется — флуда не будет.
    return withSkipThrottle(fn)
  }
  if (!circuitAllowsRequest()) return Promise.reject(circuitOpenError())
  const run = gateChain.then(async () => {
    const now = Date.now()
    const wait = Math.max(0, SERIAL_GAP_MS - (now - lastStartTime))
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
