const { logSupercellDebug } = require('../../../functions/supercellHelpers')
const { runApprouteFromDealChat } = require('../../approute/runApprouteFromDealChat')
const {
  buildAutomessageEvent,
  buildSupercellFlowEvent,
  buildSupercellFlowCheckEvent,
} = require('../../../debug/chatAutomationLog')

const BATCH_CONCURRENCY = 1
const MAX_BATCH_SIZE = 8
const supercellFlowInFlightByKey = new Set()

function beginSupercellFlowRun(tokenHash, chatId) {
  const key = `${String(tokenHash || '')}::${String(chatId || '')}`
  if (!tokenHash || !chatId || supercellFlowInFlightByKey.has(key)) return null
  supercellFlowInFlightByKey.add(key)
  return key
}

function finishSupercellFlowRun(lockKey) {
  if (!lockKey) return
  supercellFlowInFlightByKey.delete(lockKey)
}

async function resolveViewer({ token, userAgent, withRetry, isPlayerokRateLimitError, getViewer }) {
  try {
    return await withRetry(() => getViewer(token, userAgent), {
      label: 'getViewer(deal-chat-messages)',
      retries: 2,
      shouldRetry: isPlayerokRateLimitError,
    })
  } catch (_) {
    return null
  }
}

function pickEntryString(entry, ...keys) {
  for (const key of keys) {
    const value = entry && entry[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex
      nextIndex += 1
      results[currentIndex] = await mapper(items[currentIndex], currentIndex)
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), items.length)
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
  return results
}

function entryWantsMessagesOnly(entryPayload, sharedPayload) {
  if (entryPayload && entryPayload.messagesOnly === true) return true
  if (sharedPayload && sharedPayload.messagesOnly === true) return true
  return false
}

