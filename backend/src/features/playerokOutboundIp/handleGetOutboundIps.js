'use strict'

const { listAvailableOutboundIpv4, getOutboundChannelsMeta } = require('../../infra/playerokOutboundIp')
const { PLAYEROK_OUTBOUND_DISABLED } = require('../../infra/playerokOutboundChannels')

async function handleGetOutboundIps() {
  const addresses = listAvailableOutboundIpv4()
  const legacyEnv = String(process.env.PLAYEROK_OUTBOUND_IP || '').trim()
  return {
    statusCode: 200,
    data: {
      addresses,
      channels: getOutboundChannelsMeta(),
      disabledValue: PLAYEROK_OUTBOUND_DISABLED,
      legacyEnvIp: legacyEnv || null,
    },
  }
}

module.exports = { handleGetOutboundIps }
