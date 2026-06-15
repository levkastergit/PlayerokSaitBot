// Аккаунты Roblox для автовыдачи доната (метод game-pass, как у swizzyer.com).
// Cookie .ROBLOSECURITY хранится в зашифрованном виде (cookie_enc), как и токены Playerok.
function createRobloxAccountsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS roblox_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      roblox_user_id INTEGER NOT NULL,
      username TEXT,
      display_name TEXT,
      cookie_enc TEXT NOT NULL,
      robux INTEGER,
      is_premium INTEGER NOT NULL DEFAULT 0,
      avatar_url TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      last_error TEXT,
      last_checked_at INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, roblox_user_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_roblox_accounts_user_created
    ON roblox_accounts(user_id, created_at DESC, id DESC)
  `)
}

module.exports = { createRobloxAccountsTable }
