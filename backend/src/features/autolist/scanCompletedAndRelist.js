const { isAutolistRetryableMessage, autolistReasonShort, isPlayerokRateLimitMessage } = require('./autolistErrorClassify')
const { sleep } = require('../../infra/retry/withRetry')
const { logAutolistTick, warnAutolistTick } = require('../../debug/autolistTickLog')

async function scanCompletedAndRelist({
  trigger,
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
}) {
  scanMeta.lastScanTs = nowTs

  try {
    // Без кэша: иначе скан может видеть устаревший список и не попасть в нужные SOLD.
    const completed = await withRetry(() => fetchCompletedItemsFromPlayerok(token, userAgent, false), {
      label: 'completedItems',
      retries: 3,
      shouldRetry: isPlayerokRateLimitError,
    })

    const items = Array.isArray(completed?.items) ? completed.items : []
    // В «завершённых» приходят и SOLD, и EXPIRED. Раньше брались первые 10 строк целиком —
    // при нескольких EXPIRED сверху реальные продажи не попадали в окно и autolistRuntime оставался null.
    const soldItems = items.filter((it) => String(it?.status) === 'SOLD')
    const lastTen = soldItems.slice(0, 15)

    // Собираем товары со статусом 'retry' или временной 'error' (429/5xx) для повторной обработки
    const retryItems = []
    for (const it of items) {
      const itemId = it?.id != null ? String(it.id) : null
      if (!itemId) continue
      const itemState = autolistGetItemState(tokenHash, itemId)
      const shouldCollect =
        itemState &&
        (itemState.status === 'retry' ||
          (itemState.status === 'error' && isAutolistRetryableMessage(itemState.error || '')))

      if (shouldCollect) {
        retryItems.push(it)
      }
    }

    // Объединяем последние 10 и товары для повторной попытки, убираем дубликаты
    const itemsToProcess = []
    const processedIds = new Set()
    for (const it of [...retryItems, ...lastTen]) {
      const itemId = it?.id != null ? String(it.id) : null
      if (itemId && !processedIds.has(itemId)) {
        itemsToProcess.push(it)
        processedIds.add(itemId)
      }
    }

    const relistedItems = []
    const relistErrors = []
    const scanSummary = []
    const shortLabel = (it, pk) => (pk || ((it?.game || it?.game_name || '') + '::' + ((it?.title || it?.name || '').slice(0, 45))))

    for (const it of itemsToProcess) {
      const itemId = it?.id != null ? String(it.id) : null
      if (!itemId) {
        scanSummary.push({ товар: shortLabel(it, null), результат: 'не выставлен', причина: 'нет itemId' })
        continue
      }

      const itemStatus = it?.status || null
      if (String(itemStatus) !== 'SOLD') {
        scanSummary.push({
          товар: shortLabel(it, null),
          результат: 'не выставлен',
          причина: 'статус не SOLD (' + String(itemStatus) + ')',
        })
        continue
      }

      const rawTitle = it?.title || it?.name || ''
      const rawGame =
        typeof it?.game === 'string'
          ? it.game
          : (it?.game?.name && typeof it.game.name === 'string' ? it.game.name : '') || it?.game_name || ''
      const title = normalizeKeyPart(rawTitle)
      const game = normalizeKeyPart(rawGame)
      const productKey = buildProductKey(game, title)

      const eventKey = `completed:${itemId}`
      const itemState = autolistGetItemState(tokenHash, itemId)
      const shouldRetry =
        itemState &&
        (itemState.status === 'retry' ||
          (itemState.status === 'error' && isAutolistRetryableMessage(itemState.error || '')))
      const wasProcessed = autolistWasProcessed(tokenHash, eventKey)

      if (wasProcessed && !shouldRetry) {
        scanSummary.push({ товар: shortLabel(it, productKey), результат: 'не выставлен', причина: 'уже обработан' })
        continue
      }

      let effectiveSettings = null
      let effectiveKey = String(productKey)
      try {
        const row = getSettings.get(currentUserId, effectiveKey)
        if (row?.settings) {
          effectiveSettings = JSON.parse(row.settings)
          const label =
            effectiveSettings && typeof effectiveSettings.settingsLabel === 'string'
              ? effectiveSettings.settingsLabel.trim()
              : ''
          if (label) {
            const gk = getGroupSettingsKey(label)
            const groupRow = getSettings.get(currentUserId, gk)
            if (groupRow?.settings) {
              effectiveSettings = JSON.parse(groupRow.settings)
              effectiveKey = gk
            }
          }
        }
      } catch (err) {
        effectiveSettings = null
      }

      const s = effectiveSettings
      const autolistEnabled = Boolean(s?.autolist?.enabled)

      if (!autolistEnabled) {
        scanSummary.push({ товар: shortLabel(it, productKey), результат: 'не выставлен', причина: 'автовыставление отключено' })
        autolistMarkProcessed(tokenHash, eventKey, nowTs)
        autolistSetItemState(tokenHash, itemId, {
          status: 'disabled',
          error: null,
          updatedAt: nowTs,
        })
        continue
      }

      try {
        autolistSetItemState(tokenHash, itemId, {
          status: 'processing',
          error: null,
          updatedAt: nowTs,
        })

        let currentPrice = it?.price ?? 0
        const oldPrice = currentPrice
        try {
          const currentItem = await withRetry(() => requestItemById(token, userAgent, itemId), {
            label: 'itemById(autolist-price)',
            retries: 1,
            shouldRetry: isPlayerokRateLimitError,
          })
          if (currentItem) {
            const itemPrice =
              typeof currentItem.rawPrice === 'number' && currentItem.rawPrice > 0
                ? currentItem.rawPrice
                : typeof currentItem.price === 'number' && currentItem.price > 0
                  ? currentItem.price
                  : null
            if (itemPrice != null && itemPrice > 0) currentPrice = itemPrice
          }
        } catch (err) {
          // используем цену из завершенного товара
        }

        let priorityStatusId = null
        let statusesList = []
        try {
          const statuses = await withRetry(() => fetchItemPriorityStatuses(token, userAgent, itemId, currentPrice), {
            label: 'itemPriorityStatuses(autolist)',
            retries: 2,
            shouldRetry: isPlayerokRateLimitError,
          })
          statusesList = Array.isArray(statuses) ? statuses : []
          if (statusesList.length > 0) {
            const free = statusesList.find((s) => !s?.price || Number(s.price) === 0)
            const selectedStatus = free || statusesList[0] || null
            priorityStatusId = selectedStatus?.id || null
          }
        } catch (err) {
          priorityStatusId = null
        }

        let relisted = null
        let publishError = null
        const otherStatuses = statusesList
          .filter((s) => s?.id && String(s.id) !== String(priorityStatusId))
          .map((s) => s.id)
        let statusesToTry = priorityStatusId ? [priorityStatusId, ...otherStatuses] : otherStatuses
        if (statusesToTry.length === 0) statusesToTry = [AUTOBUMP_PRIORITY_STATUS_ID]

        for (let attemptIndex = 0; attemptIndex < statusesToTry.length; attemptIndex++) {
          const tryStatusId = statusesToTry[attemptIndex]
          try {
            relisted = await withRetry(() => publishItem(token, userAgent, itemId, { priorityStatusId: tryStatusId }), {
              label: 'publishItem(completedScan)',
              retries: 4,
              baseDelayMs: 1000,
              shouldRetry: isPlayerokPublishRetryable,
            })
            publishError = null
            break
          } catch (err) {
            const msg = err && err.message ? String(err.message) : String(err)
            const isInvalidBooster = msg.includes('некорректных бустеров') || msg.includes('BAD_REQUEST')
            publishError = err
            if (!isInvalidBooster) break
          }
        }

        if (!relisted) {
          try {
            relisted = await withRetry(() => publishItem(token, userAgent, itemId, { priorityStatusId: null }), {
              label: 'publishItem(completedScan-no-status)',
              retries: 3,
              baseDelayMs: 1000,
              shouldRetry: isPlayerokPublishRetryable,
            })
            publishError = null
          } catch (err) {
            // publishError уже установлен
          }
        }

        if (!relisted) {
          const finalError = publishError || new Error('Не удалось опубликовать товар')
          throw finalError
        }

        try {
          insertListingFee.run(
            currentUserId,
            String(productKey),
            String(rawTitle || 'Товар'),
            relisted?.id != null ? String(relisted.id) : String(itemId),
            Number(relisted.listingFee) || 0,
            nowTs
          )
        } catch (feeErr) {
          // игнорируем
        }

        autolistMarkProcessed(tokenHash, eventKey, nowTs)
        autolistSetItemState(tokenHash, itemId, {
          status: 'success',
          error: null,
          updatedAt: nowTs,
        })
        relistedItems.push({
          oldItemId: itemId,
          newItemId: relisted.id,
          productKey,
        })
        scanSummary.push({ товар: shortLabel(it, productKey), результат: 'выставлен', причина: 'ок' })
      } catch (err) {
        const msg = err && err.message ? String(err.message) : String(err)
        const cannotUpdateStatus = msg.includes('нельзя обновить статус')
        const retryable = isAutolistRetryableMessage(msg)
        const reasonShort = cannotUpdateStatus ? 'нельзя обновить статус' : autolistReasonShort(msg)
        warnAutolistTick('перевыставление лота не удалось', {
          trigger,
          itemId,
          productKey: String(productKey || ''),
          причинаКратко: reasonShort,
          error: msg,
        })
        scanSummary.push({ товар: shortLabel(it, productKey), результат: 'не выставлен', причина: reasonShort })
        if (cannotUpdateStatus) {
          // Товар уже в нужном статусе: помечаем событие обработанным и больше не трогаем его.
          autolistMarkProcessed(tokenHash, eventKey, nowTs)
          autolistSetItemState(tokenHash, itemId, {
            status: 'disabled',
            error: msg,
            updatedAt: nowTs,
          })
        } else if (retryable) {
          // 429 / 5xx — повторяем позже
          autolistSetItemState(tokenHash, itemId, {
            status: 'retry',
            error: msg,
            updatedAt: nowTs,
          })
          // НЕ вызываем autolistMarkProcessed - товар будет обрабатываться в следующих циклах
        } else {
          // Другие ошибки - помечаем как error, но не обработанное, чтобы можно было повторить
          autolistSetItemState(tokenHash, itemId, {
            status: 'error',
            error: msg,
            updatedAt: nowTs,
          })
          // НЕ вызываем autolistMarkProcessed для обычных ошибок, чтобы можно было повторить
        }
        relistErrors.push({
          itemId,
          productKey,
          error: msg,
        })
        if (isPlayerokRateLimitMessage(msg)) {
          await sleep(2500)
        }
      }
    }

    logAutolistTick('сводка', {
      trigger,
      проверено: itemsToProcess.length,
      выставлено: relistedItems.length,
      товары: scanSummary,
    })

    if (relistedItems.length > 0) {
      return { ok: true, action: 'relisted', trigger, relisted: relistedItems, errors: relistErrors }
    }
    return { ok: true, action: 'none', trigger }
  } catch (err) {
    warnAutolistTick('сканирование завершённых не удалось', { trigger, error: err?.message })
    if (isPlayerokRateLimitError(err)) {
      scanMeta.lastScanTs = nowTs + AUTOLIST_COMPLETED_SCAN_INTERVAL_SEC
    }
    return { ok: false, error: err && err.message ? String(err.message) : 'scan_failed', trigger }
  }
}

module.exports = { scanCompletedAndRelist }

