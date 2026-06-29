const {
  ITEM_PAID_MARKER,
  ITEM_SENT_MARKER,
  DEAL_CONFIRMED_MARKERS,
  lastMessageHasAnyMarker,
} = require('./handleChatAutomessage')
const { shouldSkipApprouteAutodelivery } = require('../approute/approuteAutodeliveryGuards')
const { logApprouteAutodelivery } = require('../../debug/approuteAutodeliveryLog')
const { logAutolistTick, warnAutolistTick } = require('../../debug/autolistTickLog')
const {
  dealApprouteOrderEventKey,
  dealApprouteChatEventKey,
} = require('../../functions/approuteDealKeys')
const { resolvePaidChatDealFromChat } = require('../../functions/resolvePaidChatDealFromChat')
const {
  buildPostPurchaseAutomessageEventKey,
  buildDealConfirmedAutomessageEventKey,
  buildPurchaseWindowAutomessageEventKey,
  buildImageAutomessageEventKey,
  CHAT_AUTOMESSAGE_MAX_TRIGGER_AGE_SEC,
} = require('./autolistState')

// Троттлинг повторных сканов автосообщений по стадиям: даже если lastMessage чата
// не менялся, раз в этот интервал всё же перечитываем чат (страховка от
// проглоченной ошибки / перезапуска). Верхняя граница осмысленности — окно
// CHAT_AUTOMESSAGE_MAX_TRIGGER_AGE_SEC (2ч).
const AUTOMSG_RESCAN_FLOOR_SEC = 300

// Потолок длительности одного тика автолиста (wall-clock). При превышении — мягко
// прекращаем сканирование на границах чатов/кандидатов/флоу и до-обработаем на
// следующем тике (стадии флоу резюмируемы). Защита от 35-мин монополизации гейта.
const AUTOLIST_TICK_BUDGET_MS = Math.max(15000, Number(process.env.AUTOLIST_TICK_BUDGET_MS) || 75000)

