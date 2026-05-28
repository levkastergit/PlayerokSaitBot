function createChatSyncRunsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_sync_runs (
      run_id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      total_chats INTEGER NOT NULL DEFAULT 0,
      processed_chats INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      error TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS chat_sync_runs_user_started_idx
    ON chat_sync_runs(user_id, started_at DESC)
  `)
}

module.exports = { createChatSyncRunsTable }

