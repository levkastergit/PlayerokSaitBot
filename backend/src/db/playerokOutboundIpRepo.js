'use strict'

const {
  normalizeOutboundBindings,
  normalizeRotationConfig,
} = require('../infra/playerokOutboundChannels')
const { normalizeSpeedConfig } = require('../infra/playerokSpeedSettings')

function setupPlayerokOutboundIpRepo(db) {
  const getRow = db.prepare(`
    SELECT bindings_json, rotation_json, speed_json, updated_at FROM playerok_outbound_ip_settings WHERE user_id = ?
  `)

  const upsertRow = db.prepare(`
    INSERT INTO playerok_outbound_ip_settings (user_id, bindings_json, rotation_json, speed_json, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      bindings_json = excluded.bindings_json,
      rotation_json = excluded.rotation_json,
      speed_json = excluded.speed_json,
      updated_at = excluded.updated_at
  `)

  function loadBindings(userId) {
    try {
      const row = getRow.get(Number(userId))
      if (!row || !row.bindings_json) return {}
      const parsed = JSON.parse(String(row.bindings_json))
      return normalizeOutboundBindings(parsed)
    } catch (e) {
      console.warn('[outbound-ip] loadBindings', e && e.message ? e.message : e)
      return {}
    }
  }

  function loadRotation(userId) {
    try {
      const row = getRow.get(Number(userId))
      if (!row || !row.rotation_json) return { enabled: false, excludedIps: [] }
      return normalizeRotationConfig(JSON.parse(String(row.rotation_json)))
    } catch (e) {
      console.warn('[outbound-ip] loadRotation', e && e.message ? e.message : e)
      return { enabled: false, excludedIps: [] }
    }
  }

  // Настройки скорости/задержек (только явно заданные оператором значения; пустое = дефолт).
  function loadSpeed(userId) {
    try {
      const row = getRow.get(Number(userId))
      if (!row || !row.speed_json) return {}
      return normalizeSpeedConfig(JSON.parse(String(row.speed_json)))
    } catch (e) {
      console.warn('[outbound-ip] loadSpeed', e && e.message ? e.message : e)
      return {}
    }
  }

  // Сохраняем привязки, конфиг ротации и скорости одной записью (общий updated_at). Если
  // какая-то часть не передана — сохраняем уже существующее значение.
  function saveSettings(userId, { bindings, rotation, speed } = {}) {
    const normalizedBindings =
      bindings !== undefined ? normalizeOutboundBindings(bindings) : loadBindings(userId)
    const normalizedRotation =
      rotation !== undefined ? normalizeRotationConfig(rotation) : loadRotation(userId)
    const normalizedSpeed =
      speed !== undefined ? normalizeSpeedConfig(speed) : loadSpeed(userId)
    const now = Math.floor(Date.now() / 1000)
    upsertRow.run(
      Number(userId),
      JSON.stringify(normalizedBindings),
      JSON.stringify(normalizedRotation),
      JSON.stringify(normalizedSpeed),
      now
    )
    return {
      bindings: normalizedBindings,
      rotation: normalizedRotation,
      speed: normalizedSpeed,
      updatedAt: now,
    }
  }

  // Обратная совместимость со старой сигнатурой saveBindings(userId, bindings).
  function saveBindings(userId, bindings) {
    return saveSettings(userId, { bindings })
  }

  function saveSpeed(userId, speed) {
    return saveSettings(userId, { speed })
  }

  return { loadBindings, loadRotation, loadSpeed, saveBindings, saveSpeed, saveSettings }
}

module.exports = { setupPlayerokOutboundIpRepo }
