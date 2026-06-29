'use strict'

// ---------------------------------------------------------------------------
// Ротация исходящего IP для запросов к Playerok — защита от 429.
//
// Идея: соседние запросы уходят с РАЗНЫХ исходящих IP → на каждый IP приходится
// меньше запросов в секунду, и лимит 429 срабатывает реже. А если запрос всё-таки
// получил 429 и повторяется (withRetry), повтор берёт ДРУГОЙ IP из пула.
//
// Лимит 429 у Playerok — ПО IP (проверено эмпирически: когда один IP залочен,
// остальные тем же токеном отдают 200). Поэтому ведём по каждому IP «штраф»:
//   - на 429 IP уходит в блок по лестнице эскалации (если он не уже в блоке):
//       1 мин → 10 мин → 30 мин → 1 час → 3 часа → 24 часа (максимум).
//     Каждый следующий 429 ПОСЛЕ истечения блока повышает ступень.
//   - на успешный ответ (200) штраф снимается полностью (IP «выздоровел»).
// Заблокированный IP пропускается в ротации для всех каналов; деградация мягкая
// (если все IP в блоке/опробованы — всё равно вернём IP, не зациклимся).
//
// Сигналы успех/429 даёт withRetry через reportOutboundResult() — он знает исход
// попытки, а выбранный IP лежит в attemptStore (контекст одной операции withRetry,
// свой у каждого параллельного запроса — без гонок).
// ---------------------------------------------------------------------------

const { AsyncLocalStorage } = require('async_hooks')

// Один глобальный курсор на все каналы: исходящий гейт сериализует запросы,
// поэтому соседние вызовы получают подряд idx, idx+1, … независимо от категории.
let rrCursor = 0

// Лестница эскалации блокировки IP (мс). Ступень N (1..6) → LADDER_MS[N-1].
const LADDER_MS = [
  60 * 1000, // 1 мин
  10 * 60 * 1000, // 10 мин
  30 * 60 * 1000, // 30 мин
  60 * 60 * 1000, // 1 час (максимум — глубже эскалировать смысла нет: брейкер не даёт долбить мёртвый пул)
]

// ip -> { level: 1..6, until: ts(ms) }. level сохраняется и после истечения until
// (чтобы следующий 429 эскалировал дальше), очищается только успехом.
const ipState = new Map()

// Контекст одной логической операции (между всеми попытками одного withRetry):
// { triedByChannel: Map<channel, Set<ip>>, lastIp: string }. Живёт через await/then
// благодаря AsyncLocalStorage. Свой у каждого параллельного withRetry → без гонок.
const attemptStore = new AsyncLocalStorage()

function runWithOutboundAttempt(fn) {
  const existing = attemptStore.getStore()
  if (existing) return fn()
  return attemptStore.run({ triedByChannel: new Map(), lastIp: null }, fn)
}

/** Уже находимся внутри контекста попытки ротации (withRetry/withPlayerokRotation)?
 *  Нужно общему хелперу, чтобы НЕ заводить вложенный ретрай-цикл (умножение попыток):
 *  внешний владелец ротации сам сделает повтор с новым IP. */
function hasOutboundAttemptContext() {
  return Boolean(attemptStore.getStore())
}

function getTriedSet(channel) {
  const store = attemptStore.getStore()
  if (!store) return null
  const key = String(channel || 'default')
  let set = store.triedByChannel.get(key)
  if (!set) {
    set = new Set()
    store.triedByChannel.set(key, set)
  }
  return set
}

function minutesLabel(ms) {
  const m = Math.round(ms / 60000)
  return m >= 60 ? `${Math.round(m / 60)} ч` : `${m} мин`
}

