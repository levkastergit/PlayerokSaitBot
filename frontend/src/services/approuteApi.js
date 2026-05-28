const ENV_ORIGIN = (import.meta.env.VITE_BACKEND_ORIGIN || '').trim()
const RUNTIME_ORIGIN = typeof window !== 'undefined' ? window.location.origin : ''

function inferBackendOrigin() {
  if (ENV_ORIGIN) return ENV_ORIGIN
  if (RUNTIME_ORIGIN && /:(5173|4173)$/i.test(RUNTIME_ORIGIN)) return 'http://localhost:3000'
  return RUNTIME_ORIGIN || 'http://localhost:3000'
}

const BACKEND_ORIGIN = inferBackendOrigin()
const SETTINGS_URL = `${BACKEND_ORIGIN}/api/approute/settings`
const SERVICES_URL = `${BACKEND_ORIGIN}/api/approute/services`

const FETCH_CREDENTIALS = { credentials: 'include' }

export async function fetchApprouteSettings() {
  const response = await fetch(SETTINGS_URL, { ...FETCH_CREDENTIALS, method: 'GET' })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    return { ok: false, error: data.error || `Ошибка ${response.status}` }
  }
  return {
    ok: true,
    configured: Boolean(data.configured),
    updatedAt: data.updated_at ?? null,
  }
}

export async function saveApprouteApiKey(apiKey) {
  const response = await fetch(SETTINGS_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: String(apiKey || '').trim() }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    return { ok: false, error: data.error || `Ошибка ${response.status}` }
  }
  return {
    ok: true,
    configured: Boolean(data.configured),
    updatedAt: data.updated_at ?? null,
  }
}

export async function clearApprouteApiKey() {
  const response = await fetch(SETTINGS_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clear: true }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    return { ok: false, error: data.error || `Ошибка ${response.status}` }
  }
  return { ok: true, configured: false, updatedAt: null }
}

export async function fetchApprouteServices() {
  const response = await fetch(SERVICES_URL, { ...FETCH_CREDENTIALS, method: 'GET' })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    return { ok: false, error: data.error || `Ошибка ${response.status}`, services: [] }
  }
  const services = Array.isArray(data.services) ? data.services : []
  return { ok: true, services }
}

export async function fetchApprouteServiceVariants(serviceId) {
  const id = String(serviceId || '').trim()
  if (!id) {
    return { ok: false, error: 'serviceId is required', variants: [] }
  }
  const url = `${BACKEND_ORIGIN}/api/approute/services/${encodeURIComponent(id)}/variants`
  const response = await fetch(url, { ...FETCH_CREDENTIALS, method: 'GET' })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    return { ok: false, error: data.error || `Ошибка ${response.status}`, variants: [] }
  }
  const variants = Array.isArray(data.variants) ? data.variants : []
  return { ok: true, variants }
}

export function formatApprouteVariantLabel(variant) {
  if (!variant) return ''
  const name = String(variant.name || variant.id || '').trim()
  const price = typeof variant.price === 'number' ? variant.price : null
  const currency = String(variant.currency || '').trim()
  if (price != null) {
    const cur = currency || '₽'
    return `${name} — ${price} ${cur}`.trim()
  }
  return name
}
