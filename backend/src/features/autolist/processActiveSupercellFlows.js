async function processActiveSupercellFlows({
  tokenHash,
  token,
  userAgent,
  viewerUsername,
  nowTs,
  autolistGetSupercellFlowMap,
  processSingleSupercellFlow,
}) {
  const flowMap = autolistGetSupercellFlowMap(tokenHash)
  const activeFlows = Object.entries(flowMap)
    .map(([chatId, state]) => ({
      chatId,
      state: state && typeof state === 'object' ? state : null,
    }))
    .filter(({ chatId, state }) => Boolean(chatId && state && state.active))

  for (const { chatId } of activeFlows) {
    await processSingleSupercellFlow(chatId, token, userAgent, viewerUsername || null, nowTs)
  }
}

module.exports = { processActiveSupercellFlows }