async function processDealChatMessagesEntry({ entryPayload, currentUserId, deps, viewer, sharedPayload }) {
  const {
    withRetry,
    isPlayerokRateLimitError,
    fetchDealChatMessagesFromPlayerok,
    autolistGetSupercellFlowMap,
    processSingleSupercellFlow,
    isSupercellModuleEnabled,
    handlePostPurchaseAutomessage: handlePostPurchaseAutomessageFn,
    handleDealConfirmedAutomessage: handleDealConfirmedAutomessageFn,
    requestDealById,
    requestItemById,
    resolveEffectiveProductSettings,
    createChatMessage,
    normalizeKeyPart,
    buildProductKey,
    toUnixTs,
    handlePaidChat,
    requestChatDealIdPost,
    loadApprouteApiKeyPlain,
    runApprouteAutodelivery,
    updateDealStatus,
    autolistWasProcessed,
    autolistMarkProcessed,
    autolistClearProcessed,
    extractSupercellEmailFromFields,
    getSupercellGameByCategory,
    pickSupercellCategoryFromItemHints,
    upsertSettings,
    insertSale,
    dealPurchaseUnixTs,
    isPlayerokPublishRetryable,
    fetchItemPriorityStatuses,
    publishItem,
    insertListingFee,
    autolistSetItemState,
    sleep,
    AUTOBUMP_PRIORITY_STATUS_ID,
  } = deps

  const token = sharedPayload.token
  const userAgent = sharedPayload.userAgent
  const dealId = entryPayload.dealId || null
  const chatId = entryPayload.chatId || null

  if (!dealId && !chatId) {
    throw new Error('dealId or chatId is required')
  }

  const buyerUsername = pickEntryString(entryPayload, 'buyerName', 'buyerUsername')
  const categoryHint = pickEntryString(entryPayload, 'category', 'itemCategory')

  const { messages, buyerSupercellEmail, itemTitle, itemImageUrl, itemCategory } =
    await fetchDealChatMessagesFromPlayerok(token, userAgent, dealId, chatId, {
      viewerUsername: viewer?.username || null,
      buyerUsername,
      categoryHint,
    })

  const effectiveChatId = chatId || entryPayload.chatId || null
  const dealItemId =
    entryPayload.dealItemId != null
      ? String(entryPayload.dealItemId).trim()
      : entryPayload.itemId != null
        ? String(entryPayload.itemId).trim()
        : null

  const automessageHandlers = [
    { fn: handlePostPurchaseAutomessageFn, logLabel: 'post-purchase-automessage' },
    { fn: handleDealConfirmedAutomessageFn, logLabel: 'deal-confirmed-automessage' },
  ]

  const automationEvents = []
  const messagesOnly = entryWantsMessagesOnly(entryPayload, sharedPayload)

  const runSupercellFlowIfActive = async (phase) => {
    if (messagesOnly || !chatId || !isSupercellModuleEnabled(currentUserId)) return

    const tokenHash = token
    const flowMap = autolistGetSupercellFlowMap(tokenHash)
    const state = flowMap[String(chatId)]
    logSupercellDebug('dealChatMessages:supercellFlowCheck', {
      chatId,
      dealIdFromRequest: dealId || null,
      categoryHint: categoryHint || null,
      flowActive: Boolean(state?.active),
      flowCategory: state?.category || null,
      flowDealId: state?.dealId || null,
      requestCodeRequested: Boolean(state?.requestCodeRequested),
      itemCategoryFromFetch: itemCategory || null,
      hasBuyerEmail: Boolean(buyerSupercellEmail),
      phase,
    })

    if (!(state && state.active)) return

    automationEvents.push(
      buildSupercellFlowCheckEvent({
        chatId,
        dealId,
        flowState: state,
        itemCategory,
        hasBuyerEmail: Boolean(buyerSupercellEmail),
      })
    )

    const lockKey = beginSupercellFlowRun(tokenHash, chatId)
    if (!lockKey) {
      logSupercellDebug('dealChatMessages:supercellFlowSkipInFlight', {
        chatId,
        dealIdFromRequest: dealId || null,
        phase,
      })
      return
    }

    const nowTs = Math.floor(Date.now() / 1000)
    try {
      const flowResult = await processSingleSupercellFlow(
        chatId,
        token,
        userAgent,
        viewer?.username || null,
        nowTs
      )
      const flowAction = String(flowResult?.action || '')
      if (
        flowAction === 'code_requested' ||
        flowAction === 'invalid_email_sent' ||
        flowAction === 'error'
      ) {
        automationEvents.push(
          buildSupercellFlowEvent({
            chatId,
            dealId,
            flowResult,
            flowState: state,
          })
        )
      }
    } catch (err) {
      automationEvents.push(
        buildSupercellFlowEvent({
          chatId,
          dealId,
          flowResult: {
            ran: true,
            action: 'error',
            reason: err?.message || String(err),
            chatId: String(chatId),
            dealId,
          },
          flowState: state,
        })
      )
    } finally {
      finishSupercellFlowRun(lockKey)
    }
  }

  if (effectiveChatId && !messagesOnly) {
    const nowTs = Math.floor(Date.now() / 1000)
    const automessageParams = {
      currentUserId,
      tokenHash: token,
      token,
      userAgent,
      nowTs,
      chatId: String(effectiveChatId),
      dealId,
      dealItemId: dealItemId || null,
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
    }

    for (const { fn, logLabel } of automessageHandlers) {
      if (!fn) continue
      try {
        const automessageResult = await fn(automessageParams)
        if (automessageResult?.sent || automessageResult?.reason === 'send_failed') {
          automationEvents.push(
            buildAutomessageEvent({
              logLabel,
              chatId: effectiveChatId,
              dealId,
              result: automessageResult,
            })
          )
        }
      } catch (err) {
        automationEvents.push(
          buildAutomessageEvent({
            logLabel,
            chatId: effectiveChatId,
            dealId,
            result: { sent: false, reason: 'send_failed', error: err?.message || String(err) },
          })
        )
      }
    }
  }

  await runSupercellFlowIfActive('before_paid_chat')

  if (!messagesOnly && effectiveChatId && typeof handlePaidChat === 'function') {
    try {
      await runApprouteFromDealChat({
        currentUserId,
        token,
        userAgent,
        chatId: String(effectiveChatId),
        dealId,
        dealItemId,
        messages,
        viewerUsername: viewer?.username || null,
        deps: {
          withRetry,
          isPlayerokRateLimitError,
          isPlayerokPublishRetryable,
          requestDealById,
          requestChatDealIdPost,
          requestChatById: deps.requestChatById,
          handlePaidChat,
          toUnixTs,
          dealPurchaseUnixTs,
          requestItemById,
          resolveEffectiveProductSettings,
          createChatMessage,
          normalizeKeyPart,
          buildProductKey,
          loadApprouteApiKeyPlain,
          runApprouteAutodelivery,
          updateDealStatus,
          autolistWasProcessed,
          autolistMarkProcessed,
          autolistClearProcessed,
          autolistGetSupercellFlowMap,
          extractSupercellEmailFromFields,
          getSupercellGameByCategory,
          pickSupercellCategoryFromItemHints,
          upsertSettings,
          insertSale,
          fetchItemPriorityStatuses,
          publishItem,
          insertListingFee,
          autolistSetItemState,
          sleep,
          AUTOBUMP_PRIORITY_STATUS_ID,
          supercellModuleEnabled: isSupercellModuleEnabled(currentUserId),
        },
      })
    } catch (_err) {}
  }

  // Flow может активироваться внутри handlePaidChat; повторно проверяем в этом же цикле.
  await runSupercellFlowIfActive('after_paid_chat')

  return {
    chatId: effectiveChatId ? String(effectiveChatId) : chatId ? String(chatId) : null,
    dealId: dealId || null,
    ok: true,
    list: messages,
    buyerSupercellEmail,
    itemTitle,
    itemImageUrl,
    itemCategory,
    automationEvents,
  }
}

