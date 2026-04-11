function createTokensTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token TEXT NOT NULL,
      token_enc TEXT,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)
  // Required for INSERT ... ON CONFLICT(user_id); older DBs were created without UNIQUE.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS tokens_user_id_unique ON tokens(user_id)
  `)
}

module.exports = { createTokensTable }

