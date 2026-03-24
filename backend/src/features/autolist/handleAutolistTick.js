async function handleAutolistTick({ payload, currentUserId, deps }) {
  const {
    getTokenFromBodyOrStored,
    withRetry,
    isPlayerokRateLimitError,
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
    insertSale,
    resolveEffectiveProductSettings,
    getSupercellGameByCategory,
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

    let lastChat = null
    let lastMessage = null
    let lastMessageId = null
    let lastMessageCreatedAt = null
    let deal = null
    let dealId = null
    let dealStatus = null
    dealItemId = null
    let dealTs = null
    let fullDealSnapshot = null

    const currentLastChat = chatNodes.length > 0 ? chatNodes[0] : null
    const currentLastChatId = currentLastChat?.id || null

    if (currentLastChatId && lastChatMeta.lastChatId && lastChatMeta.lastChatId !== currentLastChatId) {
      const lm = currentLastChat?.lastMessage || null
      const d = lm?.deal || null
      const dItemId = d?.item?.id || null
      if (dItemId) {
        const candidateDealId = d?.id || null
        const candidateLastMessageId = lm?.id || null

        let candidateDealTs = 0
        try {
          const fullDeal = await withRetry(() => requestDealById(token, userAgent, candidateDealId), {
            label: 'dealById(lastChat)',
            retries: 2,
            shouldRetry: isPlayerokRateLimitError,
          })
          fullDealSnapshot = fullDeal || null
          candidateDealTs = fullDeal
            ? toUnixTs(fullDeal.createdAt) || toUnixTs(fullDeal.completedAt) || 0
            : toUnixTs(lm?.createdAt)
          dealStatus = fullDeal?.status || d?.status || null
        } catch (_) {
          candidateDealTs = toUnixTs(lm?.createdAt) || 0
          dealStatus = d?.status || null
        }

        const candidateAgeSec = candidateDealTs ? nowTs - candidateDealTs : null
        const isFreshPaid =
          candidateDealTs &&
          (candidateAgeSec == null || candidateAgeSec <= AUTOLIST_LAST_CHAT_FRESH_SEC) &&
          (lastChatMeta.lastPaidTs == null || candidateDealTs > Number(lastChatMeta.lastPaidTs || 0))

        if (isFreshPaid) {
          lastChat = currentLastChat
          lastMessage = lm
          lastMessageId = candidateLastMessageId
          lastMessageCreatedAt = lm?.createdAt || null

          deal = d
          dealId = candidateDealId
          dealItemId = dItemId
          dealTs = candidateDealTs

          const paidScanResult = await scanCompletedAndRelist({
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

          const relistedByScanIds =
            paidScanResult?.relisted && Array.isArray(paidScanResult.relisted)
              ? paidScanResult.relisted.map((r) => String(r.oldItemId))
              : []

          await handlePaidChat({
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
            supercellModuleEnabled,
          })

          lastChatMeta.lastPaidTs = dealTs || nowTs

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

          return {
            statusCode: 200,
            data: {
              ok: true,
              from: 'paid_chat',
              periodic: periodicResult,
              chatId: currentLastChatId,
            },
          }
        }
      }
    }

    lastChatMeta.lastChatId = currentLastChatId || lastChatMeta.lastChatId

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

