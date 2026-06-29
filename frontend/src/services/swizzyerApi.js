const ENV_ORIGIN = (import.meta.env.VITE_BACKEND_ORIGIN || '').trim()
const RUNTIME_ORIGIN = typeof window !== 'undefined' ? window.location.origin : ''

function inferBackendOrigin() {
  if (ENV_ORIGIN) return ENV_ORIGIN
  if (RUNTIME_ORIGIN && /:(5173|4173)$/i.test(RUNTIME_ORIGIN)) return 'http://localhost:3000'
  return RUNTIME_ORIGIN || 'http://localhost:3000'
}

const BACKEND_ORIGIN = inferBackendOrigin()
const SETTINGS_URL = `${BACKEND_ORIGIN}/api/swizzyer/settings`
const CATALOG_URL = `${BACKEND_ORIGIN}/api/swizzyer/catalog`

const FETCH_CREDENTIALS = { credentials: 'include' }

/** Номиналы Robux для выпадающего списка лота. */
export async function fetchSwizzyerCatalog() {
  const response = await fetch(CATALOG_URL, { ...FETCH_CREDENTIALS, method: 'GET' })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    return { ok: false, error: data.error || `Ошибка ${response.status}`, denominations: [] }
  }
  const denominations = Array.isArray(data.denominations) ? data.denominations : []
  return { ok: true, denominations }
}

/** Метаданные настроек Swizzyer (что сконфигурировано) + URL вебхука. */
export async function fetchSwizzyerSettings() {
  const response = await fetch(SETTINGS_URL, { ...FETCH_CREDENTIALS, method: 'GET' })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    return { ok: false, error: data.error || `Ошибка ${response.status}` }
  }
  return {
    ok: true,
    apiKeyConfigured: Boolean(data.apiKeyConfigured),
    webhookConfigured: Boolean(data.webhookConfigured),
    webhookUrl: data.webhookUrl || null,
    updatedAt: data.updated_at ?? data.updatedAt ?? null,
  }
}

/** Сохранить ключ и/или секрет вебхука Swizzyer (передавайте только изменяемые поля). */
export async function saveSwizzyerSettings({ apiKey, webhookSecret } = {}) {
  const body = {}
  if (apiKey !== undefined) body.apiKey = String(apiKey || '').trim()
  if (webhookSecret !== undefined) body.webhookSecret = String(webhookSecret || '').trim()
  const response = await fetch(SETTINGS_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    return { ok: false, error: data.error || `Ошибка ${response.status}` }
  }
  return {
    ok: true,
    apiKeyConfigured: Boolean(data.apiKeyConfigured),
    webhookConfigured: Boolean(data.webhookConfigured),
    updatedAt: data.updated_at ?? null,
  }
}
