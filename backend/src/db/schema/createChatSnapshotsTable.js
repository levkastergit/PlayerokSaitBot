function createChatSnapshotsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_snapshots (
      user_id INTEGER NOT NULL,
      cache_key TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, cache_key),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)
}

module.exports = { createChatSnapshotsTable }

