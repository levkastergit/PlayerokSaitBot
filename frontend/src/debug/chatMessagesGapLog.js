export const DEBUG_ENABLED = true

export function logChatMessagesGap(...args) {
  if (!DEBUG_ENABLED) return
  console.log('[chat-messages-gap]', ...args)
}
