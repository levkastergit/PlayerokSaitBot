export const DEBUG_ENABLED = true

const MAX_EVENTS = 600
const STORAGE_KEY = 'playeroksait.chatLogging.events.v1'

const listeners = new Set()
let events = []

function safeClone(value) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return String(value)
  }
}

function inferLevel(event, payload) {
  const name = String(event || '').toLowerCase()
  if (name.includes('error') || (payload && payload.error)) return 'error'
  if (name.startsWith('auto:') || (payload && payload.outcome === 'error' && payload.type)) {
    return payload?.outcome === 'error' ? 'error' : 'automation'
  }
  if (name.startsWith('action:') || name.startsWith('user:')) return 'action'
  return 'info'
}

function formatAutomationTitle(event, payload) {
  const type = payload?.type || event.replace(/^auto:/, '')
  const outcome = payload?.outcome ? ` → ${payload.outcome}` : ''
  const chatId = payload?.chatId ? ` (chat ${payload.chatId})` : ''
  return `auto:${type}${outcome}${chatId}`
}

export function logChatAutomationEvents(events) {
  if (!DEBUG_ENABLED || !Array.isArray(events) || events.length === 0) return
  for (const item of events) {
    if (!item || typeof item !== 'object') continue
    const level = item.outcome === 'error' ? 'error' : 'automation'
    logChatLogging(formatAutomationTitle('auto', item), item, level)
  }
}

function loadFromStorage() {
  try {
    const raw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(STORAGE_KEY) : null
    if (!raw) return
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      events = parsed.slice(-MAX_EVENTS)
    }
  } catch {
    // ignore
  }
}

function persist() {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(events))
    }
  } catch {
    // ignore
  }
}

function emit() {
  for (const cb of listeners) cb()
}

loadFromStorage()

export function logChatLogging(event, payload = null, level = null) {
  if (!DEBUG_ENABLED) return

  const entry = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    ts: Date.now(),
    event: String(event || ''),
    level: level || inferLevel(event, payload),
    payload: payload != null ? safeClone(payload) : null,
  }

  events.push(entry)
  if (events.length > MAX_EVENTS) {
    events.splice(0, events.length - MAX_EVENTS)
  }
  persist()
  emit()

  if (payload == null) {
    console.log('[chat-logging]', entry.event)
  } else {
    console.log('[chat-logging]', entry.event, payload)
  }
}

export function getChatLoggingSnapshot() {
  return {
    events: [...events],
    maxEvents: MAX_EVENTS,
  }
}

export function subscribeChatLogging(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function clearChatLogging() {
  events = []
  persist()
  emit()
}

export function isChatApiRequest(url) {
  const u = String(url || '').toLowerCase()
  return (
    u.includes('/api/playerok/chats') ||
    u.includes('/api/playerok/deal-chat-messages') ||
    u.includes('/api/playerok/deal-chat-messages-batch') ||
    u.includes('/api/playerok/send-chat-message') ||
    u.includes('/api/playerok/hide-chat') ||
    u.includes('/api/playerok/unhide-chat') ||
    u.includes('/api/playerok/request-supercell-code') ||
    u.includes('/api/playerok/cancel-deal') ||
    u.includes('/api/playerok/confirm-deal') ||
    u.includes('/api/category-commands')
  )
}
