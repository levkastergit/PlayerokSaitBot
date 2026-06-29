'use strict'

const {
  normalizeSpeedConfig,
  invalidateSpeedCache,
  getSpeedSettingsForUi,
} = require('../../infra/playerokSpeedSettings')

// Сохраняет настройки скорости/задержек. Принимает payload.speed = { key: number|'' }.
// Пустые/невалидные значения отбрасываются (для них действует дефолт). Клампы применяются в
// normalizeSpeedConfig. После сохранения — сброс TTL-кэша, чтобы изменения применились сразу.
async function handleSetSpeedSettings({ payload, currentUserId, deps }) {
  const { saveOutboundSpeed } = deps
  if (typeof saveOutboundSpeed !== 'function') {
    return { statusCode: 500, data: { error: 'speed settings storage unavailable' } }
  }
  const raw = payload && payload.speed != null ? payload.speed : payload
  const speed = normalizeSpeedConfig(raw)
  const saved = saveOutboundSpeed(currentUserId, speed)
  invalidateSpeedCache()
  const { defs } = getSpeedSettingsForUi()
  return {
    statusCode: 200,
    data: {
      ok: true,
      defs,
      values: saved.speed || speed,
      updatedAt: saved.updatedAt,
    },
  }
}

module.exports = { handleSetSpeedSettings }