// Первая ступень блокировки — ЖИВАЯ (из настроек /settings): меньше = залоченный IP быстрее
// возвращается в пул. Дальние ступени эскалации берём из LADDER_MS. Ленивый require, чтобы
// не создавать цикл на загрузке модулей.
function firstRungMs() {
  try {
    const { getSpeed } = require('./playerokSpeedSettings')
    const v = Number(getSpeed('ipCooldownFirstRungMs'))
    if (Number.isFinite(v) && v > 0) return v
  } catch (_) {}
  return LADDER_MS[0]
}

/** 429 по IP: эскалируем блок на следующую ступень (если IP сейчас не в блоке). */
function reportIpRateLimited(ip) {
  if (!ip) return
  const now = Date.now()
  const prev = ipState.get(ip)
  // Уже в активном блоке — этот 429 лишь подтверждает, ступень не повышаем.
  if (prev && prev.until > now) return
  const level = Math.min((prev ? prev.level : 0) + 1, LADDER_MS.length)
  const dur = level === 1 ? firstRungMs() : LADDER_MS[level - 1]
  ipState.set(ip, { level, until: now + dur })
  console.log(`[outbound-ip] IP ${ip} получил 429 → блок #${level} на ${minutesLabel(dur)}`)
}

/** 200 по IP: снимаем штраф полностью. */
function reportIpSuccess(ip) {
  if (!ip) return
  if (ipState.has(ip)) {
    ipState.delete(ip)
    console.log(`[outbound-ip] IP ${ip} снова отвечает (200) → блок снят`)
  }
}

/** Записать исход последней попытки withRetry на использованный в ней IP. */
function reportOutboundResult(ok) {
  const store = attemptStore.getStore()
  const ip = store && store.lastIp ? store.lastIp : null
  if (!ip) return
  if (ok) reportIpSuccess(ip)
  else reportIpRateLimited(ip)
}

/**
 * Записать исход конкретного HTTP-ответа на использованный IP — для прямого вызова
 * из функций запроса (покрывает и пути БЕЗ withRetry: chatsSync, dealStatusWatch,
 * проба). 429 → эскалация блока, 200 → снятие. Идемпотентно (двойной отчёт с
 * withRetry безопасен: эскалация внутри активного окна не повторяется).
 */
function reportIpResult(ip, statusCode) {
  if (!ip) return
  if (statusCode === 429) reportIpRateLimited(ip)
  else if (statusCode === 200) reportIpSuccess(ip)
}

/** IP сейчас в активном блоке (until ещё не наступил)? */
function isIpOnCooldown(ip) {
  const st = ipState.get(ip)
  return Boolean(st && st.until > Date.now())
}

/**
 * Все IP пула сейчас в активном блоке (cooldown)? Тогда любой исходящий запрос
 * почти гарантированно словит 429 — это сигнал «открыть» circuit breaker. Пустой
 * пул → false (ротации нет, обычный путь). Чистое чтение ipState без мутаций.
 * Восстановление таймерное: как только истечёт ближайший until (минимум 60с),
 * функция вернёт false и брейкер закроется сам.
 */
function areAllPoolIpsOnCooldown(pool) {
  if (!Array.isArray(pool) || pool.length === 0) return false
  for (const ip of pool) {
    if (!isIpOnCooldown(ip)) return false
  }
  return true
}

/** Ближайший момент (ts, мс), когда истечёт cooldown среди IP пула; Infinity если никто не в блоке. */
function earliestCooldownUntil(pool) {
  if (!Array.isArray(pool) || pool.length === 0) return Infinity
  const now = Date.now()
  let min = Infinity
  for (const ip of pool) {
    const st = ipState.get(ip)
    if (st && st.until > now && st.until < min) min = st.until
  }
  return min
}

