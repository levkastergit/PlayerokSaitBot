function createBumpHistoryTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bump_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      product_key TEXT NOT NULL,
      product_title TEXT NOT NULL,
      bumped_at INTEGER NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      item_id TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)

  db.exec(`CREATE INDEX IF NOT EXISTS idx_bump_history_item ON bump_history(item_id)`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bump_history_bumped_at ON bump_history(user_id, bumped_at DESC)`)
}

module.exports = { createBumpHistoryTable }

