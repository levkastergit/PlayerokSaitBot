function createSwizzyerOrdersTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS swizzyer_orders (
      user_id INTEGER NOT NULL,
      deal_id TEXT NOT NULL,
      chat_id TEXT,
      order_id TEXT,
      denomination_id TEXT,
      roblox_username TEXT,
      status TEXT,
      last_version INTEGER,
      failure_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, deal_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)
  // Корреляция вебхука (приходит по order_id) с нашей сделкой/чатом.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_swizzyer_orders_order_id ON swizzyer_orders (order_id)`)
}

module.exports = { createSwizzyerOrdersTable }
