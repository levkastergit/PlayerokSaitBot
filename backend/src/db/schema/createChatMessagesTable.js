function createChatMessagesTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      deal_id TEXT,
      sender_username TEXT,
      text TEXT,
      image_url TEXT,
      created_at TEXT,
      created_ts INTEGER NOT NULL DEFAULT 0,
      raw_json TEXT,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS chat_messages_user_chat_message_unique
    ON chat_messages(user_id, chat_id, message_id)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS chat_messages_user_chat_created_idx
    ON chat_messages(user_id, chat_id, created_ts ASC, id ASC)
  `)
}

module.exports = { createChatMessagesTable }

