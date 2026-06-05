async function processActiveGptFlows({
  tokenHash,
  token,
  userAgent,
  viewerUsername,
  nowTs,
  autolistGetGptFlowMap,
  processSingleGptFlow,
}) {
  if (typeof processSingleGptFlow !== 'function') return
  const flowMap = autolistGetGptFlowMap(tokenHash)
  const activeFlows = Object.entries(flowMap)
    .map(([chatId, state]) => ({
      chatId,
      state: state && typeof state === 'object' ? state : null,
    }))
    .filter(({ chatId, state }) => Boolean(chatId && state && state.active))

  for (const { chatId } of activeFlows) {
    await processSingleGptFlow(chatId, token, userAgent, viewerUsername || null, nowTs)
  }
}

module.exports = { processActiveGptFlows }
