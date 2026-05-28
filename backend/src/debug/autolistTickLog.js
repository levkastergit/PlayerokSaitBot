const DEBUG_ENABLED = false

function logAutolistTick(...args) {
  if (!DEBUG_ENABLED) return
  console.log('[autolist-tick]', ...args)
}

function warnAutolistTick(...args) {
  if (!DEBUG_ENABLED) return
  console.warn('[autolist-tick]', ...args)
}

module.exports = { DEBUG_ENABLED, logAutolistTick, warnAutolistTick }
