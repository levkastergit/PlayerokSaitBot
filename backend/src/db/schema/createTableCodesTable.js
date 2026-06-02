function createTableCodesTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS table_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      category TEXT NOT NULL,
      code TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      deal_id TEXT,
      item_id TEXT,
      chat_id TEXT,
      status_changed_at INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)

  // Миграция для уже существующей таблицы без поля used.
  try {
    db.exec(`
      ALTER TABLE table_codes
      ADD COLUMN used INTEGER NOT NULL DEFAULT 0
    `)
  } catch (_) {
    // ignore: колонка уже существует
  }

  try {
    db.exec(`
      ALTER TABLE table_codes
      ADD COLUMN deal_id TEXT
    `)
  } catch (_) {
    // ignore: колонка уже существует
  }

  try {
    db.exec(`
      ALTER TABLE table_codes
      ADD COLUMN item_id TEXT
    `)
  } catch (_) {
    // ignore: колонка уже существует
  }

  try {
    db.exec(`
      ALTER TABLE table_codes
      ADD COLUMN chat_id TEXT
    `)
  } catch (_) {
    // ignore: колонка уже существует
  }

  // Миграция для уже существующей таблицы без поля status_changed_at.
  try {
    db.exec(`
      ALTER TABLE table_codes
      ADD COLUMN status_changed_at INTEGER
    `)
  } catch (_) {
    // ignore: колонка уже существует
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_table_codes_user_category_created
    ON table_codes(user_id, category, created_at DESC, id DESC)
  `)
}

module.exports = { createTableCodesTable }
