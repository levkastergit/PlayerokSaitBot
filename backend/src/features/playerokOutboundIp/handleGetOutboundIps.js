'use strict'

const { listAvailableOutboundIpv4, getOutboundChannelsMeta } = require('../../infra/playerokOutboundIp')
const {
  PLAYEROK_OUTBOUND_DISABLED,
  PLAYEROK_OUTBOUND_ROTATE,
} = require('../../infra/playerokOutboundChannels')
const { getCooldownSnapshot } = require('../../infra/playerokOutboundRotation')

function formatBlockLeft(sec) {
  if (sec >= 3600) {
    const h = Math.round(sec / 3600)
    return `${h} ч`
  }
  return `${Math.max(1, Math.round(sec / 60))} мин`
}

async function handleGetOutboundIps() {
  // Снимок заблокированных (429) IP: { ip: { level, secondsLeft } } — для красной
  // подсветки в настройках. Состояние живёт в памяти процесса ротации.
  const blocked = getCooldownSnapshot()
  const addresses = listAvailableOutboundIpv4().map((a) => {
    const b = blocked[a.address]
    return b
      ? {
          ...a,
          blocked: true,
          blockLevel: b.level,
          blockSecondsLeft: b.secondsLeft,
          blockLabel: formatBlockLeft(b.secondsLeft),
        }
      : { ...a, blocked: false }
  })
  const legacyEnv = String(process.env.PLAYEROK_OUTBOUND_IP || '').trim()
  return {
    statusCode: 200,
    data: {
      addresses,
      channels: getOutboundChannelsMeta(),
      disabledValue: PLAYEROK_OUTBOUND_DISABLED,
      rotateValue: PLAYEROK_OUTBOUND_ROTATE,
      // Ротация осмысленна только при 2+ доступных IP — фронт может подсказать.
      rotationPoolSize: addresses.length,
      legacyEnvIp: legacyEnv || null,
    },
  }
}

module.exports = { handleGetOutboundIps }
