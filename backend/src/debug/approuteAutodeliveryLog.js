const DEBUG_ENABLED = false

function logApprouteAutodelivery(...args) {
  if (!DEBUG_ENABLED) return
  console.log('[approute-autodelivery]', ...args)
}

module.exports = { DEBUG_ENABLED, logApprouteAutodelivery }