async function handleAutolistTick({ payload, currentUserId, deps }) {
  const {
    getTokenFromBodyOrStored,
    withRetry,
    isPlayerokRateLimitError,
    isPlayerokPublishRetryable,
    getViewer,
    requestUserChatsPage,
    AUTOLIST_MAX_CHATS_TO_SCAN,
    autolistGetCompletedScanMap,
    autolistGetLastChatMeta,
    autolistGetApprouteRetryMap,
    autolistPruneProcessedMap,
    autolistPruneSeenChatsMap,
    autolistPruneItemStateMap,
    autolistPruneSupercellFlowMap,
    AUTOLIST_COMPLETED_SCAN_INTERVAL_SEC,
    AUTOLIST_LAST_CHAT_FRESH_SEC,
    AUTOBUMP_PRIORITY_STATUS_ID,
    scanCompletedAndRelist,
    fetchCompletedItemsFromPlayerok,
    autolistGetItemState,
    autolistWasProcessed,
    autolistMarkProcessed,
    autolistClearProcessed,
    autolistSetItemState,
    getSettings,
    getGroupSettingsKey,
    requestItemById,
    fetchItemPriorityStatuses,
    publishItem,
    insertListingFee,
    normalizeKeyPart,
    buildProductKey,
    handlePaidChat,
    claimNextUnusedTableCode,
    requestDealById,
    toUnixTs,
    dealPurchaseUnixTs,
    insertSale,
    resolveEffectiveProductSettings,
    getSupercellGameByCategory,
    pickSupercellCategoryFromItemHints,
    autolistGetSupercellFlowMap,
    extractSupercellEmailFromFields,
    upsertSettings,
    createChatMessage,
    sleep,
    processActiveSupercellFlows,
    processSingleSupercellFlow,
    autolistGetTopupFlowMap,
    autolistPruneTopupFlowMap,
    processActiveTopupFlows,
    processSingleTopupFlow,
    autolistGetClodeFlowMap,
    autolistPruneClodeFlowMap,
    processActiveClodeFlows,
    processSingleClodeFlow,
    autolistGetGptFlowMap,
    autolistPruneGptFlowMap,
    processActiveGptFlows,
    processSingleGptFlow,
    autolistGetSwizzyerFlowMap,
    autolistPruneSwizzyerFlowMap,
    processActiveSwizzyerFlows,
    processSingleSwizzyerFlow,
    autolistGetPartnerGptFlowMap,
    autolistPrunePartnerGptFlowMap,
    processActivePartnerGptFlows,
    processSinglePartnerGptFlow,
    isSupercellModuleEnabled,
    handleOrderedStageAutomessage,
    handlePostPurchaseAutomessage,
    handleDealConfirmedAutomessage,
    handlePurchaseWindowAutomessage,
    handleImageAutomessage,
    sendChatImage,
    automessageImagesDir,
    fetchDealChatMessagesFromPlayerok,
    loadApprouteApiKeyPlain,
    runApprouteAutodelivery,
    updateDealStatus,
    requestChatDealIdPost,
    requestChatById,
    isOutboundCircuitOpen,
  } = deps

  const nowTs = Math.floor(Date.now() / 1000)
  const tickStartedAt = Date.now()
  const budgetExceeded = () => Date.now() - tickStartedAt > AUTOLIST_TICK_BUDGET_MS
  const circuitOpen = () => typeof isOutboundCircuitOpen === 'function' && isOutboundCircuitOpen()
  const shouldStopScan = () => budgetExceeded() || circuitOpen()

  // ── Инструментирование подзадач для вкладки «Список выполнения» ──────────────
  // Лёгкий сбор статуса/таймингов по подзадачам одного прохода. Полностью
  // аддитивно: не меняет управляющий поток, ошибки сбора проглатываются, а
  // массив steps лишь дополняет тело ответа (агрегируется в job-обёртке).
  // status: 'run'|'ok'|'idle'|'skip'|'err'. ms — длительность блока, count —
  // сколько элементов обработано, note — короткая подпись.
  const steps = []
  const mkStep = (id, label) => {
    const s = { id, label, status: 'idle', ms: 0, count: 0, note: null }
    steps.push(s)
    return s
  }
  const stepChats = mkStep('chats', 'Получение чатов')
  const stepPaid = mkStep('paid-chats', 'Оплаченные чаты и автовыдача')
  const stepAuto = mkStep('automessages', 'Автосообщения по стадиям')
  // Флоу выдачи отображаются как ПАРАЛЛЕЛЬНЫЕ под-задачи (отдельные карточки).
  const stepFlows = mkStep('flows', 'Флоу выдачи')
  let stepInFlight = null
  let stepT0 = 0
  const stepStart = (s) => {
    stepInFlight = s
    stepT0 = Date.now()
    if (s && s.status === 'idle') s.status = 'run'
  }
  const stepEnd = (patch = {}) => {
    const s = stepInFlight
    stepInFlight = null
    if (!s) return
    s.ms += Math.max(0, Date.now() - stepT0)
    if (patch.status) s.status = patch.status
    else if (s.status === 'run') s.status = 'ok'
    if (typeof patch.count === 'number') s.count = patch.count
    if (patch.note != null) s.note = patch.note
  }

  const { token } = getTokenFromBodyOrStored(currentUserId, payload)
  const userAgent = payload.userAgent

  if (!token) {
    return { statusCode: 400, data: { error: 'Token is required' } }
  }

  const tokenHash = token
  const scanMeta = autolistGetCompletedScanMap(tokenHash)
  const lastChatMeta = autolistGetLastChatMeta(tokenHash)
  const supercellModuleEnabled = isSupercellModuleEnabled(currentUserId)

  let dealItemId = null

  try {
    stepStart(stepChats)
    const viewer = await withRetry(() => getViewer(token, userAgent), {
      label: 'getViewer',
      retries: 2,
      shouldRetry: isPlayerokRateLimitError,
    })

    const chatsData = await withRetry(() => requestUserChatsPage(token, userAgent, viewer.id), {
      label: 'userChats',
      retries: 3,
      shouldRetry: isPlayerokRateLimitError,
    })

    const chatNodes = Array.isArray(chatsData?.edges)
      ? chatsData.edges.map((e) => e && e.node).filter(Boolean).slice(0, AUTOLIST_MAX_CHATS_TO_SCAN)
      : []
    stepEnd({ status: 'ok', count: chatNodes.length })

    autolistPruneProcessedMap(tokenHash, nowTs)
    autolistPruneSeenChatsMap(tokenHash, nowTs)
    autolistPruneItemStateMap(tokenHash, nowTs)
    autolistPruneSupercellFlowMap(tokenHash, nowTs)
    if (typeof autolistPruneTopupFlowMap === 'function') autolistPruneTopupFlowMap(tokenHash, nowTs)
    if (typeof autolistPruneClodeFlowMap === 'function') autolistPruneClodeFlowMap(tokenHash, nowTs)
    if (typeof autolistPruneGptFlowMap === 'function') autolistPruneGptFlowMap(tokenHash, nowTs)
    if (typeof autolistPruneSwizzyerFlowMap === 'function') autolistPruneSwizzyerFlowMap(tokenHash, nowTs)
    if (typeof autolistPrunePartnerGptFlowMap === 'function') autolistPrunePartnerGptFlowMap(tokenHash, nowTs)

    // Периодический скан/перевыставление вынесен в ОТДЕЛЬНЫЙ фоновый цикл
    // (job 'relist' / handleRelistTick), чтобы медленный скан не задерживал быстрые
    // задачи выдачи/2FA. Здесь остаётся только paid_chat-перевыставление (ниже).
    const periodicResult = null

    dealItemId = null

    stepStart(stepPaid)
    let approuteOnlyDeliveries = 0
    const PAID_CHAT_TOP_N = Math.min(10, AUTOLIST_MAX_CHATS_TO_SCAN)
    const chatsSlice = chatNodes.slice(0, PAID_CHAT_TOP_N)
    if (!lastChatMeta.lastMessageIdByChatId || typeof lastChatMeta.lastMessageIdByChatId !== 'object') {
      lastChatMeta.lastMessageIdByChatId = {}
    }
    const msgIdByChat = lastChatMeta.lastMessageIdByChatId
    const approuteRetryMap = autolistGetApprouteRetryMap(tokenHash)
    const APPROUTE_RETRY_INTERVAL_SEC = 120
    const APPROUTE_RESCAN_MAX_PER_TICK = 3
    let approuteRescanCount = 0

    const paidChatCandidates = []
    const paidChatCandidateChatIds = new Set()

    const tryCollectPaidChatCandidate = async (chatNode, { approuteOnly = false } = {}) => {
      const chatId = chatNode?.id != null ? String(chatNode.id) : null
      const lm = chatNode?.lastMessage || null
      const currMsgId = lm?.id != null ? String(lm.id) : null
      if (!chatId || !currMsgId || paidChatCandidateChatIds.has(chatId)) return

      const prevMsgId = msgIdByChat[chatId] != null ? String(msgIdByChat[chatId]) : null
      const messageChanged = prevMsgId !== currMsgId
      let scopedMessages = []
      if (messageChanged || String(lm?.text || '').includes('{{ITEM_PAID}}')) {
        try {
          const fetched = await withRetry(
            () =>
              fetchDealChatMessagesFromPlayerok(token, userAgent, lm?.deal?.id || null, chatId, {
                viewerUsername: viewer?.username || null,
              }),
            {
              label: 'dealChatMessages(autolistTick)',
              retries: 2,
              shouldRetry: isPlayerokRateLimitError,
            }
          )
          scopedMessages = Array.isArray(fetched?.messages) ? fetched.messages : []
        } catch (_) {
          scopedMessages = []
        }
      }

      const resolved = await resolvePaidChatDealFromChat({
        token,
        userAgent,
        chatNode,
        withRetry,
        isPlayerokRateLimitError,
        requestDealById,
        requestChatDealIdPost,
        requestChatById,
        messages: scopedMessages,
      })
      const d = resolved.deal || lm?.deal || chatNode?.deal || null
      const candidateDealId = resolved.dealId
      let dItemId = resolved.dealItemId

      const approuteChatKey = dealApprouteChatEventKey(candidateDealId, dItemId)
      const approuteOrderKey = dealApprouteOrderEventKey(candidateDealId, dItemId)
      const legacyApprouteKey = `approute:${candidateDealId || dItemId || ''}`
      const approuteChatPending =
        Boolean(candidateDealId || dItemId) && !autolistWasProcessed(tokenHash, approuteChatKey)
      const approuteOrderPlaced =
        autolistWasProcessed(tokenHash, approuteOrderKey) ||
        autolistWasProcessed(tokenHash, legacyApprouteKey)
      if (approuteOnly && !approuteChatPending) return
      if (approuteOnly && !messageChanged && approuteChatPending) {
        if (approuteRescanCount >= APPROUTE_RESCAN_MAX_PER_TICK) return
        approuteRescanCount++
      }
      if (!messageChanged && !approuteChatPending) return

      if (!dItemId) {
        if (approuteChatPending) {
          logApprouteAutodelivery('skip: tick no_item_id', {
            chatId,
            approuteChatKey,
            dealId: candidateDealId,
            lastMessageText: lm?.text != null ? String(lm.text).slice(0, 120) : null,
          })
        }
        return
      }

      if (!messageChanged && approuteChatPending) {
        logApprouteAutodelivery('tick: rescan pending approute', {
          chatId,
          approuteChatKey,
          approuteOrderPlaced,
          dealId: candidateDealId,
        })
      }

      paidChatCandidateChatIds.add(chatId)
      paidChatCandidates.push({
        chatNode,
        lm,
        d,
        chatId,
        currMsgId,
        dItemId,
        candidateDealId,
        scopedMessages,
      })
    }

    for (const chatNode of chatsSlice) {
      if (shouldStopScan()) break
      await tryCollectPaidChatCandidate(chatNode)
    }
    for (const chatNode of chatNodes.slice(0, AUTOLIST_MAX_CHATS_TO_SCAN)) {
      if (shouldStopScan()) break
      await tryCollectPaidChatCandidate(chatNode, { approuteOnly: true })
    }

    if (paidChatCandidates.length > 0) {
      logApprouteAutodelivery('tick: paid_chat candidates', { count: paidChatCandidates.length })
    }

    let paidScanResult = null
    if (paidChatCandidates.length > 0) {
      paidScanResult = await scanCompletedAndRelist({
        trigger: 'paid_chat',
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
    }

    const relistedByScanIds =
      paidScanResult?.relisted && Array.isArray(paidScanResult.relisted)
        ? paidScanResult.relisted.map((r) => String(r.oldItemId))
        : []

    const paidChatHandledChatIds = []
    for (const cand of paidChatCandidates) {
      if (shouldStopScan()) break // остальных обработаем на следующем тике (watermark не сдвинут)
      const { chatNode, lm, d, chatId, currMsgId, dItemId, scopedMessages } = cand
      const candidateDealId = cand.candidateDealId || d?.id || null
      const dealEventKey = `deal:${candidateDealId || dItemId}`

      let fullDealSnapshot = null
      let candidateDealTs = 0
      let dealStatus = d?.status || null
      try {
        const fullDeal = await withRetry(() => requestDealById(token, userAgent, candidateDealId), {
          label: 'dealById(paidChatScan)',
          retries: 2,
          shouldRetry: isPlayerokRateLimitError,
        })
        fullDealSnapshot = fullDeal || null
        candidateDealTs = fullDeal
          ? dealPurchaseUnixTs(fullDeal, toUnixTs)
          : toUnixTs(lm?.createdAt)
        dealStatus = fullDeal?.status || d?.status || null
      } catch (_) {
        candidateDealTs = toUnixTs(lm?.createdAt) || 0
        dealStatus = d?.status || null
      }

      const approuteChatKey = dealApprouteChatEventKey(candidateDealId, dItemId)
      const approuteOrderKey = dealApprouteOrderEventKey(candidateDealId, dItemId)
      const legacyApprouteKey = `approute:${candidateDealId || dItemId}`
      const approuteChatSent = autolistWasProcessed(tokenHash, approuteChatKey)
      const approuteOrderPlaced =
        autolistWasProcessed(tokenHash, approuteOrderKey) ||
        autolistWasProcessed(tokenHash, legacyApprouteKey)
      const approuteChatPending = !approuteChatSent
      const approuteGuard = shouldSkipApprouteAutodelivery({
        dealStatus,
        lastMessageText: lm?.text,
      })

      if (approuteGuard.skip && !approuteOrderPlaced && !approuteChatPending) {
        logApprouteAutodelivery('skip: tick deal_state (no order)', {
          chatId,
          approuteChatKey,
          dealId: candidateDealId || null,
          reason: approuteGuard.reason,
          dealStatus: approuteGuard.dealStatus,
        })
      }

      if (autolistWasProcessed(tokenHash, dealEventKey) && approuteChatSent) {
        logApprouteAutodelivery('skip: tick already_handled', {
          chatId,
          dealEventKey,
          approuteChatKey,
          dealId: candidateDealId || null,
        })
        msgIdByChat[chatId] = currMsgId
        continue
      }

      const candidateAgeSec = candidateDealTs ? nowTs - candidateDealTs : null
      const isFreshPaid =
        candidateDealTs &&
        (candidateAgeSec == null || candidateAgeSec <= AUTOLIST_LAST_CHAT_FRESH_SEC)

      if (!isFreshPaid && !approuteChatPending) {
        logAutolistTick('paid_chat: пропуск (старая сделка)', {
          chatId,
          candidateAgeSec,
          dealEventKey,
          approuteChatKey,
          approuteSkip: approuteGuard.skip ? approuteGuard.reason : null,
          approuteChatPending,
        })
        msgIdByChat[chatId] = currMsgId
        continue
      }

      if (!isFreshPaid && approuteChatPending) {
        logAutolistTick('paid_chat: старая сделка, доставка в чат', {
          chatId,
          candidateAgeSec,
          dealEventKey,
          approuteChatKey,
          approuteOrderPlaced,
        })
      }

      const prevMsgId = msgIdByChat[chatId] != null ? String(msgIdByChat[chatId]) : null
      const messageChanged = prevMsgId !== currMsgId
      if (!messageChanged && approuteChatPending && !approuteOrderPlaced) {
        const lastRetryTs = Number(approuteRetryMap[approuteChatKey] || 0)
        if (lastRetryTs && nowTs - lastRetryTs < APPROUTE_RETRY_INTERVAL_SEC) {
          continue
        }
      }

      dealItemId = dItemId
      const deliveryOnly = !isFreshPaid && approuteChatPending
      if (deliveryOnly) approuteOnlyDeliveries++
      await handlePaidChat({
        currentUserId,
        tokenHash,
        token,
        userAgent,
        nowTs,
        dealId: candidateDealId,
        dealItemId: dItemId,
        dealTs: candidateDealTs,
        dealStatus,
        lastChat: chatNode,
        fullDealSnapshot,
        relistedByScanIds,
        deliveryOnly,
        AUTOBUMP_PRIORITY_STATUS_ID,
        withRetry,
        isPlayerokRateLimitError,
        isPlayerokPublishRetryable,
        requestItemById,
        fetchItemPriorityStatuses,
        publishItem,
        insertListingFee,
        autolistMarkProcessed,
        autolistClearProcessed,
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
        autolistGetSwizzyerFlowMap,
        autolistGetPartnerGptFlowMap,
        extractSupercellEmailFromFields,
        upsertSettings,
        createChatMessage,
        sleep,
        supercellModuleEnabled,
        claimNextUnusedTableCode,
        loadApprouteApiKeyPlain,
        runApprouteAutodelivery,
        updateDealStatus,
        chatMessages: Array.isArray(scopedMessages) ? scopedMessages : [],
        viewerUsername: viewer?.username || null,
        toUnixTs,
        sendChatImage,
        automessageImagesDir,
      })

      if (approuteChatPending) {
        approuteRetryMap[approuteChatKey] = nowTs
      }

      lastChatMeta.lastPaidTs = Math.max(Number(lastChatMeta.lastPaidTs || 0), candidateDealTs || 0)
      msgIdByChat[chatId] = currMsgId
      paidChatHandledChatIds.push(chatId)
    }

    stepEnd({
      status: paidChatHandledChatIds.length > 0 ? 'ok' : 'idle',
      count: paidChatHandledChatIds.length,
      note:
        paidChatCandidates.length > 0
          ? `кандидатов: ${paidChatCandidates.length}` +
            (approuteOnlyDeliveries > 0 ? `, approute-докатка: ${approuteOnlyDeliveries}` : '')
          : null,
    })

    const currentLastChat = chatNodes.length > 0 ? chatNodes[0] : null
    const currentLastChatId = currentLastChat?.id || null
    const currentLastMessageId = currentLastChat?.lastMessage?.id || null

    if (currentLastChatId) {
      lastChatMeta.lastChatId = currentLastChatId
    }
    if (currentLastMessageId) {
      lastChatMeta.lastMessageId = currentLastMessageId
    }

    const chatAutomessageScans = [
      {
        handler: handleOrderedStageAutomessage
          ? (p) => handleOrderedStageAutomessage(p, 'purchase')
          : handlePurchaseWindowAutomessage,
        markers: [ITEM_PAID_MARKER],
        logLabel: 'purchase-stage-automessage',
        skipProcessedPreCheck: true,
      },
      {
        handler: handleOrderedStageAutomessage
          ? (p) => handleOrderedStageAutomessage(p, 'sent')
          : handlePostPurchaseAutomessage,
        markers: [ITEM_SENT_MARKER],
        logLabel: 'sent-stage-automessage',
        skipProcessedPreCheck: true,
      },
      {
        handler: handleOrderedStageAutomessage
          ? (p) => handleOrderedStageAutomessage(p, 'confirmed')
          : handleDealConfirmedAutomessage,
        markers: DEAL_CONFIRMED_MARKERS,
        logLabel: 'confirmed-stage-automessage',
        skipProcessedPreCheck: true,
      },
    ]

    // Watermark-карта повторных сканов: ключ `${scan.logLabel}::${chatId}` ->
    // { msgId, scannedAt }. Лёгкая чистка устаревших записей (старше окна триггера),
    // чтобы карта не росла бесконечно при ротации чатов.
    if (!lastChatMeta.automsgScan || typeof lastChatMeta.automsgScan !== 'object') {
      lastChatMeta.automsgScan = {}
    }
    for (const [k, v] of Object.entries(lastChatMeta.automsgScan)) {
      if (!v || nowTs - Number(v.scannedAt || 0) > CHAT_AUTOMESSAGE_MAX_TRIGGER_AGE_SEC) {
        delete lastChatMeta.automsgScan[k]
      }
    }

    stepStart(stepAuto)
    let automsgHandled = 0
    for (const scan of chatAutomessageScans) {
      if (!scan.handler) continue
      if (shouldStopScan()) break
      for (const chatNode of chatsSlice) {
        if (shouldStopScan()) break
        const chatId = chatNode?.id != null ? String(chatNode.id) : null
        const lm = chatNode?.lastMessage || null
        const currMsgId = lm?.id != null ? String(lm.id) : null
        if (!chatId || !currMsgId) continue
        const lmText = String(lm?.text || '')
        if (!lastMessageHasAnyMarker(lmText, scan.markers)) continue

        const d = lm?.deal || null
        const candidateDealId = d?.id || null
        const dItemId = d?.item?.id || null
        const eventKey = scan.buildEventKey
          ? scan.buildEventKey(chatId, candidateDealId)
          : null
        if (!scan.skipProcessedPreCheck) {
          if (!eventKey || autolistWasProcessed(tokenHash, eventKey)) continue
        }

        const triggerTs = toUnixTs(lm?.createdAt)
        if (
          triggerTs > 0 &&
          nowTs - triggerTs > CHAT_AUTOMESSAGE_MAX_TRIGGER_AGE_SEC
        ) {
          if (!scan.skipProcessedPreCheck && eventKey) {
            autolistMarkProcessed(tokenHash, eventKey, nowTs)
          }
          continue
        }

        // Троттлинг: если для этой стадии lastMessage в чате не изменился с прошлого
        // УСПЕШНОГО скана и не прошёл интервал принудительного перечитывания —
        // повторный сетевой fetch не делаем (ответ был бы тем же, хендлер всё равно
        // дедупит по журналу sent_automessages). Watermark пишем только при успехе
        // (ниже), поэтому брошенная ошибка fetch/handler не блокирует ретрай.
        const automsgScanKey = `${scan.logLabel}::${chatId}`
        const prevScan = lastChatMeta.automsgScan[automsgScanKey]
        if (
          prevScan &&
          prevScan.msgId === currMsgId &&
          Number(prevScan.scannedAt) > 0 &&
          nowTs - Number(prevScan.scannedAt) < AUTOMSG_RESCAN_FLOOR_SEC
        ) {
          continue
        }

        try {
          const { messages, itemTitle, itemCategory } = await withRetry(
            () =>
              fetchDealChatMessagesFromPlayerok(token, userAgent, candidateDealId, chatId, {
                viewerUsername: viewer?.username || null,
              }),
            {
              label: `dealChatMessages(${scan.logLabel})`,
              retries: 2,
              shouldRetry: isPlayerokRateLimitError,
            }
          )
          await scan.handler({
            currentUserId,
            tokenHash,
            token,
            userAgent,
            nowTs,
            chatId,
            dealId: candidateDealId,
            dealItemId: dItemId,
            messages,
            itemTitle,
            itemCategory,
            viewerUsername: viewer?.username || null,
            withRetry,
            isPlayerokRateLimitError,
            requestDealById,
            requestItemById,
            resolveEffectiveProductSettings,
            createChatMessage,
            normalizeKeyPart,
            buildProductKey,
            toUnixTs,
            sendChatImage,
            automessageImagesDir,
          })
          automsgHandled++
          // Успешно прочитали и обработали этот lastMessage для данной стадии —
          // фиксируем watermark, чтобы не перечитывать чат до смены сообщения или
          // истечения AUTOMSG_RESCAN_FLOOR_SEC.
          lastChatMeta.automsgScan[automsgScanKey] = { msgId: currMsgId, scannedAt: nowTs }
        } catch (err) {
          warnAutolistTick(`${scan.logLabel} scan failed`, {
            chatId,
            dealId: candidateDealId || null,
            error: err?.message || String(err),
          })
        }
      }
    }
    stepEnd({ status: automsgHandled > 0 ? 'ok' : 'idle', count: automsgHandled })

    // Флоу-автовыдача (Clode/Supercell/Topup/GPT) приоритетна: при ЗАКРЫТОМ брейкере
    // выполняем её всегда (даже если скан исчерпал бюджет тика), чтобы не задерживать
    // доставку покупателю. При ОТКРЫТОМ брейкере (весь пул IP остыл) — пропускаем тик.
    if (circuitOpen()) {
      stepFlows.status = 'skip'
      stepFlows.note = 'circuit open'
      return {
        statusCode: 200,
        data: { ok: true, skipped: 'circuit_open', partial: true, steps },
      }
    }

    stepStart(stepFlows)
    const viewerUsername = viewer?.username || null
    const countActiveFlows = (getMap) => {
      if (typeof getMap !== 'function') return 0
      try {
        const m = getMap(tokenHash)
        return Object.values(m || {}).filter((st) => st && st.active).length
      } catch (_) {
        return 0
      }
    }

    // 6 флоу выдачи запускаются КОНКУРЕНТНО (Promise.all): они независимы (разные
    // чаты/флоу-мапы), а общий серийный gate Playerok сам упорядочивает HTTP — поэтому
    // 429 не ловим, но быстрый 2FA-ответ одного флоу не ждёт другой. Каждый флоу — это
    // отдельная ПАРАЛЛЕЛЬНАЯ под-задача (parallel:true) → своя карточка на /execution.
    const flowDefs = [
      { id: 'flow-supercell', label: 'Supercell', getMap: autolistGetSupercellFlowMap,
        enabled: supercellModuleEnabled && typeof processActiveSupercellFlows === 'function',
        run: () => processActiveSupercellFlows({ tokenHash, token, userAgent, viewerUsername, nowTs, autolistGetSupercellFlowMap, processSingleSupercellFlow, shouldStop: shouldStopScan, currentUserId }) },
      { id: 'flow-topup', label: 'Topup (пополнение)', getMap: autolistGetTopupFlowMap,
        enabled: typeof processActiveTopupFlows === 'function' && typeof processSingleTopupFlow === 'function',
        run: () => processActiveTopupFlows({ tokenHash, token, userAgent, viewerUsername, nowTs, autolistGetTopupFlowMap, processSingleTopupFlow, shouldStop: shouldStopScan }) },
      { id: 'flow-clode', label: 'Clode (Claude CDK)', getMap: autolistGetClodeFlowMap,
        enabled: typeof processActiveClodeFlows === 'function' && typeof processSingleClodeFlow === 'function',
        run: () => processActiveClodeFlows({ tokenHash, token, userAgent, viewerUsername, nowTs, autolistGetClodeFlowMap, processSingleClodeFlow, shouldStop: shouldStopScan }) },
      { id: 'flow-gpt', label: 'GPT (987ai)', getMap: autolistGetGptFlowMap,
        enabled: typeof processActiveGptFlows === 'function' && typeof processSingleGptFlow === 'function',
        run: () => processActiveGptFlows({ tokenHash, token, userAgent, viewerUsername, nowTs, autolistGetGptFlowMap, processSingleGptFlow, shouldStop: shouldStopScan }) },
      { id: 'flow-swizzyer', label: 'Swizzyer (Roblox)', getMap: autolistGetSwizzyerFlowMap,
        enabled: typeof processActiveSwizzyerFlows === 'function' && typeof processSingleSwizzyerFlow === 'function',
        run: () => processActiveSwizzyerFlows({ tokenHash, token, userAgent, viewerUsername, nowTs, autolistGetSwizzyerFlowMap, processSingleSwizzyerFlow, shouldStop: shouldStopScan }) },
      { id: 'flow-pgpt', label: 'ChatGPT/Claude (partner)', getMap: autolistGetPartnerGptFlowMap,
        enabled: typeof processActivePartnerGptFlows === 'function' && typeof processSinglePartnerGptFlow === 'function',
        run: () => processActivePartnerGptFlows({ tokenHash, token, userAgent, viewerUsername, nowTs, autolistGetPartnerGptFlowMap, processSinglePartnerGptFlow, shouldStop: shouldStopScan }) },
    ]

    const flowSubSteps = await Promise.all(
      flowDefs.map(async (def) => {
        const activeBefore = countActiveFlows(def.getMap)
        const sub = { id: def.id, label: def.label, status: 'idle', ms: 0, count: activeBefore, note: null, parallel: true }
        if (!def.enabled) {
          sub.status = 'skip'
          return sub
        }
        const t = Date.now()
        try {
          await def.run()
          const activeAfter = countActiveFlows(def.getMap)
          sub.count = Math.max(activeBefore, activeAfter)
          sub.status = sub.count > 0 ? 'ok' : 'idle'
        } catch (err) {
          sub.status = 'err'
          sub.note = (err && err.message ? String(err.message) : String(err)).slice(0, 160)
        }
        sub.ms = Date.now() - t
        return sub
      })
    )
    for (const sub of flowSubSteps) steps.push(sub)

    const flowsTotal = flowSubSteps.reduce((n, s) => n + (Number(s.count) || 0), 0)
    stepEnd({
      status: flowSubSteps.some((s) => s.status === 'err') ? 'err' : flowsTotal > 0 ? 'ok' : 'idle',
      count: flowsTotal,
      note: flowSubSteps.map((s) => `${String(s.label).split(' ')[0].toLowerCase()}:${s.count}`).join(' '),
    })

    if (periodicResult && periodicResult.action === 'relisted') {
      return {
        statusCode: 200,
        data: {
          ok: true,
          from: 'periodic',
          steps,
          ...periodicResult,
        },
      }
    }

    if (paidChatHandledChatIds.length > 0) {
      return {
        statusCode: 200,
        data: {
          ok: true,
          from: 'paid_chat',
          periodic: periodicResult,
          chatIds: paidChatHandledChatIds,
          chatId: paidChatHandledChatIds[0] || null,
          steps,
        },
      }
    }

    if (!currentLastChatId) {
      return { statusCode: 200, data: { ok: true, skipped: 'no_chats', steps } }
    }

    return {
      statusCode: 200,
      data: {
        ok: true,
        skipped: 'no_fresh_paid_or_relist',
        periodic: periodicResult,
        chatId: currentLastChatId,
        steps,
      },
    }
  } catch (err) {
    // Отметить подзадачу, на которой упал проход, как ошибочную (best-effort).
    try {
      if (stepInFlight) {
        stepInFlight.ms += Math.max(0, Date.now() - stepT0)
        stepInFlight.status = 'err'
        stepInFlight.note = err && err.message ? String(err.message).slice(0, 160) : String(err).slice(0, 160)
      }
    } catch (_) {
      // ignore
    }

    try {
      if (dealItemId) {
        autolistSetItemState(tokenHash, dealItemId, {
          status: 'error',
          error: err && err.message ? String(err.message) : String(err),
          updatedAt: nowTs,
        })
      }
    } catch (_) {
      // ignore
    }

    return {
      statusCode: 500,
      data: { error: err && err.message ? String(err.message) : 'autolist failed', steps },
    }
  }
}

module.exports = { handleAutolistTick }

