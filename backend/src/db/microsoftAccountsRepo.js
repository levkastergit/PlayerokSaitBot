const { encryptToken, decryptToken, isTokenCryptoConfigured } = require('../infra/crypto/tokenCrypto')

// Учётные данные MS-аккаунта (email/пароль/иное) шифруем как одну JSON-строку.
function encodeCreds(creds) {
  const value = creds == null ? '' : typeof creds === 'string' ? creds : JSON.stringify(creds)
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

function decodeCreds(stored) {
  const value = String(stored || '')
  if (!value) return ''
  if (value.startsWith('plain:')) return value.slice('plain:'.length)
  try {
    return decryptToken(value)
  } catch (_) {
    return ''
  }
}

function setupMicrosoftAccountsRepo(db) {
  const listStmt = db.prepare(`
    SELECT id, label, email, region, balance_amount, balance_currency, status,
           last_error, last_used_at, created_at
    FROM microsoft_accounts
    WHERE user_id = ?
    ORDER BY created_at DESC, id DESC
  `)

  const getByIdStmt = db.prepare(`SELECT * FROM microsoft_accounts WHERE user_id = ? AND id = ?`)

  const insertStmt = db.prepare(`
    INSERT INTO microsoft_accounts
      (user_id, label, email, creds_enc, region, balance_amount, balance_currency,
       status, last_error, last_used_at, created_at)
    VALUES
      (@user_id, @label, @email, @creds_enc, @region, @balance_amount, @balance_currency,
       @status, @last_error, @last_used_at, @created_at)
  `)

  const updateStmt = db.prepare(`
    UPDATE microsoft_accounts
    SET label = @label,
        email = @email,
        region = @region,
        balance_amount = @balance_amount,
        balance_currency = @balance_currency,
        status = @status,
        last_error = @last_error,
        last_used_at = @last_used_at
    WHERE user_id = @user_id AND id = @id
  `)

  const deleteStmt = db.prepare(`DELETE FROM microsoft_accounts WHERE user_id = ? AND id = ?`)

  function mapRow(row) {
    if (!row) return null
    return {
      id: row.id,
      label: row.label || null,
      email: row.email || null,
      region: row.region || null,
      balanceAmount: row.balance_amount != null ? Number(row.balance_amount) : null,
      balanceCurrency: row.balance_currency || null,
      status: row.status || 'idle',
      lastError: row.last_error || null,
      lastUsedAt: row.last_used_at != null ? Number(row.last_used_at) : null,
      createdAt: Number(row.created_at),
    }
  }

  function listAccounts(userId) {
    return (listStmt.all(Number(userId)) || []).map(mapRow)
  }

  function getAccount(userId, id) {
    return mapRow(getByIdStmt.get(Number(userId), Number(id)))
  }

  function getAccountCreds(userId, id) {
    const row = getByIdStmt.get(Number(userId), Number(id))
    if (!row) return null
    const raw = decodeCreds(row.creds_enc)
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch (_) {
      return { raw }
    }
  }

  function addAccount(userId, acc) {
    const now = Math.floor(Date.now() / 1000)
    const info = insertStmt.run({
      user_id: Number(userId),
      label: acc.label != null ? String(acc.label) : null,
      email: acc.email != null ? String(acc.email) : null,
      creds_enc: encodeCreds(acc.creds != null ? acc.creds : { email: acc.email, password: acc.password }),
      region: acc.region != null ? String(acc.region) : null,
      balance_amount: acc.balanceAmount != null ? Number(acc.balanceAmount) : null,
      balance_currency: acc.balanceCurrency != null ? String(acc.balanceCurrency) : null,
      status: acc.status != null ? String(acc.status) : 'idle',
      last_error: null,
      last_used_at: null,
      created_at: now,
    })
    return getAccount(userId, info.lastInsertRowid)
  }

  function updateAccount(userId, id, patch) {
    const cur = getByIdStmt.get(Number(userId), Number(id))
    if (!cur) return null
    updateStmt.run({
      user_id: Number(userId),
      id: Number(id),
      label: patch.label !== undefined ? (patch.label != null ? String(patch.label) : null) : cur.label,
      email: patch.email !== undefined ? (patch.email != null ? String(patch.email) : null) : cur.email,
      region: patch.region !== undefined ? (patch.region != null ? String(patch.region) : null) : cur.region,
      balance_amount:
        patch.balanceAmount !== undefined
          ? patch.balanceAmount != null
            ? Number(patch.balanceAmount)
            : null
          : cur.balance_amount,
      balance_currency:
        patch.balanceCurrency !== undefined
          ? patch.balanceCurrency != null
            ? String(patch.balanceCurrency)
            : null
          : cur.balance_currency,
      status: patch.status !== undefined ? String(patch.status) : cur.status,
      last_error: patch.lastError !== undefined ? (patch.lastError != null ? String(patch.lastError) : null) : cur.last_error,
      last_used_at: patch.touchUsed ? Math.floor(Date.now() / 1000) : cur.last_used_at,
    })
    return getAccount(userId, id)
  }

  function deleteAccount(userId, id) {
    return deleteStmt.run(Number(userId), Number(id)).changes > 0
  }

  return { listAccounts, getAccount, getAccountCreds, addAccount, updateAccount, deleteAccount }
}

module.exports = { setupMicrosoftAccountsRepo }
