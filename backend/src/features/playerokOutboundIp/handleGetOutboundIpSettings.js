'use strict'

const { getOutboundChannelsMeta } = require('../../infra/playerokOutboundIp')

async function handleGetOutboundIpSettings({ currentUserId, deps }) {
  const { loadOutboundIpBindings } = deps
  const bindings = loadOutboundIpBindings(currentUserId)
  return {
    statusCode: 200,
    data: {
      bindings,
      channels: getOutboundChannelsMeta(),
    },
  }
}

module.exports = { handleGetOutboundIpSettings }
