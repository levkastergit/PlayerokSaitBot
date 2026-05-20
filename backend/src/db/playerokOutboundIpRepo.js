'use strict'

const { normalizeOutboundBindings } = require('../infra/playerokOutboundChannels')

function setupPlayerokOutboundIpRepo(db) {
  const getRow = db.prepare(`
    SELECT bindings_json, updated_at FROM playerok_outbound_ip_settings WHERE user_id = ?
  `)

  const upsertRow = db.prepare(`
    INSERT INTO playerok_outbound_ip_settings (user_id, bindings_json, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      bindings_json = excluded.bindings_json,
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

  function saveBindings(userId, bindings) {
    const normalized = normalizeOutboundBindings(bindings)
    const json = JSON.stringify(normalized)
    const now = Math.floor(Date.now() / 1000)
    upsertRow.run(Number(userId), json, now)
    return { bindings: normalized, updatedAt: now }
  }

  return { loadBindings, saveBindings }
}

module.exports = { setupPlayerokOutboundIpRepo }
