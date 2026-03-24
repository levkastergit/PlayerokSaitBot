import { trackedFetch } from './requestTracker'

const ENV_ORIGIN = (import.meta.env.VITE_BACKEND_ORIGIN || '').trim()
const RUNTIME_ORIGIN = typeof window !== 'undefined' ? window.location.origin : ''

// В dev (Vite) фронтенд часто стартует на 5173/4173, а backend на 3000.
function inferBackendOrigin() {
  if (ENV_ORIGIN) return ENV_ORIGIN
  if (RUNTIME_ORIGIN && /:(5173|4173)$/i.test(RUNTIME_ORIGIN)) return 'http://localhost:3000'
  return RUNTIME_ORIGIN || 'http://localhost:3000'
}

const BACKEND_ORIGIN = inferBackendOrigin()
const AUTH_LOGIN_URL = `${BACKEND_ORIGIN}/api/auth/login`
const AUTH_REGISTER_URL = `${BACKEND_ORIGIN}/api/auth/register`
const AUTH_ME_URL = `${BACKEND_ORIGIN}/api/auth/me`
const AUTH_LOGOUT_URL = `${BACKEND_ORIGIN}/api/auth/logout`
const AUTH_CHANGE_PASSWORD_URL = `${BACKEND_ORIGIN}/api/auth/change-password`

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
 * Регистрация нового пользователя.
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function register(loginValue, password) {
  try {
    const res = await trackedFetch(AUTH_REGISTER_URL, {
      ...opts,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: loginValue, password: password || '' }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return { ok: false, error: data.error || 'Ошибка регистрации' }
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

/**
 * Данные текущей сессии (логин из БД после регистрации).
 * @returns {Promise<{ ok: boolean, userId?: number, login?: string | null, moduleSupercell?: boolean, error?: string }>}
 */
export async function fetchAuthMe() {
  try {
    const res = await trackedFetch(AUTH_ME_URL, opts)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return { ok: false, error: data.error || 'Ошибка запроса' }
    }
    const rawId = data.userId
    const userId =
      typeof rawId === 'number'
        ? rawId
        : rawId != null && String(rawId).trim() !== ''
          ? Number(rawId)
          : undefined
    return {
      ok: true,
      userId: Number.isFinite(userId) ? userId : undefined,
      login: data.login != null && String(data.login).trim() !== '' ? String(data.login) : null,
      moduleSupercell: Boolean(data.moduleSupercell),
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Ошибка сети' }
  }
}

/**
 * Смена пароля аккаунта приложения (не Playerok).
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function changeAccountPassword(currentPassword, newPassword) {
  try {
    const res = await trackedFetch(AUTH_CHANGE_PASSWORD_URL, {
      ...opts,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        currentPassword: currentPassword || '',
        newPassword: newPassword || '',
      }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return { ok: false, error: data.error || 'Не удалось сменить пароль' }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Ошибка сети' }
  }
}
