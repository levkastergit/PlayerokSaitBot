const { encryptToken, decryptToken, isTokenCryptoConfigured } = require('../infra/crypto/tokenCrypto')

// Cookie .ROBLOSECURITY длинная и секретная — шифруем тем же AES-GCM, что и токены Playerok.
// Если TOKEN_SECRET/HEAD_CODE не задан (локальная разработка), храним с префиксом plain:
// чтобы приложение всё равно работало (cookie должна оставаться рабочей для запросов к Roblox).
function encodeCookie(plain) {
  const value = String(plain || '')
  if (!value) return ''
  if (isTokenCryptoConfigured()) {
    try {
      return encryptToken(value)
    } catch (_) {
      return `plain:${value}`
    }
  }
  return `plain:${value}`
}

function decodeCookie(stored) {
  const value = String(stored || '')
  if (!value) return ''
  if (value.startsWith('plain:')) return value.slice('plain:'.length)
  try {
    return decryptToken(value)
  } catch (_) {
    return ''
  }
}

function setupRobloxAccountsRepo(db) {
  const listStmt = db.prepare(`
    SELECT id, roblox_user_id, username, display_name, robux, is_premium, avatar_url,
           status, last_error, last_checked_at, created_at
    FROM roblox_accounts
    WHERE user_id = ?
    ORDER BY created_at DESC, id DESC
  `)

  const getByIdStmt = db.prepare(`
    SELECT * FROM roblox_accounts WHERE user_id = ? AND id = ?
  `)

  const getByRobloxIdStmt = db.prepare(`
    SELECT * FROM roblox_accounts WHERE user_id = ? AND roblox_user_id = ?
  `)

  const upsertStmt = db.prepare(`
    INSERT INTO roblox_accounts
      (user_id, roblox_user_id, username, display_name, cookie_enc, robux, is_premium,
       avatar_url, status, last_error, last_checked_at, created_at)
    VALUES
      (@user_id, @roblox_user_id, @username, @display_name, @cookie_enc, @robux, @is_premium,
       @avatar_url, @status, @last_error, @last_checked_at, @created_at)
    ON CONFLICT(user_id, roblox_user_id) DO UPDATE SET
      username = excluded.username,
      display_name = excluded.display_name,
      cookie_enc = excluded.cookie_enc,
      robux = excluded.robux,
      is_premium = excluded.is_premium,
      avatar_url = excluded.avatar_url,
      status = excluded.status,
      last_error = excluded.last_error,
      last_checked_at = excluded.last_checked_at
  `)

  const updateStateStmt = db.prepare(`
    UPDATE roblox_accounts
    SET robux = @robux,
        is_premium = @is_premium,
        username = @username,
        display_name = @display_name,
        avatar_url = @avatar_url,
        status = @status,
        last_error = @last_error,
        last_checked_at = @last_checked_at
    WHERE user_id = @user_id AND id = @id
  `)

  const deleteStmt = db.prepare(`
    DELETE FROM roblox_accounts WHERE user_id = ? AND id = ?
  `)

  function mapRow(row) {
    if (!row) return null
    return {
      id: row.id,
      robloxUserId: Number(row.roblox_user_id),
      username: row.username || null,
      displayName: row.display_name || null,
      robux: row.robux != null ? Number(row.robux) : null,
      isPremium: Number(row.is_premium || 0) === 1,
      avatarUrl: row.avatar_url || null,
      status: row.status || 'active',
      lastError: row.last_error || null,
      lastCheckedAt: row.last_checked_at != null ? Number(row.last_checked_at) : null,
      createdAt: Number(row.created_at),
    }
  }

  function listAccounts(userId) {
    const rows = listStmt.all(Number(userId))
    return (rows || []).map(mapRow)
  }

  function getAccount(userId, id) {
    return mapRow(getByIdStmt.get(Number(userId), Number(id)))
  }

  // Возвращает расшифрованную cookie для серверных запросов к Roblox (наружу не отдаём).
  function getAccountCookie(userId, id) {
    const row = getByIdStmt.get(Number(userId), Number(id))
    if (!row) return ''
    return decodeCookie(row.cookie_enc)
  }

  function upsertAccount(userId, account) {
    const now = Math.floor(Date.now() / 1000)
    upsertStmt.run({
      user_id: Number(userId),
      roblox_user_id: Number(account.robloxUserId),
      username: account.username != null ? String(account.username) : null,
      display_name: account.displayName != null ? String(account.displayName) : null,
      cookie_enc: encodeCookie(account.cookie),
      robux: account.robux != null ? Number(account.robux) : null,
      is_premium: account.isPremium ? 1 : 0,
      avatar_url: account.avatarUrl != null ? String(account.avatarUrl) : null,
      status: account.status != null ? String(account.status) : 'active',
      last_error: account.lastError != null ? String(account.lastError) : null,
      last_checked_at: now,
      created_at: now,
    })
    return mapRow(getByRobloxIdStmt.get(Number(userId), Number(account.robloxUserId)))
  }

  function updateAccountState(userId, id, state) {
    const now = Math.floor(Date.now() / 1000)
    updateStateStmt.run({
      user_id: Number(userId),
      id: Number(id),
      robux: state.robux != null ? Number(state.robux) : null,
      is_premium: state.isPremium ? 1 : 0,
      username: state.username != null ? String(state.username) : null,
      display_name: state.displayName != null ? String(state.displayName) : null,
      avatar_url: state.avatarUrl != null ? String(state.avatarUrl) : null,
      status: state.status != null ? String(state.status) : 'active',
      last_error: state.lastError != null ? String(state.lastError) : null,
      last_checked_at: now,
    })
    return getAccount(userId, id)
  }

  function deleteAccount(userId, id) {
    const info = deleteStmt.run(Number(userId), Number(id))
    return info.changes > 0
  }

  return {
    listAccounts,
    getAccount,
    getAccountCookie,
    upsertAccount,
    updateAccountState,
    deleteAccount,
  }
}

module.exports = { setupRobloxAccountsRepo }
