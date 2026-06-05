const { sendJson } = require('./sendJson')
const { readJsonBody } = require('./readJsonBody')
const { runPlayerokInteractive } = require('../infra/playerokRequestGate')
const { runWithPlayerokUser } = require('../infra/playerokRequestContext')

function effectiveUserIdFromPayload(payload, currentUserId) {
  const raw = payload && Object.prototype.hasOwnProperty.call(payload, 'userId') ? payload.userId : null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : currentUserId
}

const { handleActiveLots } = require('../features/playerok/activeLots/handleActiveLots')
const { handleChats } = require('../features/playerok/chats/handleChats')
const { handleChatsProbeStep } = require('../features/playerok/chats/handleChatsProbeStep')
const { handleHideChat } = require('../features/playerok/chats/handleHideChat')
const { handleUnhideChat } = require('../features/playerok/chats/handleUnhideChat')
const { handleBump } = require('../features/playerok/bump/handleBump')
const { handleAutolistTick } = require('../features/autolist/handleAutolistTick')
const { handleRelistItem } = require('../features/playerok/relistItem/handleRelistItem')
const { handleItemPriorityStatuses } = require('../features/playerok/itemPriorityStatuses/handleItemPriorityStatuses')
const { handleCompletedLots } = require('../features/playerok/completedLots/handleCompletedLots')
const { handleInProgressDeals } = require('../features/playerok/inProgressDeals/handleInProgressDeals')
const { handleCompletedDeals } = require('../features/playerok/completedDeals/handleCompletedDeals')
const { handleDealChatMessages, handleDealChatMessagesBatch } = require('../features/playerok/dealChatMessages/handleDealChatMessages')
const { handleApprouteChatRescan } = require('../features/approute/handleApprouteChatRescan')
const { handleSendChatMessage } = require('../features/playerok/sendChatMessage/handleSendChatMessage')
const { handleRequestSupercellCode } = require('../features/playerok/requestSupercellCode/handleRequestSupercellCode')
const { handleCancelDeal } = require('../features/playerok/dealsActions/handleCancelDeal')
const { handleConfirmDeal } = require('../features/playerok/dealsActions/handleConfirmDeal')
const { handleCompleteDeal } = require('../features/playerok/dealsActions/handleCompleteDeal')
const { handleBalanceOverview } = require('../features/playerok/balance/handleBalanceOverview')
const { handleTransactionProviders } = require('../features/playerok/balance/handleTransactionProviders')
const { handleTransactions } = require('../features/playerok/balance/handleTransactions')
const { handleVerifiedCards } = require('../features/playerok/balance/handleVerifiedCards')
const { handleRequestWithdrawal } = require('../features/playerok/balance/handleRequestWithdrawal')
const { handleRemoveTransaction } = require('../features/playerok/balance/handleRemoveTransaction')

async function readPayloadMaybeLimited(req, { maxBytes = null } = {}) {
  const opts = maxBytes != null ? { fallback: {}, maxBytes } : { fallback: {} }
  return readJsonBody(req, opts)
}

