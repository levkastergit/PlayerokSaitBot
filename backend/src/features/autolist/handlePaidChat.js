async function handlePaidChat({
  currentUserId,
  tokenHash,
  token,
  userAgent,
  nowTs,
  dealId,
  dealItemId,
  dealTs,
  dealStatus,
  lastChat,
  fullDealSnapshot,
  relistedByScanIds,
  AUTOBUMP_PRIORITY_STATUS_ID,
  withRetry,
  isPlayerokRateLimitError,
  requestItemById,
  fetchItemPriorityStatuses,
  publishItem,
  insertListingFee,
  autolistMarkProcessed,
  autolistSetItemState,
  insertSale,
  normalizeKeyPart,
  buildProductKey,
  requestDealById,
  resolveEffectiveProductSettings,
  getSupercellGameByCategory,
  autolistGetSupercellFlowMap,
  extractSupercellEmailFromFields,
  upsertSettings,
  createChatMessage,
  sleep,
  supercellModuleEnabled = true,
}) {
  // 2.2 Фиксируем продажу и выполняем автосообщения/автовыдачу для этого товара
  const item = await withRetry(
    () => requestItemById(token, userAgent, dealItemId),
    { label: 'itemById', retries: 3, shouldRetry: isPlayerokRateLimitError }
  )

  if (!item) return

  const itemStatus = item.status || null
  const rawTitle = item.title || item.name || ''
  const rawGame =
    typeof item?.game === 'string'
      ? item.game
      : (item?.game?.name && typeof item.game.name === 'string' ? item.game.name : '') || item?.game_name || ''

  const title = normalizeKeyPart(rawTitle)
  const game = normalizeKeyPart(rawGame)
  const productKey = buildProductKey(game, title)

  // 2.3 Пытаемся перевыставить конкретный товар из сделки, подбирая корректный статус приоритета
  let paidChatPriorityStatusId = null
  let paidChatStatusIds = []
  try {
    // Для получения статусов поднятия используем ОРИГИНАЛЬНУЮ цену (rawPrice), а не цену со скидкой
    const priceForStatuses =
      typeof item?.rawPrice === 'number' && item.rawPrice > 0
        ? item.rawPrice
        : typeof item?.price === 'number' && item.price > 0
          ? item.price
          : 0

    let statusesList = []
    let priorityStatusId = null
    try {
      const statuses = await withRetry(
        () => fetchItemPriorityStatuses(token, userAgent, dealItemId, priceForStatuses),
        { label: 'itemPriorityStatuses(paid_chat)', retries: 2, shouldRetry: isPlayerokRateLimitError }
      )

      const list = Array.isArray(statuses) ? statuses : []
      statusesList = list
      paidChatStatusIds = list.map((s) => (s?.id != null ? String(s.id) : null)).filter(Boolean)

      const free = list.find((s) => !s?.price || Number(s.price) === 0)
      const selectedStatus = free || list[0] || null
      priorityStatusId = selectedStatus?.id || null
      paidChatPriorityStatusId = priorityStatusId
    } catch (_) {
      priorityStatusId = null
      statusesList = []
    }

    const wasRelistedByScan = relistedByScanIds.includes(String(dealItemId))
    if (wasRelistedByScan) {
      console.log('[autolist-tick] paid_chat: товар уже перевыставлен в scan, пропуск publishItem', {
        dealItemId,
        productKey: String(productKey || ''),
      })
      autolistMarkProcessed(tokenHash, `deal:${dealId || dealItemId}`, nowTs)
      autolistSetItemState(tokenHash, dealItemId, {
        status: 'success',
        error: null,
        updatedAt: nowTs,
      })
    } else if (String(itemStatus) === 'SOLD') {
      // Логика выбора статуса такая же, как в scanCompletedAndRelist: пробуем несколько статусов и затем null
      let relisted = null
      let publishError = null

      const otherStatuses = statusesList
        .filter((s) => s?.id && String(s.id) !== String(priorityStatusId))
        .map((s) => s.id)

      let statusesToTry = priorityStatusId ? [priorityStatusId, ...otherStatuses] : otherStatuses
      if (statusesToTry.length === 0) statusesToTry = [AUTOBUMP_PRIORITY_STATUS_ID]

      console.log('[autolist-tick] paid_chat: перед publishItem', {
        dealItemId,
        itemIdFromItem: item?.id,
        itemStatus,
        productKey: String(productKey || ''),
        priceForStatuses,
        priorityStatusId: paidChatPriorityStatusId,
        statusIdsFromApi: paidChatStatusIds,
        statusesToTry: statusesToTry.map(String),
      })

      for (let attemptIndex = 0; attemptIndex < statusesToTry.length; attemptIndex++) {
        const tryStatusId = statusesToTry[attemptIndex]
        try {
          relisted = await withRetry(
            () => publishItem(token, userAgent, dealItemId, { priorityStatusId: tryStatusId }),
            { label: 'publishItem(paid_chat)', retries: 3, shouldRetry: isPlayerokRateLimitError }
          )
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
          relisted = await withRetry(
            () => publishItem(token, userAgent, dealItemId, { priorityStatusId: null }),
            { label: 'publishItem(paid_chat-no-status)', retries: 1, shouldRetry: isPlayerokRateLimitError }
          )
          publishError = null
        } catch (err) {
          // publishError уже установлен
        }
      }

      if (!relisted) {
        const finalError = publishError || new Error('Не удалось опубликовать товар (paid_chat)')
        throw finalError
      }

      try {
        insertListingFee.run(
          currentUserId,
          String(productKey),
          String(rawTitle || 'Товар'),
          relisted?.id != null ? String(relisted.id) : String(dealItemId),
          Number(relisted.listingFee) || 0,
          nowTs
        )
      } catch (_) {}

      autolistMarkProcessed(tokenHash, `deal:${dealId || dealItemId}`, nowTs)
      autolistSetItemState(tokenHash, dealItemId, {
        status: 'success',
        error: null,
        updatedAt: nowTs,
      })
    } else {
      console.log('[autolist-tick] paid_chat: publishItem не вызывался — статус товара не SOLD', {
        dealItemId,
        itemStatus,
        productKey: String(productKey || ''),
      })
    }
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err)
    const cannotUpdateStatus = msg.includes('нельзя обновить статус')
    const isServerError =
      msg.includes('status 500') || msg.includes('INTERNAL_SERVER_ERROR') || msg.includes('priorityStatuses')

    console.warn('[autolist-tick] перевыставление не удалось', {
      trigger: 'paid_chat',
      itemId: dealItemId,
      productKey: String(productKey || ''),
      error: msg,
      isServerError,
      paidChatItemStatus: item?.status ?? null,
      paidChatPriorityStatusId: paidChatPriorityStatusId,
      paidChatStatusIdsFromApi: paidChatStatusIds,
      wasRelistedByScan: relistedByScanIds.includes(String(dealItemId)),
    })

    if (cannotUpdateStatus) {
      autolistMarkProcessed(tokenHash, `deal:${dealId || dealItemId}`, nowTs)
      autolistSetItemState(tokenHash, dealItemId, {
        status: 'disabled',
        error: msg,
        updatedAt: nowTs,
      })
    } else if (isServerError) {
      // Ошибка 500 - не помечаем как обработанное, чтобы система продолжала пытаться выставить товар
      // Помечаем как 'retry' чтобы система знала, что нужно продолжать попытки
      autolistSetItemState(tokenHash, dealItemId, {
        status: 'retry',
        error: msg,
        updatedAt: nowTs,
      })
      // НЕ вызываем autolistMarkProcessed - товар будет обрабатываться в следующих циклах
    } else {
      // Другие ошибки
      autolistSetItemState(tokenHash, dealItemId, {
        status: 'error',
        error: msg,
        updatedAt: nowTs,
      })
      // НЕ вызываем autolistMarkProcessed для обычных ошибок, чтобы можно было повторить
    }
  }

  // Fix: insert into sales_history
  try {
    const salePrice =
      typeof item.price === 'number'
        ? item.price
        : typeof item.rawPrice === 'number'
          ? item.rawPrice
          : 0

    let buyerName = null
    try {
      const fullDeal = await withRetry(
        () => requestDealById(token, userAgent, dealId),
        { label: 'dealById(buyerName)', retries: 2, shouldRetry: isPlayerokRateLimitError }
      )

      buyerName = (fullDeal && fullDeal.user && fullDeal.user.username) || null
    } catch (_) {
      buyerName = null
    }

    insertSale.run(
      currentUserId,
      productKey,
      title || 'Товар',
      dealTs || nowTs,
      Number(salePrice) || 0,
      dealStatus || null,
      dealId || null,
      dealItemId || null,
      buyerName,
      String(dealStatus || '') === 'ROLLED_BACK' ? 1 : 0
    )
  } catch (e) {
    // ignore sale record failure
  }

  // Настройки: по productKey; если есть settingsLabel — берём из группы __group__::метка
  const { effectiveSettings, effectiveKey } = resolveEffectiveProductSettings(currentUserId, productKey)

  const dealCategory =
    fullDealSnapshot &&
    typeof fullDealSnapshot.productKey === 'string' &&
    fullDealSnapshot.productKey.indexOf('::') > 0
      ? fullDealSnapshot.productKey.slice(0, fullDealSnapshot.productKey.indexOf('::')).trim()
      : fullDealSnapshot && typeof fullDealSnapshot.category === 'string' ? fullDealSnapshot.category.trim() : ''

  const effectiveCategory = rawGame || game || dealCategory || ''
  const supercellGame = getSupercellGameByCategory(effectiveCategory)

  if (supercellModuleEnabled && supercellGame && lastChat?.id) {
    const flowMap = autolistGetSupercellFlowMap(tokenHash)
    const flowChatId = String(lastChat.id)

    const validation =
      effectiveSettings?.emailValidation && typeof effectiveSettings.emailValidation === 'object'
        ? effectiveSettings.emailValidation
        : {}

    const invalidEmailMessage =
      validation.enabled && typeof validation.invalidEmailMessage === 'string' ? validation.invalidEmailMessage.trim() : ''

    flowMap[flowChatId] = {
      ...(flowMap[flowChatId] || {}),
      chatId: flowChatId,
      dealId: dealId || null,
      productKey,
      category: effectiveCategory,
      invalidEmailMessage,
      invalidMessageSent: Boolean(flowMap[flowChatId]?.invalidMessageSent),
      requestCodeRequested: Boolean(flowMap[flowChatId]?.requestCodeRequested),
      latestEmail: String(
        extractSupercellEmailFromFields(
          (fullDealSnapshot && Array.isArray(fullDealSnapshot.obtainingFields) && fullDealSnapshot.obtainingFields) ||
            (fullDealSnapshot &&
              fullDealSnapshot.item &&
              Array.isArray(fullDealSnapshot.item.dataFields) &&
              fullDealSnapshot.item.dataFields) ||
            []
        ) || ''
      ).trim() || null,
      active: true,
      createdAt: Number(flowMap[flowChatId]?.createdAt || nowTs),
      updatedAt: nowTs,
    }
  }

  const s = effectiveSettings
  if (!s) return

  // Автосообщение
  const am = s.automessage
  if (am?.enabled && lastChat?.id) {
    const raw = am.messages
    const messages = Array.isArray(raw)
      ? raw.map((m) => String(m).trim()).filter(Boolean)
      : typeof raw === 'string' && raw.trim()
        ? raw.split('\n').map((line) => line.trim()).filter(Boolean)
        : []

    for (let i = 0; i < messages.length; i++) {
      try {
        await withRetry(
          () => createChatMessage(token, userAgent, lastChat.id, messages[i]),
          { label: 'createChatMessage(automessage)', retries: 3, shouldRetry: isPlayerokRateLimitError }
        )
        if (i < messages.length - 1) {
          await sleep(900)
        }
      } catch (err) {
        console.warn('[autolist-tick] automessage не отправлено', {
          reason: 'automessage_send_failed',
          chatId: lastChat.id,
          dealId: dealId || null,
          index: i,
          error: err?.message || String(err),
        })
      }
    }
  }

  // Автовыдача
  if (s.autodelivery?.enabled && lastChat?.id) {
    const messageOnPurchase = (s.autodelivery.messageOnPurchase && String(s.autodelivery.messageOnPurchase).trim()) || ''

    if (messageOnPurchase) {
      try {
        await withRetry(
          () => createChatMessage(token, userAgent, lastChat.id, messageOnPurchase),
          { label: 'createChatMessage(messageOnPurchase)', retries: 3, shouldRetry: isPlayerokRateLimitError }
        )
      } catch (err) {
        console.warn('[autolist-tick] автодоставка messageOnPurchase не удалась', { error: err?.message })
      }
    }

    if (Array.isArray(s.autodelivery.codes) && s.autodelivery.codes.length > 0) {
      const codeToSend = String(s.autodelivery.codes[0]).trim()
      if (codeToSend) {
        try {
          await withRetry(
            () => createChatMessage(token, userAgent, lastChat.id, codeToSend),
            { label: 'createChatMessage(code)', retries: 3, shouldRetry: isPlayerokRateLimitError }
          )

          const newCodes = s.autodelivery.codes.slice(1)
          const updated = {
            ...s,
            autodelivery: { ...s.autodelivery, codes: newCodes },
          }
          const updatedAt = Math.floor(Date.now() / 1000)
          upsertSettings.run(currentUserId, effectiveKey, JSON.stringify(updated), updatedAt)
        } catch (err) {
          console.warn('[autolist-tick] автодоставка отправка кода не удалась', { productKey: effectiveKey, error: err?.message })
        }
      }
    }
  }
}

module.exports = { handlePaidChat }

