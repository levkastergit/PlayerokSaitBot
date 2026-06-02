function setupTableColumnsRepo(db) {
  const getColumnsBySubtab = db.prepare(`
    SELECT id, name, sort_order, created_at
    FROM table_columns
    WHERE user_id = ? AND subtab_id = ?
    ORDER BY sort_order ASC, id ASC
  `)

  const getColumnById = db.prepare(`
    SELECT id, user_id, subtab_id, name, sort_order
    FROM table_columns
    WHERE id = ?
  `)

  const getMaxSortOrderBySubtab = db.prepare(`
    SELECT COALESCE(MAX(sort_order), -1) AS max_sort
    FROM table_columns
    WHERE user_id = ? AND subtab_id = ?
  `)

  const insertColumn = db.prepare(`
    INSERT INTO table_columns (user_id, subtab_id, name, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?)
  `)

  const updateColumnName = db.prepare(`
    UPDATE table_columns
    SET name = ?
    WHERE id = ? AND user_id = ?
  `)

  const deleteColumnById = db.prepare(`
    DELETE FROM table_columns
    WHERE id = ? AND user_id = ?
  `)

  const deleteColumnsBySubtabId = db.prepare(`
    DELETE FROM table_columns
    WHERE subtab_id = ? AND user_id = ?
  `)

  const getValuesByCategory = db.prepare(`
    SELECT v.code_id, v.column_id, v.value
    FROM table_code_column_values v
    INNER JOIN table_codes c ON c.id = v.code_id
    WHERE c.user_id = ? AND c.category = ?
  `)

  const upsertCellValue = db.prepare(`
    INSERT INTO table_code_column_values (code_id, column_id, value)
    VALUES (?, ?, ?)
    ON CONFLICT(code_id, column_id) DO UPDATE SET value = excluded.value
  `)

  return {
    getColumnsBySubtab,
    getColumnById,
    getMaxSortOrderBySubtab,
    insertColumn,
    updateColumnName,
    deleteColumnById,
    deleteColumnsBySubtabId,
    getValuesByCategory,
    upsertCellValue,
  }
}

module.exports = { setupTableColumnsRepo }
