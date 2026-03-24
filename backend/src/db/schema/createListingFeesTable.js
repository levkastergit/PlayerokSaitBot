function createListingFeesTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS listing_fees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      product_key TEXT NOT NULL,
      fee REAL NOT NULL DEFAULT 0,
      relisted_at INTEGER NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)

  const columns = db.prepare(`PRAGMA table_info(listing_fees)`).all()
  const names = new Set(columns.map((c) => String(c.name)))
  if (!names.has('product_title')) {
    db.exec(`ALTER TABLE listing_fees ADD COLUMN product_title TEXT`)
  }
  if (!names.has('item_id')) {
    db.exec(`ALTER TABLE listing_fees ADD COLUMN item_id TEXT`)
  }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_listing_fees_product ON listing_fees(user_id, product_key, relisted_at)`)
}

module.exports = { createListingFeesTable }

