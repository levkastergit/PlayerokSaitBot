function createChatDealsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_deals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      deal_id TEXT NOT NULL,
      chat_id TEXT,
      item_id TEXT,
      item_title TEXT,
      item_image_url TEXT,
      category TEXT,
      buyer_name TEXT,
      status TEXT,
      is_paid_marker_seen INTEGER NOT NULL DEFAULT 0,
      last_message_id TEXT,
      last_seen_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS chat_deals_user_deal_unique
    ON chat_deals(user_id, deal_id)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS chat_deals_user_chat_idx
    ON chat_deals(user_id, chat_id)
  `)
  try {
    db.exec('ALTER TABLE chat_deals ADD COLUMN item_image_url TEXT')
  } catch (_) {
    // column already exists
  }
}

module.exports = { createChatDealsTable }

