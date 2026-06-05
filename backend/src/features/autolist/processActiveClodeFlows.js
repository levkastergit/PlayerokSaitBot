async function processActiveClodeFlows({
  tokenHash,
  token,
  userAgent,
  viewerUsername,
  nowTs,
  autolistGetClodeFlowMap,
  processSingleClodeFlow,
}) {
  if (typeof processSingleClodeFlow !== 'function') return
  const flowMap = autolistGetClodeFlowMap(tokenHash)
  const activeFlows = Object.entries(flowMap)
    .map(([chatId, state]) => ({
      chatId,
      state: state && typeof state === 'object' ? state : null,
    }))
    .filter(({ chatId, state }) => Boolean(chatId && state && state.active))

  for (const { chatId } of activeFlows) {
    await processSingleClodeFlow(chatId, token, userAgent, viewerUsername || null, nowTs)
  }
}

module.exports = { processActiveClodeFlows }
