'use strict'

const { listAvailableOutboundIpv4 } = require('../../infra/playerokOutboundIp')
const {
  normalizeOutboundBindings,
  normalizeRotationConfig,
  isOutboundDisabledBindingValue,
  isOutboundRotateBindingValue,
} = require('../../infra/playerokOutboundChannels')
const { clearPlayerokHttpsAgentCache } = require('../../infra/playerokHttpsAgent')

function validateBindingsAgainstServer(bindings) {
  const allowed = new Set(listAvailableOutboundIpv4().map((a) => a.address))
  const errors = []
  for (const [channel, ip] of Object.entries(bindings)) {
    const trimmed = String(ip || '').trim()
    // Пустое («Автовыбор»), «Выключено» и «Чередование» не привязаны к конкретному IP.
    if (
      !trimmed ||
      isOutboundDisabledBindingValue(trimmed) ||
      isOutboundRotateBindingValue(trimmed)
    ) {
      continue
    }
    if (!allowed.has(trimmed)) {
      errors.push(`IP ${trimmed} для «${channel}» недоступен на этом сервере`)
    }
  }
  return errors
}

async function handleSetOutboundIpSettings({ payload, currentUserId, deps }) {
  const { saveOutboundIpSettings, saveOutboundIpBindings } = deps
  const raw = payload && payload.bindings != null ? payload.bindings : payload
  const bindings = normalizeOutboundBindings(raw)
  const rotation =
    payload && payload.rotation != null ? normalizeRotationConfig(payload.rotation) : undefined
  const errors = validateBindingsAgainstServer(bindings)
  if (errors.length) {
    return { statusCode: 400, data: { error: errors[0], errors } }
  }
  // saveOutboundIpSettings сохраняет привязки + ротацию одной записью; для совместимости
  // оставляем фолбэк на старый saveOutboundIpBindings, если новая функция не передана.
  const saved =
    typeof saveOutboundIpSettings === 'function'
      ? saveOutboundIpSettings(currentUserId, { bindings, rotation })
      : saveOutboundIpBindings(currentUserId, bindings)
  clearPlayerokHttpsAgentCache()
  return {
    statusCode: 200,
    data: {
      ok: true,
      bindings: saved.bindings,
      rotation: saved.rotation || { enabled: false },
      updatedAt: saved.updatedAt,
    },
  }
}

module.exports = { handleSetOutboundIpSettings }
