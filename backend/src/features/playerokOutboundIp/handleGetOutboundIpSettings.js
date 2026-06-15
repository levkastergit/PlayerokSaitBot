'use strict'

const { getOutboundChannelsMeta } = require('../../infra/playerokOutboundIp')
const { normalizeRotationConfig } = require('../../infra/playerokOutboundChannels')

async function handleGetOutboundIpSettings({ currentUserId, deps }) {
  const { loadOutboundIpBindings, loadOutboundIpRotation } = deps
  const bindings = loadOutboundIpBindings(currentUserId)
  const rotation =
    typeof loadOutboundIpRotation === 'function'
      ? normalizeRotationConfig(loadOutboundIpRotation(currentUserId))
      : { enabled: false, excludedIps: [] }
  return {
    statusCode: 200,
    data: {
      bindings,
      rotation,
      channels: getOutboundChannelsMeta(),
    },
  }
}

module.exports = { handleGetOutboundIpSettings }
