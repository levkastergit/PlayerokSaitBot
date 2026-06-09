import { trackedFetch } from './requestTracker'

const ENV_ORIGIN = (import.meta.env.VITE_BACKEND_ORIGIN || '').trim()
const RUNTIME_ORIGIN = typeof window !== 'undefined' ? window.location.origin : ''

function inferBackendOrigin() {
  if (ENV_ORIGIN) return ENV_ORIGIN
  if (RUNTIME_ORIGIN && /:(5173|4173)$/i.test(RUNTIME_ORIGIN)) return 'http://localhost:3000'
  return RUNTIME_ORIGIN || 'http://localhost:3000'
}

const BACKEND_ORIGIN = inferBackendOrigin()
const OUTBOUND_IPS_URL = `${BACKEND_ORIGIN}/api/playerok/outbound-ips`
const OUTBOUND_IP_SETTINGS_URL = `${BACKEND_ORIGIN}/api/playerok/outbound-ip-settings`

const opts = { credentials: 'include' }

/** Должен совпадать с PLAYEROK_OUTBOUND_DISABLED на backend. */
export const OUTBOUND_IP_DISABLED = '__disabled__'

/** Должен совпадать с PLAYEROK_OUTBOUND_ROTATE на backend. */
export const OUTBOUND_IP_ROTATE = '__rotate__'

export async function fetchOutboundIps() {
  try {
    const res = await trackedFetch(OUTBOUND_IPS_URL, opts)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return { ok: false, error: data.error || 'Не удалось загрузить IP-адреса' }
    }
    return {
      ok: true,
      addresses: Array.isArray(data.addresses) ? data.addresses : [],
      channels: Array.isArray(data.channels) ? data.channels : [],
      legacyEnvIp: data.legacyEnvIp || null,
      disabledValue: data.disabledValue || OUTBOUND_IP_DISABLED,
      rotateValue: data.rotateValue || OUTBOUND_IP_ROTATE,
      rotationPoolSize: Number(data.rotationPoolSize) || 0,
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Ошибка сети' }
  }
}

export async function fetchOutboundIpSettings() {
  try {
    const res = await trackedFetch(OUTBOUND_IP_SETTINGS_URL, opts)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return { ok: false, error: data.error || 'Не удалось загрузить настройки IP' }
    }
    return {
      ok: true,
      bindings: data.bindings && typeof data.bindings === 'object' ? data.bindings : {},
      rotation:
        data.rotation && typeof data.rotation === 'object'
          ? { enabled: Boolean(data.rotation.enabled) }
          : { enabled: false },
      channels: Array.isArray(data.channels) ? data.channels : [],
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Ошибка сети' }
  }
}

export async function saveOutboundIpSettings(bindings, rotation) {
  try {
    const body = { bindings }
    if (rotation !== undefined) body.rotation = { enabled: Boolean(rotation && rotation.enabled) }
    const res = await trackedFetch(OUTBOUND_IP_SETTINGS_URL, {
      ...opts,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      return { ok: false, error: data.error || 'Не удалось сохранить настройки IP' }
    }
    return {
      ok: true,
      bindings: data.bindings || bindings,
      rotation: data.rotation || rotation || { enabled: false },
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Ошибка сети' }
  }
}
