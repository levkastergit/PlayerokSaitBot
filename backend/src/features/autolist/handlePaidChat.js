const { isAutolistRetryableMessage } = require('./autolistErrorClassify')
const { logSupercellDebug, scopeMessagesToDeal } = require('../../functions/supercellHelpers')
const { dealPurchaseUnixTs } = require('../../functions/dealPurchaseUnixTs')
const { toUnixTs } = require('../../functions/toUnixTs')
const { shouldSkipApprouteAutodelivery } = require('../approute/approuteAutodeliveryGuards')
const { logApprouteAutodelivery } = require('../../debug/approuteAutodeliveryLog')
const { logAutolistTick, warnAutolistTick } = require('../../debug/autolistTickLog')
const {
  dealApprouteOrderEventKey,
  dealApprouteChatEventKey,
} = require('../../functions/approuteDealKeys')
const {
  buildPaidChatAutomessageEventKey,
  tryBeginChatAutomessageSend,
  finishChatAutomessageSend,
  tryBeginApprouteChatSend,
  finishApprouteChatSend,
  autolistWasAutomessageSent: autolistWasAutomessageSentDefault,
  autolistMarkAutomessageSent: autolistMarkAutomessageSentDefault,
  PAID_CHAT_AUTOMESSAGE_MAX_DEAL_AGE_SEC,
} = require('./autolistState')
const { hasSellerMessageText } = require('./handleChatAutomessage')

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
  isPlayerokPublishRetryable,
  requestItemById,
  fetchItemPriorityStatuses,
  publishItem,
  insertListingFee,
  autolistMarkProcessed,
  autolistWasProcessed,
  autolistSetItemState,
  insertSale,
  normalizeKeyPart,
  buildProductKey,
  requestDealById,
  resolveEffectiveProductSettings,
  getSupercellGameByCategory,
  pickSupercellCategoryFromItemHints,
  autolistGetSupercellFlowMap,
  autolistGetTopupFlowMap,
  extractSupercellEmailFromFields,
  upsertSettings,
  createChatMessage,
  sleep,
  supercellModuleEnabled = true,
  loadApprouteApiKeyPlain,
  runApprouteAutodelivery,
  updateDealStatus,
  deliveryOnly = false,
  skipRelist = false,
  chatMessages = null,
  viewerUsername = null,
  // Дедуп лот-автосообщений (журнал в БД). По умолчанию — реальные функции из
  // autolistState; в тест-песочнице подменяются на no-op, чтобы не писать в БД.
  autolistWasAutomessageSent = autolistWasAutomessageSentDefault,
  autolistMarkAutomessageSent = autolistMarkAutomessageSentDefault,
}) {
  // 2.2 Фиксируем продажу и выполняем автосообщения/автовыдачу для этого товара
  let item = null
  if (dealItemId) {
    item = await withRetry(
      () => requestItemById(token, userAgent, dealItemId),
      { label: 'itemById', retries: 3, shouldRetry: isPlayerokRateLimitError }
    )
  }
  if (!item && fullDealSnapshot?.item && typeof fullDealSnapshot.item === 'object') {
    item = fullDealSnapshot.item
  }

  const itemStatus = item?.status || fullDealSnapshot?.item?.status || null
  const rawTitle =
    item?.title ||
    item?.name ||
    fullDealSnapshot?.item?.title ||
    fullDealSnapshot?.item?.name ||
    fullDealSnapshot?.productTitle ||
    lastChat?.itemTitle ||
    ''
  const rawGame =
    typeof item?.game === 'string'
      ? item.game
      : (item?.game?.name && typeof item.game.name === 'string' ? item.game.name : '') ||
        item?.game_name ||
        (typeof fullDealSnapshot?.item?.game === 'string' ? fullDealSnapshot.item.game : '') ||
        (fullDealSnapshot?.item?.game?.name && typeof fullDealSnapshot.item.game.name === 'string'
          ? fullDealSnapshot.item.game.name
          : '') ||
        fullDealSnapshot?.item?.game_name ||
        (typeof fullDealSnapshot?.category === 'string' ? fullDealSnapshot.category : '') ||
        (typeof lastChat?.category === 'string' ? lastChat.category : '') ||
        ''
  const itemCategoryName =
    item?.category && typeof item.category === 'object'
      ? String(item.category.name || item.category.title || '').trim()
      : typeof fullDealSnapshot?.category === 'string'
        ? String(fullDealSnapshot.category).trim()
        : ''

  const title = normalizeKeyPart(rawTitle)
  const game = normalizeKeyPart(rawGame)
  const productKeyFromDeal =
    fullDealSnapshot && typeof fullDealSnapshot.productKey === 'string'
      ? String(fullDealSnapshot.productKey).trim()
      : ''
  const productKey = productKeyFromDeal || buildProductKey(game, title)
  const publishEventKey = `deal:${dealId || dealItemId}`
  const approuteOrderKey = dealApprouteOrderEventKey(dealId, dealItemId)
  const approuteChatKey = dealApprouteChatEventKey(dealId, dealItemId)
  const skipPublishRelist =
    typeof autolistWasProcessed === 'function' && autolistWasProcessed(tokenHash, publishEventKey)

  const { effectiveSettings: settingsForPublish, effectiveKey: settingsKeyForPublish } =
    resolveEffectiveProductSettings(currentUserId, productKey)
  const autolistEnabled = Boolean(settingsForPublish?.autolist?.enabled)
  const shouldTryPublish = !deliveryOnly && !skipRelist && autolistEnabled

  // 2.3 Пытаемся перевыставить конкретный товар из сделки, подбирая корректный статус приоритета
  let paidChatPriorityStatusId = null
  let paidChatStatusIds = []
  if (!shouldTryPublish) {
    // только доставка в чат (AppRoute и т.п.) — publishItem не вызываем
  } else if (!dealItemId) {
    warnAutolistTick('paid_chat: publishItem пропущен, отсутствует itemId', {
      dealId: dealId || null,
      productKey: String(productKey || ''),
    })
  } else if (skipPublishRelist) {
    logAutolistTick('paid_chat: publish уже обработан, пропуск publishItem', {
      dealItemId,
      productKey: String(productKey || ''),
      publishEventKey,
    })
  } else try {
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
      logAutolistTick('paid_chat: товар уже перевыставлен в scan, пропуск publishItem', {
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

      logAutolistTick('paid_chat: перед publishItem', {
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
            {
              label: 'publishItem(paid_chat)',
              retries: 4,
              baseDelayMs: 1000,
              shouldRetry: isPlayerokPublishRetryable,
            }
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
            {
              label: 'publishItem(paid_chat-no-status)',
              retries: 3,
              baseDelayMs: 1000,
              shouldRetry: isPlayerokPublishRetryable,
            }
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
      logAutolistTick('paid_chat: publishItem не вызывался — статус товара не SOLD', {
        dealItemId,
        itemStatus,
        productKey: String(productKey || ''),
      })
    }
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err)
    const cannotUpdateStatus = msg.includes('нельзя обновить статус')
    const retryable = isAutolistRetryableMessage(msg)

    warnAutolistTick('перевыставление не удалось', {
      trigger: 'paid_chat',
      itemId: dealItemId,
      productKey: String(productKey || ''),
      error: msg,
      retryable,
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
    } else if (retryable) {
      // 429 / 5xx — повтор позже
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
      typeof item?.price === 'number'
        ? item.price
        : typeof item?.rawPrice === 'number'
          ? item.rawPrice
          : 0

    let buyerName = null
    let fullDealForSale = null
    try {
      fullDealForSale = await withRetry(
        () => requestDealById(token, userAgent, dealId),
        { label: 'dealById(buyerName)', retries: 2, shouldRetry: isPlayerokRateLimitError }
      )

      buyerName = (fullDealForSale && fullDealForSale.user && fullDealForSale.user.username) || null
    } catch (_) {
      buyerName = null
    }

    const soldAtTs =
      dealPurchaseUnixTs(fullDealForSale, toUnixTs) ||
      dealPurchaseUnixTs(fullDealSnapshot, toUnixTs) ||
      dealTs ||
      0

    if (soldAtTs && dealId) {
      insertSale.run(
        currentUserId,
        productKey,
        title || 'Товар',
        soldAtTs,
        Number(salePrice) || 0,
        dealStatus || null,
        dealId || null,
        dealItemId || null,
        buyerName,
        String(dealStatus || '') === 'ROLLED_BACK' ? 1 : 0
      )
    }
  } catch (e) {
    // ignore sale record failure
  }

  // Настройки: по productKey; если есть settingsLabel — берём из группы __group__::метка
  const effectiveSettings = settingsForPublish
  const effectiveKey = settingsKeyForPublish

  const dealCategory =
    fullDealSnapshot &&
    typeof fullDealSnapshot.productKey === 'string' &&
    fullDealSnapshot.productKey.indexOf('::') > 0
      ? fullDealSnapshot.productKey.slice(0, fullDealSnapshot.productKey.indexOf('::')).trim()
      : fullDealSnapshot && typeof fullDealSnapshot.category === 'string' ? fullDealSnapshot.category.trim() : ''

  let productKeyGamePart = ''
  if (fullDealSnapshot && typeof fullDealSnapshot.productKey === 'string') {
    const sep = fullDealSnapshot.productKey.indexOf('::')
    if (sep > 0) productKeyGamePart = fullDealSnapshot.productKey.slice(0, sep).trim()
  }

  const pickedSupercellCategory = pickSupercellCategoryFromItemHints({
    gameName: rawGame,
    categoryName: itemCategoryName,
    productKeyGamePart,
    itemTitle: rawTitle,
  })
  const effectiveCategory =
    (pickedSupercellCategory && String(pickedSupercellCategory).trim()) ||
    rawGame ||
    game ||
    dealCategory ||
    ''
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

    logSupercellDebug('paidChat:flowActivated', {
      chatId: flowChatId,
      dealId: dealId || null,
      category: effectiveCategory,
      gameKey: supercellGame.gameKey,
      hasEmailInState: Boolean(
        extractSupercellEmailFromFields(
          (fullDealSnapshot && Array.isArray(fullDealSnapshot.obtainingFields) && fullDealSnapshot.obtainingFields) ||
            (fullDealSnapshot &&
              fullDealSnapshot.item &&
              Array.isArray(fullDealSnapshot.item.dataFields) &&
              fullDealSnapshot.item.dataFields) ||
            []
        )
      ),
    })

    const prevFlow = flowMap[flowChatId] || {}
    const prevDealId = prevFlow.dealId != null ? String(prevFlow.dealId).trim() : ''
    const nextDealId = dealId != null ? String(dealId).trim() : ''
    const isNewDealInChat = Boolean(nextDealId && prevDealId && nextDealId !== prevDealId)

    const emailFromNewDeal = String(
      extractSupercellEmailFromFields(
        (fullDealSnapshot && Array.isArray(fullDealSnapshot.obtainingFields) && fullDealSnapshot.obtainingFields) ||
          (fullDealSnapshot &&
            fullDealSnapshot.item &&
            Array.isArray(fullDealSnapshot.item.dataFields) &&
            fullDealSnapshot.item.dataFields) ||
          []
      ) || ''
    ).trim() || null

    flowMap[flowChatId] = {
      ...prevFlow,
      chatId: flowChatId,
      dealId: dealId || null,
      productKey,
      category: effectiveCategory,
      invalidEmailMessage,
      invalidMessageSent: isNewDealInChat ? false : Boolean(prevFlow.invalidMessageSent),
      requestCodeRequested: isNewDealInChat ? false : Boolean(prevFlow.requestCodeRequested),
      latestEmail: emailFromNewDeal || (isNewDealInChat ? null : prevFlow.latestEmail || null),
      active: true,
      createdAt: isNewDealInChat ? nowTs : Number(prevFlow.createdAt || nowTs),
      updatedAt: nowTs,
    }
  }

  // Автопополнение по API (DTU): активируем чат-флоу (бот спросит ID/логин у покупателя).
  if (typeof autolistGetTopupFlowMap === 'function' && effectiveSettings?.autotopupApi?.enabled && lastChat?.id) {
    const topupMap = autolistGetTopupFlowMap(tokenHash)
    const topupChatId = String(lastChat.id)
    const prev = topupMap[topupChatId] || {}
    const prevDealId = prev.dealId != null ? String(prev.dealId).trim() : ''
    const nextDealId = dealId != null ? String(dealId).trim() : ''
    const isNewDeal = Boolean(nextDealId && prevDealId && nextDealId !== prevDealId)
    topupMap[topupChatId] = {
      ...prev,
      chatId: topupChatId,
      dealId: dealId || null,
      userId: currentUserId,
      productKey,
      cfg: effectiveSettings.autotopupApi,
      stage: isNewDeal ? 'await_id' : prev.stage || 'await_id',
      askMsgTs: isNewDeal ? 0 : Number(prev.askMsgTs || 0),
      confirmMsgTs: isNewDeal ? 0 : Number(prev.confirmMsgTs || 0),
      candidateId: isNewDeal ? '' : prev.candidateId || '',
      orderPlaced: isNewDeal ? false : Boolean(prev.orderPlaced),
      active: true,
      createdAt: isNewDeal ? nowTs : Number(prev.createdAt || nowTs),
      updatedAt: nowTs,
    }
    logApprouteAutodelivery('topup: flow activated', {
      chatId: topupChatId,
      dealId: dealId || null,
      productKey,
    })
  }

  const s = effectiveSettings

  const runApprouteBlock = typeof runApprouteAutodelivery === 'function' && Boolean(s?.autodeliveryApi?.enabled)

  if (!s) {
    warnAutolistTick('paid_chat: нет настроек для товара', {
      productKey: String(productKey || ''),
      effectiveKey: String(effectiveKey || ''),
      dealId: dealId || null,
    })
    logApprouteAutodelivery('skip: no_product_settings', {
      productKey: String(productKey || ''),
      dealId: dealId || null,
      approuteChatKey,
    })
    return
  }

  // Автосообщение
  const am = s.automessage
  if (am?.enabled && lastChat?.id) {
    const chatIdStr = String(lastChat.id)
    const automessageEventKey = buildPaidChatAutomessageEventKey(chatIdStr, dealId)
    const dealTsForAutomessage =
      (Number(dealTs) > 0 ? Number(dealTs) : 0) || dealPurchaseUnixTs(fullDealSnapshot, toUnixTs) || 0
    const isAutomessageDealExpired =
      dealTsForAutomessage > 0 && nowTs - dealTsForAutomessage > PAID_CHAT_AUTOMESSAGE_MAX_DEAL_AGE_SEC

    if (isAutomessageDealExpired) {
      if (automessageEventKey && typeof autolistMarkProcessed === 'function') {
        autolistMarkProcessed(tokenHash, automessageEventKey, nowTs)
      }
      logAutolistTick('paid_chat: automessage пропущен (сделка устарела)', {
        chatId: chatIdStr,
        dealId: dealId || null,
        dealAgeSec: nowTs - dealTsForAutomessage,
        maxAgeSec: PAID_CHAT_AUTOMESSAGE_MAX_DEAL_AGE_SEC,
      })
    } else if (
      automessageEventKey &&
      typeof tryBeginChatAutomessageSend === 'function' &&
      typeof finishChatAutomessageSend === 'function' &&
      tryBeginChatAutomessageSend(tokenHash, automessageEventKey)
    ) {
      let automessageSuccess = false
      try {
        const raw = am.messages
        const textsToSend = Array.isArray(raw)
          ? raw.map((m) => String(m).trim()).filter(Boolean)
          : typeof raw === 'string' && raw.trim()
            ? raw.split('\n').map((line) => line.trim()).filter(Boolean)
            : []

        // Персистентный дедуп (журнал в БД): не отправляем лот-автосообщение повторно
        // по этой сделке — переживает перезапуск и устаревание загруженных сообщений.
        const lotAutoAlreadySent = autolistWasAutomessageSent(currentUserId, chatIdStr, dealId, 'lot_automessage')

        // Дубль ищем ТОЛЬКО в рамках текущей сделки (повторные покупки в одном чате):
        // иначе автосообщение из прошлой сделки покупателя ошибочно считается уже
        // отправленным, и для новой сделки оно не уходит.
        const history = scopeMessagesToDeal(Array.isArray(chatMessages) ? chatMessages : [], dealId)
        const allAlreadyInChat =
          textsToSend.length > 0 &&
          history.length > 0 &&
          textsToSend.every((line) => hasSellerMessageText(history, line, viewerUsername))

        if (lotAutoAlreadySent || allAlreadyInChat) {
          automessageSuccess = true
        } else if (textsToSend.length > 0) {
          let sentCount = 0
          let failedIndex = -1

          for (let i = 0; i < textsToSend.length; i++) {
            if (history.length > 0 && hasSellerMessageText(history, textsToSend[i], viewerUsername)) {
              sentCount += 1
              continue
            }
            try {
              await withRetry(
                () => createChatMessage(token, userAgent, chatIdStr, textsToSend[i]),
                { label: 'createChatMessage(automessage)', retries: 3, shouldRetry: isPlayerokRateLimitError }
              )
              sentCount += 1
              if (i < textsToSend.length - 1) {
                await sleep(900)
              }
            } catch (err) {
              failedIndex = i
              warnAutolistTick('automessage не отправлено', {
                reason: 'automessage_send_failed',
                chatId: chatIdStr,
                dealId: dealId || null,
                index: i,
                error: err?.message || String(err),
              })
              break
            }
          }

          automessageSuccess = sentCount === textsToSend.length && failedIndex < 0
        }
      } finally {
        if (automessageSuccess) {
          autolistMarkAutomessageSent(currentUserId, chatIdStr, dealId, 'lot_automessage', nowTs)
        }
        finishChatAutomessageSend(tokenHash, automessageEventKey, {
          success: automessageSuccess,
          nowTs,
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
        warnAutolistTick('автодоставка messageOnPurchase не удалась', { error: err?.message })
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
          warnAutolistTick('автодоставка отправка кода не удалась', { productKey: effectiveKey, error: err?.message })
        }
      }
    }
  }

  if (typeof runApprouteAutodelivery !== 'function') {
    warnAutolistTick('paid_chat: runApprouteAutodelivery не подключён', {
      productKey: String(productKey || ''),
      dealId: dealId || null,
    })
  } else if (!runApprouteBlock) {
    const apiCfg = s?.autodeliveryApi
    const approuteNeverConfigured =
      !apiCfg?.enabled && !(apiCfg?.serviceId != null && String(apiCfg.serviceId).trim())
    logApprouteAutodelivery('skip: autodelivery_api_disabled', {
      productKey: String(effectiveKey || productKey || ''),
      dealId: dealId || null,
      approuteChatKey,
      apiEnabled: Boolean(apiCfg?.enabled),
      hasServiceId: Boolean(apiCfg?.serviceId),
      approuteNeverConfigured,
    })
    if (approuteNeverConfigured && typeof autolistMarkProcessed === 'function') {
      autolistMarkProcessed(tokenHash, approuteChatKey, nowTs)
    }
  } else {
    const legacyApprouteKey = `approute:${dealId || dealItemId}`
    const approuteChatSent =
      typeof autolistWasProcessed === 'function' && autolistWasProcessed(tokenHash, approuteChatKey)
    const approuteOrderPlaced =
      (typeof autolistWasProcessed === 'function' && autolistWasProcessed(tokenHash, approuteOrderKey)) ||
      (typeof autolistWasProcessed === 'function' && autolistWasProcessed(tokenHash, legacyApprouteKey))
    const lastMessageText = lastChat?.lastMessage?.text ?? null
    const approuteGuard = shouldSkipApprouteAutodelivery({ dealStatus, lastMessageText })

    if (approuteChatSent) {
      logApprouteAutodelivery('skip: chat already sent', {
        approuteChatKey,
        productKey: String(effectiveKey || ''),
        dealId: dealId || null,
      })
    } else if (
      approuteGuard.skip &&
      !approuteOrderPlaced &&
      !(approuteGuard.reason === 'item_sent' && runApprouteBlock)
    ) {
      logApprouteAutodelivery('skip: paid_chat deal_state (no order)', {
        approuteChatKey,
        productKey: String(effectiveKey || ''),
        dealId: dealId || null,
        reason: approuteGuard.reason,
        dealStatus: approuteGuard.dealStatus,
      })
    } else if (!tryBeginApprouteChatSend(tokenHash, approuteChatKey)) {
      logApprouteAutodelivery('skip: approute in-flight', {
        approuteChatKey,
        dealId: dealId || null,
      })
    } else {
      try {
        const approuteResult = await runApprouteAutodelivery({
          currentUserId,
          loadApprouteApiKeyPlain,
          settings: s,
          lastChat,
          dealId,
          dealStatus,
          lastMessageText,
          productKey: effectiveKey,
          token,
          userAgent,
          createChatMessage,
          withRetry,
          isPlayerokRateLimitError,
          sleep,
          orderAlreadyPlaced: approuteOrderPlaced || deliveryOnly,
          onApprouteOrderPlaced: () => {
            if (typeof autolistMarkProcessed === 'function') {
              autolistMarkProcessed(tokenHash, approuteOrderKey, nowTs)
            }
          },
          updateDealStatus,
          chatMessages,
          viewerUsername,
        })
        if (approuteResult?.markApprouteOrderDone && typeof autolistMarkProcessed === 'function') {
          autolistMarkProcessed(tokenHash, approuteOrderKey, nowTs)
        }
        if (approuteResult?.markApprouteChatDone && typeof autolistMarkProcessed === 'function') {
          autolistMarkProcessed(tokenHash, approuteChatKey, nowTs)
        }
      } finally {
        finishApprouteChatSend(tokenHash, approuteChatKey)
      }
    }
  }
}

module.exports = { handlePaidChat }