async function dispatchPlayerok({ req, res, pathname, currentUserId, nowTs, deps }) {
  const actionsStopped = typeof deps.isAllActionsStopped === 'function' && deps.isAllActionsStopped()
  const readLimited = async () => {
    try {
      return await readPayloadMaybeLimited(req, { maxBytes: 1e6 })
    } catch (err) {
      if (err && err.statusCode === 413) return null
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return null
    }
  }

  const readUnlimited = async () => {
    try {
      return await readPayloadMaybeLimited(req, { maxBytes: null })
    } catch (_) {
      sendJson(res, 400, { error: 'Invalid JSON body' })
      return null
    }
  }

  if (req.method === 'POST' && pathname === '/api/playerok/active-lots') {
    const payload = await readLimited()
    if (payload == null) return true
    const result = await handleActiveLots({
      payload,
      currentUserId,
      deps: { getTokenFromBodyOrStored: deps.getTokenFromBodyOrStored, fetchActiveItemsFromPlayerok: deps.fetchActiveItemsFromPlayerok },
    })
    return sendJson(res, result.statusCode, result.data) || true
  }

  if (req.method === 'POST' && pathname === '/api/playerok/chats-probe-step') {
    const payload = await readLimited()
    if (payload == null) return true
    const result = await runPlayerokInteractive(() =>
      handleChatsProbeStep({
        payload,
        currentUserId,
        deps: {
          getTokenFromBodyOrStored: deps.getTokenFromBodyOrStored,
          getViewer: deps.getViewer,
          requestUserChatsPage: deps.requestUserChatsPage,
          isPlayerokRateLimitError: deps.isPlayerokRateLimitError,
        },
      })
    )
    return sendJson(res, result.statusCode, result.data) || true
  }

  if (req.method === 'POST' && pathname === '/api/playerok/chats') {
    const payload = await readLimited()
    if (payload == null) return true
    const chatsDeps = {
      getTokenFromBodyOrStored: deps.getTokenFromBodyOrStored,
      getHiddenChats: deps.getHiddenChats,
      withRetry: deps.withRetry,
      isPlayerokRateLimitError: deps.isPlayerokRateLimitError,
      getViewer: deps.getViewer,
      requestUserChatsPage: deps.requestUserChatsPage,
      fetchActiveItemsFromPlayerok: deps.fetchActiveItemsFromPlayerok,
      fetchCompletedItemsFromPlayerok: deps.fetchCompletedItemsFromPlayerok,
      fetchDealsFromPlayerok: deps.fetchDealsFromPlayerok,
      requestDealById: deps.requestDealById,
      requestChatById: deps.requestChatById,
      requestItemById: deps.requestItemById,
      requestChatMessagesPage: deps.requestChatMessagesPage,
      extractItemImageUrl: deps.extractItemImageUrl,
      getChatsSnapshotCache: deps.getChatsSnapshotCache,
      setChatsSnapshotCache: deps.setChatsSnapshotCache,
      isChatsSnapshotFresh: deps.isChatsSnapshotFresh,
      scheduleChatsSnapshotRefresh: deps.scheduleChatsSnapshotRefresh,
    }
    const effectiveUserId = effectiveUserIdFromPayload(payload, currentUserId)
    const result = await runWithPlayerokUser(effectiveUserId, () =>
      payload.warmup === true
        ? handleChats({ payload, currentUserId: effectiveUserId, deps: chatsDeps })
        : runPlayerokInteractive(() =>
            handleChats({ payload, currentUserId: effectiveUserId, deps: chatsDeps })
          )
    )
    return sendJson(res, result.statusCode, result.data) || true
  }

  if (req.method === 'POST' && pathname === '/api/playerok/hide-chat') {
    const payload = await readLimited()
    if (payload == null) return true
    const result = await handleHideChat({
      payload,
      currentUserId,
      deps: { getTokenFromBodyOrStored: deps.getTokenFromBodyOrStored, upsertHiddenChat: deps.upsertHiddenChat },
    })
    return sendJson(res, result.statusCode, result.data) || true
  }

  if (req.method === 'POST' && pathname === '/api/playerok/unhide-chat') {
    const payload = await readLimited()
    if (payload == null) return true
    const result = await handleUnhideChat({
      payload,
      currentUserId,
      deps: { getTokenFromBodyOrStored: deps.getTokenFromBodyOrStored, deleteHiddenChat: deps.deleteHiddenChat },
    })
    return sendJson(res, result.statusCode, result.data) || true
  }

  if (req.method === 'POST' && pathname === '/api/playerok/bump') {
    const payload = await readUnlimited()
    if (payload == null) return true
    const result = await handleBump({
      payload,
      currentUserId,
      deps: {
        getTokenFromBodyOrStored: deps.getTokenFromBodyOrStored,
        requestItemById: deps.requestItemById,
        fetchItemPriorityStatuses: deps.fetchItemPriorityStatuses,
        increaseItemPriorityStatus: deps.increaseItemPriorityStatus,
        insertBump: deps.insertBump,
        isPlayerokRateLimitError: deps.isPlayerokRateLimitError,
      },
    })
    return sendJson(res, result.statusCode, result.data) || true
  }

  if (req.method === 'POST' && pathname === '/api/playerok/autolist-tick') {
    if (actionsStopped) {
      return sendJson(res, 423, { ok: false, error: 'Фоновые действия остановлены' }) || true
    }
    const payload = await readUnlimited()
    if (payload == null) return true
    const effectiveUserId = effectiveUserIdFromPayload(payload, currentUserId)
    const result = await runWithPlayerokUser(effectiveUserId, () =>
      handleAutolistTick({
      payload,
      currentUserId: effectiveUserId,
      deps: {
        getTokenFromBodyOrStored: deps.getTokenFromBodyOrStored,
        withRetry: deps.withRetry,
        isPlayerokRateLimitError: deps.isPlayerokRateLimitError,
        isPlayerokPublishRetryable: deps.isPlayerokPublishRetryable,
        getViewer: deps.getViewer,
        requestUserChatsPage: deps.requestUserChatsPage,
        AUTOLIST_MAX_CHATS_TO_SCAN: deps.AUTOLIST_MAX_CHATS_TO_SCAN,
        autolistGetCompletedScanMap: deps.autolistGetCompletedScanMap,
        autolistGetLastChatMeta: deps.autolistGetLastChatMeta,
        autolistGetApprouteRetryMap: deps.autolistGetApprouteRetryMap,
        autolistPruneProcessedMap: deps.autolistPruneProcessedMap,
        autolistPruneSeenChatsMap: deps.autolistPruneSeenChatsMap,
        autolistPruneItemStateMap: deps.autolistPruneItemStateMap,
        autolistPruneSupercellFlowMap: deps.autolistPruneSupercellFlowMap,
        AUTOLIST_COMPLETED_SCAN_INTERVAL_SEC: deps.AUTOLIST_COMPLETED_SCAN_INTERVAL_SEC,
        AUTOLIST_LAST_CHAT_FRESH_SEC: deps.AUTOLIST_LAST_CHAT_FRESH_SEC,
        AUTOBUMP_PRIORITY_STATUS_ID: deps.AUTOBUMP_PRIORITY_STATUS_ID,
        scanCompletedAndRelist: deps.scanCompletedAndRelist,
        fetchCompletedItemsFromPlayerok: deps.fetchCompletedItemsFromPlayerok,
        autolistGetItemState: deps.autolistGetItemState,
        autolistWasProcessed: deps.autolistWasProcessed,
        autolistMarkProcessed: deps.autolistMarkProcessed,
        autolistClearProcessed: deps.autolistClearProcessed,
        autolistSetItemState: deps.autolistSetItemState,
        getSettings: deps.getSettings,
        getGroupSettingsKey: deps.getGroupSettingsKey,
        requestItemById: deps.requestItemById,
        fetchItemPriorityStatuses: deps.fetchItemPriorityStatuses,
        publishItem: deps.publishItem,
        insertListingFee: deps.insertListingFee,
        normalizeKeyPart: deps.normalizeKeyPart,
        buildProductKey: deps.buildProductKey,
        handlePaidChat: deps.handlePaidChat,
        claimNextUnusedTableCode: deps.claimNextUnusedTableCode,
        loadApprouteApiKeyPlain: deps.loadApprouteApiKeyPlain,
        runApprouteAutodelivery: deps.runApprouteAutodelivery,
        updateDealStatus: deps.updateDealStatus,
        requestDealById: deps.requestDealById,
        requestChatDealIdPost: deps.requestChatDealIdPost,
        requestChatById: deps.requestChatById,
        toUnixTs: deps.toUnixTs,
        dealPurchaseUnixTs: deps.dealPurchaseUnixTs,
        insertSale: deps.insertSale,
        resolveEffectiveProductSettings: deps.resolveEffectiveProductSettings,
        getSupercellGameByCategory: deps.getSupercellGameByCategory,
        pickSupercellCategoryFromItemHints: deps.pickSupercellCategoryFromItemHints,
        autolistGetSupercellFlowMap: deps.autolistGetSupercellFlowMap,
        autolistGetTopupFlowMap: deps.autolistGetTopupFlowMap,
        autolistPruneTopupFlowMap: deps.autolistPruneTopupFlowMap,
        autolistGetClodeFlowMap: deps.autolistGetClodeFlowMap,
        autolistPruneClodeFlowMap: deps.autolistPruneClodeFlowMap,
        autolistGetGptFlowMap: deps.autolistGetGptFlowMap,
        autolistPruneGptFlowMap: deps.autolistPruneGptFlowMap,
        extractSupercellEmailFromFields: deps.extractSupercellEmailFromFields,
        upsertSettings: deps.upsertSettings,
        createChatMessage: deps.createChatMessage,
        sleep: deps.sleep,
        processActiveSupercellFlows: deps.processActiveSupercellFlows,
        processSingleSupercellFlow: deps.processSingleSupercellFlow,
        processActiveTopupFlows: deps.processActiveTopupFlows,
        processSingleTopupFlow: deps.processSingleTopupFlow,
        processActiveClodeFlows: deps.processActiveClodeFlows,
        processSingleClodeFlow: deps.processSingleClodeFlow,
        processActiveGptFlows: deps.processActiveGptFlows,
        processSingleGptFlow: deps.processSingleGptFlow,
        isSupercellModuleEnabled: deps.isSupercellModuleEnabled,
        handleOrderedStageAutomessage: deps.handleOrderedStageAutomessage,
        handlePostPurchaseAutomessage: deps.handlePostPurchaseAutomessage,
        handleDealConfirmedAutomessage: deps.handleDealConfirmedAutomessage,
        handlePurchaseWindowAutomessage: deps.handlePurchaseWindowAutomessage,
        handleImageAutomessage: deps.handleImageAutomessage,
        sendChatImage: deps.sendChatImage,
        automessageImagesDir: deps.automessageImagesDir,
        fetchDealChatMessagesFromPlayerok: deps.fetchDealChatMessagesFromPlayerok,
      },
    }))
    return sendJson(res, result.statusCode, result.data) || true
  }

  if (req.method === 'POST' && pathname === '/api/playerok/relist-item') {
    const payload = await readUnlimited()
    if (payload == null) return true
    const result = await handleRelistItem({
      payload,
      currentUserId,
      deps: {
        getTokenFromBodyOrStored: deps.getTokenFromBodyOrStored,
        publishItem: deps.publishItem,
        fetchItemPriorityStatuses: deps.fetchItemPriorityStatuses,
        requestItemById: deps.requestItemById,
        withRetry: deps.withRetry,
        isPlayerokRateLimitError: deps.isPlayerokRateLimitError,
        isPlayerokPublishRetryable: deps.isPlayerokPublishRetryable,
        AUTOBUMP_PRIORITY_STATUS_ID: deps.AUTOBUMP_PRIORITY_STATUS_ID,
      },
    })
    return sendJson(res, result.statusCode, result.data) || true
  }

  if (req.method === 'POST' && pathname === '/api/playerok/item-priority-statuses') {
    const payload = await readUnlimited()
    if (payload == null) return true
    const result = await handleItemPriorityStatuses({
      payload,
      currentUserId,
      deps: {
        getTokenFromBodyOrStored: deps.getTokenFromBodyOrStored,
        requestItemById: deps.requestItemById,
        fetchItemPriorityStatuses: deps.fetchItemPriorityStatuses,
      },
    })
    return sendJson(res, result.statusCode, result.data) || true
  }

  if (req.method === 'POST' && pathname === '/api/playerok/completed-lots') {
    const payload = await readLimited()
    if (payload == null) return true
    const result = await handleCompletedLots({
      payload,
      currentUserId,
      nowTs,
      deps: {
        getTokenFromBodyOrStored: deps.getTokenFromBodyOrStored,
        fetchCompletedItemsFromPlayerok: deps.fetchCompletedItemsFromPlayerok,
        autolistPruneItemStateMap: deps.autolistPruneItemStateMap,
        autolistGetItemState: deps.autolistGetItemState,
      },
    })
    return sendJson(res, result.statusCode, result.data) || true
  }

  if (req.method === 'POST' && pathname === '/api/playerok/in-progress-deals') {
    const payload = await readLimited()
    if (payload == null) return true
    const result = await handleInProgressDeals({
      payload,
      currentUserId,
      deps: {
        getTokenFromBodyOrStored: deps.getTokenFromBodyOrStored,
        fetchInProgressDealsFromPlayerok: deps.fetchInProgressDealsFromPlayerok,
        fetchActiveItemsFromPlayerok: deps.fetchActiveItemsFromPlayerok,
        fetchCompletedItemsFromPlayerok: deps.fetchCompletedItemsFromPlayerok,
      },
    })
    return sendJson(res, result.statusCode, result.data) || true
  }

  if (req.method === 'POST' && pathname === '/api/playerok/completed-deals') {
    const payload = await readLimited()
    if (payload == null) return true
    const result = await handleCompletedDeals({
      payload,
      currentUserId,
      deps: {
        getTokenFromBodyOrStored: deps.getTokenFromBodyOrStored,
        fetchCompletedDealsFromPlayerok: deps.fetchCompletedDealsFromPlayerok,
        fetchActiveItemsFromPlayerok: deps.fetchActiveItemsFromPlayerok,
        fetchCompletedItemsFromPlayerok: deps.fetchCompletedItemsFromPlayerok,
      },
    })
    return sendJson(res, result.statusCode, result.data) || true
  }

  if (req.method === 'POST' && pathname === '/api/playerok/approute-chat-rescan') {
    const payload = await readLimited()
    if (payload == null) return true
    const result = await runPlayerokInteractive(() =>
      handleApprouteChatRescan({
        payload,
        currentUserId,
        deps: {
          getTokenFromBodyOrStored: deps.getTokenFromBodyOrStored,
          withRetry: deps.withRetry,
          isPlayerokRateLimitError: deps.isPlayerokRateLimitError,
          requestDealById: deps.requestDealById,
          requestChatDealIdPost: deps.requestChatDealIdPost,
          requestChatById: deps.requestChatById,
          requestItemById: deps.requestItemById,
          resolveEffectiveProductSettings: deps.resolveEffectiveProductSettings,
          fetchDealChatMessagesFromPlayerok: deps.fetchDealChatMessagesFromPlayerok,
          loadApprouteApiKeyPlain: deps.loadApprouteApiKeyPlain,
          updateDealStatus: deps.updateDealStatus,
          createChatMessage: deps.createChatMessage,
          autolistClearProcessed: deps.autolistClearProcessed,
          autolistMarkProcessed: deps.autolistMarkProcessed,
          normalizeKeyPart: deps.normalizeKeyPart,
          buildProductKey: deps.buildProductKey,
          sleep: deps.sleep,
        },
      })
    )
    return sendJson(res, result.statusCode, result.data) || true
  }

  if (req.method === 'POST' && pathname === '/api/playerok/deal-chat-messages') {
    if (actionsStopped) {
      return sendJson(res, 423, { ok: false, error: 'Фоновые действия остановлены' }) || true
    }
    // Внутренний эндпоинт (вызывается из синхронизации с уже загруженными
    // сообщениями в теле — prefetched). Тело может превышать 1 МБ, поэтому без
    // лимита, иначе запрос отбрасывается и автосообщения не отправляются.
    const payload = await readUnlimited()
    if (payload == null) return true
    const result = await handleDealChatMessages({
        payload,
        currentUserId,
        deps: {
          getTokenFromBodyOrStored: deps.getTokenFromBodyOrStored,
          withRetry: deps.withRetry,
          isPlayerokRateLimitError: deps.isPlayerokRateLimitError,
          getViewer: deps.getViewer,
          fetchDealChatMessagesFromPlayerok: deps.fetchDealChatMessagesFromPlayerok,
          autolistGetSupercellFlowMap: deps.autolistGetSupercellFlowMap,
          processSingleSupercellFlow: deps.processSingleSupercellFlow,
          autolistGetTopupFlowMap: deps.autolistGetTopupFlowMap,
          processSingleTopupFlow: deps.processSingleTopupFlow,
          autolistGetClodeFlowMap: deps.autolistGetClodeFlowMap,
          processSingleClodeFlow: deps.processSingleClodeFlow,
          autolistGetGptFlowMap: deps.autolistGetGptFlowMap,
          processSingleGptFlow: deps.processSingleGptFlow,
          isSupercellModuleEnabled: deps.isSupercellModuleEnabled,
          handleOrderedStageAutomessage: deps.handleOrderedStageAutomessage,
          handlePostPurchaseAutomessage: deps.handlePostPurchaseAutomessage,
          handleDealConfirmedAutomessage: deps.handleDealConfirmedAutomessage,
          handlePurchaseWindowAutomessage: deps.handlePurchaseWindowAutomessage,
          handleImageAutomessage: deps.handleImageAutomessage,
          sendChatImage: deps.sendChatImage,
          automessageImagesDir: deps.automessageImagesDir,
          requestDealById: deps.requestDealById,
          requestItemById: deps.requestItemById,
          resolveEffectiveProductSettings: deps.resolveEffectiveProductSettings,
          createChatMessage: deps.createChatMessage,
          normalizeKeyPart: deps.normalizeKeyPart,
          buildProductKey: deps.buildProductKey,
          toUnixTs: deps.toUnixTs,
          handlePaidChat: deps.handlePaidChat,
          claimNextUnusedTableCode: deps.claimNextUnusedTableCode,
          requestChatDealIdPost: deps.requestChatDealIdPost,
          loadApprouteApiKeyPlain: deps.loadApprouteApiKeyPlain,
          runApprouteAutodelivery: deps.runApprouteAutodelivery,
          updateDealStatus: deps.updateDealStatus,
          autolistWasProcessed: deps.autolistWasProcessed,
          autolistMarkProcessed: deps.autolistMarkProcessed,
          autolistClearProcessed: deps.autolistClearProcessed,
          extractSupercellEmailFromFields: deps.extractSupercellEmailFromFields,
          getSupercellGameByCategory: deps.getSupercellGameByCategory,
          pickSupercellCategoryFromItemHints: deps.pickSupercellCategoryFromItemHints,
          upsertSettings: deps.upsertSettings,
          insertSale: deps.insertSale,
          dealPurchaseUnixTs: deps.dealPurchaseUnixTs,
          isPlayerokPublishRetryable: deps.isPlayerokPublishRetryable,
          fetchItemPriorityStatuses: deps.fetchItemPriorityStatuses,
          publishItem: deps.publishItem,
          insertListingFee: deps.insertListingFee,
          autolistSetItemState: deps.autolistSetItemState,
          sleep: deps.sleep,
          AUTOBUMP_PRIORITY_STATUS_ID: deps.AUTOBUMP_PRIORITY_STATUS_ID,
        },
    })
    return sendJson(res, result.statusCode, result.data) || true
  }

  if (req.method === 'POST' && pathname === '/api/playerok/deal-chat-messages-batch') {
    if (actionsStopped) {
      return sendJson(res, 423, { ok: false, error: 'Фоновые действия остановлены' }) || true
    }
    const payload = await readLimited()
    if (payload == null) return true
    const result = await handleDealChatMessagesBatch({
        payload,
        currentUserId,
        deps: {
          getTokenFromBodyOrStored: deps.getTokenFromBodyOrStored,
          withRetry: deps.withRetry,
          isPlayerokRateLimitError: deps.isPlayerokRateLimitError,
          getViewer: deps.getViewer,
          fetchDealChatMessagesFromPlayerok: deps.fetchDealChatMessagesFromPlayerok,
          autolistGetSupercellFlowMap: deps.autolistGetSupercellFlowMap,
          processSingleSupercellFlow: deps.processSingleSupercellFlow,
          autolistGetTopupFlowMap: deps.autolistGetTopupFlowMap,
          processSingleTopupFlow: deps.processSingleTopupFlow,
          autolistGetClodeFlowMap: deps.autolistGetClodeFlowMap,
          processSingleClodeFlow: deps.processSingleClodeFlow,
          autolistGetGptFlowMap: deps.autolistGetGptFlowMap,
          processSingleGptFlow: deps.processSingleGptFlow,
          isSupercellModuleEnabled: deps.isSupercellModuleEnabled,
          handleOrderedStageAutomessage: deps.handleOrderedStageAutomessage,
          handlePostPurchaseAutomessage: deps.handlePostPurchaseAutomessage,
          handleDealConfirmedAutomessage: deps.handleDealConfirmedAutomessage,
          handlePurchaseWindowAutomessage: deps.handlePurchaseWindowAutomessage,
          handleImageAutomessage: deps.handleImageAutomessage,
          sendChatImage: deps.sendChatImage,
          automessageImagesDir: deps.automessageImagesDir,
          requestDealById: deps.requestDealById,
          requestItemById: deps.requestItemById,
          resolveEffectiveProductSettings: deps.resolveEffectiveProductSettings,
          createChatMessage: deps.createChatMessage,
          normalizeKeyPart: deps.normalizeKeyPart,
          buildProductKey: deps.buildProductKey,
          toUnixTs: deps.toUnixTs,
          handlePaidChat: deps.handlePaidChat,
          claimNextUnusedTableCode: deps.claimNextUnusedTableCode,
          requestChatDealIdPost: deps.requestChatDealIdPost,
          loadApprouteApiKeyPlain: deps.loadApprouteApiKeyPlain,
          runApprouteAutodelivery: deps.runApprouteAutodelivery,
          updateDealStatus: deps.updateDealStatus,
          autolistWasProcessed: deps.autolistWasProcessed,
          autolistMarkProcessed: deps.autolistMarkProcessed,
          autolistClearProcessed: deps.autolistClearProcessed,
          extractSupercellEmailFromFields: deps.extractSupercellEmailFromFields,
          getSupercellGameByCategory: deps.getSupercellGameByCategory,
          pickSupercellCategoryFromItemHints: deps.pickSupercellCategoryFromItemHints,
          upsertSettings: deps.upsertSettings,
          insertSale: deps.insertSale,
          dealPurchaseUnixTs: deps.dealPurchaseUnixTs,
          isPlayerokPublishRetryable: deps.isPlayerokPublishRetryable,
          fetchItemPriorityStatuses: deps.fetchItemPriorityStatuses,
          publishItem: deps.publishItem,
          insertListingFee: deps.insertListingFee,
          autolistSetItemState: deps.autolistSetItemState,
          sleep: deps.sleep,
          AUTOBUMP_PRIORITY_STATUS_ID: deps.AUTOBUMP_PRIORITY_STATUS_ID,
        },
    })
    return sendJson(res, result.statusCode, result.data) || true
  }

  if (req.method === 'POST' && pathname === '/api/playerok/send-chat-message') {
    const payload = await readLimited()
    if (payload == null) return true
    const result = await runPlayerokInteractive(() =>
      handleSendChatMessage({
        payload,
        currentUserId,
        deps: { getTokenFromBodyOrStored: deps.getTokenFromBodyOrStored, sendChatMessageToPlayerok: deps.sendChatMessageToPlayerok },
      })
    )
    return sendJson(res, result.statusCode, result.data) || true
  }

  if (req.method === 'POST' && pathname === '/api/playerok/request-supercell-code') {
    const payload = await readLimited()
    if (payload == null) return true
    const result = await runPlayerokInteractive(() =>
      handleRequestSupercellCode({
        payload,
        currentUserId,
        deps: {
          getTokenFromBodyOrStored: deps.getTokenFromBodyOrStored,
          getSupercellGameByCategory: deps.getSupercellGameByCategory,
          requestSupercellCodeForChat: deps.requestSupercellCodeForChat,
          isSupercellModuleEnabled: deps.isSupercellModuleEnabled,
          requestDealById: deps.requestDealById,
        },
      })
    )
    return sendJson(res, result.statusCode, result.data) || true
  }

  if (req.method === 'POST' && pathname === '/api/playerok/cancel-deal') {
    const payload = await readLimited()
    if (payload == null) return true
    const result = await handleCancelDeal({
      payload,
      currentUserId,
      deps: { getTokenFromBodyOrStored: deps.getTokenFromBodyOrStored, updateDealStatus: deps.updateDealStatus },
    })
    return sendJson(res, result.statusCode, result.data) || true
  }

  if (req.method === 'POST' && pathname === '/api/playerok/confirm-deal') {
    const payload = await readLimited()
    if (payload == null) return true
    const result = await handleConfirmDeal({
      payload,
      currentUserId,
      deps: { getTokenFromBodyOrStored: deps.getTokenFromBodyOrStored, updateDealStatus: deps.updateDealStatus },
    })
    return sendJson(res, result.statusCode, result.data) || true
  }

  if (req.method === 'POST' && pathname === '/api/playerok/complete-deal') {
    const payload = await readLimited()
    if (payload == null) return true
    const result = await handleCompleteDeal({
      payload,
      currentUserId,
      deps: { getTokenFromBodyOrStored: deps.getTokenFromBodyOrStored, updateDealStatus: deps.updateDealStatus },
    })
    return sendJson(res, result.statusCode, result.data) || true
  }

  if (req.method === 'POST' && pathname === '/api/playerok/balance-overview') {
    const payload = await readLimited()
    if (payload == null) return true
    const result = await handleBalanceOverview({
      payload,
      currentUserId,
      deps: { getTokenFromBodyOrStored: deps.getTokenFromBodyOrStored, getViewer: deps.getViewer },
    })
    return sendJson(res, result.statusCode, result.data) || true
  }

  if (req.method === 'POST' && pathname === '/api/playerok/transaction-providers') {
    const payload = await readLimited()
    if (payload == null) return true
    const result = await handleTransactionProviders({
      payload,
      currentUserId,
      deps: {
        getTokenFromBodyOrStored: deps.getTokenFromBodyOrStored,
        fetchTransactionProviders: deps.fetchTransactionProviders,
      },
    })
    return sendJson(res, result.statusCode, result.data) || true
  }

  if (req.method === 'POST' && pathname === '/api/playerok/transactions') {
    const payload = await readLimited()
    if (payload == null) return true
    const result = await handleTransactions({
      payload,
      currentUserId,
      deps: {
        getTokenFromBodyOrStored: deps.getTokenFromBodyOrStored,
        fetchTransactions: deps.fetchTransactions,
        getViewer: deps.getViewer,
      },
    })
    return sendJson(res, result.statusCode, result.data) || true
  }

  if (req.method === 'POST' && pathname === '/api/playerok/verified-cards') {
    const payload = await readLimited()
    if (payload == null) return true
    const result = await handleVerifiedCards({
      payload,
      currentUserId,
      deps: { getTokenFromBodyOrStored: deps.getTokenFromBodyOrStored, fetchVerifiedCards: deps.fetchVerifiedCards },
    })
    return sendJson(res, result.statusCode, result.data) || true
  }

  if (req.method === 'POST' && pathname === '/api/playerok/request-withdrawal') {
    const payload = await readLimited()
    if (payload == null) return true
    const result = await handleRequestWithdrawal({
      payload,
      currentUserId,
      deps: { getTokenFromBodyOrStored: deps.getTokenFromBodyOrStored, requestWithdrawal: deps.requestWithdrawal },
    })
    return sendJson(res, result.statusCode, result.data) || true
  }

  if (req.method === 'POST' && pathname === '/api/playerok/remove-transaction') {
    const payload = await readLimited()
    if (payload == null) return true
    const result = await handleRemoveTransaction({
      payload,
      currentUserId,
      deps: { getTokenFromBodyOrStored: deps.getTokenFromBodyOrStored, removeTransaction: deps.removeTransaction },
    })
    return sendJson(res, result.statusCode, result.data) || true
  }

  return false
}

module.exports = { dispatchPlayerok }

