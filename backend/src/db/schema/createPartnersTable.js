function createPartnersTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS partner_invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_user_id INTEGER NOT NULL,
      worker_user_id INTEGER NOT NULL,
      invite_password_hash TEXT NOT NULL,
      connect_status INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(owner_user_id, worker_user_id)
    )
  `)
}

module.exports = { createPartnersTable }

