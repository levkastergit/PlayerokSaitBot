'use strict'

const { parse: parseUrl } = require('url')
const { HttpsProxyAgent } = require('https-proxy-agent')
const { resolveOutboundLocalAddress, assertPlayerokChannelEnabled } = require('./playerokOutboundIp')

const agentCache = new Map()

/**
 * URL исходящего прокси для HTTPS-запросов к playerok.com.
 * Приоритет: PLAYEROK_PROXY → HTTPS_PROXY → HTTP_PROXY (как у большинства CLI).
 */
function resolvePlayerokProxyUrl() {
  const u = String(
    process.env.PLAYEROK_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || ''
  ).trim()
  return u || null
}

function getCachedAgent(proxyUrl, localAddress) {
  const key = `${proxyUrl || ''}\0${localAddress || ''}`
  if (agentCache.has(key)) return agentCache.get(key)
  let agent
  if (localAddress) {
    agent = new HttpsProxyAgent(Object.assign(parseUrl(proxyUrl), { localAddress }))
  } else {
    agent = new HttpsProxyAgent(proxyUrl)
  }
  agentCache.set(key, agent)
  return agent
}

function clearPlayerokHttpsAgentCache() {
  agentCache.clear()
}

function getPlayerokHttpsAgent(channel) {
  const url = resolvePlayerokProxyUrl()
  const localAddress = resolveOutboundLocalAddress(channel)
  if (!url) return undefined
  return getCachedAgent(url, localAddress)
}

/**
 * Стабильный идентификатор «канала выхода» для учёта 429/cooldown по IP.
 * Принимает УЖЕ вычисленные extra-опции, чтобы НЕ дёргать ротацию повторно (повторный
 * resolveOutboundLocalAddress сместил бы round-robin курсор и отчёт ушёл бы не на тот IP).
 * Приоритет: привязанный localAddress (ротация/пин) → URL прокси → null (OS-дефолт: пула
 * нет, ротации нет — отчитываться некому, reportIpResult сам делает no-op на null).
 */
function playerokEgressKey(extra) {
  if (extra && extra.localAddress) return extra.localAddress
  return resolvePlayerokProxyUrl() || null
}

/** Фрагмент опций для https.request: { agent }, { localAddress } или оба по необходимости */
function playerokHttpsExtraOptions(channel) {
  assertPlayerokChannelEnabled(channel)
  const proxyUrl = resolvePlayerokProxyUrl()
  const localAddress = resolveOutboundLocalAddress(channel)
  if (proxyUrl) {
    return { agent: getCachedAgent(proxyUrl, localAddress) }
  }
  if (localAddress) return { localAddress }
  return {}
}

module.exports = {
  resolvePlayerokProxyUrl,
  getPlayerokHttpsAgent,
  playerokHttpsExtraOptions,
  playerokEgressKey,
  clearPlayerokHttpsAgentCache,
}
