async function processActiveSupercellFlows({
  tokenHash,
  token,
  userAgent,
  viewerUsername,
  nowTs,
  autolistGetSupercellFlowMap,
  processSingleSupercellFlow,
  shouldStop = null,
  currentUserId = null,
}) {
  const flowMap = autolistGetSupercellFlowMap(tokenHash)
  const activeFlows = Object.entries(flowMap)
    .map(([chatId, state]) => ({
      chatId,
      state: state && typeof state === 'object' ? state : null,
    }))
    .filter(({ chatId, state }) => Boolean(chatId && state && state.active))

  for (const { chatId } of activeFlows) {
    // Уважаем бюджет тика / открытый брейкер — не бросаем коды в мёртвый пул IP.
    if (typeof shouldStop === 'function' && shouldStop()) break
    await processSingleSupercellFlow(chatId, token, userAgent, viewerUsername || null, nowTs, currentUserId)
  }
}

module.exports = { processActiveSupercellFlows }

