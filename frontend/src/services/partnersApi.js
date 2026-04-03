import { trackedFetch } from './requestTracker'

const ENV_ORIGIN = (import.meta.env.VITE_BACKEND_ORIGIN || '').trim()
const RUNTIME_ORIGIN = typeof window !== 'undefined' ? window.location.origin : ''

function inferBackendOrigin() {
  if (ENV_ORIGIN) return ENV_ORIGIN
  if (RUNTIME_ORIGIN && /:(5173|4173)$/i.test(RUNTIME_ORIGIN)) return 'http://localhost:3000'
  return RUNTIME_ORIGIN || 'http://localhost:3000'
}

const BACKEND_ORIGIN = inferBackendOrigin()
const FETCH_CREDENTIALS = { credentials: 'include' }

const API_OWNER_LIST_URL = `${BACKEND_ORIGIN}/api/partners/owner`
const API_WORKER_LIST_URL = `${BACKEND_ORIGIN}/api/partners/worker`
const API_INVITE_URL = `${BACKEND_ORIGIN}/api/partners/invite`
const API_INVITE_DELETE_URL = `${BACKEND_ORIGIN}/api/partners/invite/delete`
const API_CONNECT_URL = `${BACKEND_ORIGIN}/api/partners/connect`

async function parseJsonSafe(res) {
  try {
    return await res.json()
  } catch {
    return {}
  }
}

function formatError(res, fallback) {
  // server uses { error } pattern in most places.
  return fallback || 'Ошибка'
}

export async function fetchPartnersForOwner() {
  const res = await trackedFetch(API_OWNER_LIST_URL, FETCH_CREDENTIALS)
  const data = await parseJsonSafe(res)
  if (!res.ok) throw new Error(data?.error || formatError(res, 'Ошибка получения списка'))
  return data
}

export async function fetchDirectorsForWorker() {
  const res = await trackedFetch(API_WORKER_LIST_URL, FETCH_CREDENTIALS)
  const data = await parseJsonSafe(res)
  if (!res.ok) throw new Error(data?.error || formatError(res, 'Ошибка получения списка'))
  return data
}

export async function invitePartner(partnerId, password) {
  const res = await trackedFetch(API_INVITE_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ partnerId, password: password || '' }),
  })
  const data = await parseJsonSafe(res)
  if (!res.ok) throw new Error(data?.error || formatError(res, 'Ошибка приглашения'))
  return data
}

export async function deletePartnerInvite(partnerId) {
  const res = await trackedFetch(API_INVITE_DELETE_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ partnerId }),
  })
  const data = await parseJsonSafe(res)
  if (!res.ok) throw new Error(data?.error || formatError(res, 'Ошибка удаления'))
  return data
}

export async function connectToDirector({ ownerId, password }) {
  const res = await trackedFetch(API_CONNECT_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ownerId, password: password || '' }),
  })
  const data = await parseJsonSafe(res)
  if (!res.ok) throw new Error(data?.error || formatError(res, 'Ошибка подключения'))
  return data
}

