'use strict'

const os = require('os')
const {
  PLAYEROK_OUTBOUND_CHANNELS,
  PLAYEROK_OUTBOUND_DISABLED,
  PLAYEROK_OUTBOUND_ROTATE,
  isOutboundDisabledBindingValue,
  isOutboundRotateBindingValue,
} = require('./playerokOutboundChannels')
const { getPlayerokRequestUserId } = require('./playerokRequestContext')
const { pickRotationIp } = require('./playerokOutboundRotation')

let bindingsResolver = null
let rotationResolver = null

function setOutboundIpBindingsResolver(fn) {
  bindingsResolver = typeof fn === 'function' ? fn : null
}

function setOutboundRotationResolver(fn) {
  rotationResolver = typeof fn === 'function' ? fn : null
}

function loadBindingsForCurrentUser() {
  if (!bindingsResolver) return {}
  const userId = getPlayerokRequestUserId()
  if (!userId) return {}
  try {
    return bindingsResolver(userId) || {}
  } catch (_) {
    return {}
  }
}

function loadRotationForCurrentUser() {
  if (!rotationResolver) return { enabled: false }
  const userId = getPlayerokRequestUserId()
  if (!userId) return { enabled: false }
  try {
    return rotationResolver(userId) || { enabled: false }
  } catch (_) {
    return { enabled: false }
  }
}

function resolveChannelBindingRaw(channel, bindings) {
  const ch = String(channel || 'default').trim() || 'default'
  const map = bindings && typeof bindings === 'object' ? bindings : {}
  if (Object.prototype.hasOwnProperty.call(map, ch)) {
    return map[ch]
  }
  if (ch !== 'default') {
    return map.default
  }
  return ''
}

function getOutboundChannelLabel(channel) {
  const ch = String(channel || 'default').trim() || 'default'
  const meta = PLAYEROK_OUTBOUND_CHANNELS.find((c) => c.id === ch)
  return meta ? meta.label : ch
}

function isOutboundChannelDisabled(channel, bindings) {
  const raw = resolveChannelBindingRaw(channel, bindings ?? loadBindingsForCurrentUser())
  return isOutboundDisabledBindingValue(raw)
}

class PlayerokChannelDisabledError extends Error {
  constructor(channel) {
    const label = getOutboundChannelLabel(channel)
    super(`Категория «${label}» отключена в настройках IP`)
    this.name = 'PlayerokChannelDisabledError'
    this.code = 'PLAYEROK_CHANNEL_DISABLED'
    this.channel = String(channel || 'default')
    this.statusCode = 503
  }
}

function assertPlayerokChannelEnabled(channel) {
  if (isOutboundChannelDisabled(channel)) {
    throw new PlayerokChannelDisabledError(channel)
  }
}

function isIpv4BoundLocally(addr) {
  const ifs = os.networkInterfaces()
  for (const list of Object.values(ifs)) {
    if (!list) continue
    for (const info of list) {
      if (info.internal) continue
      if (info.family !== 'IPv4' && info.family !== 4) continue
      if (String(info.address) === addr) return true
    }
  }
  return false
}

function listAvailableOutboundIpv4() {
  const seen = new Set()
  const addresses = []
  for (const list of Object.values(os.networkInterfaces())) {
    if (!list) continue
    for (const info of list) {
      if (info.internal) continue
      if (info.family !== 'IPv4' && info.family !== 4) continue
      const address = String(info.address || '').trim()
      if (!address || seen.has(address)) continue
      seen.add(address)
      addresses.push({ address })
    }
  }
  addresses.sort((a, b) => a.address.localeCompare(b.address, undefined, { numeric: true }))
  return addresses
}

function resolveConfiguredIpForChannel(channel, bindings) {
  if (isOutboundChannelDisabled(channel, bindings)) return null
  const ch = String(channel || 'default').trim() || 'default'
  const map = bindings && typeof bindings === 'object' ? bindings : {}
  // __rotate__ — не статический IP: пропускаем как кандидата для статической привязки.
  const candidates = [map[ch], map.default, process.env.PLAYEROK_OUTBOUND_IP]
  for (const raw of candidates) {
    const ip = String(raw || '').trim()
    if (!ip || isOutboundDisabledBindingValue(ip) || isOutboundRotateBindingValue(ip)) continue
    if (isIpv4BoundLocally(ip)) return ip
  }
  return null
}

/** Пул IP для ротации = все доступные внешние IPv4 сервера (отсортированы стабильно),
 *  за вычетом вручную исключённых пользователем адресов (excludedIps). */
function listRotationPool(excludedIps) {
  const excluded =
    excludedIps instanceof Set
      ? excludedIps
      : new Set(Array.isArray(excludedIps) ? excludedIps.map((ip) => String(ip || '').trim()) : [])
  return listAvailableOutboundIpv4()
    .map((a) => a.address)
    .filter((ip) => ip && !excluded.has(ip))
}

/** Нужно ли каналу крутить IP по пулу: явный __rotate__ ИЛИ «Автовыбор» при включённом
 *  глобальном тумблере ротации. Закреплённый конкретный IP и «Выключено» — не крутим. */
function shouldRotateChannel(channel, bindings, rotation) {
  const raw = resolveChannelBindingRaw(channel, bindings)
  if (isOutboundDisabledBindingValue(raw)) return false
  if (isOutboundRotateBindingValue(raw)) return true
  // Глобальный тумблер «Ротация IP» — мастер-переключатель: при включённом тумблере
  // крутим IP по пулу для ВСЕХ каналов, кроме явно отключённых, — даже если для канала
  // выбран конкретный IP. Так случайно закреплённый в UI адрес не отменяет ротацию.
  // Конкретный IP (пин) действует только при ВЫКЛЮЧЕННОМ тумблере.
  if (rotation && rotation.enabled) return true
  return false
}

function resolveOutboundLocalAddress(channel) {
  const bindings = loadBindingsForCurrentUser()
  const rotation = loadRotationForCurrentUser()
  if (shouldRotateChannel(channel, bindings, rotation)) {
    const pool = listRotationPool(rotation && rotation.excludedIps)
    if (pool.length > 0) {
      const picked = pickRotationIp(channel, pool)
      if (picked.ip) {
        if (picked.failover) {
          console.log(
            `[outbound-ip] 429-повтор: канал «${getOutboundChannelLabel(channel)}» переключён на IP ${picked.ip}`
          )
        }
        return picked.ip
      }
    }
    // Пул пуст (на сервере нет внешних IPv4) — откатываемся к статической привязке/ОС.
  }
  return resolveConfiguredIpForChannel(channel, bindings)
}

function getOutboundChannelsMeta() {
  return PLAYEROK_OUTBOUND_CHANNELS.map((c) => ({ id: c.id, label: c.label, hint: c.hint }))
}

module.exports = {
  PLAYEROK_OUTBOUND_DISABLED,
  PLAYEROK_OUTBOUND_ROTATE,
  setOutboundIpBindingsResolver,
  setOutboundRotationResolver,
  loadBindingsForCurrentUser,
  loadRotationForCurrentUser,
  isOutboundChannelDisabled,
  assertPlayerokChannelEnabled,
  PlayerokChannelDisabledError,
  getOutboundChannelLabel,
  isIpv4BoundLocally,
  listAvailableOutboundIpv4,
  listRotationPool,
  shouldRotateChannel,
  resolveConfiguredIpForChannel,
  resolveOutboundLocalAddress,
  getOutboundChannelsMeta,
}
