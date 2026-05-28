const { sendJson } = require('./sendJson')
const { readJsonBody } = require('./readJsonBody')
const {
  getChatSyncStepLogSnapshot,
  clearChatSyncStepLog,
} = require('../debug/chatSyncStepLog')
const { getSupercellGameByCategory } = require('../functions/supercellHelpers')
const { resolveBuyerSupercellEmailFromDeal } = require('../functions/resolveBuyerSupercellEmailFromDeal')
const { logChatMessagesGap } = require('../debug/chatMessagesGapLog')

const SMART_EMAIL_CACHE_TTL_MS = 2 * 60 * 1000
const SMART_EMAIL_NEGATIVE_TTL_MS = 30 * 1000
const smartEmailCache = new Map()
const blockingMessagesSyncByChat = new Map()

function buildSmartEmailCacheKey({ userId, chatId, dealId }) {
  return `${Number(userId)}::${String(chatId || '')}::${String(dealId || '')}`
}

function getCachedSmartEmail(key) {
  const row = smartEmailCache.get(key)
  if (!row) return null
  const ttl = row.email ? SMART_EMAIL_CACHE_TTL_MS : SMART_EMAIL_NEGATIVE_TTL_MS
  if (Date.now() - Number(row.checkedAt || 0) > ttl) {
    smartEmailCache.delete(key)
    return null
  }
  return row
}

function setCachedSmartEmail(key, email) {
  smartEmailCache.set(key, {
    email: email ? String(email) : null,
    checkedAt: Date.now(),
  })
}

function buildBlockingSyncKey(userId, chatId) {
  return `${Number(userId)}::${String(chatId || '')}`
}

function mapThreadToChat(row, hiddenSet) {
  return {
    id: row.chat_id != null ? String(row.chat_id) : null,
    buyerName: row.buyer_name || null,
    itemTitle: row.item_title || null,
    itemImageUrl: row.item_image_url || null,
    category: row.category || null,
    status: row.status || null,
    dealId: row.last_deal_id || null,
    itemId: row.last_item_id || null,
    lastMessageId: row.last_message_id || null,
    lastMessageText: row.last_message_text || null,
    lastMessageCreatedAt: row.last_message_created_at || null,
    unreadCount: Number(row.unread_count || 0),
    isHidden: hiddenSet.has(String(row.chat_id || '')),
  }
}

function mapMessageRow(row) {
  let parsed = null
  try {
    parsed = row.raw_json ? JSON.parse(row.raw_json) : null
  } catch (_) {
    parsed = null
  }
  return {
    id: row.message_id,
    text: row.text != null ? String(row.text) : '',
    createdAt: row.created_at || null,
    imageUrl: row.image_url || null,
    dealId: row.deal_id || null,
    user: {
      username:
        row.sender_username ||
        parsed?.user?.username ||
        parsed?.user?.name ||
        null,
    },
  }
}

function extractEmailsFromText(text) {
  const source = text != null ? String(text) : ''
  if (!source) return []
  const matches = source.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)
  if (!Array.isArray(matches) || matches.length === 0) return []
  return matches
    .map((x) => String(x || '').trim())
    .filter(Boolean)
}

function emailsFromMessageRow(row) {
  const fromText = extractEmailsFromText(row?.text)
  if (fromText.length > 0) return fromText
  if (!row?.raw_json) return []
  try {
    const parsed = JSON.parse(row.raw_json)
    return extractEmailsFromText(parsed?.text || parsed?.content || parsed?.message)
  } catch (_) {
    return []
  }
}

function pickLatestBuyerSupercellEmail(rows, buyerName) {
  const list = Array.isArray(rows) ? rows : []
  if (list.length === 0) return null
  const buyerLower = buyerName != null ? String(buyerName).trim().toLowerCase() : ''

  const pickFromRows = (targetRows) => {
    for (let i = targetRows.length - 1; i >= 0; i -= 1) {
      const emails = emailsFromMessageRow(targetRows[i])
      if (emails.length > 0) return emails[emails.length - 1]
    }
    return null
  }

  if (buyerLower) {
    const buyerRows = list.filter((row) => {
      const sender = row?.sender_username != null ? String(row.sender_username).trim().toLowerCase() : ''
      return sender && sender === buyerLower
    })
    const emailFromBuyerRows = pickFromRows(buyerRows)
    if (emailFromBuyerRows) return emailFromBuyerRows
  }

  return pickFromRows(list)
}

