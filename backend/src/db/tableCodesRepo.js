function setupTableCodesRepo(db) {
  const insertCode = db.prepare(`
    INSERT INTO table_codes (user_id, category, code, used, deal_id, item_id, chat_id, status_changed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const getCodesByUserAndCategory = db.prepare(`
    SELECT id, code, used, deal_id, item_id, chat_id, status_changed_at, created_at
    FROM table_codes
    WHERE user_id = ? AND category = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1000
  `)

  const updateCodeUsed = db.prepare(`
    UPDATE table_codes
    SET used = ?, status_changed_at = ?
    WHERE id = ? AND user_id = ?
  `)

  const deleteCodeById = db.prepare(`
    DELETE FROM table_codes
    WHERE id = ? AND user_id = ?
  `)

  const deleteCodesByCategory = db.prepare(`
    DELETE FROM table_codes
    WHERE user_id = ? AND category = ?
  `)

  const getCodeById = db.prepare(`
    SELECT id, user_id, category
    FROM table_codes
    WHERE id = ?
  `)

  const insertCodesBulk = db.transaction((userId, category, codesList) => {
    const nowTs = Math.floor(Date.now() / 1000)
    const items = []
    for (const code of codesList) {
      const info = insertCode.run(userId, category, code, 0, null, null, null, null, nowTs)
      items.push({
        id: info.lastInsertRowid,
        code,
        used: false,
        dealId: null,
        itemId: null,
        chatId: null,
        statusChangedAt: null,
        createdAt: nowTs,
        customValues: {},
      })
    }
    return items
  })

  return {
    insertCode,
    insertCodesBulk,
    getCodesByUserAndCategory,
    updateCodeUsed,
    deleteCodeById,
    deleteCodesByCategory,
    getCodeById,
  }
}

module.exports = { setupTableCodesRepo }
