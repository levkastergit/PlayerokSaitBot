import { trackedFetch } from './requestTracker'

const BACKEND_ORIGIN =
  import.meta.env.VITE_BACKEND_ORIGIN ||
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000')
const AUTH_LOGIN_URL = `${BACKEND_ORIGIN}/api/auth/login`
const AUTH_ME_URL = `${BACKEND_ORIGIN}/api/auth/me`
const AUTH_LOGOUT_URL = `${BACKEND_ORIGIN}/api/auth/logout`

const opts = { credentials: 'include' }

/**
 * Проверяет, авторизован ли пользователь (сессия валидна).
 * @returns {Promise<boolean>}
 */
export async function checkAuth() {
  try {
    const res = await trackedFetch(AUTH_ME_URL, opts)
    return res.ok
  } catch {
    return false
  }
}

/**
 * Вход по логину и паролю.
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function login(loginValue, password) {
  try {
    const res = await trackedFetch(AUTH_LOGIN_URL, {
      ...opts,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: loginValue, password: password || '' }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return { ok: false, error: data.error || 'Ошибка входа' }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Ошибка сети' }
  }
}

/**
 * Выход (инвалидирует сессию на сервере).
 */
export async function logout() {
  try {
    await trackedFetch(AUTH_LOGOUT_URL, { ...opts, method: 'POST' })
  } catch {
    // ignore
  }
}
