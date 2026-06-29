// Трекинг заказов Swizzyer на (user_id, deal_id). Даёт ДВЕ гарантии:
//   1) Идемпотентность создания заказа между перезапусками: если order_id уже
//      сохранён по сделке — повторно НЕ создаём (заказ = 2 транзакции + реальное
//      списание в MS Store, дубль недопустим). Резюмируемся через GET /orders/:id.
//   2) Корреляция вебхука: событие приходит по order_id → находим сделку/чат.
function setupSwizzyerOrdersRepo(db) {
  const getByDeal = db.prepare(
    `SELECT * FROM swizzyer_orders WHERE user_id = ? AND deal_id = ?`
  )
  const getByOrderId = db.prepare(
    `SELECT * FROM swizzyer_orders WHERE order_id = ? LIMIT 1`
  )
  const upsert = db.prepare(`
    INSERT INTO swizzyer_orders
      (user_id, deal_id, chat_id, order_id, denomination_id, roblox_username, status, last_version, failure_code, created_at, updated_at)
    VALUES
      (@user_id, @deal_id, @chat_id, @order_id, @denomination_id, @roblox_username, @status, @last_version, @failure_code, @created_at, @updated_at)
    ON CONFLICT(user_id, deal_id) DO UPDATE SET
      chat_id = COALESCE(excluded.chat_id, swizzyer_orders.chat_id),
      order_id = COALESCE(excluded.order_id, swizzyer_orders.order_id),
      denomination_id = COALESCE(excluded.denomination_id, swizzyer_orders.denomination_id),
      roblox_username = COALESCE(excluded.roblox_username, swizzyer_orders.roblox_username),
      status = COALESCE(excluded.status, swizzyer_orders.status),
      last_version = COALESCE(excluded.last_version, swizzyer_orders.last_version),
      failure_code = COALESCE(excluded.failure_code, swizzyer_orders.failure_code),
      updated_at = excluded.updated_at
  `)

  function getSwizzyerOrderByDeal(userId, dealId) {
    const d = String(dealId == null ? '' : dealId).trim()
    if (!d) return null
    try {
      return getByDeal.get(userId, d) || null
    } catch {
      return null
    }
  }

  function getSwizzyerOrderByOrderId(orderId) {
    const o = String(orderId == null ? '' : orderId).trim()
    if (!o) return null
    try {
      return getByOrderId.get(o) || null
    } catch {
      return null
    }
  }

  // fields: { chatId, orderId, denominationId, robloxUsername, status, lastVersion, failureCode }
  function upsertSwizzyerOrder(userId, dealId, fields = {}) {
    const d = String(dealId == null ? '' : dealId).trim()
    if (!d) return null
    const nowTs = Math.floor(Date.now() / 1000)
    const norm = (v) => (v === undefined || v === null ? null : v)
    const row = {
      user_id: userId,
      deal_id: d,
      chat_id: fields.chatId != null ? String(fields.chatId) : null,
      order_id: fields.orderId != null ? String(fields.orderId) : null,
      denomination_id: fields.denominationId != null ? String(fields.denominationId) : null,
      roblox_username: fields.robloxUsername != null ? String(fields.robloxUsername) : null,
      status: fields.status != null ? String(fields.status) : null,
      last_version: fields.lastVersion != null ? Number(fields.lastVersion) : null,
      failure_code: fields.failureCode != null ? String(fields.failureCode) : null,
      created_at: nowTs,
      updated_at: nowTs,
    }
    // norm() здесь не нужен — поля уже либо строка/число, либо null.
    void norm
    try {
      upsert.run(row)
    } catch (e) {
      console.warn('[swizzyer] upsertSwizzyerOrder', e?.message || e)
    }
    return getSwizzyerOrderByDeal(userId, d)
  }

  return {
    getSwizzyerOrderByDeal,
    getSwizzyerOrderByOrderId,
    upsertSwizzyerOrder,
  }
}

module.exports = { setupSwizzyerOrdersRepo }
