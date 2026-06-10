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
//
// Cooldown: лимит 429 у Playerok — ПО IP (проверено эмпирически), а не по токену.
// Поэтому когда какой-то IP получает 429 (виден как failover-повтор), он временно
// «остывает» — pickRotationIp пропускает его для ВСЕХ каналов/запросов на
// COOLDOWN_MS. Так заблокированный/перегруженный IP не тратит ~1/N запросов
// впустую и не роняет инструменты вроде вкладки «Тест».
// ---------------------------------------------------------------------------

const { AsyncLocalStorage } = require('async_hooks')

// Один глобальный курсор на все каналы: исходящий гейт сериализует запросы,
// поэтому соседние вызовы получают подряд idx, idx+1, … → «1 запрос — 1 IP,
// 2 запрос — 2 IP» независимо от категории.
let rrCursor = 0

// Сколько держать IP вне ротации после полученного 429.
const COOLDOWN_MS = 60000
// ip -> timestamp (ms), до которого IP пропускается в ротации.
const cooldownUntil = new Map()

// Контекст одной логической операции (между всеми попытками одного withRetry):
// { triedByChannel: Map<channel, Set<ip>>, lastIpByChannel: Map<channel, ip> }.
// Живёт через await/then благодаря AsyncLocalStorage — тот же механизм, что и у
// playerokRequestContext.
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
  return attemptStore.run({ triedByChannel: new Map(), lastIpByChannel: new Map() }, fn)
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

/** Пометить IP «остывающим» на COOLDOWN_MS — пропускать его в ротации. */
function markIpCooldown(ip) {
  if (ip) cooldownUntil.set(ip, Date.now() + COOLDOWN_MS)
}

/** На cooldown ли IP сейчас (с авто-очисткой просроченных записей). */
function isIpOnCooldown(ip) {
  const until = cooldownUntil.get(ip)
  if (!until) return false
  if (until <= Date.now()) {
    cooldownUntil.delete(ip)
    return false
  }
  return true
}

/**
 * Выбрать следующий IP из пула по кругу, исключая уже опробованные в этой
 * операции (для данного канала) и временно «остывающие» после 429. Если
 * подходящих нет — деградируем мягко: сначала игнорируем cooldown, затем берём
 * по обычному кругу, не зацикливаясь.
 *
 * @param {string} channel    категория запроса (для учёта опробованных IP)
 * @param {string[]} pool     список IPv4 (непустой, уже отфильтрованный)
 * @returns {{ ip: string, failover: boolean }} ip и флаг «это повтор с другим IP»
 */
function pickRotationIp(channel, pool) {
  if (!Array.isArray(pool) || pool.length === 0) return { ip: null, failover: false }

  const store = attemptStore.getStore()
  const tried = getTriedSet(channel)
  const chKey = String(channel || 'default')
  const wasTriedBefore = tried ? tried.size > 0 : false

  // Повтор после ошибки (failover): предыдущий выбранный для канала IP только что
  // вернул 429 — отправляем его на cooldown для всех последующих запросов.
  if (wasTriedBefore && store && store.lastIpByChannel) {
    markIpCooldown(store.lastIpByChannel.get(chKey))
  }

  const start = rrCursor % pool.length
  let chosen = null
  let chosenIdx = -1

  // Проход 1: первый не опробованный в этой операции и не на cooldown.
  for (let i = 0; i < pool.length; i += 1) {
    const cand = pool[(start + i) % pool.length]
    if ((!tried || !tried.has(cand)) && !isIpOnCooldown(cand)) {
      chosen = cand
      chosenIdx = start + i
      break
    }
  }
  // Проход 2: первый не опробованный (cooldown игнорируем — лучше попробовать
  // остывающий IP, чем встать; например когда все живые уже опробованы).
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
  // Проход 3: все IP пула уже опробованы — берём текущий по кругу.
  if (chosen == null) {
    chosen = pool[start]
    chosenIdx = start
  }

  rrCursor = chosenIdx + 1
  if (tried) tried.add(chosen)
  if (store) {
    if (!store.lastIpByChannel) store.lastIpByChannel = new Map()
    store.lastIpByChannel.set(chKey, chosen)
  }
  // failover = это уже не первый IP в рамках данной операции (был 429 → повтор).
  return { ip: chosen, failover: wasTriedBefore }
}

// Для тестов/диагностики: текущее положение курсора.
function getRotationCursor() {
  return rrCursor
}

// Для тестов/диагностики: снимок активных cooldown.
function getCooldownSnapshot() {
  const now = Date.now()
  const out = {}
  for (const [ip, until] of cooldownUntil) {
    if (until > now) out[ip] = Math.round((until - now) / 1000)
  }
  return out
}

module.exports = {
  runWithOutboundAttempt,
  pickRotationIp,
  getRotationCursor,
  markIpCooldown,
  isIpOnCooldown,
  getCooldownSnapshot,
}
