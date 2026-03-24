function createSalesHistoryTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sales_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      product_key TEXT NOT NULL,
      product_title TEXT NOT NULL,
      sold_at INTEGER NOT NULL,
      price REAL NOT NULL DEFAULT 0,
      status TEXT,
      deal_id TEXT,
      item_id TEXT,
      buyer_name TEXT,
      is_refund INTEGER DEFAULT 0,
      UNIQUE(deal_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)

  db.exec(`CREATE INDEX IF NOT EXISTS idx_sales_history_sold_at ON sales_history(user_id, sold_at DESC)`)
}

module.exports = { createSalesHistoryTable }

