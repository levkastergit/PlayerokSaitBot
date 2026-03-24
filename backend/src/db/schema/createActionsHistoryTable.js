function createActionsHistoryTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS actions_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      action_type TEXT NOT NULL,
      product_key TEXT NOT NULL,
      product_title TEXT NOT NULL,
      item_id TEXT,
      amount REAL NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_actions_history_user_created
    ON actions_history(user_id, created_at DESC)
  `)
}

module.exports = { createActionsHistoryTable }
