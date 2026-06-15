const crypto = require('crypto')

// Машина состояний заказов автовыдачи Robux (метод MS Store). См. createRobloxOrdersTable.js.
const ACTIVE_STATUSES = ['queued', 'awaiting_login', 'awaiting_2fa', 'ready', 'claimed', 'purchasing', 'claiming', 'verifying']
const TERMINAL_STATUSES = ['delivered', 'failed', 'canceled']

function setupRobloxOrdersRepo(db) {
  const listStmt = db.prepare(`
    SELECT * FROM roblox_orders WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
  `)
  const getByIdStmt = db.prepare(`SELECT * FROM roblox_orders WHERE user_id = ? AND id = ?`)
  const getByPublicIdStmt = db.prepare(`SELECT * FROM roblox_orders WHERE public_id = ?`)
  const getByTwofaTokenStmt = db.prepare(`SELECT * FROM roblox_orders WHERE twofa_token = ?`)

  const insertStmt = db.prepare(`
    INSERT INTO roblox_orders
      (user_id, public_id, robux_amount, buyer_username, buyer_account_id, microsoft_account_id,
       status, phase, note, log, created_at, updated_at)
    VALUES
      (@user_id, @public_id, @robux_amount, @buyer_username, @buyer_account_id, @microsoft_account_id,
       @status, @phase, @note, @log, @created_at, @updated_at)
  `)

  // Атомарный захват следующего готового заказа воркером (ready → claimed).
  const claimNextReadyStmt = db.prepare(`
    UPDATE roblox_orders
    SET status = 'claimed', worker_id = @worker_id, phase = 'claimed', updated_at = @now
    WHERE id = (
      SELECT id FROM roblox_orders
      WHERE status = 'ready'
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    )
    RETURNING *
  `)

  const setStateStmt = db.prepare(`
    UPDATE roblox_orders
    SET status = @status,
        phase = @phase,
        last_error = @last_error,
        log = @log,
        updated_at = @now,
        delivered_at = @delivered_at
    WHERE id = @id
  `)

  const setTwofaStmt = db.prepare(`
    UPDATE roblox_orders
    SET status = 'awaiting_2fa', phase = 'awaiting_2fa', twofa_token = @twofa_token,
        twofa_media_type = @twofa_media_type, updated_at = @now
    WHERE user_id = @user_id AND id = @id
  `)

  const setBuyerAccountStmt = db.prepare(`
    UPDATE roblox_orders
    SET buyer_account_id = @buyer_account_id, buyer_username = @buyer_username,
        status = 'ready', phase = 'ready', twofa_token = NULL, updated_at = @now
    WHERE id = @id
  `)

  const setMsAccountStmt = db.prepare(`
    UPDATE roblox_orders SET microsoft_account_id = @microsoft_account_id, updated_at = @now WHERE user_id = @user_id AND id = @id
  `)

  function mapRow(row) {
    if (!row) return null
    let log = []
    try {
      log = row.log ? JSON.parse(row.log) : []
    } catch (_) {
      log = []
    }
    return {
      id: row.id,
      userId: Number(row.user_id),
      publicId: row.public_id,
      robuxAmount: Number(row.robux_amount),
      buyerUsername: row.buyer_username || null,
      buyerAccountId: row.buyer_account_id != null ? Number(row.buyer_account_id) : null,
      microsoftAccountId: row.microsoft_account_id != null ? Number(row.microsoft_account_id) : null,
      status: row.status,
      phase: row.phase || null,
      twofaMediaType: row.twofa_media_type || null,
      workerId: row.worker_id || null,
      note: row.note || null,
      lastError: row.last_error || null,
      log,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      deliveredAt: row.delivered_at != null ? Number(row.delivered_at) : null,
    }
  }

  function appendLog(existingLogJson, message, phase) {
    let arr = []
    try {
      arr = existingLogJson ? JSON.parse(existingLogJson) : []
    } catch (_) {
      arr = []
    }
    arr.push({ at: Math.floor(Date.now() / 1000), phase: phase || null, message: String(message || '') })
    // Держим компактным: последние 100 записей.
    if (arr.length > 100) arr = arr.slice(arr.length - 100)
    return JSON.stringify(arr)
  }

  function listOrders(userId, limit = 100) {
    const lim = Number.isFinite(Number(limit)) && Number(limit) > 0 ? Math.min(500, Math.floor(Number(limit))) : 100
    return (listStmt.all(Number(userId), lim) || []).map(mapRow)
  }

  function getOrder(userId, id) {
    return mapRow(getByIdStmt.get(Number(userId), Number(id)))
  }

  function getOrderByPublicId(publicId) {
    return mapRow(getByPublicIdStmt.get(String(publicId || '')))
  }

  function getOrderByTwofaToken(token) {
    return mapRow(getByTwofaTokenStmt.get(String(token || '')))
  }

  function createOrder(userId, { robuxAmount, buyerUsername, note, microsoftAccountId }) {
    const now = Math.floor(Date.now() / 1000)
    const publicId = `RBX-${crypto.randomBytes(4).toString('hex').toUpperCase()}`
    const info = insertStmt.run({
      user_id: Number(userId),
      public_id: publicId,
      robux_amount: Number(robuxAmount),
      buyer_username: buyerUsername != null ? String(buyerUsername) : null,
      buyer_account_id: null,
      microsoft_account_id: microsoftAccountId != null ? Number(microsoftAccountId) : null,
      status: 'awaiting_login',
      phase: 'awaiting_login',
      note: note != null ? String(note) : null,
      log: appendLog(null, 'Заказ создан, ожидает входа покупателя', 'awaiting_login'),
      created_at: now,
      updated_at: now,
    })
    return getOrder(userId, info.lastInsertRowid)
  }

  // Перевести заказ в произвольный статус с записью в лог.
  function setState(userId, id, { status, phase, lastError, logMessage }) {
    const cur = getByIdStmt.get(Number(userId), Number(id))
    if (!cur) return null
    const now = Math.floor(Date.now() / 1000)
    setStateStmt.run({
      id: Number(id),
      status: status != null ? String(status) : cur.status,
      phase: phase !== undefined ? (phase != null ? String(phase) : null) : cur.phase,
      last_error: lastError !== undefined ? (lastError != null ? String(lastError) : null) : cur.last_error,
      log: logMessage ? appendLog(cur.log, logMessage, phase || cur.phase) : cur.log,
      now,
      delivered_at: status === 'delivered' ? now : cur.delivered_at,
    })
    return getOrder(userId, id)
  }

  function setTwofaPending(userId, id, mediaType) {
    const token = crypto.randomBytes(16).toString('hex')
    setTwofaStmt.run({
      user_id: Number(userId),
      id: Number(id),
      twofa_token: token,
      twofa_media_type: mediaType != null ? String(mediaType) : null,
      now: Math.floor(Date.now() / 1000),
    })
    return token
  }

  function setBuyerSession(userId, id, { buyerAccountId, buyerUsername }) {
    setBuyerAccountStmt.run({
      id: Number(id),
      buyer_account_id: Number(buyerAccountId),
      buyer_username: buyerUsername != null ? String(buyerUsername) : null,
      now: Math.floor(Date.now() / 1000),
    })
    return getOrder(userId, id)
  }

  function setMicrosoftAccount(userId, id, microsoftAccountId) {
    setMsAccountStmt.run({
      user_id: Number(userId),
      id: Number(id),
      microsoft_account_id: microsoftAccountId != null ? Number(microsoftAccountId) : null,
      now: Math.floor(Date.now() / 1000),
    })
    return getOrder(userId, id)
  }

  // Воркер: захватить следующий готовый заказ (любого пользователя — воркер общий).
  function claimNextReady(workerId) {
    const row = claimNextReadyStmt.get({ worker_id: String(workerId || 'worker'), now: Math.floor(Date.now() / 1000) })
    return mapRow(row)
  }

  const getByRawIdStmt = db.prepare(`SELECT * FROM roblox_orders WHERE id = ?`)

  // Воркер: отчёт о шаге. status/phase/error/message обновляют заказ по его id (без user scope — воркер доверенный).
  function workerReport(id, { status, phase, lastError, logMessage }) {
    const row = getByRawIdStmt.get(Number(id))
    if (!row) return null
    const now = Math.floor(Date.now() / 1000)
    setStateStmt.run({
      id: Number(id),
      status: status != null ? String(status) : row.status,
      phase: phase !== undefined ? (phase != null ? String(phase) : null) : row.phase,
      last_error: lastError !== undefined ? (lastError != null ? String(lastError) : null) : row.last_error,
      log: logMessage ? appendLog(row.log, logMessage, phase || row.phase) : row.log,
      now,
      delivered_at: status === 'delivered' ? now : row.delivered_at,
    })
    return mapRow(getByRawIdStmt.get(Number(id)))
  }

  return {
    ACTIVE_STATUSES,
    TERMINAL_STATUSES,
    listOrders,
    getOrder,
    getOrderByPublicId,
    getOrderByTwofaToken,
    createOrder,
    setState,
    setTwofaPending,
    setBuyerSession,
    setMicrosoftAccount,
    claimNextReady,
    workerReport,
  }
}

module.exports = { setupRobloxOrdersRepo }
