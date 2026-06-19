import { trackedFetch } from './requestTracker'

const ENV_ORIGIN = (import.meta.env.VITE_BACKEND_ORIGIN || '').trim()
const RUNTIME_ORIGIN = typeof window !== 'undefined' ? window.location.origin : ''

function inferBackendOrigin() {
  if (ENV_ORIGIN) return ENV_ORIGIN
  if (RUNTIME_ORIGIN && /:(5173|4173)$/i.test(RUNTIME_ORIGIN)) return 'http://localhost:3000'
  return RUNTIME_ORIGIN || 'http://localhost:3000'
}

const BACKEND_ORIGIN = inferBackendOrigin()
const BASE = `${BACKEND_ORIGIN}/api/roblox`
const opts = { credentials: 'include' }

async function postJson(url, body) {
  const res = await trackedFetch(url, {
    ...opts,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  })
  const data = await res.json().catch(() => ({}))
  return { res, data }
}

export async function fetchRobloxAccounts() {
  try {
    const res = await trackedFetch(`${BASE}/accounts`, opts)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: data.error || 'Не удалось загрузить аккаунты' }
    return { ok: true, accounts: Array.isArray(data.accounts) ? data.accounts : [] }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Ошибка сети' }
  }
}

export async function addRobloxAccount(cookie) {
  try {
    const { res, data } = await postJson(`${BASE}/accounts/add`, { cookie })
    if (!res.ok || !data.ok) return { ok: false, error: data.error || 'Не удалось добавить аккаунт' }
    return { ok: true, account: data.account }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Ошибка сети' }
  }
}

export async function refreshRobloxAccount(id) {
  try {
    const { res, data } = await postJson(`${BASE}/accounts/refresh`, id != null ? { id } : {})
    if (!res.ok || !data.ok) return { ok: false, error: data.error || 'Не удалось обновить' }
    return { ok: true, accounts: Array.isArray(data.accounts) ? data.accounts : [] }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Ошибка сети' }
  }
}

export async function deleteRobloxAccount(id) {
  try {
    const { res, data } = await postJson(`${BASE}/accounts/delete`, { id })
    if (!res.ok || !data.ok) return { ok: false, error: data.error || 'Не удалось удалить' }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Ошибка сети' }
  }
}

// ── Microsoft-аккаунты (метод MS Store) ──────────────────────────────────────
export async function fetchMsAccounts() {
  try {
    const res = await trackedFetch(`${BASE}/ms-accounts`, opts)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: data.error || 'Не удалось загрузить MS-аккаунты' }
    return { ok: true, accounts: Array.isArray(data.accounts) ? data.accounts : [] }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Ошибка сети' }
  }
}

export async function addMsAccount(account) {
  try {
    const { res, data } = await postJson(`${BASE}/ms-accounts/add`, account)
    if (!res.ok || !data.ok) return { ok: false, error: data.error || 'Не удалось добавить' }
    return { ok: true, account: data.account }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Ошибка сети' }
  }
}

export async function deleteMsAccount(id) {
  try {
    const { res, data } = await postJson(`${BASE}/ms-accounts/delete`, { id })
    if (!res.ok || !data.ok) return { ok: false, error: data.error || 'Не удалось удалить' }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Ошибка сети' }
  }
}

// ── Заказы (метод MS Store) ──────────────────────────────────────────────────
export async function fetchOrders() {
  try {
    const res = await trackedFetch(`${BASE}/orders`, opts)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: data.error || 'Не удалось загрузить заказы' }
    return { ok: true, orders: Array.isArray(data.orders) ? data.orders : [] }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Ошибка сети' }
  }
}

export async function createOrder(order) {
  try {
    const { res, data } = await postJson(`${BASE}/orders/create`, order)
    if (!res.ok || !data.ok) return { ok: false, error: data.error || 'Не удалось создать заказ' }
    return { ok: true, order: data.order }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Ошибка сети' }
  }
}

export async function orderLogin({ orderId, username, password }) {
  try {
    const { res, data } = await postJson(`${BASE}/orders/login`, { orderId, username, password })
    if (!res.ok || !data.ok) return { ok: false, error: data.error || 'Логин не удался' }
    return { ok: true, ...data }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Ошибка сети' }
  }
}

export async function cancelOrder(orderId) {
  try {
    const { res, data } = await postJson(`${BASE}/orders/cancel`, { orderId })
    if (!res.ok || !data.ok) return { ok: false, error: data.error || 'Не удалось отменить' }
    return { ok: true, order: data.order }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Ошибка сети' }
  }
}
