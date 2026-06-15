// Заказы автовыдачи Robux методом MS Store. Машина состояний (status):
//   queued         — создан, ждёт входа покупателя
//   awaiting_login — нужен вход в аккаунт покупателя (логин/пароль)
//   awaiting_2fa   — покупателю отправлена hosted-ссылка для ввода 2FA-кода
//   ready          — сессия покупателя (.ROBLOSECURITY) получена, готов к выдаче воркером
//   claimed        — Windows-воркер взял заказ в работу
//   purchasing     — phase_ms_buy: покупка Robux-пака в UWP за баланс MS-аккаунта
//   claiming       — phase_generate_store_id + phase_claim: зачисление на аккаунт Roblox
//   verifying      — phase_verify: проверяем, что баланс Robux вырос
//   delivered      — успех
//   failed         — ошибка (см. last_error)
//   canceled       — отменён вручную
//
// buyer_account_id  → roblox_accounts.id (сессия покупателя, куда выдаём)
// microsoft_account_id → microsoft_accounts.id (чем оплачиваем)
function createRobloxOrdersTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS roblox_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      public_id TEXT NOT NULL,
      robux_amount INTEGER NOT NULL,
      buyer_username TEXT,
      buyer_account_id INTEGER,
      microsoft_account_id INTEGER,
      status TEXT NOT NULL DEFAULT 'queued',
      phase TEXT,
      twofa_token TEXT,
      twofa_media_type TEXT,
      worker_id TEXT,
      note TEXT,
      last_error TEXT,
      log TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      delivered_at INTEGER,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `)

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_roblox_orders_user_created
    ON roblox_orders(user_id, created_at DESC, id DESC)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_roblox_orders_user_status
    ON roblox_orders(user_id, status, created_at ASC, id ASC)
  `)
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_roblox_orders_twofa_token
    ON roblox_orders(twofa_token)
  `)
}

module.exports = { createRobloxOrdersTable }
