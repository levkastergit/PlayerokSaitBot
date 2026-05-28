'use strict'

const DEBUG_ENABLED = true

function logChatMessagesGap(...args) {
  if (!DEBUG_ENABLED) return
  console.log('[chat-messages-gap]', ...args)
}

module.exports = { DEBUG_ENABLED, logChatMessagesGap }
