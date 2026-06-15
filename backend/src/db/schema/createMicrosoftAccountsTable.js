// Microsoft-аккаунты для метода «донат через Microsoft Store»: баланс MS Store (от подарочных карт)
// тратится на покупку Robux в UWP-приложении Roblox. Регион важен — Microsoft привязывает
// валюту/баланс к рынку аккаунта (VPN не обходит), поэтому храним market/region.
// Пароль/секреты шифруются тем же AES-GCM, что и токены Playerok (creds_enc).
function createMicrosoftAccountsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS microsoft_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      label TEXT,
      email TEXT,
      creds_enc TEXT,
      region TEXT,
      balance_amount REAL,
      balance_currency TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      last_error TEXT,
      last_used_at INTEGER,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_microsoft_accounts_user
    ON microsoft_accounts(user_id, created_at DESC, id DESC)
  `)
}

module.exports = { createMicrosoftAccountsTable }
