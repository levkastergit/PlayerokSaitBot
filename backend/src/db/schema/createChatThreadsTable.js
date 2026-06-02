function createChatThreadsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      chat_id TEXT NOT NULL,
      buyer_name TEXT,
      item_title TEXT,
      item_image_url TEXT,
      category TEXT,
      status TEXT,
      last_message_id TEXT,
      last_message_text TEXT,
      last_message_created_at TEXT,
      last_deal_id TEXT,
      last_item_id TEXT,
      unread_count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      synced_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS chat_threads_user_chat_unique
    ON chat_threads(user_id, chat_id)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS chat_threads_user_updated_idx
    ON chat_threads(user_id, updated_at DESC)
  `)
  const extraCols = [
    ['last_message_sender_username', 'TEXT'],
    ['last_message_from_buyer', 'INTEGER'],
  ]
  for (const [name, type] of extraCols) {
    try {
      db.exec(`ALTER TABLE chat_threads ADD COLUMN ${name} ${type}`)
    } catch (_) {
      // column already exists
    }
  }

  // Локальное состояние прочтения (на нашем сайте): какое сообщение прочитано
  // последним и в какой момент. Непрочитанность считаем сами, не доверяя Playerok.
  // Бэкфилл выполняется ОДИН раз при первом создании колонки: все существующие
  // чаты считаем уже прочитанными, чтобы при апгрейде не подсветить разом всё.
  try {
    db.exec(`ALTER TABLE chat_threads ADD COLUMN last_read_message_id TEXT`)
    db.exec(`UPDATE chat_threads SET last_read_message_id = last_message_id`)
  } catch (_) {
    // column already exists
  }
  try {
    db.exec(`ALTER TABLE chat_threads ADD COLUMN last_read_ts INTEGER`)
    db.exec(`UPDATE chat_threads SET last_read_ts = CAST(strftime('%s','now') AS INTEGER)`)
  } catch (_) {
    // column already exists
  }
}

module.exports = { createChatThreadsTable }

