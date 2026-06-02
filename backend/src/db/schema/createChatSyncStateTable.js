function createChatSyncStateTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_sync_state (
      user_id INTEGER PRIMARY KEY,
      poll_cursor TEXT,
      last_poll_at INTEGER NOT NULL DEFAULT 0,
      last_success_at INTEGER NOT NULL DEFAULT 0,
      scan_in_progress INTEGER NOT NULL DEFAULT 0,
      scan_progress_total INTEGER NOT NULL DEFAULT 0,
      scan_progress_done INTEGER NOT NULL DEFAULT 0,
      full_scan_completed_at INTEGER NOT NULL DEFAULT 0,
      full_scan_requested_at INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      scan_current_chat_id TEXT,
      scan_current_label TEXT,
      scan_step TEXT,
      updated_at INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)
  const extraCols = [
    ['scan_current_chat_id', 'TEXT'],
    ['scan_current_label', 'TEXT'],
    ['scan_step', 'TEXT'],
    ['scan_phase', 'TEXT'],
    ['scan_paused', 'INTEGER NOT NULL DEFAULT 0'],
    ['list_cursor', 'TEXT'],
    ['list_scan_completed_at', 'INTEGER NOT NULL DEFAULT 0'],
  ]
  for (const [name, type] of extraCols) {
    try {
      db.exec(`ALTER TABLE chat_sync_state ADD COLUMN ${name} ${type}`)
    } catch (_) {
      // column already exists
    }
  }
}

module.exports = { createChatSyncStateTable }

