'use strict'

const os = require('os')
const {
  PLAYEROK_OUTBOUND_CHANNELS,
  PLAYEROK_OUTBOUND_DISABLED,
  isOutboundDisabledBindingValue,
} = require('./playerokOutboundChannels')
const { getPlayerokRequestUserId } = require('./playerokRequestContext')

let bindingsResolver = null

function setOutboundIpBindingsResolver(fn) {
  bindingsResolver = typeof fn === 'function' ? fn : null
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
  const candidates = [map[ch], map.default, process.env.PLAYEROK_OUTBOUND_IP]
  for (const raw of candidates) {
    const ip = String(raw || '').trim()
    if (!ip || isOutboundDisabledBindingValue(ip)) continue
    if (isIpv4BoundLocally(ip)) return ip
  }
  return null
}

function resolveOutboundLocalAddress(channel) {
  return resolveConfiguredIpForChannel(channel, loadBindingsForCurrentUser())
}

function getOutboundChannelsMeta() {
  return PLAYEROK_OUTBOUND_CHANNELS.map((c) => ({ id: c.id, label: c.label, hint: c.hint }))
}

module.exports = {
  PLAYEROK_OUTBOUND_DISABLED,
  setOutboundIpBindingsResolver,
  loadBindingsForCurrentUser,
  isOutboundChannelDisabled,
  assertPlayerokChannelEnabled,
  PlayerokChannelDisabledError,
  getOutboundChannelLabel,
  isIpv4BoundLocally,
  listAvailableOutboundIpv4,
  resolveConfiguredIpForChannel,
  resolveOutboundLocalAddress,
  getOutboundChannelsMeta,
}