// Полуоткрытие (half-open): даже при полностью остывшем пуле раз в интервал пропускаем
// ОДИН пробный запрос — иначе на верхних ступенях лестницы сайт ослеп бы надолго.
// Глобальный single-flight; серийный гейт сам троттлит до ~1 пробы за интервал.
let __lastProbeAt = 0
function allowCircuitProbe(intervalMs) {
  let liveIv = null
  try {
    const { getSpeed } = require('./playerokSpeedSettings')
    const v = Number(getSpeed('circuitProbeIntervalMs'))
    if (Number.isFinite(v) && v > 0) liveIv = v
  } catch (_) {}
  const iv =
    Number.isFinite(intervalMs) && intervalMs >= 0
      ? intervalMs
      : liveIv || Number(process.env.PLAYEROK_CIRCUIT_PROBE_INTERVAL_MS) || 15000
  const now = Date.now()
  if (now - __lastProbeAt >= iv) {
    __lastProbeAt = now
    return true
  }
  return false
}

/** Операционный аварийный сброс блокировок (оператор подтвердил, что Playerok поднят).
 *  Без ip — чистит весь Map. Возвращает число снятых записей. */
function resetCooldowns(ip) {
  if (ip) {
    const had = ipState.delete(String(ip))
    if (had) console.log(`[outbound-ip] ручной сброс блокировки IP ${ip}`)
    return had ? 1 : 0
  }
  const n = ipState.size
  ipState.clear()
  if (n > 0) console.log(`[outbound-ip] ручной сброс ВСЕХ блокировок (${n})`)
  return n
}

/**
 * Выбрать следующий IP из пула по кругу, исключая уже опробованные в этой операции
 * (для данного канала) и заблокированные (cooldown). Деградация мягкая: если живых
 * нет — игнорируем блок; если все опробованы — берём по кругу.
 *
 * @returns {{ ip: string, failover: boolean }}
 */
function pickRotationIp(channel, pool) {
  if (!Array.isArray(pool) || pool.length === 0) return { ip: null, failover: false }

  const store = attemptStore.getStore()
  const tried = getTriedSet(channel)
  const wasTriedBefore = tried ? tried.size > 0 : false

  const start = rrCursor % pool.length
  let chosen = null
  let chosenIdx = -1

  // Проход 1: первый не опробованный и не заблокированный.
  for (let i = 0; i < pool.length; i += 1) {
    const cand = pool[(start + i) % pool.length]
    if ((!tried || !tried.has(cand)) && !isIpOnCooldown(cand)) {
      chosen = cand
      chosenIdx = start + i
      break
    }
  }
  // Проход 2: первый не опробованный (блок игнорируем — лучше попробовать, чем встать).
  if (chosen == null) {
    for (let i = 0; i < pool.length; i += 1) {
      const cand = pool[(start + i) % pool.length]
      if (!tried || !tried.has(cand)) {
        chosen = cand
        chosenIdx = start + i
        break
      }
    }
  }
  // Проход 3: все опробованы — берём текущий по кругу.
  if (chosen == null) {
    chosen = pool[start]
    chosenIdx = start
  }

  rrCursor = chosenIdx + 1
  if (tried) tried.add(chosen)
  if (store) store.lastIp = chosen
  return { ip: chosen, failover: wasTriedBefore }
}

// Для тестов/диагностики.
function getRotationCursor() {
  return rrCursor
}

/** Снимок активных блокировок для UI: { ip: { level, secondsLeft } }. */
function getCooldownSnapshot() {
  const now = Date.now()
  const out = {}
  for (const [ip, st] of ipState) {
    if (st.until > now) out[ip] = { level: st.level, secondsLeft: Math.round((st.until - now) / 1000) }
  }
  return out
}

module.exports = {
  runWithOutboundAttempt,
  hasOutboundAttemptContext,
  pickRotationIp,
  reportOutboundResult,
  reportIpResult,
  reportIpRateLimited,
  reportIpSuccess,
  isIpOnCooldown,
  areAllPoolIpsOnCooldown,
  earliestCooldownUntil,
  allowCircuitProbe,
  resetCooldowns,
  getRotationCursor,
  getCooldownSnapshot,
  LADDER_MS,
}
