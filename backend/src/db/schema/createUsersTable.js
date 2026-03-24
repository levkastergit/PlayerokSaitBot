function createUsersTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      login TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      module_supercell INTEGER NOT NULL DEFAULT 0
    )
  `)

  // Миграция для уже существующей таблицы users без module_supercell.
  const columns = db.prepare(`PRAGMA table_info(users)`).all()
  const hasModuleSupercell = Array.isArray(columns) && columns.some((c) => c && c.name === 'module_supercell')
  if (!hasModuleSupercell) {
    db.exec(`ALTER TABLE users ADD COLUMN module_supercell INTEGER NOT NULL DEFAULT 0`)
  }
}

module.exports = { createUsersTable }

