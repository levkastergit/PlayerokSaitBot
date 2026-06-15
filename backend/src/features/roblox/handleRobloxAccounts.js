'use strict'

const roblox = require('../../integrations/roblox/robloxClient')

// Список аккаунтов Roblox пользователя (без cookie).
async function handleRobloxAccountsList({ currentUserId, deps }) {
  const { robloxAccountsRepo } = deps
  const accounts = robloxAccountsRepo.listAccounts(currentUserId)
  return { statusCode: 200, data: { ok: true, accounts } }
}

// Добавить аккаунт по cookie .ROBLOSECURITY: валидируем, тянем ник/баланс/аватар, сохраняем.
async function handleRobloxAccountAdd({ payload, currentUserId, deps }) {
  const { robloxAccountsRepo } = deps
  const cookie = roblox.normalizeCookie(payload && payload.cookie)
  if (!cookie) {
    return { statusCode: 400, data: { ok: false, error: 'Вставьте cookie .ROBLOSECURITY' } }
  }

  let user
  try {
    user = await roblox.getAuthenticatedUser(cookie)
  } catch (err) {
    const code = err && err.code
    const status = code === 'INVALID_COOKIE' || code === 'EMPTY_COOKIE' ? 400 : 502
    return { statusCode: status, data: { ok: false, error: err && err.message ? err.message : 'Не удалось проверить cookie' } }
  }

  let robux = null
  let lastError = null
  try {
    robux = await roblox.getRobuxBalance(cookie, user.id)
  } catch (err) {
    lastError = err && err.message ? String(err.message) : 'Не удалось получить баланс'
  }
  const isPremium = await roblox.getPremium(cookie, user.id)
  const avatarUrl = await roblox.getAvatarHeadshotUrl(user.id)

  const saved = robloxAccountsRepo.upsertAccount(currentUserId, {
    robloxUserId: user.id,
    username: user.name,
    displayName: user.displayName,
    cookie,
    robux,
    isPremium,
    avatarUrl,
    status: lastError ? 'error' : 'active',
    lastError,
  })

  return { statusCode: 200, data: { ok: true, account: saved } }
}

// Обновить баланс/ник/аватар одного аккаунта (или всех, если id не передан).
async function handleRobloxAccountRefresh({ payload, currentUserId, deps }) {
  const { robloxAccountsRepo } = deps
  const id = payload && payload.id != null ? Number(payload.id) : null

  const targets =
    id != null
      ? [robloxAccountsRepo.getAccount(currentUserId, id)].filter(Boolean)
      : robloxAccountsRepo.listAccounts(currentUserId)

  if (id != null && targets.length === 0) {
    return { statusCode: 404, data: { ok: false, error: 'Аккаунт не найден' } }
  }

  const results = []
  for (const acc of targets) {
    const cookie = robloxAccountsRepo.getAccountCookie(currentUserId, acc.id)
    if (!cookie) {
      results.push(robloxAccountsRepo.updateAccountState(currentUserId, acc.id, {
        ...acc,
        status: 'error',
        lastError: 'Cookie отсутствует',
      }))
      continue
    }
    try {
      const user = await roblox.getAuthenticatedUser(cookie)
      const robux = await roblox.getRobuxBalance(cookie, user.id)
      const isPremium = await roblox.getPremium(cookie, user.id)
      const avatarUrl = (await roblox.getAvatarHeadshotUrl(user.id)) || acc.avatarUrl
      results.push(
        robloxAccountsRepo.updateAccountState(currentUserId, acc.id, {
          username: user.name,
          displayName: user.displayName,
          robux,
          isPremium,
          avatarUrl,
          status: 'active',
          lastError: null,
        })
      )
    } catch (err) {
      results.push(
        robloxAccountsRepo.updateAccountState(currentUserId, acc.id, {
          username: acc.username,
          displayName: acc.displayName,
          robux: acc.robux,
          isPremium: acc.isPremium,
          avatarUrl: acc.avatarUrl,
          status: err && err.code === 'INVALID_COOKIE' ? 'invalid' : 'error',
          lastError: err && err.message ? String(err.message) : 'Ошибка обновления',
        })
      )
    }
  }

  return { statusCode: 200, data: { ok: true, accounts: results } }
}

// Удалить аккаунт.
async function handleRobloxAccountDelete({ payload, currentUserId, deps }) {
  const { robloxAccountsRepo } = deps
  const id = payload && payload.id != null ? Number(payload.id) : null
  if (!Number.isFinite(id)) {
    return { statusCode: 400, data: { ok: false, error: 'Не передан id аккаунта' } }
  }
  const removed = robloxAccountsRepo.deleteAccount(currentUserId, id)
  return { statusCode: removed ? 200 : 404, data: { ok: removed } }
}

module.exports = {
  handleRobloxAccountsList,
  handleRobloxAccountAdd,
  handleRobloxAccountRefresh,
  handleRobloxAccountDelete,
}
