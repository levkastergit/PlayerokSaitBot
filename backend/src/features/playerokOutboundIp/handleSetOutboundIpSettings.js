'use strict'

const { listAvailableOutboundIpv4 } = require('../../infra/playerokOutboundIp')
const {
  normalizeOutboundBindings,
  isOutboundDisabledBindingValue,
} = require('../../infra/playerokOutboundChannels')
const { clearPlayerokHttpsAgentCache } = require('../../infra/playerokHttpsAgent')

function validateBindingsAgainstServer(bindings) {
  const allowed = new Set(listAvailableOutboundIpv4().map((a) => a.address))
  const errors = []
  for (const [channel, ip] of Object.entries(bindings)) {
    const trimmed = String(ip || '').trim()
    if (!trimmed || isOutboundDisabledBindingValue(trimmed)) continue
    if (!allowed.has(trimmed)) {
      errors.push(`IP ${trimmed} для «${channel}» недоступен на этом сервере`)
    }
  }
  return errors
}

async function handleSetOutboundIpSettings({ payload, currentUserId, deps }) {
  const { saveOutboundIpBindings } = deps
  const raw = payload && payload.bindings != null ? payload.bindings : payload
  const bindings = normalizeOutboundBindings(raw)
  const errors = validateBindingsAgainstServer(bindings)
  if (errors.length) {
    return { statusCode: 400, data: { error: errors[0], errors } }
  }
  const saved = saveOutboundIpBindings(currentUserId, bindings)
  clearPlayerokHttpsAgentCache()
  return {
    statusCode: 200,
    data: {
      ok: true,
      bindings: saved.bindings,
      updatedAt: saved.updatedAt,
    },
  }
}

module.exports = { handleSetOutboundIpSettings }
