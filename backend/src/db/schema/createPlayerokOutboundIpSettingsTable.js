function createPlayerokOutboundIpSettingsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS playerok_outbound_ip_settings (
      user_id INTEGER PRIMARY KEY,
      bindings_json TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    )
  `)

  // Миграция для существующих БД: конфиг ротации IP ({ enabled }) хранится отдельной
  // колонкой. ALTER TABLE ADD COLUMN идемпотентен только при отсутствии колонки —
  // проверяем через PRAGMA, чтобы не падать на повторном запуске.
  const cols = db.prepare(`PRAGMA table_info(playerok_outbound_ip_settings)`).all()
  const hasRotationColumn = cols.some((col) => col && col.name === 'rotation_json')
  if (!hasRotationColumn) {
    db.exec(
      `ALTER TABLE playerok_outbound_ip_settings ADD COLUMN rotation_json TEXT NOT NULL DEFAULT '{}'`
    )
  }

  // Миграция: настраиваемые из /settings параметры скорости/задержек хранятся в speed_json.
  const hasSpeedColumn = cols.some((col) => col && col.name === 'speed_json')
  if (!hasSpeedColumn) {
    db.exec(
      `ALTER TABLE playerok_outbound_ip_settings ADD COLUMN speed_json TEXT NOT NULL DEFAULT '{}'`
    )
  }
}

module.exports = { createPlayerokOutboundIpSettingsTable }
