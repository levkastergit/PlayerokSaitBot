async function processActivePartnerGptFlows({
  tokenHash,
  token,
  userAgent,
  viewerUsername,
  nowTs,
  autolistGetPartnerGptFlowMap,
  processSinglePartnerGptFlow,
  shouldStop,
}) {
  if (typeof processSinglePartnerGptFlow !== 'function') return
  const flowMap = autolistGetPartnerGptFlowMap(tokenHash)
  const activeFlows = Object.entries(flowMap)
    .map(([chatId, state]) => ({ chatId, state: state && typeof state === 'object' ? state : null }))
    .filter(({ chatId, state }) => Boolean(chatId && state && state.active))

  for (const { chatId } of activeFlows) {
    if (typeof shouldStop === 'function' && shouldStop()) break
    await processSinglePartnerGptFlow(chatId, token, userAgent, viewerUsername || null, nowTs)
  }
}

module.exports = { processActivePartnerGptFlows }
