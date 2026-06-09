'use strict'

// ---------------------------------------------------------------------------
// Ротация исходящего IP для запросов к Playerok — защита от 429.
//
// Идея: если соседние запросы уходят с РАЗНЫХ исходящих IP, то на каждый
// отдельный IP приходится меньше запросов в секунду, и лимит 429 срабатывает
// реже. А если запрос всё-таки получил 429 и повторяется (withRetry), повтор
// берёт ДРУГОЙ IP из пула, а не тот же самый.
//
// Здесь только «механика выбора»: глобальный round-robin счётчик + контекст
// одной логической операции (попытки withRetry), в котором копятся уже
// опробованные IP по каналам — чтобы повтор после 429 их исключил.
// Сам пул IP и решение «крутить или нет» — в playerokOutboundIp.js.
// ---------------------------------------------------------------------------

const { AsyncLocalStorage } = require('async_hooks')

// Один глобальный курсор на все каналы: исходящий гейт сериализует запросы,
// поэтому соседние вызовы получают подряд idx, idx+1, … → «1 запрос — 1 IP,
// 2 запрос — 2 IP» независимо от категории.
let rrCursor = 0

// Контекст одной логической операции (между всеми попытками одного withRetry):
// { triedByChannel: Map<channel, Set<ip>> }. Живёт через await/then благодаря
// AsyncLocalStorage — тот же механизм, что и у playerokRequestContext.
const attemptStore = new AsyncLocalStorage()

/**
 * Выполнить операцию (обычно — весь цикл повторов withRetry) в общем контексте
 * попыток, чтобы повтор после 429 знал, какие IP уже были опробованы, и взял
 * другой. Вложенные вызовы переиспользуют уже существующий контекст (не сбрасываем
 * накопленные triedByChannel — иначе внешний повтор потерял бы историю).
 */
function runWithOutboundAttempt(fn) {
  const existing = attemptStore.getStore()
  if (existing) return fn()
  return attemptStore.run({ triedByChannel: new Map() }, fn)
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

/**
 * Выбрать следующий IP из пула по кругу, исключая уже опробованные в этой
 * операции (для данного канала). Если все IP пула уже опробованы (пул меньше
 * числа повторов) — берём по обычному кругу, не зацикливаясь.
 *
 * @param {string} channel    категория запроса (для учёта опробованных IP)
 * @param {string[]} pool     список IPv4 (непустой, уже отфильтрованный)
 * @returns {{ ip: string, failover: boolean }} ip и флаг «это повтор с другим IP»
 */
function pickRotationIp(channel, pool) {
  if (!Array.isArray(pool) || pool.length === 0) return { ip: null, failover: false }

  const tried = getTriedSet(channel)
  const start = rrCursor % pool.length
  const wasTriedBefore = tried ? tried.size > 0 : false

  let chosen = null
  // Идём по кругу от текущего курсора и берём первый не опробованный IP.
  for (let i = 0; i < pool.length; i += 1) {
    const cand = pool[(start + i) % pool.length]
    if (!tried || !tried.has(cand)) {
      chosen = cand
      rrCursor = start + i + 1
      break
    }
  }
  // Все IP пула уже опробованы в этой операции — берём текущий по кругу.
  if (chosen == null) {
    chosen = pool[start]
    rrCursor = start + 1
  }

  if (tried) tried.add(chosen)
  // failover = это уже не первый IP в рамках данной операции (был 429 → повтор).
  return { ip: chosen, failover: wasTriedBefore }
}

// Для тестов/диагностики: текущее положение курсора.
function getRotationCursor() {
  return rrCursor
}

module.exports = {
  runWithOutboundAttempt,
  pickRotationIp,
  getRotationCursor,
}
