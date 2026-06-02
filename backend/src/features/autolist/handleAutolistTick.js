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
  CHAT_AUTOMESSAGE_MAX_TRIGGER_AGE_SEC,
} = require('./autolistState')

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
    isSupercellModuleEnabled,
    handlePostPurchaseAutomessage,
    handleDealConfirmedAutomessage,
    handlePurchaseWindowAutomessage,
    fetchDealChatMessagesFromPlayerok,
    loadApprouteApiKeyPlain,
    runApprouteAutodelivery,
    updateDealStatus,
    requestChatDealIdPost,
    requestChatById,
  } = deps

  const nowTs = Math.floor(Date.now() / 1000)

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

    autolistPruneProcessedMap(tokenHash, nowTs)
    autolistPruneSeenChatsMap(tokenHash, nowTs)
    autolistPruneItemStateMap(tokenHash, nowTs)
    autolistPruneSupercellFlowMap(tokenHash, nowTs)
    if (typeof autolistPruneTopupFlowMap === 'function') autolistPruneTopupFlowMap(tokenHash, nowTs)

    let periodicResult = null
    const lastScanTs = Number(scanMeta?.lastScanTs || 0)
    const shouldPeriodicScan =
      !lastScanTs || nowTs - lastScanTs >= AUTOLIST_COMPLETED_SCAN_INTERVAL_SEC

    if (shouldPeriodicScan) {
      periodicResult = await scanCompletedAndRelist({
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
    }

    dealItemId = null

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
      await tryCollectPaidChatCandidate(chatNode)
    }
    for (const chatNode of chatNodes.slice(0, AUTOLIST_MAX_CHATS_TO_SCAN)) {
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
        extractSupercellEmailFromFields,
        upsertSettings,
        createChatMessage,
        sleep,
        supercellModuleEnabled,
        loadApprouteApiKeyPlain,
        runApprouteAutodelivery,
        updateDealStatus,
        chatMessages: Array.isArray(scopedMessages) ? scopedMessages : [],
        viewerUsername: viewer?.username || null,
      })

      if (approuteChatPending) {
        approuteRetryMap[approuteChatKey] = nowTs
      }

      lastChatMeta.lastPaidTs = Math.max(Number(lastChatMeta.lastPaidTs || 0), candidateDealTs || 0)
      msgIdByChat[chatId] = currMsgId
      paidChatHandledChatIds.push(chatId)
    }

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
        handler: handlePostPurchaseAutomessage,
        markers: [ITEM_SENT_MARKER],
        buildEventKey: buildPostPurchaseAutomessageEventKey,
        logLabel: 'post-purchase-automessage',
      },
      {
        handler: handleDealConfirmedAutomessage,
        markers: DEAL_CONFIRMED_MARKERS,
        buildEventKey: buildDealConfirmedAutomessageEventKey,
        logLabel: 'deal-confirmed-automessage',
      },
      {
        handler: handlePurchaseWindowAutomessage,
        markers: [ITEM_PAID_MARKER],
        buildEventKey: buildPurchaseWindowAutomessageEventKey,
        logLabel: 'purchase-window-automessage',
      },
    ]

    for (const scan of chatAutomessageScans) {
      if (!scan.handler) continue
      for (const chatNode of chatsSlice) {
        const chatId = chatNode?.id != null ? String(chatNode.id) : null
        const lm = chatNode?.lastMessage || null
        const currMsgId = lm?.id != null ? String(lm.id) : null
        if (!chatId || !currMsgId) continue
        const lmText = String(lm?.text || '')
        if (!lastMessageHasAnyMarker(lmText, scan.markers)) continue

        const d = lm?.deal || null
        const candidateDealId = d?.id || null
        const dItemId = d?.item?.id || null
        const eventKey = scan.buildEventKey(chatId, candidateDealId)
        if (!eventKey || autolistWasProcessed(tokenHash, eventKey)) continue

        const triggerTs = toUnixTs(lm?.createdAt)
        if (
          triggerTs > 0 &&
          nowTs - triggerTs > CHAT_AUTOMESSAGE_MAX_TRIGGER_AGE_SEC
        ) {
          autolistMarkProcessed(tokenHash, eventKey, nowTs)
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
          })
        } catch (err) {
          warnAutolistTick(`${scan.logLabel} scan failed`, {
            chatId,
            dealId: candidateDealId || null,
            error: err?.message || String(err),
          })
        }
      }
    }

    if (supercellModuleEnabled) {
      await processActiveSupercellFlows({
        tokenHash,
        token,
        userAgent,
        viewerUsername: viewer?.username || null,
        nowTs,
        autolistGetSupercellFlowMap,
        processSingleSupercellFlow,
      })
    }

    if (typeof processActiveTopupFlows === 'function' && typeof processSingleTopupFlow === 'function') {
      await processActiveTopupFlows({
        tokenHash,
        token,
        userAgent,
        viewerUsername: viewer?.username || null,
        nowTs,
        autolistGetTopupFlowMap,
        processSingleTopupFlow,
      })
    }

    if (periodicResult && periodicResult.action === 'relisted') {
      return {
        statusCode: 200,
        data: {
          ok: true,
          from: 'periodic',
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
        },
      }
    }

    if (!currentLastChatId) {
      return { statusCode: 200, data: { ok: true, skipped: 'no_chats' } }
    }

    return {
      statusCode: 200,
      data: {
        ok: true,
        skipped: 'no_fresh_paid_or_relist',
        periodic: periodicResult,
        chatId: currentLastChatId,
      },
    }
  } catch (err) {
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
      data: { error: err && err.message ? String(err.message) : 'autolist failed' },
    }
  }
}

module.exports = { handleAutolistTick }

