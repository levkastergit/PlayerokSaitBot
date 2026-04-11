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
    isSupercellModuleEnabled,
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

    const paidChatCandidates = []
    for (const chatNode of chatsSlice) {
      const chatId = chatNode?.id != null ? String(chatNode.id) : null
      const lm = chatNode?.lastMessage || null
      const currMsgId = lm?.id != null ? String(lm.id) : null
      if (!chatId || !currMsgId) continue
      const prevMsgId = msgIdByChat[chatId] != null ? String(msgIdByChat[chatId]) : null
      if (prevMsgId === currMsgId) continue

      const d = lm?.deal || null
      const dItemId = d?.item?.id || null
      if (!dItemId) {
        msgIdByChat[chatId] = currMsgId
        continue
      }

      paidChatCandidates.push({ chatNode, lm, d, chatId, currMsgId, dItemId })
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
      const { chatNode, lm, d, chatId, currMsgId, dItemId } = cand
      const candidateDealId = d?.id || null
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

      if (autolistWasProcessed(tokenHash, dealEventKey)) {
        msgIdByChat[chatId] = currMsgId
        continue
      }

      const candidateAgeSec = candidateDealTs ? nowTs - candidateDealTs : null
      const isFreshPaid =
        candidateDealTs &&
        (candidateAgeSec == null || candidateAgeSec <= AUTOLIST_LAST_CHAT_FRESH_SEC)

      if (!isFreshPaid) {
        msgIdByChat[chatId] = currMsgId
        continue
      }

      dealItemId = dItemId
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
        AUTOBUMP_PRIORITY_STATUS_ID,
        withRetry,
        isPlayerokRateLimitError,
        isPlayerokPublishRetryable,
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
        pickSupercellCategoryFromItemHints,
        autolistGetSupercellFlowMap,
        extractSupercellEmailFromFields,
        upsertSettings,
        createChatMessage,
        sleep,
        supercellModuleEnabled,
      })

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

