function createSwizzyerSettingsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS swizzyer_settings (
      user_id INTEGER PRIMARY KEY,
      api_key_enc TEXT,
      webhook_secret_enc TEXT,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)
}

module.exports = { createSwizzyerSettingsTable }