async function dispatchChatDb({ req, res, pathname, currentUserId, deps }) {
  const {
    chatDbRepo,
    getTokenFromBodyOrStored,
    getHiddenChats,
    getViewer,
    fetchDealChatMessagesFromPlayerok,
    requestDealById,
    sendChatMessageToPlayerok,
    chatDbSyncService,
    loadStoredTokenPlain,
    getAllStoredTokens,
  } = deps
  if (req.method === 'POST' && pathname === '/api/chat-db/list') {
    try {
      const payload = await readJsonBody(req, { fallback: {} })
      const limitRaw = Number(payload?.limit)
      const offsetRaw = Number(payload?.offset)
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(200, Math.floor(limitRaw)) : 24
      const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0
      const rows = chatDbRepo.listThreads.all(currentUserId, limit, offset)
      const totalRow = chatDbRepo.countThreads.get(currentUserId)
      const hiddenRows = getHiddenChats.all(currentUserId)
      const hiddenSet = new Set((hiddenRows || []).map((x) => String(x.chat_id || '')).filter(Boolean))
      const list = []
      for (const row of rows) {
        const mapped = mapThreadToChat(row, hiddenSet)
        if ((!mapped.buyerName || String(mapped.buyerName).trim() === '') && row.last_deal_id) {
          const dealRow = chatDbRepo.getDealById.get(currentUserId, row.last_deal_id)
          if (dealRow?.buyer_name) mapped.buyerName = String(dealRow.buyer_name)
        }
        list.push(mapped)
      }
      return sendJson(res, 200, {
        list,
        total: Number(totalRow?.total || 0),
        pageInfo: {
          hasNextPage: offset + limit < Number(totalRow?.total || 0),
          endCursor: null,
        },
      }) || true
    } catch (err) {
      return sendJson(res, 500, { error: err && err.message ? String(err.message) : 'chat-db list failed' }) || true
    }
  }

  if (req.method === 'POST' && pathname === '/api/chat-db/messages') {
    try {
      const payload = await readJsonBody(req, { fallback: {} })
      const chatId = payload?.chatId != null ? String(payload.chatId).trim() : ''
      const dealId = payload?.dealId != null ? String(payload.dealId).trim() : ''
      let effectiveChatId = chatId || null
      if (!effectiveChatId && dealId) {
        const dealRow = chatDbRepo.getDealById.get(currentUserId, dealId)
        effectiveChatId = dealRow?.chat_id ? String(dealRow.chat_id) : null
      }
      if (!effectiveChatId) {
        return sendJson(res, 400, { error: 'chatId or known dealId is required' }) || true
      }
      let rows = chatDbRepo.listMessages.all(currentUserId, effectiveChatId)
      let thread = chatDbRepo.getThreadByChatId.get(currentUserId, effectiveChatId)
      let deals = chatDbRepo.listDealsByChatId.all(currentUserId, effectiveChatId)
      const requestedDealId = dealId || null
      let viewerUsername = null
      const latestLocalMessage = chatDbRepo.getLatestMessageByChatId.get(currentUserId, effectiveChatId)
      const localLatestMessageId =
        latestLocalMessage?.message_id != null ? String(latestLocalMessage.message_id) : null
      const threadLastMessageId =
        thread?.last_message_id != null ? String(thread.last_message_id) : null
      const localHasThreadLastMessage = Boolean(
        threadLastMessageId &&
        rows.some((row) => row?.message_id != null && String(row.message_id) === threadLastMessageId)
      )
      const localMessagesBehindThread =
        Boolean(threadLastMessageId) &&
        !localHasThreadLastMessage &&
        (!localLatestMessageId || localLatestMessageId !== threadLastMessageId)

      const hasLocalMessages = rows.length > 0
      const needsMessagesSync = !hasLocalMessages || localMessagesBehindThread
      const needsMetaSync =
        !thread ||
        !thread?.buyer_name ||
        !thread?.last_deal_id ||
        !thread?.last_item_id ||
        !thread?.category

      // Сообщения из БД отдаём сразу; если thread опережает messages — синхронизируем блокирующе.
      if ((needsMessagesSync || needsMetaSync) && chatDbSyncService?.syncOneChangedChat) {
        const { token } = getTokenFromBodyOrStored(currentUserId, payload)
        if (token) {
          const threadForSync = {
            id: effectiveChatId,
            buyerName: thread?.buyer_name || null,
            itemTitle: thread?.item_title || null,
            itemImageUrl: thread?.item_image_url || null,
            category: thread?.category || null,
            status: thread?.status || null,
            lastMessageId: thread?.last_message_id || null,
            lastMessageText: thread?.last_message_text || null,
            lastMessageCreatedAt: thread?.last_message_created_at || null,
            dealId: requestedDealId || thread?.last_deal_id || null,
            itemId: thread?.last_item_id || null,
            unreadCount: Number(thread?.unread_count || 0),
          }
          const blockingHistoryPages = localMessagesBehindThread ? 6 : 4
          const syncPayload = {
            userId: currentUserId,
            token,
            userAgent: payload?.userAgent,
            item: {
              node: null,
              thread: threadForSync,
              hasPrev: Boolean(thread),
              needsMetaRefresh: needsMetaSync && !needsMessagesSync,
              messagesStale: needsMessagesSync,
            },
            viewerUsername: null,
            fetchHistoryMaxPages: blockingHistoryPages,
            runAutomation: false,
            queueLeft: 0,
          }
          if (localMessagesBehindThread) {
            logChatMessagesGap('messages:blocking-sync', {
              chatId: effectiveChatId,
              threadLastMessageId,
              localLatestMessageId,
              localRows: rows.length,
            })
          }
          if (needsMessagesSync) {
            try {
              const syncKey = buildBlockingSyncKey(currentUserId, effectiveChatId)
              let syncPromise = blockingMessagesSyncByChat.get(syncKey)
              if (!syncPromise) {
                syncPromise = chatDbSyncService.syncOneChangedChat(syncPayload)
                blockingMessagesSyncByChat.set(syncKey, syncPromise)
                syncPromise.finally(() => {
                  if (blockingMessagesSyncByChat.get(syncKey) === syncPromise) {
                    blockingMessagesSyncByChat.delete(syncKey)
                  }
                })
              }
              await syncPromise
              rows = chatDbRepo.listMessages.all(currentUserId, effectiveChatId)
              thread = chatDbRepo.getThreadByChatId.get(currentUserId, effectiveChatId)
              deals = chatDbRepo.listDealsByChatId.all(currentUserId, effectiveChatId)
              const afterLatest = chatDbRepo.getLatestMessageByChatId.get(currentUserId, effectiveChatId)
              logChatMessagesGap('messages:after-blocking-sync', {
                chatId: effectiveChatId,
                threadLastMessageId,
                localLatestMessageId: afterLatest?.message_id || null,
                localRows: rows.length,
                stillBehind: Boolean(
                  threadLastMessageId &&
                  !rows.some((row) => String(row?.message_id || '') === threadLastMessageId)
                ),
              })
            } catch (err) {
              logChatMessagesGap('messages:blocking-sync-failed', {
                chatId: effectiveChatId,
                error: err && err.message ? String(err.message) : String(err),
              })
            }
          } else {
            setTimeout(async () => {
              try {
                await chatDbSyncService.syncOneChangedChat(syncPayload)
              } catch (_) {
                // ignore background refresh errors
              }
            }, 0)
          }
        }
      }

      const primaryDeal = requestedDealId
        ? deals.find((d) => String(d?.deal_id || '') === requestedDealId) || null
        : deals[0] || null
      const resolvedBuyerName = primaryDeal?.buyer_name || thread?.buyer_name || null
      let buyerSupercellEmail = pickLatestBuyerSupercellEmail(rows, resolvedBuyerName)

      const categoryHint = primaryDeal?.category || thread?.category || null
      const skipSmartEmail =
        payload?.skipSmartEmail === true || payload?.messagesOnly === true

      // Почта Supercell чаще в полях сделки, а не в тексте чата — один запрос deal, без загрузки истории.
      if (
        !buyerSupercellEmail &&
        getSupercellGameByCategory(categoryHint) &&
        typeof requestDealById === 'function'
      ) {
        const dealIdForEmail =
          requestedDealId || primaryDeal?.deal_id || thread?.last_deal_id || null
        const cacheKey = buildSmartEmailCacheKey({
          userId: currentUserId,
          chatId: effectiveChatId,
          dealId: dealIdForEmail || '',
        })
        const cached = getCachedSmartEmail(cacheKey)
        if (cached) {
          buyerSupercellEmail = cached.email || null
        } else {
          const { token } = getTokenFromBodyOrStored(currentUserId, payload)
          if (token && dealIdForEmail) {
            buyerSupercellEmail = await resolveBuyerSupercellEmailFromDeal({
              requestDealById,
              token,
              userAgent: payload?.userAgent,
              dealId: dealIdForEmail,
              categoryHint,
            })
            setCachedSmartEmail(cacheKey, buyerSupercellEmail || null)
          }
        }
      }

      // Полная загрузка чата с Playerok — только если явно не skipSmartEmail (тяжёлый путь).
      if (!skipSmartEmail && !buyerSupercellEmail && typeof fetchDealChatMessagesFromPlayerok === 'function') {
        const { token } = getTokenFromBodyOrStored(currentUserId, payload)
        if (token) {
          const dealIdForSmartResolve =
            requestedDealId || primaryDeal?.deal_id || thread?.last_deal_id || null
          const cacheKey = buildSmartEmailCacheKey({
            userId: currentUserId,
            chatId: effectiveChatId,
            dealId: dealIdForSmartResolve || '',
          })
          const cached = getCachedSmartEmail(cacheKey)
          if (cached) {
            buyerSupercellEmail = cached.email || null
          } else {
            try {
              if (!viewerUsername && typeof getViewer === 'function') {
                const viewer = await getViewer(token, payload?.userAgent)
                viewerUsername = viewer?.username ? String(viewer.username) : null
              }
              const smart = await fetchDealChatMessagesFromPlayerok(
                token,
                payload?.userAgent,
                dealIdForSmartResolve,
                effectiveChatId,
                {
                  viewerUsername: viewerUsername || null,
                  buyerUsername: resolvedBuyerName || undefined,
                  categoryHint: primaryDeal?.category || thread?.category || undefined,
                  maxPages: 40,
                }
              )
              const smartEmail =
                smart?.buyerSupercellEmail != null ? String(smart.buyerSupercellEmail).trim() : ''
              buyerSupercellEmail = smartEmail || null
              setCachedSmartEmail(cacheKey, buyerSupercellEmail || null)
            } catch (_) {
              setCachedSmartEmail(cacheKey, null)
            }
          }
        }
      }

      return sendJson(res, 200, {
        ok: true,
        chatId: effectiveChatId,
        list: rows.map(mapMessageRow),
        itemTitle: primaryDeal?.item_title || thread?.item_title || null,
        itemImageUrl: primaryDeal?.item_image_url || thread?.item_image_url || null,
        itemCategory: primaryDeal?.category || thread?.category || null,
        buyerSupercellEmail: buyerSupercellEmail || null,
        dealIds: deals.map((d) => d.deal_id).filter(Boolean),
        deals: deals.map((d) => ({
          dealId: d?.deal_id || null,
          itemTitle: d?.item_title || null,
          itemImageUrl: d?.item_image_url || null,
          itemCategory: d?.category || null,
        })),
      }) || true
    } catch (err) {
      return sendJson(res, 500, { error: err && err.message ? String(err.message) : 'chat-db messages failed' }) || true
    }
  }

  if (req.method === 'POST' && pathname === '/api/chat-db/send') {
    try {
      const payload = await readJsonBody(req, { fallback: {} })
      const { token } = getTokenFromBodyOrStored(currentUserId, payload)
      const userAgent = payload?.userAgent
      const chatId = payload?.chatId != null ? String(payload.chatId).trim() : null
      let dealId = payload?.dealId != null ? String(payload.dealId).trim() : null
      const text = payload?.text != null ? String(payload.text) : ''
      const clientMessageIdRaw = payload?.clientMessageId != null ? String(payload.clientMessageId).trim() : ''
      const clientCreatedAtRaw = payload?.clientCreatedAt != null ? String(payload.clientCreatedAt).trim() : ''
      if (!token) return sendJson(res, 400, { error: 'token is required' }) || true
      if (!chatId && !dealId) return sendJson(res, 400, { error: 'chatId or dealId is required' }) || true
      if (chatId && !dealId) {
        const deals = chatDbRepo.listDealsByChatId.all(currentUserId, chatId)
        if (deals.length > 0) dealId = deals[0].deal_id || null
      }
      const now = Date.now()
      const effectiveChatId = chatId || (payload?.chatId ? String(payload.chatId) : null)
      const pendingMessageId =
        clientMessageIdRaw || `local-${now}-${Math.random().toString(16).slice(2, 8)}`
      const pendingCreatedAt = clientCreatedAtRaw || new Date(now).toISOString()
      const previousThread = effectiveChatId
        ? chatDbRepo.getThreadByChatId.get(currentUserId, effectiveChatId)
        : null
      if (effectiveChatId) {
        chatDbRepo.putMessages(currentUserId, effectiveChatId, [
          {
            id: pendingMessageId,
            text,
            createdAt: pendingCreatedAt,
            dealId: dealId || null,
            user: { username: 'Levkaster' },
            pending: true,
          },
        ], { syncedAt: now })
        chatDbRepo.putThread(currentUserId, {
          id: effectiveChatId,
          buyerName: previousThread?.buyer_name || null,
          itemTitle: previousThread?.item_title || null,
          itemImageUrl: previousThread?.item_image_url || null,
          category: previousThread?.category || null,
          status: previousThread?.status || null,
          lastMessageId: pendingMessageId,
          lastMessageText: text,
          lastMessageCreatedAt: pendingCreatedAt,
          dealId: dealId || previousThread?.last_deal_id || null,
          itemId: previousThread?.last_item_id || null,
          unreadCount: 0,
        }, { syncedAt: now })
      }

      try {
        const message = await sendChatMessageToPlayerok(token, userAgent, dealId, chatId, text)
        if (effectiveChatId) {
          const resolvedMessageId =
            message?.id != null && String(message.id).trim()
              ? String(message.id).trim()
              : pendingMessageId
          const resolvedCreatedAt = message?.createdAt || pendingCreatedAt
          const resolvedText = message?.text != null ? String(message.text) : text

          if (resolvedMessageId !== pendingMessageId) {
            chatDbRepo.deleteMessageById.run(currentUserId, effectiveChatId, pendingMessageId)
          }

          chatDbRepo.putMessages(currentUserId, effectiveChatId, [
            {
              id: resolvedMessageId,
              text: resolvedText,
              createdAt: resolvedCreatedAt,
              dealId: dealId || null,
              user: { username: 'Levkaster' },
            },
          ], { syncedAt: Date.now() })

          const latest = chatDbRepo.getLatestMessageByChatId.get(currentUserId, effectiveChatId)
          chatDbRepo.putThread(currentUserId, {
            id: effectiveChatId,
            buyerName: previousThread?.buyer_name || null,
            itemTitle: previousThread?.item_title || null,
            itemImageUrl: previousThread?.item_image_url || null,
            category: previousThread?.category || null,
            status: previousThread?.status || null,
            lastMessageId: latest?.message_id || resolvedMessageId,
            lastMessageText: latest?.text != null ? String(latest.text) : resolvedText,
            lastMessageCreatedAt: latest?.created_at || resolvedCreatedAt,
            dealId: dealId || previousThread?.last_deal_id || null,
            itemId: previousThread?.last_item_id || null,
            unreadCount: 0,
          }, { syncedAt: Date.now() })
        }
        return sendJson(res, 200, { ok: true, message }) || true
      } catch (sendErr) {
        if (effectiveChatId) {
          chatDbRepo.deleteMessageById.run(currentUserId, effectiveChatId, pendingMessageId)
          const latest = chatDbRepo.getLatestMessageByChatId.get(currentUserId, effectiveChatId)
          if (latest) {
            chatDbRepo.putThread(currentUserId, {
              id: effectiveChatId,
              buyerName: previousThread?.buyer_name || null,
              itemTitle: previousThread?.item_title || null,
              itemImageUrl: previousThread?.item_image_url || null,
              category: previousThread?.category || null,
              status: previousThread?.status || null,
              lastMessageId: latest.message_id || previousThread?.last_message_id || null,
              lastMessageText:
                latest.text != null
                  ? String(latest.text)
                  : previousThread?.last_message_text || null,
              lastMessageCreatedAt: latest.created_at || previousThread?.last_message_created_at || null,
              dealId: latest.deal_id || dealId || previousThread?.last_deal_id || null,
              itemId: previousThread?.last_item_id || null,
              unreadCount: Number(previousThread?.unread_count || 0),
            }, { syncedAt: Date.now() })
          } else if (previousThread) {
            chatDbRepo.putThread(currentUserId, {
              id: effectiveChatId,
              buyerName: previousThread?.buyer_name || null,
              itemTitle: previousThread?.item_title || null,
              itemImageUrl: previousThread?.item_image_url || null,
              category: previousThread?.category || null,
              status: previousThread?.status || null,
              lastMessageId: previousThread?.last_message_id || null,
              lastMessageText: previousThread?.last_message_text || null,
              lastMessageCreatedAt: previousThread?.last_message_created_at || null,
              dealId: previousThread?.last_deal_id || null,
              itemId: previousThread?.last_item_id || null,
              unreadCount: Number(previousThread?.unread_count || 0),
            }, { syncedAt: Date.now() })
          }
        }
        throw sendErr
      }
    } catch (err) {
      return sendJson(res, 500, { error: err && err.message ? String(err.message) : 'chat-db send failed' }) || true
    }
  }

  if (req.method === 'POST' && pathname === '/api/chat-db/full-scan') {
    try {
      const payload = await readJsonBody(req, { fallback: {} })
      const force = payload?.force === true
      const runAutomation = payload?.runAutomation === true
      const { token } = getTokenFromBodyOrStored(currentUserId, payload)
      if (!token) return sendJson(res, 400, { error: 'token is required' }) || true
      const state = chatDbRepo.getSyncState.get(currentUserId)
      if (!force && Number(state?.scan_in_progress || 0) === 1) {
        return sendJson(res, 409, { error: 'Сканирование уже запущено' }) || true
      }
      if (force && Number(state?.scan_in_progress || 0) === 1 && chatDbSyncService?.abortFullScan) {
        chatDbSyncService.abortFullScan(currentUserId, 'Перезапуск сканирования')
      }
      if (!force && Number(state?.full_scan_completed_at || 0) > 0) {
        return sendJson(res, 409, { error: 'Полная прогрузка уже выполнялась. Повтор отключен.' }) || true
      }
      // fire-and-forget
      setTimeout(async () => {
        try {
          await chatDbSyncService.runFullScan({
            userId: currentUserId,
            token,
            userAgent: payload?.userAgent,
            force,
            runAutomation,
          })
        } catch (_) {
          // state already persisted
        }
      }, 0)
      return sendJson(res, 200, { ok: true, started: true }) || true
    } catch (err) {
      return sendJson(res, 500, { error: err && err.message ? String(err.message) : 'full scan failed to start' }) || true
    }
  }

  if (req.method === 'POST' && pathname === '/api/chat-db/full-scan-reset') {
    try {
      if (!chatDbSyncService?.abortFullScan) {
        return sendJson(res, 500, { error: 'reset not available' }) || true
      }
      chatDbSyncService.abortFullScan(currentUserId, 'Сканирование сброшено вручную')
      return sendJson(res, 200, { ok: true }) || true
    } catch (err) {
      return sendJson(res, 500, { error: err && err.message ? String(err.message) : 'reset failed' }) || true
    }
  }

  if (req.method === 'GET' && pathname === '/api/chat-db/full-scan-status') {
    try {
      const state = chatDbRepo.getSyncState.get(currentUserId)
      const runs = chatDbRepo.listSyncRuns.all(currentUserId)
      return sendJson(res, 200, {
        ok: true,
        state: state || null,
        runs,
      }) || true
    } catch (err) {
      return sendJson(res, 500, { error: err && err.message ? String(err.message) : 'status failed' }) || true
    }
  }

  if (req.method === 'GET' && pathname === '/api/chat-db/sync-step-log') {
    try {
      const snapshot = getChatSyncStepLogSnapshot()
      const allEntries = snapshot.entries || []
      const forUser = allEntries.filter(
        (entry) => Number(entry.userId) === Number(currentUserId)
      )
      const entries = forUser.length > 0 ? forUser : allEntries
      return sendJson(res, 200, { ...snapshot, entries, currentUserId }) || true
    } catch (err) {
      return sendJson(res, 500, { error: err && err.message ? String(err.message) : 'sync-step-log failed' }) || true
    }
  }

  if (req.method === 'POST' && pathname === '/api/chat-db/sync-step-log/clear') {
    try {
      clearChatSyncStepLog()
      return sendJson(res, 200, { ok: true }) || true
    } catch (err) {
      return sendJson(res, 500, { error: err && err.message ? String(err.message) : 'sync-step-log clear failed' }) || true
    }
  }

  if (req.method === 'POST' && pathname === '/api/chat-db/sync-step') {
    try {
      const payload = await readJsonBody(req, { fallback: {} })
      const { token } = getTokenFromBodyOrStored(currentUserId, payload)
      if (!token) return sendJson(res, 400, { error: 'token is required' }) || true
      const result = await chatDbSyncService.syncUserChatsStep({
        userId: currentUserId,
        token,
        userAgent: payload?.userAgent,
        limit: payload?.limit,
        fetchHistoryMaxPages: payload?.fetchHistoryMaxPages,
        runAutomation: payload?.runAutomation !== false,
      })
      return sendJson(res, 200, result) || true
    } catch (err) {
      return sendJson(res, 500, { error: err && err.message ? String(err.message) : 'sync step failed' }) || true
    }
  }

  if (req.method === 'POST' && pathname === '/api/chat-db/sync-all-users-step') {
    try {
      const rows = getAllStoredTokens.all()
      let done = 0
      for (const row of Array.isArray(rows) ? rows : []) {
        const userId = Number(row?.user_id)
        if (!Number.isFinite(userId) || userId <= 0) continue
        const stored = loadStoredTokenPlain(userId)
        if (!stored?.token) continue
        try {
          await chatDbSyncService.syncUserChatsStep({
            userId,
            token: stored.token,
            userAgent: null,
            runAutomation: true,
          })
          done += 1
        } catch (_) {
          // continue users
        }
      }
      return sendJson(res, 200, { ok: true, usersProcessed: done }) || true
    } catch (err) {
      return sendJson(res, 500, { error: err && err.message ? String(err.message) : 'sync-all-users failed' }) || true
    }
  }

  return false
}

module.exports = { dispatchChatDb }

