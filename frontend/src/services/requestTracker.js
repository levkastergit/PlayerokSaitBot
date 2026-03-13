const DEFAULT_MAX_EVENTS = 800
const STORAGE_KEY = 'playeroksait.requestTracker.events.v1'
const CHANNEL_NAME = 'playeroksait.requestTracker.v1'

function nowMs() {
  return Date.now()
}

function safeString(v) {
  try {
    return String(v)
  } catch {
    return ''
  }
}

function normalizeUrl(input) {
  if (!input) return ''
  if (typeof input === 'string') return input
  // Request object or URL
  if (typeof input?.url === 'string') return input.url
  return safeString(input)
}

function pickMethod(init, input) {
  const m =
    (init && init.method) ||
    (input && typeof input === 'object' && input.method) ||
    'GET'
  return safeString(m || 'GET').toUpperCase()
}

function classifyTarget(url) {
  const u = (url || '').toLowerCase()
  if (u.includes('playerok.com')) return 'playerok'
  if (u.includes('/api/playerok/')) return 'playerok-proxy'
  if (u.includes('/api/sync-sales')) return 'playerok-proxy'
  if (u.includes('/api/autolist') || u.includes('/api/bump')) return 'playerok-proxy'
  if (u.includes('/api/')) return 'backend'
  return 'other'
}

function compactStack(stack) {
  if (!stack) return null
  const lines = String(stack)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  // drop first line "Error"
  const cleaned = lines.slice(1)
  // remove fetch/tracker internals
  const filtered = cleaned.filter(
    (l) =>
      !l.includes('requestTracker') &&
      !l.includes('trackedFetch') &&
      !l.includes('/services/playerokApi') &&
      !l.includes('/services/authApi')
  )
  return filtered.slice(0, 4)
}

class RequestTracker {
  constructor() {
    this.maxEvents = DEFAULT_MAX_EVENTS
    this.events = []
    this.listeners = new Set()
    this.enabled = true
    this._channel = null
    this._initPersistence()
  }

  _initPersistence() {
    // Load last snapshot for this browser session/tab-group.
    try {
      const raw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(STORAGE_KEY) : null
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          this.events = parsed.slice(-this.maxEvents)
        }
      }
    } catch {
      // ignore
    }

    // Cross-tab sync (same origin).
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        this._channel = new BroadcastChannel(CHANNEL_NAME)
        this._channel.onmessage = (ev) => {
          const msg = ev && ev.data ? ev.data : null
          if (!msg || msg.type !== 'push' || !msg.event) return
          this._push(msg.event, { persist: true, broadcast: false })
        }
      }
    } catch {
      this._channel = null
    }

    // Also react to sessionStorage updates (some browsers).
    try {
      if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('storage', (e) => {
          if (!e || e.key !== STORAGE_KEY) return
          try {
            const parsed = e.newValue ? JSON.parse(e.newValue) : []
            if (Array.isArray(parsed)) {
              this.events = parsed.slice(-this.maxEvents)
              this._emit()
            }
          } catch {
            // ignore
          }
        })
      }
    } catch {
      // ignore
    }
  }

  setEnabled(next) {
    this.enabled = Boolean(next)
    this._emit()
  }

  clear() {
    this.events = []
    this._persist()
    this._emit()
  }

  subscribe(cb) {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  getSnapshot() {
    return {
      enabled: this.enabled,
      maxEvents: this.maxEvents,
      events: this.events,
    }
  }

  _emit() {
    for (const cb of this.listeners) cb()
  }

  _persist() {
    try {
      if (typeof sessionStorage === 'undefined') return
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(this.events))
    } catch {
      // ignore (quota/disabled)
    }
  }

  _push(event, opts = { persist: true, broadcast: true }) {
    this.events.push(event)
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents)
    }
    if (opts && opts.persist) this._persist()
    if (opts && opts.broadcast && this._channel) {
      try {
        this._channel.postMessage({ type: 'push', event })
      } catch {
        // ignore
      }
    }
    this._emit()
  }

  start(input, init) {
    if (!this.enabled) return { stop: () => {} }

    const startAt = nowMs()
    const url = normalizeUrl(input)
    const method = pickMethod(init, input)
    const target = classifyTarget(url)
    const stack = compactStack(new Error().stack)
    const id = `${startAt}-${Math.random().toString(16).slice(2)}`

    let finished = false
    return {
      stop: ({ status, ok, error }) => {
        if (finished) return
        finished = true
        const endAt = nowMs()
        this._push({
          id,
          ts: startAt,
          url,
          method,
          target,
          status: typeof status === 'number' ? status : null,
          ok: typeof ok === 'boolean' ? ok : null,
          durationMs: Math.max(0, endAt - startAt),
          error: error ? safeString(error) : null,
          stack,
        })
      },
    }
  }
}

export const requestTracker = new RequestTracker()

export async function trackedFetch(input, init) {
  const span = requestTracker.start(input, init)
  try {
    const res = await fetch(input, init)
    span.stop({ status: res.status, ok: res.ok })
    return res
  } catch (e) {
    span.stop({ status: null, ok: false, error: e instanceof Error ? e.message : safeString(e) })
    throw e
  }
}

