function createTableTabsTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS table_tabs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS table_subtabs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      tab_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (tab_id) REFERENCES table_tabs(id) ON DELETE CASCADE
    )
  `)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_table_tabs_user_created
    ON table_tabs(user_id, created_at ASC, id ASC)
  `)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_table_subtabs_user_tab_created
    ON table_subtabs(user_id, tab_id, created_at ASC, id ASC)
  `)
}

module.exports = { createTableTabsTables }
