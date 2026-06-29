async function processActiveSwizzyerFlows({
  tokenHash,
  token,
  userAgent,
  viewerUsername,
  nowTs,
  autolistGetSwizzyerFlowMap,
  processSingleSwizzyerFlow,
  shouldStop,
}) {
  if (typeof processSingleSwizzyerFlow !== 'function') return
  const flowMap = autolistGetSwizzyerFlowMap(tokenHash)
  const activeFlows = Object.entries(flowMap)
    .map(([chatId, state]) => ({
      chatId,
      state: state && typeof state === 'object' ? state : null,
    }))
    .filter(({ chatId, state }) => Boolean(chatId && state && state.active))

  for (const { chatId } of activeFlows) {
    if (typeof shouldStop === 'function' && shouldStop()) break
    await processSingleSwizzyerFlow(chatId, token, userAgent, viewerUsername || null, nowTs)
  }
}

module.exports = { processActiveSwizzyerFlows }
