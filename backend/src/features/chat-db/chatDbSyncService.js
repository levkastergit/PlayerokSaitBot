'use strict'

const crypto = require('crypto')
const { recordChatSyncStepLog } = require('../../debug/chatSyncStepLog')

const FULL_SCAN_PER_CHAT_TIMEOUT_MS = 90_000
const FULL_SCAN_DEFAULT_HISTORY_PAGES = 50

const fullScanGenerationByUser = new Map()

function withTimeout(promise, ms, label) {
  let timer
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Таймаут загрузки чата (${Math.round(ms / 1000)}с): ${label}`))
    }, ms)
  })
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function chatScanLabel(thread) {
  return (
    normalizeText(thread?.buyerName) ||
    normalizeText(thread?.itemTitle) ||
    (thread?.id ? String(thread.id).slice(0, 12) : 'чат')
  )
}

function normalizeText(value) {
  const s = value != null ? String(value).trim() : ''
  return s || null
}

function previewMessageText(value, maxLen = 160) {
  const s = normalizeText(value)
  if (!s) return null
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s
}

function pickLastMessageText(messages) {
  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const text = previewMessageText(list[i]?.text)
    if (text) return text
  }
  return null
}

function toCreatedTs(value) {
  if (!value) return 0
  const n = Date.parse(value)
  return Number.isFinite(n) ? n : 0
}

function isRecentByLastMessage() {
  return true
}

function filterMessagesByAge(messages) {
  return Array.isArray(messages) ? messages : []
}

function extractBuyerFromMessages(messages, viewerUsername) {
  const viewer = normalizeText(viewerUsername)
  if (!viewer) return null
  const viewerLower = viewer.toLowerCase()
  for (const m of Array.isArray(messages) ? messages : []) {
    const uname = normalizeText(m?.user?.username || m?.user?.name || null)
    if (!uname) continue
    const unameLower = uname.toLowerCase()
    if (unameLower !== viewerLower) return uname
  }
  return null
}

function resolveBuyerName({
  threadBuyerName,
  dataBuyerName,
  buyerNameFromMessages,
  viewerUsername,
}) {
  const viewer = normalizeText(viewerUsername)
  const threadBuyer = normalizeText(threadBuyerName)
  const dataBuyer = normalizeText(dataBuyerName)
  const fromMessages = normalizeText(buyerNameFromMessages)
  const viewerLower = viewer ? viewer.toLowerCase() : null
  const threadBuyerLower = threadBuyer ? threadBuyer.toLowerCase() : null
  const threadLooksLikeViewer = Boolean(viewerLower && threadBuyerLower && threadBuyerLower === viewerLower)
  return dataBuyer || fromMessages || (threadLooksLikeViewer ? null : threadBuyer) || null
}

function shouldForceBuyerNameNull({
  threadBuyerName,
  resolvedBuyerName,
  viewerUsername,
}) {
  const viewer = normalizeText(viewerUsername)
  if (!viewer) return false
  const threadBuyer = normalizeText(threadBuyerName)
  const resolvedBuyer = normalizeText(resolvedBuyerName)
  const viewerLower = viewer.toLowerCase()
  const threadLower = threadBuyer ? threadBuyer.toLowerCase() : null
  const resolvedLower = resolvedBuyer ? resolvedBuyer.toLowerCase() : null
  return threadLower === viewerLower && (!resolvedLower || resolvedLower === viewerLower)
}

function nodeToThread(node, opts = {}) {
  const lastMessage = node?.lastMessage || null
  const deal = lastMessage?.deal || node?.deal || null
  const item = deal?.item || null
  const buyer =
    deal?.buyer ||
    node?.buyer ||
    null
  const itemTitle =
    item?.title ||
    item?.name ||
    node?.item?.title ||
    node?.item?.name ||
    deal?.productTitle ||
    null
  const category =
    item?.game?.name ||
    item?.game?.title ||
    item?.category?.name ||
    item?.category?.title ||
    node?.game?.name ||
    node?.game?.title ||
    node?.category?.name ||
    node?.category?.title ||
    (typeof deal?.category === 'string' ? deal.category : null) ||
    null
  const unreadRaw = node?.unreadMessagesCount ?? node?.unreadCount ?? node?.unreadMessages
  const unreadCount = Number.isFinite(Number(unreadRaw)) ? Math.max(0, Math.trunc(Number(unreadRaw))) : 0

  return {
    id: node?.id != null ? String(node.id) : null,
    buyerName: normalizeText(buyer?.username || buyer?.name || null),
    itemTitle: normalizeText(itemTitle),
    itemImageUrl: item?.imageUrl || item?.image || node?.item?.imageUrl || node?.item?.image || null,
    category: normalizeText(category),
    status: normalizeText(node?.status || deal?.status || null),
    lastMessageId: lastMessage?.id != null ? String(lastMessage.id) : null,
    lastMessageText: normalizeText(lastMessage?.text || null),
    lastMessageCreatedAt: lastMessage?.createdAt || null,
    dealId: deal?.id != null ? String(deal.id) : null,
    itemId: item?.id != null ? String(item.id) : null,
    unreadCount,
  }
}

function buildDealRows({ userId, chatId, messages, itemTitle, itemCategory, buyerName, viewerUsername, nowTs }) {
  const byDeal = new Map()
  const fallbackTitle = normalizeText(itemTitle)
  const fallbackCategory = normalizeText(itemCategory)
  const viewerLower = normalizeText(viewerUsername)?.toLowerCase() || null
  for (const m of Array.isArray(messages) ? messages : []) {
    const dealId =
      m?.dealId != null ? String(m.dealId).trim() : m?.deal?.id != null ? String(m.deal.id).trim() : ''
    if (!dealId) continue
    const itemId =
      m?.deal?.item?.id != null ? String(m.deal.item.id) :
      m?.itemId != null ? String(m.itemId) : null
    const messageTs = toCreatedTs(m?.createdAt)
    const text = String(m?.text || '')
    const messageCategory = normalizeText(
      m?.itemCategory ||
      m?.deal?.item?.game?.name ||
      m?.deal?.item?.game?.title ||
      m?.deal?.item?.category?.name ||
      m?.deal?.item?.category?.title
    )
    const messageItemTitle = normalizeText(
      m?.dealItemTitle ||
      m?.deal?.item?.title ||
      m?.deal?.item?.name
    )
    const messageItemImageUrl = normalizeText(
      m?.dealItemImageUrl ||
      m?.deal?.item?.imageUrl ||
      m?.deal?.item?.image
    )
    const msgUserName = normalizeText(m?.user?.username || m?.user?.name || null)
    const buyerFromMsg =
      viewerLower && msgUserName && msgUserName.toLowerCase() !== viewerLower ? msgUserName : null

    const prev = byDeal.get(dealId)
    if (!prev) {
      byDeal.set(dealId, {
        userId: Number(userId),
        dealId,
        chatId: String(chatId),
        itemId: itemId || null,
        itemTitle: messageItemTitle || fallbackTitle || null,
        itemImageUrl: messageItemImageUrl || null,
        category: messageCategory || fallbackCategory || null,
        buyerName: buyerFromMsg || normalizeText(buyerName),
        status: null,
        isPaidMarkerSeen: text.includes('{{ITEM_PAID}}') ? 1 : 0,
        lastMessageId: m?.id != null ? String(m.id) : null,
        lastMessageTs: messageTs,
        lastSeenAt: messageTs || nowTs,
        updatedAt: nowTs,
        _messageTs: messageTs,
      })
      continue
    }
    if (itemId && !prev.itemId) prev.itemId = itemId
    if (messageItemTitle && !prev.itemTitle) prev.itemTitle = messageItemTitle
    if (messageItemImageUrl && !prev.itemImageUrl) prev.itemImageUrl = messageItemImageUrl
    if (messageCategory && !prev.category) prev.category = messageCategory
    if (buyerFromMsg && !prev.buyerName) prev.buyerName = buyerFromMsg
    if (text.includes('{{ITEM_PAID}}')) prev.isPaidMarkerSeen = 1
    if (messageTs >= Number(prev._messageTs || 0)) {
      prev.lastMessageId = m?.id != null ? String(m.id) : prev.lastMessageId
      prev._messageTs = messageTs
      prev.lastMessageTs = messageTs
      prev.lastSeenAt = messageTs || prev.lastSeenAt || nowTs
    }
  }
  return Array.from(byDeal.values()).map((row) => {
    const { _messageTs, ...clean } = row
    return clean
  })
}

function createChatDbSyncService({
  chatDbRepo,
  getViewer,
  requestUserChatsPage,
  fetchDealChatMessagesFromPlayerok,
  userAgentProvider,
  runAutomationForChat,
}) {
  if (!chatDbRepo) throw new Error('chatDbRepo is required')

  async function syncOneChangedChat({
    userId,
    token,
    userAgent,
    item,
    viewerUsername,
    fetchHistoryMaxPages = 40,
    runAutomation = true,
    queueLeft = 0,
    nowTs = Date.now(),
  }) {
    const uid = Number(userId)
    const ua = userAgent || (typeof userAgentProvider === 'function' ? userAgentProvider() : null)
    const thread = item.thread
    const node = item.node
    const prevThread = chatDbRepo.getThreadByChatId.get(uid, thread.id)
    const knownThreadItemId =
      thread?.itemId != null && String(thread.itemId).trim()
        ? String(thread.itemId).trim()
        : prevThread?.last_item_id != null && String(prevThread.last_item_id).trim()
          ? String(prevThread.last_item_id).trim()
          : null
    const chatStartedAt = Date.now()
    const dealIdHint = thread.dealId || null
    const maxPagesForChat =
      item.hasPrev && item.needsMetaRefresh && !item.messagesStale
        ? Math.min(2, Math.max(1, Number(fetchHistoryMaxPages) || 40))
        : fetchHistoryMaxPages

    try {
      const data = await fetchDealChatMessagesFromPlayerok(
        token,
        ua,
        dealIdHint,
        thread.id,
        {
          buyerUsername: thread.buyerName || undefined,
          categoryHint: thread.category || undefined,
          maxPages: maxPagesForChat,
        }
      )
      const messages = filterMessagesByAge(data?.messages, nowTs)
      const buyerNameFromMessages = extractBuyerFromMessages(messages, viewerUsername)
      const resolvedBuyerName = resolveBuyerName({
        threadBuyerName: thread.buyerName,
        dataBuyerName: data?.buyerUsername,
        buyerNameFromMessages,
        viewerUsername,
      })
      chatDbRepo.putMessages(uid, thread.id, messages, { syncedAt: nowTs })
      const deals = buildDealRows({
        userId: uid,
        chatId: thread.id,
        messages,
        itemTitle: data?.itemTitle || thread.itemTitle || null,
        itemCategory: data?.itemCategory || thread.category || null,
        buyerName: resolvedBuyerName,
        viewerUsername,
        nowTs,
      })
      const effectiveDealId = data?.effectiveDealId || thread.dealId || null
      const effectiveItemId = data?.effectiveItemId || knownThreadItemId || null
      if (deals.length === 0 && effectiveDealId) {
        deals.push({
          userId: uid,
          dealId: String(effectiveDealId),
          chatId: String(thread.id),
          itemId: effectiveItemId || null,
          itemTitle: data?.itemTitle || thread.itemTitle || null,
          itemImageUrl: data?.itemImageUrl || thread.itemImageUrl || null,
          category: data?.itemCategory || thread.category || null,
          buyerName: resolvedBuyerName,
          status: null,
          isPaidMarkerSeen: 0,
          lastMessageId: thread.lastMessageId || null,
          lastMessageTs: toCreatedTs(thread.lastMessageCreatedAt),
          lastSeenAt: toCreatedTs(thread.lastMessageCreatedAt) || nowTs,
          updatedAt: nowTs,
        })
      }

      const primaryDeal =
        deals.length > 0
          ? deals.reduce((best, d) => {
              const bt = best ? Number(best.lastMessageTs || 0) : -1
              const dt = Number(d.lastMessageTs || 0)
              return dt >= bt ? d : best
            }, null)
          : null

      const finalBuyerName = primaryDeal?.buyerName || resolvedBuyerName
      const forceBuyerNameNull = shouldForceBuyerNameNull({
        threadBuyerName: thread.buyerName,
        resolvedBuyerName: finalBuyerName,
        viewerUsername,
      })
      chatDbRepo.putThread(
        uid,
        {
          ...thread,
          buyerName: finalBuyerName,
          dealId: primaryDeal?.dealId || thread.dealId || null,
          itemId: primaryDeal?.itemId || effectiveItemId || null,
          itemTitle: primaryDeal?.itemTitle || data?.itemTitle || thread.itemTitle || null,
          itemImageUrl: primaryDeal?.itemImageUrl || data?.itemImageUrl || thread.itemImageUrl || null,
          category: primaryDeal?.category || data?.itemCategory || thread.category || null,
        },
        { syncedAt: nowTs, forceBuyerNameNull }
      )

      for (const deal of deals) {
        const dealItemIdForSave = deal.itemId || effectiveItemId || null
        chatDbRepo.upsertDeal.run(
          deal.userId,
          deal.dealId,
          deal.chatId,
          dealItemIdForSave,
          deal.itemTitle,
          deal.itemImageUrl,
          deal.category,
          deal.buyerName,
          deal.status,
          deal.isPaidMarkerSeen,
          deal.lastMessageId,
          deal.lastSeenAt,
          deal.updatedAt
        )
      }
      if (runAutomation && typeof runAutomationForChat === 'function') {
        await runAutomationForChat({
          userId: uid,
          token,
          userAgent: ua,
          chatId: thread.id,
          dealId: primaryDeal?.dealId || thread.dealId || null,
          dealItemId: primaryDeal?.itemId || effectiveItemId || null,
          node,
        })
      }

      recordChatSyncStepLog({
        ok: true,
        userId: uid,
        phase: 'chat_messages',
        source: 'dealChatMessages',
        durationMs: Date.now() - chatStartedAt,
        chatId: thread.id,
        chats: [
          {
            chatId: thread.id,
            buyerName: resolvedBuyerName,
            messagesCount: messages.length,
            lastMessageId: thread.lastMessageId || null,
            lastMessageText:
              previewMessageText(thread.lastMessageText) || pickLastMessageText(messages),
            syncAction: item.needsMetaRefresh ? 'meta_refresh' : 'fetch_messages',
          },
        ],
        sync: { messagesCount: messages.length, queueLeft },
      })

      return { ok: true, messagesCount: messages.length }
    } catch (err) {
      recordChatSyncStepLog({
        ok: false,
        userId: uid,
        phase: 'chat_messages',
        source: 'dealChatMessages',
        durationMs: Date.now() - chatStartedAt,
        chatId: thread.id,
        error: err && err.message ? String(err.message) : String(err),
        sync: { queueLeft },
      })
      throw err
    }
  }

  async function syncUserChatsListPoll({
    userId,
    token,
    userAgent,
    limit = 24,
  }) {
    const uid = Number(userId)
    if (!Number.isFinite(uid) || uid <= 0) throw new Error('invalid userId')
    if (!token) throw new Error('token required')
    const ua = userAgent || (typeof userAgentProvider === 'function' ? userAgentProvider() : null)
    const nowTs = Date.now()
    const stepStartedAt = Date.now()
    const chatDiagnostics = []
    let skippedChatsCount = 0

    const viewer = await getViewer(token, ua)
    const viewerUsername = normalizeText(viewer?.username || null)
    if (viewerUsername && typeof chatDbRepo.clearViewerAsBuyer === 'function') {
      chatDbRepo.clearViewerAsBuyer(uid, viewerUsername, { updatedAt: nowTs })
    }
    const page = await requestUserChatsPage(token, ua, viewer.id, { first: Number(limit) || 24 })
    const edges = Array.isArray(page?.edges) ? page.edges : []
    const changedChats = []
    const changedChatIds = []
    let recentChatsCount = 0

    for (const edge of edges) {
      const node = edge?.node
      if (!node) continue
      const thread = nodeToThread(node)
      if (!thread.id) continue
      const viewerLower = viewerUsername ? viewerUsername.toLowerCase() : null
      const threadBuyerIsViewer = Boolean(
        viewerUsername &&
        normalizeText(thread.buyerName) &&
        viewerLower && normalizeText(thread.buyerName).toLowerCase() === viewerLower
      )
      if (threadBuyerIsViewer) thread.buyerName = null
      const isRecent = isRecentByLastMessage(thread.lastMessageCreatedAt, nowTs)
      if (isRecent) recentChatsCount += 1
      const prev = chatDbRepo.getThreadByChatId.get(uid, thread.id)
      const prevLatestMessage = chatDbRepo.getLatestMessageByChatId.get(uid, thread.id)
      const prevLastFromMessages =
        prevLatestMessage?.message_id != null ? String(prevLatestMessage.message_id) : null
      const hasLocalMessagesHistory = Boolean(prevLastFromMessages)
      const latestKnownLast = hasLocalMessagesHistory ? prevLastFromMessages : null
      const nextLast = thread.lastMessageId != null ? String(thread.lastMessageId) : null
      const messagesBootstrapRequired = Boolean(nextLast) && !hasLocalMessagesHistory
      const changed = Boolean(nextLast && latestKnownLast !== nextLast)
      const metaReasons = []
      if (!prev) {
        metaReasons.push('new_chat')
      } else {
        if (!prev?.buyer_name) metaReasons.push('buyer_missing')
        if (!hasLocalMessagesHistory) {
        if (!prev?.last_deal_id) metaReasons.push('deal_missing')
        if (!prev?.last_item_id) metaReasons.push('item_missing')
        if (!prev?.category) metaReasons.push('category_missing')
        }
      }
      const needsMetaRefresh = metaReasons.length > 0

      let syncAction = 'skip'
      if (messagesBootstrapRequired) syncAction = 'bootstrap_messages'
      else if (changed) syncAction = 'fetch_messages'
      else if (needsMetaRefresh) syncAction = 'meta_refresh'

      chatDbRepo.putThread(uid, thread, {
        syncedAt: nowTs,
        forceBuyerNameNull: threadBuyerIsViewer,
      })
      if (messagesBootstrapRequired || changed || needsMetaRefresh) {
        changedChats.push({
          node,
          thread,
          hasPrev: Boolean(prev),
          needsMetaRefresh,
          messagesStale: changed || messagesBootstrapRequired,
          messagesBootstrapRequired,
          metaReasons,
        })
        changedChatIds.push(thread.id)
      } else {
        skippedChatsCount += 1
      }

      chatDiagnostics.push({
        chatId: thread.id,
        buyerName: thread.buyerName,
        category: thread.category,
        dealId: thread.dealId,
        itemId: thread.itemId,
        lastMessageId: thread.lastMessageId,
        lastMessageText: previewMessageText(thread.lastMessageText),
        lastMessageCreatedAt: thread.lastMessageCreatedAt,
        dbLastMessageId: latestKnownLast,
        dbLastMessageText: previewMessageText(
          prev?.last_message_text || prevLatestMessage?.text || null
        ),
        metaReason: needsMetaRefresh ? metaReasons.join(', ') : null,
        syncAction,
      })
    }

    const prevSync = chatDbRepo.getSyncState.get(uid)
    chatDbRepo.writeSyncState(uid, {
      lastPollAt: nowTs,
      lastSuccessAt: Number(prevSync?.last_success_at || nowTs),
      scanInProgress: Number(prevSync?.scan_in_progress || 0),
      scanProgressTotal: Number(prevSync?.scan_progress_total || 0),
      scanProgressDone: Number(prevSync?.scan_progress_done || 0),
      fullScanCompletedAt: Number(prevSync?.full_scan_completed_at || 0),
      fullScanRequestedAt: Number(prevSync?.full_scan_requested_at || 0),
      lastError: null,
    })

    const syncSummary = {
      playerokEdges: edges.length,
      fetchedChats: recentChatsCount,
      changedChats: changedChatIds.length,
      skippedChats: skippedChatsCount,
      changedChatIds,
      pageInfo: page?.pageInfo || null,
    }

    recordChatSyncStepLog({
      ok: true,
      userId: uid,
      phase: 'playerok_list',
      durationMs: Date.now() - stepStartedAt,
      source: 'userChats',
      limit: Number(limit) || 24,
      viewerUsername,
      pageInfo: page?.pageInfo || null,
      chats: chatDiagnostics,
      sync: syncSummary,
    })

    return {
      ok: true,
      userId: uid,
      viewerUsername,
      changedChats,
      chatDiagnostics,
      sync: syncSummary,
    }
  }

  async function syncUserChatsStep({
    userId,
    token,
    userAgent,
    limit = 24,
    fetchHistoryMaxPages = 40,
    runAutomation = true,
  }) {
    const uid = Number(userId)
    const nowTs = Date.now()
    const stepStartedAt = Date.now()

    try {
      const listResult = await syncUserChatsListPoll({
        userId,
        token,
        userAgent,
        limit,
      })
      const { changedChats, viewerUsername, chatDiagnostics, sync: syncSummary } = listResult

      for (const item of changedChats) {
        await syncOneChangedChat({
          userId: uid,
          token,
          userAgent,
          item,
          viewerUsername,
          fetchHistoryMaxPages,
          runAutomation,
          queueLeft: 0,
          nowTs,
        })
      }

      const prevSync = chatDbRepo.getSyncState.get(uid)
      chatDbRepo.writeSyncState(uid, {
        lastPollAt: nowTs,
        lastSuccessAt: nowTs,
        scanInProgress: Number(prevSync?.scan_in_progress || 0),
        scanProgressTotal: Number(prevSync?.scan_progress_total || 0),
        scanProgressDone: Number(prevSync?.scan_progress_done || 0),
        fullScanCompletedAt: Number(prevSync?.full_scan_completed_at || 0),
        fullScanRequestedAt: Number(prevSync?.full_scan_requested_at || 0),
        lastError: null,
      })

      const syncResult = {
        ok: true,
        userId: uid,
        fetchedChats: syncSummary.fetchedChats,
        playerokEdges: syncSummary.playerokEdges,
        changedChats: syncSummary.changedChats,
        skippedChats: syncSummary.skippedChats,
        changedChatIds: syncSummary.changedChatIds,
        pageInfo: syncSummary.pageInfo,
      }

      recordChatSyncStepLog({
        ok: true,
        userId: uid,
        phase: 'complete',
        durationMs: Date.now() - stepStartedAt,
        source: 'userChats',
        limit: Number(limit) || 24,
        viewerUsername,
        pageInfo: syncSummary.pageInfo,
        chats: chatDiagnostics,
        sync: syncResult,
      })

      return syncResult
    } catch (err) {
      recordChatSyncStepLog({
        ok: false,
        userId: uid,
        durationMs: Date.now() - stepStartedAt,
        source: 'userChats',
        error: err && err.message ? String(err.message) : String(err),
      })
      throw err
    }
  }

  function bumpFullScanGeneration(uid) {
    const next = (fullScanGenerationByUser.get(uid) || 0) + 1
    fullScanGenerationByUser.set(uid, next)
    return next
  }

  function isFullScanCancelled(uid, generation) {
    return fullScanGenerationByUser.get(uid) !== generation
  }

  function reportFullScanProgress(uid, startedAt, state, patch) {
    chatDbRepo.writeSyncState(uid, {
      scanInProgress: 1,
      scanProgressTotal: patch.total,
      scanProgressDone: patch.processed,
      fullScanRequestedAt: startedAt,
      fullScanCompletedAt: Number(state?.full_scan_completed_at || 0),
      scanCurrentChatId: patch.currentChatId ?? null,
      scanCurrentLabel: patch.currentLabel ?? null,
      scanStep: patch.step ?? null,
      lastError: patch.lastError !== undefined ? patch.lastError : undefined,
      lastPollAt: Date.now(),
    })
  }

  function abortFullScan(userId, reason) {
    const uid = Number(userId)
    if (!Number.isFinite(uid) || uid <= 0) throw new Error('invalid userId')
    bumpFullScanGeneration(uid)
    const state = chatDbRepo.getSyncState.get(uid)
    chatDbRepo.writeSyncState(uid, {
      scanInProgress: 0,
      scanCurrentChatId: null,
      scanCurrentLabel: null,
      scanStep: null,
      lastError: reason || 'Сканирование прервано',
    })
    return { ok: true }
  }

  async function runFullScan({
    userId,
    token,
    userAgent,
    force = false,
    pageLimit = 24,
    maxPages = 200,
    maxHistoryPagesPerChat = FULL_SCAN_DEFAULT_HISTORY_PAGES,
    perChatTimeoutMs = FULL_SCAN_PER_CHAT_TIMEOUT_MS,
    runAutomation = false,
    onProgress = null,
  }) {
    const uid = Number(userId)
    if (!Number.isFinite(uid) || uid <= 0) throw new Error('invalid userId')
    if (!token) throw new Error('token required')
    const ua = userAgent || (typeof userAgentProvider === 'function' ? userAgentProvider() : null)
    const state = chatDbRepo.getSyncState.get(uid)
    if (!force && Number(state?.scan_in_progress || 0) === 1) {
      return { ok: false, reason: 'scan_in_progress' }
    }
    if (!force && Number(state?.full_scan_completed_at || 0) > 0) {
      return { ok: false, reason: 'already_completed' }
    }

    const scanGeneration = bumpFullScanGeneration(uid)
    const runId = crypto.randomUUID()
    const startedAt = Date.now()
    chatDbRepo.startSyncRun.run(runId, uid, 'full_scan', 'running', 0, 0, startedAt)
    reportFullScanProgress(uid, startedAt, state, {
      total: 0,
      processed: 0,
      currentChatId: null,
      currentLabel: null,
      step: 'list',
      lastError: null,
    })

    let afterCursor = null
    let processed = 0
    let total = 0
    let pageIndex = 0
    let finalError = null
    let skippedChats = 0
    try {
      const viewer = await getViewer(token, ua)
      const viewerUsernameFS = normalizeText(viewer?.username || null)
      do {
        if (isFullScanCancelled(uid, scanGeneration)) {
          finalError = 'Сканирование прервано'
          break
        }
        const page = await requestUserChatsPage(token, ua, viewer.id, {
          first: Number(pageLimit) || 24,
          after: afterCursor || null,
        })
        const edges = Array.isArray(page?.edges) ? page.edges : []
        const recentEntries = edges
          .map((edge) => edge?.node || null)
          .filter(Boolean)
          .map((node) => ({ node, thread: nodeToThread(node) }))
          .filter((x) => x.thread?.id)
        total += recentEntries.length
        reportFullScanProgress(uid, startedAt, state, {
          total,
          processed,
          step: 'list',
        })
        for (const entry of recentEntries) {
          if (isFullScanCancelled(uid, scanGeneration)) {
            finalError = 'Сканирование прервано'
            break
          }
          const node = entry.node
          const thread = entry.thread
          const label = chatScanLabel(thread)
          chatDbRepo.putThread(uid, thread, { syncedAt: Date.now() })
          reportFullScanProgress(uid, startedAt, state, {
            total,
            processed,
            currentChatId: thread.id,
            currentLabel: label,
            step: 'messages',
            lastError: null,
          })

          let chatError = null
          let data = null
          try {
            data = await withTimeout(
              fetchDealChatMessagesFromPlayerok(
                token,
                ua,
                thread.dealId || null,
                thread.id,
                {
                  buyerUsername: thread.buyerName || undefined,
                  categoryHint: thread.category || undefined,
                  maxPages: maxHistoryPagesPerChat,
                }
              ),
              Number(perChatTimeoutMs) || FULL_SCAN_PER_CHAT_TIMEOUT_MS,
              label
            )
          } catch (err) {
            chatError = err && err.message ? String(err.message) : String(err)
            skippedChats += 1
          }

          if (data) {
            const messages = filterMessagesByAge(data?.messages, Date.now())
            const buyerNameFromMsgsFS = extractBuyerFromMessages(messages, viewerUsernameFS)
            const resolvedBuyerNameFS = resolveBuyerName({
              threadBuyerName: thread.buyerName,
              dataBuyerName: data?.buyerUsername,
              buyerNameFromMessages: buyerNameFromMsgsFS,
              viewerUsername: viewerUsernameFS,
            })
            const forceBuyerNameNullPreDealFS = shouldForceBuyerNameNull({
              threadBuyerName: thread.buyerName,
              resolvedBuyerName: resolvedBuyerNameFS,
              viewerUsername: viewerUsernameFS,
            })
            chatDbRepo.putMessages(uid, thread.id, messages, { syncedAt: Date.now() })
            chatDbRepo.putThread(uid, {
              ...thread,
              buyerName: resolvedBuyerNameFS,
              itemTitle: data?.itemTitle || thread.itemTitle || null,
              itemImageUrl: data?.itemImageUrl || thread.itemImageUrl || null,
              category: data?.itemCategory || thread.category || null,
            }, { syncedAt: Date.now(), forceBuyerNameNull: forceBuyerNameNullPreDealFS })
            const deals = buildDealRows({
              userId: uid,
              chatId: thread.id,
              messages,
              itemTitle: data?.itemTitle || thread.itemTitle || null,
              itemCategory: data?.itemCategory || thread.category || null,
              buyerName: resolvedBuyerNameFS,
              viewerUsername: viewerUsernameFS,
              nowTs: Date.now(),
            })
            const effectiveDealId = data?.effectiveDealId || thread.dealId || null
            const prevThreadFs = chatDbRepo.getThreadByChatId.get(uid, thread.id)
            const fallbackThreadItemIdFs =
              thread?.itemId != null && String(thread.itemId).trim()
                ? String(thread.itemId).trim()
                : prevThreadFs?.last_item_id != null && String(prevThreadFs.last_item_id).trim()
                  ? String(prevThreadFs.last_item_id).trim()
                  : null
            const effectiveItemId = data?.effectiveItemId || fallbackThreadItemIdFs || null
            if (deals.length === 0 && effectiveDealId) {
              deals.push({
                userId: uid,
                dealId: String(effectiveDealId),
                chatId: String(thread.id),
                itemId: effectiveItemId || null,
                itemTitle: data?.itemTitle || thread.itemTitle || null,
                itemImageUrl: data?.itemImageUrl || thread.itemImageUrl || null,
                category: data?.itemCategory || thread.category || null,
                buyerName: resolvedBuyerNameFS,
                status: null,
                isPaidMarkerSeen: 0,
                lastMessageId: thread.lastMessageId || null,
                lastMessageTs: toCreatedTs(thread.lastMessageCreatedAt),
                lastSeenAt: toCreatedTs(thread.lastMessageCreatedAt) || Date.now(),
                updatedAt: Date.now(),
              })
            }

            const primaryDeal =
              deals.length > 0
                ? deals.reduce((best, d) => {
                    const bt = best ? Number(best.lastMessageTs || 0) : -1
                    const dt = Number(d.lastMessageTs || 0)
                    return dt >= bt ? d : best
                  }, null)
                : null

            if (primaryDeal) {
              const finalBuyerNameFS = primaryDeal.buyerName || resolvedBuyerNameFS
              const forceBuyerNameNullFS = shouldForceBuyerNameNull({
                threadBuyerName: thread.buyerName,
                resolvedBuyerName: finalBuyerNameFS,
                viewerUsername: viewerUsernameFS,
              })
              chatDbRepo.putThread(uid, {
                ...thread,
                buyerName: finalBuyerNameFS,
                dealId: primaryDeal.dealId || thread.dealId || null,
                itemId: primaryDeal.itemId || effectiveItemId || null,
                itemTitle: primaryDeal.itemTitle || data?.itemTitle || thread.itemTitle || null,
                itemImageUrl:
                  primaryDeal.itemImageUrl || data?.itemImageUrl || thread.itemImageUrl || null,
                category: primaryDeal.category || data?.itemCategory || thread.category || null,
              }, { syncedAt: Date.now(), forceBuyerNameNull: forceBuyerNameNullFS })
            }
            for (const deal of deals) {
              const dealItemIdForSave = deal.itemId || effectiveItemId || null
              chatDbRepo.upsertDeal.run(
                deal.userId,
                deal.dealId,
                deal.chatId,
                dealItemIdForSave,
                deal.itemTitle,
                deal.itemImageUrl,
                deal.category,
                deal.buyerName,
                deal.status,
                deal.isPaidMarkerSeen,
                deal.lastMessageId,
                deal.lastSeenAt,
                deal.updatedAt
              )
            }
            if (runAutomation && typeof runAutomationForChat === 'function') {
              await runAutomationForChat({
                userId: uid,
                token,
                userAgent: ua,
                chatId: thread.id,
                dealId: primaryDeal?.dealId || thread.dealId || null,
                dealItemId: primaryDeal?.itemId || effectiveItemId || null,
                node,
              })
            }
          }

          processed += 1
          reportFullScanProgress(uid, startedAt, state, {
            total,
            processed,
            currentChatId: thread.id,
            currentLabel: label,
            step: chatError ? 'skip' : 'done',
            lastError: chatError,
          })
          if (typeof onProgress === 'function') {
            onProgress({ runId, total, processed, skippedChats, chatError })
          }
        }
        if (finalError) break
        const pageInfo = page?.pageInfo || {}
        afterCursor = pageInfo.hasNextPage ? pageInfo.endCursor || null : null
        pageIndex += 1
      } while (afterCursor && pageIndex < Number(maxPages || 200))
    } catch (err) {
      finalError = err && err.message ? String(err.message) : String(err)
    }

    if (isFullScanCancelled(uid, scanGeneration) && !finalError) {
      finalError = 'Сканирование прервано'
    }

    const finishedAt = Date.now()
    const cancelled = finalError === 'Сканирование прервано'
    const status = cancelled ? 'cancelled' : finalError ? 'failed' : 'done'
    chatDbRepo.finishSyncRun.run(status, total, processed, finishedAt, finalError, runId)
    chatDbRepo.writeSyncState(uid, {
      lastPollAt: finishedAt,
      lastSuccessAt: finalError && !cancelled ? Number(state?.last_success_at || 0) : finishedAt,
      scanInProgress: 0,
      scanProgressTotal: total,
      scanProgressDone: processed,
      fullScanCompletedAt:
        finalError && !cancelled ? Number(state?.full_scan_completed_at || 0) : finishedAt,
      fullScanRequestedAt: startedAt,
      scanCurrentChatId: null,
      scanCurrentLabel: null,
      scanStep: null,
      lastError: finalError,
    })
    if (finalError && !cancelled) throw new Error(finalError)
    return { ok: !finalError, runId, total, processed, skippedChats, finishedAt, cancelled: Boolean(cancelled) }
  }

  return {
    syncUserChatsStep,
    syncUserChatsListPoll,
    syncOneChangedChat,
    runFullScan,
    abortFullScan,
  }
}

module.exports = { createChatDbSyncService, nodeToThread }

