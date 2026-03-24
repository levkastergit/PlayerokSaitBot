function createProductSettingsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_settings (
      user_id INTEGER NOT NULL,
      product_key TEXT NOT NULL,
      settings TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, product_key),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)
}

module.exports = { createProductSettingsTable }

