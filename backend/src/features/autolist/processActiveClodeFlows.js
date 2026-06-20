async function processActiveClodeFlows({
  tokenHash,
  token,
  userAgent,
  viewerUsername,
  nowTs,
  autolistGetClodeFlowMap,
  processSingleClodeFlow,
  shouldStop,
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
    // Останавливаемся только МЕЖДУ флоу (каждый runFlow атомарен: claim→redeem→release
    // внутри одного прогона под локом), поэтому зарезервированный код не зависнет.
    if (typeof shouldStop === 'function' && shouldStop()) break
    await processSingleClodeFlow(chatId, token, userAgent, viewerUsername || null, nowTs)
  }
}

module.exports = { processActiveClodeFlows }
