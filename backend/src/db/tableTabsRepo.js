const DEFAULT_TAB_NAMES = ['Грок', 'чат гпт', 'Клод']

function setupTableTabsRepo(db, { deleteCodesByCategory, deleteColumnsBySubtabId }) {
  const getTabsByUser = db.prepare(`
    SELECT id, name, created_at
    FROM table_tabs
    WHERE user_id = ?
    ORDER BY created_at ASC, id ASC
  `)

  const getSubtabsByUser = db.prepare(`
    SELECT id, tab_id, name, created_at
    FROM table_subtabs
    WHERE user_id = ?
    ORDER BY created_at ASC, id ASC
  `)

  const insertTab = db.prepare(`
    INSERT INTO table_tabs (user_id, name, created_at)
    VALUES (?, ?, ?)
  `)

  const insertSubtab = db.prepare(`
    INSERT INTO table_subtabs (user_id, tab_id, name, created_at)
    VALUES (?, ?, ?, ?)
  `)

  const getTabById = db.prepare(`
    SELECT id, user_id, name
    FROM table_tabs
    WHERE id = ?
  `)

  const getSubtabById = db.prepare(`
    SELECT id, user_id, tab_id, name
    FROM table_subtabs
    WHERE id = ?
  `)

  const updateSubtabName = db.prepare(`
    UPDATE table_subtabs
    SET name = ?
    WHERE id = ? AND user_id = ?
  `)

  const getSubtabIdsByTabId = db.prepare(`
    SELECT id
    FROM table_subtabs
    WHERE tab_id = ? AND user_id = ?
  `)

  const deleteSubtabById = db.prepare(`
    DELETE FROM table_subtabs
    WHERE id = ? AND user_id = ?
  `)

  const deleteSubtabsByTabId = db.prepare(`
    DELETE FROM table_subtabs
    WHERE tab_id = ? AND user_id = ?
  `)

  const deleteTabById = db.prepare(`
    DELETE FROM table_tabs
    WHERE id = ? AND user_id = ?
  `)

  const deleteSubtabTx = db.transaction((userId, subtabId) => {
    deleteCodesByCategory.run(userId, `subtab:${subtabId}`)
    deleteColumnsBySubtabId.run(subtabId, userId)
    return deleteSubtabById.run(subtabId, userId)
  })

  const deleteTabTx = db.transaction((userId, tabId) => {
    const subtabs = getSubtabIdsByTabId.all(tabId, userId)
    for (const row of subtabs) {
      deleteCodesByCategory.run(userId, `subtab:${row.id}`)
      deleteColumnsBySubtabId.run(row.id, userId)
    }
    deleteSubtabsByTabId.run(tabId, userId)
    return deleteTabById.run(tabId, userId)
  })

  const ensureDefaultTabsTx = db.transaction((userId, nowTs) => {
    const existingTabs = getTabsByUser.all(userId)
    if (existingTabs.length > 0) return

    for (const tabName of DEFAULT_TAB_NAMES) {
      const tabInfo = insertTab.run(userId, tabName, nowTs)
      const tabId = Number(tabInfo.lastInsertRowid)
      insertSubtab.run(userId, tabId, 'Таблица 1', nowTs)
    }
  })

  return {
    getTabsByUser,
    getSubtabsByUser,
    insertTab,
    insertSubtab,
    getTabById,
    getSubtabById,
    getSubtabIdsByTabId,
    updateSubtabName,
    deleteSubtabTx,
    deleteTabTx,
    ensureDefaultTabsTx,
  }
}

module.exports = { setupTableTabsRepo }
