function createTableColumnsTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS table_columns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      subtab_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)

  db.exec(`
    CREATE TABLE IF NOT EXISTS table_code_column_values (
      code_id INTEGER NOT NULL,
      column_id INTEGER NOT NULL,
      value TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (code_id, column_id),
      FOREIGN KEY (code_id) REFERENCES table_codes(id) ON DELETE CASCADE,
      FOREIGN KEY (column_id) REFERENCES table_columns(id) ON DELETE CASCADE
    )
  `)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_table_columns_user_subtab_sort
    ON table_columns(user_id, subtab_id, sort_order ASC, id ASC)
  `)
}

module.exports = { createTableColumnsTables }
