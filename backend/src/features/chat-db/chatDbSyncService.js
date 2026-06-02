'use strict'

const crypto = require('crypto')
const { recordChatSyncStepLog } = require('../../debug/chatSyncStepLog')

const FULL_SCAN_PER_CHAT_TIMEOUT_MS = 90_000
const FULL_SCAN_DEFAULT_HISTORY_PAGES = 50

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

// Кто отправил последнее сообщение треда: ищем сообщение по lastMessageId,
// иначе берём хронологически последнее. Сравниваем с viewer → fromBuyer.
function deriveLastMessageSender({ messages, lastMessageId, viewerUsername }) {
  const list = Array.isArray(messages) ? messages : []
  const viewerLower = normalizeText(viewerUsername)?.toLowerCase() || null
  const wantedId = lastMessageId != null ? String(lastMessageId) : null

  let picked = null
  if (wantedId) {
    picked = list.find((m) => m?.id != null && String(m.id) === wantedId) || null
  }
  if (!picked) {
    let bestTs = -1
    for (const m of list) {
      if (!m) continue
      const ts = toCreatedTs(m.createdAt)
      if (ts >= bestTs) {
        bestTs = ts
        picked = m
      }
    }
  }

  const senderUsername = normalizeText(picked?.user?.username || picked?.user?.name || null)
  let fromBuyer = null
  if (senderUsername && viewerLower) {
    fromBuyer = senderUsername.toLowerCase() !== viewerLower
  }
  return { senderUsername: senderUsername || null, fromBuyer }
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
  // Счётчик непрочитанных Playerok намеренно НЕ используем: непрочитанность
  // определяется прочтением на нашем сайте (см. computeLocalUnread в dispatchChatDb).
  const unreadCount = 0

  const lastMessageSenderUsername = normalizeText(
    lastMessage?.user?.username || lastMessage?.user?.name || null
  )
  const viewerLower = normalizeText(opts?.viewerUsername)?.toLowerCase() || null
  let lastMessageFromBuyer = null
  if (lastMessageSenderUsername && viewerLower) {
    lastMessageFromBuyer = lastMessageSenderUsername.toLowerCase() !== viewerLower
  }

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
    lastMessageSenderUsername,
    lastMessageFromBuyer,
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
          // Переиспользуем уже загруженные сообщения, чтобы не делать повторный
          // запрос к Playerok в обработчике автоматизации (ускоряет автосообщения).
          prefetched: {
            messages,
            buyerSupercellEmail: data?.buyerSupercellEmail ?? null,
            itemTitle: data?.itemTitle ?? thread.itemTitle ?? null,
            itemImageUrl: data?.itemImageUrl ?? thread.itemImageUrl ?? null,
            itemCategory: data?.itemCategory ?? thread.category ?? null,
            viewerUsername: viewerUsername || null,
          },
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
      const thread = nodeToThread(node, { viewerUsername })
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

  const scanGenerationByUser = new Map()
  const pauseFlagByUser = new Map()
  const activeRunByUser = new Map()

  function bumpScanGeneration(uid) {
    const next = (scanGenerationByUser.get(uid) || 0) + 1
    scanGenerationByUser.set(uid, next)
    return next
  }

  function isScanCancelled(uid, generation) {
    return scanGenerationByUser.get(uid) !== generation
  }

  function threadRowToThread(row) {
    if (!row) return null
    return {
      id: row.chat_id != null ? String(row.chat_id) : null,
      buyerName: normalizeText(row.buyer_name),
      itemTitle: normalizeText(row.item_title),
      itemImageUrl: row.item_image_url || null,
      category: normalizeText(row.category),
      status: normalizeText(row.status),
      lastMessageId: row.last_message_id != null ? String(row.last_message_id) : null,
      lastMessageText: normalizeText(row.last_message_text),
      lastMessageCreatedAt: row.last_message_created_at || null,
      lastMessageSenderUsername: normalizeText(row.last_message_sender_username),
      lastMessageFromBuyer:
        row.last_message_from_buyer == null ? null : Number(row.last_message_from_buyer) === 1,
      dealId: row.last_deal_id != null ? String(row.last_deal_id) : null,
      itemId: row.last_item_id != null ? String(row.last_item_id) : null,
      unreadCount: Number(row.unread_count || 0),
    }
  }

  // Принудительная перепроверка одного чата: тянет историю с Playerok и доливает
  // недостающие сообщения в БД (putMessages — upsert по message_id, ничего не удаляет).
  async function recheckOneChat({ userId, token, userAgent, chatId, maxHistoryPages = 200 }) {
    const uid = Number(userId)
    const cid = chatId != null ? String(chatId).trim() : ''
    if (!Number.isFinite(uid) || uid <= 0 || !cid) {
      throw new Error('userId and chatId are required')
    }
    const row = chatDbRepo.getThreadByChatId.get(uid, cid)
    const thread = threadRowToThread(row)
    if (!thread) throw new Error('chat not found')
    const ua = userAgent || (typeof userAgentProvider === 'function' ? userAgentProvider() : null)
    const viewer = await getViewer(token, ua)
    const viewerUsername = normalizeText(viewer?.username || null)
    const before = Number(chatDbRepo.countMessagesByChatId.get(uid, cid)?.total || 0)
    const result = await processChatHistoryForThread({
      userId: uid,
      token,
      userAgent: ua,
      thread,
      viewerUsername,
      maxHistoryPagesPerChat: maxHistoryPages,
      runAutomation: false,
    })
    const after = Number(chatDbRepo.countMessagesByChatId.get(uid, cid)?.total || 0)
    return {
      ok: true,
      chatId: cid,
      fetched: Number(result?.messagesCount || 0),
      before,
      after,
      added: Math.max(0, after - before),
    }
  }

  // Выкачивает историю сообщений одного чата и сохраняет thread/deals/messages.
  async function processChatHistoryForThread({
    userId,
    token,
    userAgent,
    thread,
    viewerUsername,
    node = null,
    maxHistoryPagesPerChat = FULL_SCAN_DEFAULT_HISTORY_PAGES,
    perChatTimeoutMs = FULL_SCAN_PER_CHAT_TIMEOUT_MS,
    runAutomation = false,
  }) {
    const uid = Number(userId)
    const ua = userAgent || (typeof userAgentProvider === 'function' ? userAgentProvider() : null)
    const label = chatScanLabel(thread)
    const data = await withTimeout(
      fetchDealChatMessagesFromPlayerok(token, ua, thread.dealId || null, thread.id, {
        buyerUsername: thread.buyerName || undefined,
        categoryHint: thread.category || undefined,
        maxPages: maxHistoryPagesPerChat,
      }),
      Number(perChatTimeoutMs) || FULL_SCAN_PER_CHAT_TIMEOUT_MS,
      label
    )
    const messages = filterMessagesByAge(data?.messages, Date.now())
    const senderForLast = deriveLastMessageSender({
      messages,
      lastMessageId: thread.lastMessageId,
      viewerUsername,
    })
    const threadWithSender = {
      ...thread,
      lastMessageSenderUsername: senderForLast.senderUsername ?? thread.lastMessageSenderUsername ?? null,
      lastMessageFromBuyer:
        senderForLast.fromBuyer != null ? senderForLast.fromBuyer : thread.lastMessageFromBuyer ?? null,
    }
    const buyerNameFromMsgs = extractBuyerFromMessages(messages, viewerUsername)
    const resolvedBuyerName = resolveBuyerName({
      threadBuyerName: thread.buyerName,
      dataBuyerName: data?.buyerUsername,
      buyerNameFromMessages: buyerNameFromMsgs,
      viewerUsername,
    })
    const forceBuyerNameNullPreDeal = shouldForceBuyerNameNull({
      threadBuyerName: thread.buyerName,
      resolvedBuyerName,
      viewerUsername,
    })
    chatDbRepo.putMessages(uid, thread.id, messages, { syncedAt: Date.now() })
    chatDbRepo.putThread(uid, {
      ...threadWithSender,
      buyerName: resolvedBuyerName,
      itemTitle: data?.itemTitle || thread.itemTitle || null,
      itemImageUrl: data?.itemImageUrl || thread.itemImageUrl || null,
      category: data?.itemCategory || thread.category || null,
    }, { syncedAt: Date.now(), forceBuyerNameNull: forceBuyerNameNullPreDeal })
    const deals = buildDealRows({
      userId: uid,
      chatId: thread.id,
      messages,
      itemTitle: data?.itemTitle || thread.itemTitle || null,
      itemCategory: data?.itemCategory || thread.category || null,
      buyerName: resolvedBuyerName,
      viewerUsername,
      nowTs: Date.now(),
    })
    const effectiveDealId = data?.effectiveDealId || thread.dealId || null
    const prevThread = chatDbRepo.getThreadByChatId.get(uid, thread.id)
    const fallbackThreadItemId =
      thread?.itemId != null && String(thread.itemId).trim()
        ? String(thread.itemId).trim()
        : prevThread?.last_item_id != null && String(prevThread.last_item_id).trim()
          ? String(prevThread.last_item_id).trim()
          : null
    const effectiveItemId = data?.effectiveItemId || fallbackThreadItemId || null
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
      const finalBuyerName = primaryDeal.buyerName || resolvedBuyerName
      const forceBuyerNameNull = shouldForceBuyerNameNull({
        threadBuyerName: thread.buyerName,
        resolvedBuyerName: finalBuyerName,
        viewerUsername,
      })
      chatDbRepo.putThread(uid, {
        ...threadWithSender,
        buyerName: finalBuyerName,
        dealId: primaryDeal.dealId || thread.dealId || null,
        itemId: primaryDeal.itemId || effectiveItemId || null,
        itemTitle: primaryDeal.itemTitle || data?.itemTitle || thread.itemTitle || null,
        itemImageUrl: primaryDeal.itemImageUrl || data?.itemImageUrl || thread.itemImageUrl || null,
        category: primaryDeal.category || data?.itemCategory || thread.category || null,
      }, { syncedAt: Date.now(), forceBuyerNameNull })
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
    return { messagesCount: messages.length }
  }

  // Пауза: останавливает текущий проход, но сохраняет прогресс для возобновления.
  function pauseScan(userId) {
    const uid = Number(userId)
    if (!Number.isFinite(uid) || uid <= 0) throw new Error('invalid userId')
    pauseFlagByUser.set(uid, true)
    bumpScanGeneration(uid)
    return { ok: true }
  }

  // Стоп: полностью прекращает проход. Уже загруженные данные сохраняются.
  // Флаг очищается всегда — это снимает и «зависшее» состояние после перезапуска сервера.
  function stopScan(userId, reason) {
    const uid = Number(userId)
    if (!Number.isFinite(uid) || uid <= 0) throw new Error('invalid userId')
    pauseFlagByUser.set(uid, false)
    bumpScanGeneration(uid)
    activeRunByUser.delete(uid)
    chatDbRepo.writeSyncState(uid, {
      scanInProgress: 0,
      scanPaused: 0,
      scanPhase: null,
      listCursor: null,
      scanCurrentChatId: null,
      scanCurrentLabel: null,
      scanStep: null,
      lastError: reason || null,
    })
    return { ok: true }
  }

  // Двухфазный проход: (1) быстрый сбор всего списка чатов (только треды),
  // (2) добор истории сообщений по самым старым чатам. Поддерживает паузу/стоп и возобновление.
  async function runChatScan({
    userId,
    token,
    userAgent,
    force = false,
    listPageLimit = 50,
    maxListPages = 600,
    maxHistoryPagesPerChat = FULL_SCAN_DEFAULT_HISTORY_PAGES,
    perChatTimeoutMs = FULL_SCAN_PER_CHAT_TIMEOUT_MS,
    runAutomation = false,
  }) {
    const uid = Number(userId)
    if (!Number.isFinite(uid) || uid <= 0) throw new Error('invalid userId')
    if (!token) throw new Error('token required')
    const ua = userAgent || (typeof userAgentProvider === 'function' ? userAgentProvider() : null)
    const state = chatDbRepo.getSyncState.get(uid)
    if (!force && Number(state?.scan_in_progress || 0) === 1) {
      return { ok: false, reason: 'scan_in_progress' }
    }

    const generation = bumpScanGeneration(uid)
    pauseFlagByUser.set(uid, false)
    const runId = crypto.randomUUID()
    activeRunByUser.set(uid, runId)
    const startedAt = Date.now()
    chatDbRepo.startSyncRun.run(runId, uid, 'chat_scan', 'running', 0, 0, startedAt)

    let finalError = null
    let paused = false
    let currentPhase = null
    let listCount = 0
    let processed = 0
    let total = 0

    const isOwner = () => activeRunByUser.get(uid) === runId
    const writeProgress = (fields) => {
      if (!isOwner()) return
      chatDbRepo.writeSyncState(uid, { scanInProgress: 1, lastPollAt: Date.now(), ...fields })
    }
    const checkInterrupt = () => {
      if (isScanCancelled(uid, generation)) {
        paused = pauseFlagByUser.get(uid) === true
        finalError = paused ? null : 'stopped'
        return true
      }
      return false
    }

    try {
      const viewer = await getViewer(token, ua)
      const viewerUsername = normalizeText(viewer?.username || null)
      if (viewerUsername && typeof chatDbRepo.clearViewerAsBuyer === 'function') {
        chatDbRepo.clearViewerAsBuyer(uid, viewerUsername, { updatedAt: Date.now() })
      }

      // ---- Фаза 1: список чатов (только треды, быстро) ----
      const listAlreadyDone = !force && Number(state?.list_scan_completed_at || 0) > 0
      if (!listAlreadyDone) {
        currentPhase = 'list'
        let afterCursor = force ? null : state?.list_cursor || null
        let listPages = 0
        writeProgress({
          scanPhase: 'list',
          scanPaused: 0,
          scanStep: 'list',
          fullScanRequestedAt: startedAt,
          lastError: null,
          scanCurrentChatId: null,
          scanCurrentLabel: 'Загрузка списка чатов…',
          scanProgressTotal: 0,
          scanProgressDone: 0,
          listScanCompletedAt: force ? 0 : Number(state?.list_scan_completed_at || 0),
        })
        do {
          if (checkInterrupt()) break
          const page = await requestUserChatsPage(token, ua, viewer.id, {
            first: Number(listPageLimit) || 50,
            after: afterCursor || null,
          })
          const edges = Array.isArray(page?.edges) ? page.edges : []
          for (const edge of edges) {
            const node = edge?.node
            if (!node) continue
            const thread = nodeToThread(node, { viewerUsername })
            if (!thread.id) continue
            const viewerLower = viewerUsername ? viewerUsername.toLowerCase() : null
            const threadBuyerIsViewer = Boolean(
              viewerUsername &&
                normalizeText(thread.buyerName) &&
                viewerLower &&
                normalizeText(thread.buyerName).toLowerCase() === viewerLower
            )
            if (threadBuyerIsViewer) thread.buyerName = null
            chatDbRepo.putThread(uid, thread, {
              syncedAt: Date.now(),
              forceBuyerNameNull: threadBuyerIsViewer,
            })
            listCount += 1
          }
          const pageInfo = page?.pageInfo || {}
          afterCursor = pageInfo.hasNextPage ? pageInfo.endCursor || null : null
          listPages += 1
          writeProgress({
            listCursor: afterCursor,
            scanProgressTotal: listCount,
            scanProgressDone: listCount,
            scanCurrentLabel: `Загружено чатов: ${listCount}`,
          })
        } while (afterCursor && listPages < Number(maxListPages || 600))

        if (!finalError && !isScanCancelled(uid, generation)) {
          writeProgress({ listScanCompletedAt: Date.now(), listCursor: null })
        }
      }

      // ---- Фаза 2: добор истории сообщений (самые старые чаты первыми) ----
      if (!finalError && !isScanCancelled(uid, generation)) {
        currentPhase = 'history'
        total = Number(chatDbRepo.countThreadsWithoutHistory.get(uid)?.total || 0)
        writeProgress({
          scanPhase: 'history',
          scanStep: 'messages',
          scanProgressTotal: total,
          scanProgressDone: 0,
          scanCurrentLabel: 'Добор истории сообщений…',
        })
        const attempted = new Set()
        for (;;) {
          if (checkInterrupt()) break
          const batch = chatDbRepo.listThreadsWithoutHistoryOldest.all(uid, 100)
          const fresh = batch.filter((r) => !attempted.has(String(r.chat_id)))
          if (fresh.length === 0) break
          let interrupted = false
          for (const row of fresh) {
            if (checkInterrupt()) {
              interrupted = true
              break
            }
            const thread = threadRowToThread(row)
            attempted.add(String(row.chat_id))
            const label = chatScanLabel(thread)
            writeProgress({
              scanCurrentChatId: thread.id,
              scanCurrentLabel: label,
              scanStep: 'messages',
              lastError: null,
            })
            let chatError = null
            try {
              await processChatHistoryForThread({
                userId: uid,
                token,
                userAgent: ua,
                thread,
                viewerUsername,
                maxHistoryPagesPerChat,
                perChatTimeoutMs,
                runAutomation,
              })
            } catch (err) {
              chatError = err && err.message ? String(err.message) : String(err)
            }
            processed += 1
            writeProgress({
              scanProgressDone: processed,
              scanCurrentChatId: thread.id,
              scanCurrentLabel: label,
              scanStep: chatError ? 'skip' : 'done',
              lastError: chatError,
            })
          }
          if (interrupted) break
        }
      }
    } catch (err) {
      finalError = err && err.message ? String(err.message) : String(err)
    }

    if (isScanCancelled(uid, generation) && !finalError && !paused) {
      paused = pauseFlagByUser.get(uid) === true
      finalError = paused ? null : 'stopped'
    }

    const finishedAt = Date.now()
    const stopped = finalError === 'stopped'
    const status = paused ? 'paused' : stopped ? 'cancelled' : finalError ? 'failed' : 'done'
    const cleanDone = !finalError && !paused
    chatDbRepo.finishSyncRun.run(
      status,
      total || listCount,
      processed,
      finishedAt,
      finalError && !stopped ? finalError : null,
      runId
    )
    if (isOwner()) {
      chatDbRepo.writeSyncState(uid, {
        lastPollAt: finishedAt,
        lastSuccessAt: cleanDone ? finishedAt : Number(state?.last_success_at || 0),
        scanInProgress: 0,
        scanPaused: paused ? 1 : 0,
        scanPhase: paused ? currentPhase : null,
        scanProgressTotal: total || listCount,
        scanProgressDone: processed,
        fullScanCompletedAt: cleanDone ? finishedAt : Number(state?.full_scan_completed_at || 0),
        fullScanRequestedAt: startedAt,
        listCursor: paused ? undefined : null,
        scanCurrentChatId: null,
        scanCurrentLabel: null,
        scanStep: null,
        lastError: finalError && !stopped ? finalError : null,
      })
      activeRunByUser.delete(uid)
    }
    if (pauseFlagByUser.get(uid) === true) pauseFlagByUser.delete(uid)
    if (finalError && !stopped && !paused) throw new Error(finalError)
    return { ok: !finalError || paused, runId, listCount, total, processed, finishedAt, paused, stopped }
  }

  return {
    syncUserChatsStep,
    syncUserChatsListPoll,
    syncOneChangedChat,
    runChatScan,
    recheckOneChat,
    pauseScan,
    stopScan,
  }
}

module.exports = { createChatDbSyncService, nodeToThread }

