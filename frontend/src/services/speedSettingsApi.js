import { trackedFetch } from './requestTracker'

const ENV_ORIGIN = (import.meta.env.VITE_BACKEND_ORIGIN || '').trim()
const RUNTIME_ORIGIN = typeof window !== 'undefined' ? window.location.origin : ''

function inferBackendOrigin() {
  if (ENV_ORIGIN) return ENV_ORIGIN
  if (RUNTIME_ORIGIN && /:(5173|4173)$/i.test(RUNTIME_ORIGIN)) return 'http://localhost:3000'
  return RUNTIME_ORIGIN || 'http://localhost:3000'
}

const BACKEND_ORIGIN = inferBackendOrigin()
const SPEED_SETTINGS_URL = `${BACKEND_ORIGIN}/api/playerok/speed-settings`

const opts = { credentials: 'include' }

function normDefs(data) {
  return {
    ok: true,
    defs: Array.isArray(data.defs) ? data.defs : [],
    values: data.values && typeof data.values === 'object' ? data.values : {},
  }
}

export async function fetchSpeedSettings() {
  try {
    const res = await trackedFetch(SPEED_SETTINGS_URL, opts)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: data.error || 'Не удалось загрузить настройки скорости' }
    return normDefs(data)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Ошибка сети' }
  }
}

// values: { key: number } — только заданные оператором. Пустые поля НЕ отправляем (= дефолт).
export async function saveSpeedSettings(values) {
  try {
    const res = await trackedFetch(SPEED_SETTINGS_URL, {
      ...opts,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ speed: values && typeof values === 'object' ? values : {} }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: data.error || 'Не удалось сохранить настройки скорости' }
    return normDefs(data)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Ошибка сети' }
  }
}
