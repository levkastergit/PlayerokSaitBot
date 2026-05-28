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
}

module.exports = { createChatThreadsTable }

