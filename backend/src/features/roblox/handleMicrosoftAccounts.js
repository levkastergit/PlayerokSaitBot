'use strict'

// Инвентарь Microsoft-аккаунтов (оплата Robux балансом MS Store). Секреты не отдаём наружу.
async function handleMsAccountsList({ currentUserId, deps }) {
  const { microsoftAccountsRepo } = deps
  return { statusCode: 200, data: { ok: true, accounts: microsoftAccountsRepo.listAccounts(currentUserId) } }
}

async function handleMsAccountAdd({ payload, currentUserId, deps }) {
  const { microsoftAccountsRepo } = deps
  const email = payload && payload.email != null ? String(payload.email).trim() : ''
  const password = payload && payload.password != null ? String(payload.password) : ''
  if (!email) return { statusCode: 400, data: { ok: false, error: 'Укажите email Microsoft-аккаунта' } }
  const account = microsoftAccountsRepo.addAccount(currentUserId, {
    label: payload && payload.label,
    email,
    password,
    region: payload && payload.region,
    balanceAmount: payload && payload.balanceAmount,
    balanceCurrency: payload && payload.balanceCurrency,
    status: 'idle',
  })
  return { statusCode: 200, data: { ok: true, account } }
}

async function handleMsAccountUpdate({ payload, currentUserId, deps }) {
  const { microsoftAccountsRepo } = deps
  const id = payload && payload.id != null ? Number(payload.id) : null
  if (!Number.isFinite(id)) return { statusCode: 400, data: { ok: false, error: 'Не передан id' } }
  const account = microsoftAccountsRepo.updateAccount(currentUserId, id, {
    label: payload.label,
    region: payload.region,
    balanceAmount: payload.balanceAmount,
    balanceCurrency: payload.balanceCurrency,
    status: payload.status,
  })
  if (!account) return { statusCode: 404, data: { ok: false, error: 'Аккаунт не найден' } }
  return { statusCode: 200, data: { ok: true, account } }
}

async function handleMsAccountDelete({ payload, currentUserId, deps }) {
  const { microsoftAccountsRepo } = deps
  const id = payload && payload.id != null ? Number(payload.id) : null
  if (!Number.isFinite(id)) return { statusCode: 400, data: { ok: false, error: 'Не передан id' } }
  const removed = microsoftAccountsRepo.deleteAccount(currentUserId, id)
  return { statusCode: removed ? 200 : 404, data: { ok: removed } }
}

module.exports = {
  handleMsAccountsList,
  handleMsAccountAdd,
  handleMsAccountUpdate,
  handleMsAccountDelete,
}