async function handleDealChatMessages({ payload, currentUserId, deps }) {
  const { getTokenFromBodyOrStored, withRetry, isPlayerokRateLimitError, getViewer } = deps

  const { token } = getTokenFromBodyOrStored(currentUserId, payload)
  const userAgent = payload.userAgent
  const dealId = payload.dealId || null
  const chatId = payload.chatId || null

  if (!token || (!dealId && !chatId)) {
    return { statusCode: 400, data: { error: 'token and (dealId or chatId) are required' } }
  }

  try {
    const viewer = await resolveViewer({ token, userAgent, withRetry, isPlayerokRateLimitError, getViewer })
    const result = await processDealChatMessagesEntry({
      entryPayload: payload,
      currentUserId,
      deps,
      viewer,
      sharedPayload: {
        token,
        userAgent,
        messagesOnly: payload.messagesOnly === true,
      },
    })

    return {
      statusCode: 200,
      data: {
        list: result.list,
        buyerSupercellEmail: result.buyerSupercellEmail,
        itemTitle: result.itemTitle,
        itemImageUrl: result.itemImageUrl,
        itemCategory: result.itemCategory,
        automationEvents: Array.isArray(result.automationEvents) ? result.automationEvents : [],
      },
    }
  } catch (err) {
    const message = err && err.message ? String(err.message) : 'Не удалось загрузить сообщения чата с Playerok'
    return { statusCode: 500, data: { error: message } }
  }
}

async function handleDealChatMessagesBatch({ payload, currentUserId, deps }) {
  const { getTokenFromBodyOrStored, withRetry, isPlayerokRateLimitError, getViewer } = deps

  const { token } = getTokenFromBodyOrStored(currentUserId, payload)
  const userAgent = payload.userAgent
  const chats = Array.isArray(payload.chats) ? payload.chats : []

  if (!token) {
    return { statusCode: 400, data: { error: 'token is required' } }
  }
  if (chats.length === 0) {
    return { statusCode: 400, data: { error: 'chats array is required' } }
  }
  if (chats.length > MAX_BATCH_SIZE) {
    return {
      statusCode: 400,
      data: { error: `chats array exceeds max batch size (${MAX_BATCH_SIZE})` },
    }
  }

  const validChats = chats.filter((entry) => entry && (entry.dealId || entry.chatId))
  if (validChats.length === 0) {
    return { statusCode: 400, data: { error: 'each chat entry requires dealId or chatId' } }
  }

  try {
    const viewer = await resolveViewer({ token, userAgent, withRetry, isPlayerokRateLimitError, getViewer })
    const sharedPayload = {
      token,
      userAgent,
      messagesOnly: payload.messagesOnly === true,
    }

    const results = await mapWithConcurrency(validChats, BATCH_CONCURRENCY, async (entry) => {
      const chatId = entry.chatId != null ? String(entry.chatId) : null
      try {
        return await processDealChatMessagesEntry({
          entryPayload: entry,
          currentUserId,
          deps,
          viewer,
          sharedPayload,
        })
      } catch (err) {
        return {
          chatId,
          dealId: entry.dealId || null,
          ok: false,
          error: err && err.message ? String(err.message) : 'Не удалось загрузить сообщения чата',
        }
      }
    })

    return { statusCode: 200, data: { results } }
  } catch (err) {
    const message = err && err.message ? String(err.message) : 'Не удалось загрузить сообщения чатов с Playerok'
    return { statusCode: 500, data: { error: message } }
  }
}

module.exports = { handleDealChatMessages, handleDealChatMessagesBatch }
