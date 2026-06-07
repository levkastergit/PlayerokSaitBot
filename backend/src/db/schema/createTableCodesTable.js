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

  // Трёхзначный статус кода: 'unused' (свободен) | 'pending' (зарезервирован/в ожидании
  // активации) | 'used' (использован). Прежнее булево поле `used` сохраняем синхронным
  // (used=1 ⇔ status='used') ради обратной совместимости старых выборок/фильтров.
  // ALTER ADD COLUMN с DEFAULT проставит всем существующим строкам 'unused' —
  // поэтому только что после добавления столбца разово бэкфиллим 'used' для used=1.
  try {
    db.exec(`
      ALTER TABLE table_codes
      ADD COLUMN status TEXT NOT NULL DEFAULT 'unused'
    `)
  } catch (_) {
    // ignore: колонка уже существует
  }

  // Бэкфилл/самолечение: used=1 ⇔ status='used' (идемпотентно, дёшево). Выполняем
  // безусловно — чтобы привести в согласованность старые строки независимо от того,
  // был ли столбец только что добавлен или существовал ранее без бэкфилла.
  try {
    db.exec(`
      UPDATE table_codes SET status = 'used' WHERE used = 1 AND status != 'used'
    `)
  } catch (_) {
    // ignore: столбец status ещё не существует (крайне маловероятно после ALTER выше)
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_table_codes_user_category_created
    ON table_codes(user_id, category, created_at DESC, id DESC)
  `)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_table_codes_user_category_status
    ON table_codes(user_id, category, status, created_at ASC, id ASC)
  `)
}

module.exports = { createTableCodesTable }
