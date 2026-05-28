function createApprouteSettingsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS approute_settings (
      user_id INTEGER PRIMARY KEY,
      api_key_enc TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)
}

module.exports = { createApprouteSettingsTable }
