function createPlayerokOutboundIpSettingsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS playerok_outbound_ip_settings (
      user_id INTEGER PRIMARY KEY,
      bindings_json TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    )
  `)
}

module.exports = { createPlayerokOutboundIpSettingsTable }
