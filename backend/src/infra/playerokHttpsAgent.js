'use strict'

const os = require('os')
const { parse: parseUrl } = require('url')
const { HttpsProxyAgent } = require('https-proxy-agent')

let cachedAgent = null
let cachedKey = null
let warnedOutboundIpUnavailable = false

function isIpv4BoundLocally(addr) {
  const ifs = os.networkInterfaces()
  for (const list of Object.values(ifs)) {
    if (!list) continue
    for (const info of list) {
      if (info.internal) continue
      if (String(info.address) === addr && info.family === 'IPv4') return true
    }
  }
  return false
}

/**
 * URL исходящего прокси для HTTPS-запросов к playerok.com.
 * Приоритет: PLAYEROK_PROXY → HTTPS_PROXY → HTTP_PROXY (как у большинства CLI).
 * Пример: http://user:pass@host:8080 или http://host:8080
 */
function resolvePlayerokProxyUrl() {
  const u = String(
    process.env.PLAYEROK_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || ''
  ).trim()
  return u || null
}

/**
 * PLAYEROK_OUTBOUND_IP: bind только если адрес есть у этого процесса.
 * Иначе EADDRNOTAVAIL (типично: bridge Docker без network_mode: host).
 */
function resolvePlayerokOutboundLocalAddress() {
  const a = String(process.env.PLAYEROK_OUTBOUND_IP || '').trim()
  if (!a) return null
  if (isIpv4BoundLocally(a)) return a
  if (!warnedOutboundIpUnavailable) {
    warnedOutboundIpUnavailable = true
    console.warn(
      '[playerok] PLAYEROK_OUTBOUND_IP=' +
        a +
        ' не на интерфейсах процесса; исходящие без привязки. Для bind в Docker: network_mode: host.'
    )
  }
  return null
}

function getPlayerokHttpsAgent() {
  const url = resolvePlayerokProxyUrl()
  const localAddress = resolvePlayerokOutboundLocalAddress()
  const key = `${url}\0${localAddress || ''}`

  if (!url) {
    cachedAgent = null
    cachedKey = null
    return undefined
  }
  if (cachedAgent && cachedKey === key) return cachedAgent

  cachedKey = key
  if (localAddress) {
    cachedAgent = new HttpsProxyAgent(Object.assign(parseUrl(url), { localAddress }))
  } else {
    cachedAgent = new HttpsProxyAgent(url)
  }
  return cachedAgent
}

/** Фрагмент опций для https.request: { agent }, { localAddress } или оба по необходимости */
function playerokHttpsExtraOptions() {
  const agent = getPlayerokHttpsAgent()
  const localAddress = resolvePlayerokOutboundLocalAddress()
  if (agent) return { agent }
  if (localAddress) return { localAddress }
  return {}
}

module.exports = {
  resolvePlayerokProxyUrl,
  resolvePlayerokOutboundLocalAddress,
  getPlayerokHttpsAgent,
  playerokHttpsExtraOptions,
}
