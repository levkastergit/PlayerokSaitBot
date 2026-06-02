function setupHistoryRepo(db) {
  const insertBump = db.prepare(`
    INSERT INTO bump_history (user_id, product_key, product_title, bumped_at, price, item_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `)

  const getBumpHistory = db.prepare(`
    SELECT product_key, product_title, bumped_at, price, item_id FROM bump_history
    WHERE user_id = ?
    ORDER BY bumped_at DESC LIMIT 500
  `)

  const insertSale = db.prepare(`
    INSERT OR REPLACE INTO sales_history
      (user_id, product_key, product_title, sold_at, price, status, deal_id, item_id, buyer_name, is_refund)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const getSalesHistory = db.prepare(`
    SELECT product_key, product_title, sold_at, price, status, is_refund, buyer_name
    FROM sales_history
    WHERE user_id = ?
    ORDER BY sold_at DESC
    LIMIT 500
  `)

  const getSalesHistoryAll = db.prepare(`
    SELECT product_key, product_title, sold_at, price, status, is_refund, buyer_name, deal_id, item_id
    FROM sales_history
    WHERE user_id = ?
    ORDER BY sold_at DESC
  `)

  const deleteSalesHistoryByUser = db.prepare(`
    DELETE FROM sales_history WHERE user_id = ?
  `)

  const insertListingFee = db.prepare(`
    INSERT INTO listing_fees (user_id, product_key, product_title, item_id, fee, relisted_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `)

  const getListingFees = db.prepare(`
    SELECT product_key, product_title, item_id, fee, relisted_at FROM listing_fees
    WHERE user_id = ?
    ORDER BY relisted_at DESC
  `)

  const insertAction = db.prepare(`
    INSERT INTO actions_history (
      user_id,
      action_type,
      product_key,
      product_title,
      item_id,
      amount,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `)

  const getActionsHistory = db.prepare(`
    SELECT action_type, product_key, product_title, item_id, amount, created_at
    FROM actions_history
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 1000
  `)

  // Таблица hidden_chats создаётся из приложения (ранние миграции могли её не содержать)
  db.exec(`
    CREATE TABLE IF NOT EXISTS hidden_chats (
      chat_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      hidden_at INTEGER NOT NULL,
      PRIMARY KEY (chat_id, user_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)

  const upsertHiddenChat = db.prepare(`
    INSERT OR REPLACE INTO hidden_chats (chat_id, user_id, hidden_at)
    VALUES (?, ?, ?)
  `)

  const deleteHiddenChat = db.prepare(`
    DELETE FROM hidden_chats WHERE chat_id = ? AND user_id = ?
  `)

  const getHiddenChats = db.prepare(`
    SELECT chat_id FROM hidden_chats WHERE user_id = ?
  `)

  const getSalesYears = db.prepare(`
    SELECT DISTINCT CAST(strftime('%Y', sold_at, 'unixepoch') AS INTEGER) AS year
    FROM sales_history
    WHERE sold_at > 0
    ORDER BY year DESC
  `)

  const getSalesMonthsForYear = db.prepare(`
    SELECT DISTINCT CAST(strftime('%m', sold_at, 'unixepoch') AS INTEGER) AS month
    FROM sales_history
    WHERE sold_at > 0 AND strftime('%Y', sold_at, 'unixepoch') = ?
    ORDER BY month ASC
  `)

  return {
    insertBump,
    getBumpHistory,
    insertSale,
    getSalesHistory,
    getSalesHistoryAll,
    deleteSalesHistoryByUser,
    insertListingFee,
    getListingFees,
    insertAction,
    getActionsHistory,
    upsertHiddenChat,
    deleteHiddenChat,
    getHiddenChats,
    getSalesYears,
    getSalesMonthsForYear,
  }
}

module.exports = { setupHistoryRepo }

