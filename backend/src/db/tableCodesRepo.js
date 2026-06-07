function setupTableCodesRepo(db) {
  const insertCode = db.prepare(`
    INSERT INTO table_codes (user_id, category, code, used, deal_id, item_id, chat_id, status_changed_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  const getCodesByUserAndCategory = db.prepare(`
    SELECT id, code, used, status, deal_id, item_id, chat_id, status_changed_at, created_at
    FROM table_codes
    WHERE user_id = ? AND category = ?
    ORDER BY created_at DESC, id DESC
    LIMIT 1000
  `)

  // Ручное переключение статуса из таблицы (UI): держим used и status согласованными.
  const updateCodeUsed = db.prepare(`
    UPDATE table_codes
    SET used = ?, status = ?, status_changed_at = ?
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

  // Свободным считается только status='unused' — зарезервированные ('pending') и
  // использованные ('used') коды в выдачу не попадают, чтобы исключить двойную выдачу.
  const selectOldestUnusedCode = db.prepare(`
    SELECT id, code
    FROM table_codes
    WHERE user_id = ? AND category = ? AND status = 'unused'
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `)

  // Резерв кода под выдачу: мгновенная выдача → сразу 'used'; интерактивные флоу
  // (clode/gpt) → 'pending' (в ожидании), финализируется markCodeUsed после успеха.
  const claimCodeWithMeta = db.prepare(`
    UPDATE table_codes
    SET used = ?, status = ?, status_changed_at = ?, deal_id = ?, item_id = ?, chat_id = ?
    WHERE id = ? AND user_id = ? AND status = 'unused'
  `)

  // Финализация зарезервированного кода: 'pending' → 'used' после подтверждённой выдачи.
  const markCodeUsedStmt = db.prepare(`
    UPDATE table_codes
    SET used = 1, status = 'used', status_changed_at = ?
    WHERE id = ? AND user_id = ?
  `)

  // Возврат кода в пул ('unused') при провале активации — чтобы код не пропадал.
  const releaseCodeStmt = db.prepare(`
    UPDATE table_codes
    SET used = 0, status = 'unused', status_changed_at = ?, deal_id = NULL, item_id = NULL, chat_id = NULL
    WHERE id = ? AND user_id = ?
  `)

  const claimNextUnusedCodeTx = db.transaction((userId, category, meta) => {
    const row = selectOldestUnusedCode.get(userId, category)
    if (!row) return null
    const nowTs =
      Number(meta?.nowTs) > 0 ? Math.floor(Number(meta.nowTs)) : Math.floor(Date.now() / 1000)
    const pending = Boolean(meta?.pending)
    const info = claimCodeWithMeta.run(
      pending ? 0 : 1,
      pending ? 'pending' : 'used',
      nowTs,
      meta?.dealId != null ? String(meta.dealId) : null,
      meta?.itemId != null ? String(meta.itemId) : null,
      meta?.chatId != null ? String(meta.chatId) : null,
      row.id,
      userId
    )
    if (!info.changes) return null
    return { id: row.id, code: String(row.code || '').trim() }
  })

  function claimNextUnusedCode(userId, category, meta = {}) {
    const uid = Number(userId)
    const cat = String(category || '').trim()
    if (!Number.isFinite(uid) || uid <= 0 || !cat) return null
    return claimNextUnusedCodeTx(uid, cat, meta)
  }

  function markCodeUsed(userId, codeId, meta = {}) {
    const uid = Number(userId)
    const cid = Number(codeId)
    if (!Number.isFinite(uid) || uid <= 0 || !Number.isFinite(cid) || cid <= 0) return false
    const nowTs =
      Number(meta?.nowTs) > 0 ? Math.floor(Number(meta.nowTs)) : Math.floor(Date.now() / 1000)
    return Boolean(markCodeUsedStmt.run(nowTs, cid, uid).changes)
  }

  function releaseCode(userId, codeId, meta = {}) {
    const uid = Number(userId)
    const cid = Number(codeId)
    if (!Number.isFinite(uid) || uid <= 0 || !Number.isFinite(cid) || cid <= 0) return false
    const nowTs =
      Number(meta?.nowTs) > 0 ? Math.floor(Number(meta.nowTs)) : Math.floor(Date.now() / 1000)
    return Boolean(releaseCodeStmt.run(nowTs, cid, uid).changes)
  }

  const insertCodesBulk = db.transaction((userId, category, codesList) => {
    const nowTs = Math.floor(Date.now() / 1000)
    const items = []
    for (const code of codesList) {
      const info = insertCode.run(userId, category, code, 0, null, null, null, null, nowTs)
      items.push({
        id: info.lastInsertRowid,
        code,
        used: false,
        status: 'unused',
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
    claimNextUnusedCode,
    markCodeUsed,
    releaseCode,
  }
}

module.exports = { setupTableCodesRepo }
