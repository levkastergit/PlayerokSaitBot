// Отдельный тик «Перевыставление» (Автовыставление): периодический скан
// завершённых (SOLD) товаров и их перевыставление. Вынесен из общего autolist-тика
// в собственный фоновый цикл со своим интервалом — чтобы медленный скан НЕ
// задерживал быстрые задачи выдачи/2FA. Внутри — последовательная цепочка под-шагов
// (скан → выбор статуса → публикация), всё через серийный gate Playerok.

async function handleRelistTick({ payload, currentUserId, deps }) {
  const {
    getTokenFromBodyOrStored,
    withRetry,
    isPlayerokRateLimitError,
    isPlayerokPublishRetryable,
    AUTOLIST_COMPLETED_SCAN_INTERVAL_SEC,
    AUTOBUMP_PRIORITY_STATUS_ID,
    scanCompletedAndRelist,
    fetchCompletedItemsFromPlayerok,
    autolistGetItemState,
    autolistWasProcessed,
    autolistMarkProcessed,
    autolistSetItemState,
    autolistGetCompletedScanMap,
    getSettings,
    getGroupSettingsKey,
    requestItemById,
    fetchItemPriorityStatuses,
    publishItem,
    insertListingFee,
    normalizeKeyPart,
    buildProductKey,
    isOutboundCircuitOpen,
  } = deps

  const nowTs = Math.floor(Date.now() / 1000)
  const { token } = getTokenFromBodyOrStored(currentUserId, payload)
  const userAgent = payload.userAgent
  if (!token) return { statusCode: 400, data: { error: 'Token is required' } }

  // Под-шаги (последовательная цепочка — одна карточка на /execution).
  const steps = [
    { id: 'relist-scan', label: 'Сканирование выполненных', status: 'idle', ms: 0, count: 0, note: null },
    { id: 'relist-status', label: 'Выбор статуса поднятия', status: 'idle', ms: 0, count: 0, note: null },
    { id: 'relist-publish', label: 'Публикация товара', status: 'idle', ms: 0, count: 0, note: null },
  ]
  const byId = (id) => steps.find((s) => s.id === id)

  if (typeof isOutboundCircuitOpen === 'function' && isOutboundCircuitOpen()) {
    byId('relist-scan').status = 'skip'
    byId('relist-status').status = 'skip'
    byId('relist-publish').status = 'skip'
    return { statusCode: 200, data: { ok: true, skipped: 'circuit_open', steps } }
  }

  const tokenHash = token
  const scanMeta = autolistGetCompletedScanMap(tokenHash)

  const t0 = Date.now()
  byId('relist-scan').status = 'run'
  try {
    const result = await scanCompletedAndRelist({
      trigger: 'periodic',
      scanMeta,
      nowTs,
      currentUserId,
      tokenHash,
      token,
      userAgent,
      AUTOLIST_COMPLETED_SCAN_INTERVAL_SEC,
      AUTOBUMP_PRIORITY_STATUS_ID,
      withRetry,
      isPlayerokRateLimitError,
      isPlayerokPublishRetryable,
      fetchCompletedItemsFromPlayerok,
      autolistGetItemState,
      autolistWasProcessed,
      autolistMarkProcessed,
      autolistSetItemState,
      getSettings,
      getGroupSettingsKey,
      requestItemById,
      fetchItemPriorityStatuses,
      publishItem,
      insertListingFee,
      normalizeKeyPart,
      buildProductKey,
    })

    const elapsed = Date.now() - t0
    const scanned = Number(result?.scanned || 0)
    const relisted = Array.isArray(result?.relisted) ? result.relisted.length : 0

    // Длительность распределяем по под-шагам пропорционально-условно (скан/публикация
    // выполняются вперемешку внутри функции; для UI достаточно итогов и счётчиков).
    const scanStep = byId('relist-scan')
    scanStep.status = result?.ok === false ? 'err' : 'ok'
    scanStep.count = scanned
    scanStep.ms = Math.round(elapsed * 0.3)
    scanStep.note = result?.ok === false ? String(result.error || 'ошибка скана').slice(0, 160) : `к обработке: ${scanned}`

    const statusStep = byId('relist-status')
    statusStep.status = scanned > 0 ? 'ok' : 'idle'
    statusStep.count = scanned
    statusStep.ms = Math.round(elapsed * 0.3)

    const pubStep = byId('relist-publish')
    pubStep.status = relisted > 0 ? 'ok' : scanned > 0 ? 'idle' : 'idle'
    pubStep.count = relisted
    pubStep.ms = Math.round(elapsed * 0.4)
    pubStep.note = relisted > 0 ? `перевыставлено: ${relisted}` : null

    return {
      statusCode: 200,
      data: {
        ok: result?.ok !== false,
        action: result?.action || 'none',
        relisted,
        scanned,
        steps,
      },
    }
  } catch (err) {
    const elapsed = Date.now() - t0
    const scanStep = byId('relist-scan')
    scanStep.status = 'err'
    scanStep.ms = elapsed
    scanStep.note = (err && err.message ? String(err.message) : String(err)).slice(0, 160)
    return { statusCode: 500, data: { error: scanStep.note, steps } }
  }
}

module.exports = { handleRelistTick }
