'use strict'

const DEBUG_ENABLED = false

const MAX_ENTRIES = 250
const entries = []

function safeClone(value) {
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return value != null ? String(value) : null
  }
}

function recordChatSyncStepLog(payload) {
  if (!DEBUG_ENABLED) return
  const entry = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    ts: Date.now(),
    ...safeClone(payload),
  }
  entries.push(entry)
  if (entries.length > MAX_ENTRIES) {
    entries.splice(0, entries.length - MAX_ENTRIES)
  }
  console.log('[chat-sync-step]', entry.ok === false ? 'error' : 'ok', {
    userId: entry.userId,
    durationMs: entry.durationMs,
    chats: Array.isArray(entry.chats) ? entry.chats.length : 0,
    changedChats: entry.sync?.changedChats,
    skippedChats: entry.sync?.skippedChats,
  })
}

function getChatSyncStepLogSnapshot() {
  return {
    entries: [...entries],
    maxEntries: MAX_ENTRIES,
    enabled: DEBUG_ENABLED,
  }
}

function clearChatSyncStepLog() {
  entries.length = 0
}

module.exports = {
  DEBUG_ENABLED,
  recordChatSyncStepLog,
  getChatSyncStepLogSnapshot,
  clearChatSyncStepLog,
}
