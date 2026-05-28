const AUTOLIST_LAST_CHAT_FRESH_SEC = 600
const AUTOLIST_MAX_CHATS_TO_SCAN = 25
const AUTOLIST_PROCESSED_TTL_SEC = 60 * 60
const AUTOLIST_SEEN_CHAT_TTL_SEC = 24 * 60 * 60
const AUTOLIST_ITEM_STATE_TTL_SEC = 24 * 60 * 60
// Даже если новых чатов нет, периодически сканируем последние завершённые товары.
// Иначе "ожидает автовыставления" может висеть бесконечно. Интервал — 2 минуты.
const AUTOLIST_COMPLETED_SCAN_INTERVAL_SEC = 120
/** Макс. возраст системного триггера (подтверждение товара / сделки) для автосообщения в чат. */
const CHAT_AUTOMESSAGE_MAX_TRIGGER_AGE_SEC = 10 * 60
/** Макс. возраст сделки для paid_chat-автосообщения после покупки. */
const PAID_CHAT_AUTOMESSAGE_MAX_DEAL_AGE_SEC = 2 * 60

function autolistGetProcessedMap(tokenHash) {
  global.__autolistProcessedByTokenHash = global.__autolistProcessedByTokenHash || {}
  const key = String(tokenHash)
  const map = global.__autolistProcessedByTokenHash[key]
  if (map && typeof map === 'object') return map
  global.__autolistProcessedByTokenHash[key] = {}
  return global.__autolistProcessedByTokenHash[key]
}

function autolistPruneProcessedMap(tokenHash, nowTs) {
  const map = autolistGetProcessedMap(tokenHash)
  for (const [k, ts] of Object.entries(map)) {
    if (!ts || (nowTs - Number(ts)) > AUTOLIST_PROCESSED_TTL_SEC) delete map[k]
  }
}

function autolistWasProcessed(tokenHash, eventKey) {
  if (!eventKey) return false
  const map = autolistGetProcessedMap(tokenHash)
  return map[eventKey] != null
}

function autolistMarkProcessed(tokenHash, eventKey, nowTs) {
  if (!eventKey) return
  const map = autolistGetProcessedMap(tokenHash)
  map[eventKey] = nowTs
}

function autolistClearProcessed(tokenHash, eventKey) {
  if (!eventKey) return
  const map = autolistGetProcessedMap(tokenHash)
  delete map[eventKey]
}

function autolistClearApprouteChatProcessed(tokenHash) {
  const map = autolistGetProcessedMap(tokenHash)
  let cleared = 0
  for (const k of Object.keys(map)) {
    if (String(k).startsWith('approute-chat:')) {
      delete map[k]
      cleared++
    }
  }
  return cleared
}

function autolistGetSeenChatsMap(tokenHash) {
  global.__autolistSeenChatsByTokenHash = global.__autolistSeenChatsByTokenHash || {}
  const key = String(tokenHash)
  const map = global.__autolistSeenChatsByTokenHash[key]
  if (map && typeof map === 'object') return map
  global.__autolistSeenChatsByTokenHash[key] = {}
  return global.__autolistSeenChatsByTokenHash[key]
}

function autolistPruneSeenChatsMap(tokenHash, nowTs) {
  const map = autolistGetSeenChatsMap(tokenHash)
  for (const [chatId, ts] of Object.entries(map)) {
    if (!ts || (nowTs - Number(ts)) > AUTOLIST_SEEN_CHAT_TTL_SEC) delete map[chatId]
  }
}

function autolistWasChatSeen(tokenHash, chatId) {
  if (!chatId) return false
  const map = autolistGetSeenChatsMap(tokenHash)
  return map[String(chatId)] != null
}

function autolistMarkChatSeen(tokenHash, chatId, nowTs) {
  if (!chatId) return
  const map = autolistGetSeenChatsMap(tokenHash)
  map[String(chatId)] = nowTs
}

function autolistGetItemStateMap(tokenHash) {
  global.__autolistItemStateByTokenHash = global.__autolistItemStateByTokenHash || {}
  const key = String(tokenHash)
  const map = global.__autolistItemStateByTokenHash[key]
  if (map && typeof map === 'object') return map
  global.__autolistItemStateByTokenHash[key] = {}
  return global.__autolistItemStateByTokenHash[key]
}

function autolistPruneItemStateMap(tokenHash, nowTs) {
  const map = autolistGetItemStateMap(tokenHash)
  for (const [itemId, st] of Object.entries(map)) {
    const ts = st && typeof st === 'object' ? Number(st.updatedAt || 0) : 0
    if (!ts || (nowTs - ts) > AUTOLIST_ITEM_STATE_TTL_SEC) delete map[itemId]
  }
}

function autolistSetItemState(tokenHash, itemId, state) {
  if (!itemId) return
  const map = autolistGetItemStateMap(tokenHash)
  map[String(itemId)] = state
}

function autolistGetItemState(tokenHash, itemId) {
  if (!itemId) return null
  const map = autolistGetItemStateMap(tokenHash)
  return map[String(itemId)] || null
}

function autolistGetCompletedScanMap(tokenHash) {
  global.__autolistCompletedScanByTokenHash =
    global.__autolistCompletedScanByTokenHash || {}
  const key = String(tokenHash)
  const map = global.__autolistCompletedScanByTokenHash[key]
  if (map && typeof map === 'object') return map
  global.__autolistCompletedScanByTokenHash[key] = { lastScanTs: 0 }
  return global.__autolistCompletedScanByTokenHash[key]
}

function autolistGetApprouteRetryMap(tokenHash) {
  global.__approuteRetryByTokenHash = global.__approuteRetryByTokenHash || {}
  const key = String(tokenHash)
  const map = global.__approuteRetryByTokenHash[key]
  if (map && typeof map === 'object') return map
  global.__approuteRetryByTokenHash[key] = {}
  return global.__approuteRetryByTokenHash[key]
}

function autolistGetLastChatMeta(tokenHash) {
  global.__autolistLastChatByTokenHash = global.__autolistLastChatByTokenHash || {}
  const key = String(tokenHash)
  const meta = global.__autolistLastChatByTokenHash[key]
  if (meta && typeof meta === 'object') return meta
  global.__autolistLastChatByTokenHash[key] = {
    lastChatId: null,
    lastMessageId: null,
    lastPaidTs: 0,
    lastMessageIdByChatId: {},
  }
  return global.__autolistLastChatByTokenHash[key]
}

function autolistGetSupercellFlowMap(tokenHash) {
  global.__autolistSupercellFlowByTokenHash = global.__autolistSupercellFlowByTokenHash || {}
  const key = String(tokenHash)
  const map = global.__autolistSupercellFlowByTokenHash[key]
  if (map && typeof map === 'object') return map
  global.__autolistSupercellFlowByTokenHash[key] = {}
  return global.__autolistSupercellFlowByTokenHash[key]
}

function autolistPruneSupercellFlowMap(tokenHash, nowTs) {
  const map = autolistGetSupercellFlowMap(tokenHash)
  for (const [chatId, state] of Object.entries(map)) {
    const updatedAt = Number(state?.updatedAt || state?.createdAt || 0)
    const ageSec = updatedAt ? nowTs - updatedAt : Number.MAX_SAFE_INTEGER
    const maxAgeSec = state?.active ? 24 * 60 * 60 : 60 * 60
    if (ageSec > maxAgeSec) {
      delete map[chatId]
    }
  }
}

function buildChatAutomessageEventKey(prefix, chatId, dealId) {
  const c = String(chatId || '').trim()
  const d = String(dealId || '').trim()
  if (c && d) return `${prefix}:${c}:${d}`
  if (c) return `${prefix}:chat:${c}`
  if (d) return `${prefix}:deal:${d}`
  return ''
}

function buildPostPurchaseAutomessageEventKey(chatId, dealId) {
  return buildChatAutomessageEventKey('post_purchase_auto_msg', chatId, dealId)
}

function buildDealConfirmedAutomessageEventKey(chatId, dealId) {
  return buildChatAutomessageEventKey('deal_confirmed_auto_msg', chatId, dealId)
}

function buildPaidChatAutomessageEventKey(chatId, dealId) {
  return buildChatAutomessageEventKey('lot_automessage', chatId, dealId)
}

function chatAutomessageLockKey(tokenHash, eventKey) {
  return `${String(tokenHash)}::${String(eventKey)}`
}

function approuteChatLockKey(tokenHash, eventKey) {
  return `${String(tokenHash)}::${String(eventKey)}`
}

/** Синхронная «захват» отправки — защита от гонок при параллельных poll deal-chat-messages. */
function tryBeginChatAutomessageSend(tokenHash, eventKey) {
  if (!eventKey) return false
  if (autolistWasProcessed(tokenHash, eventKey)) return false

  global.__chatAutomessageInFlight = global.__chatAutomessageInFlight || {}
  const lockKey = chatAutomessageLockKey(tokenHash, eventKey)
  if (global.__chatAutomessageInFlight[lockKey]) return false
  global.__chatAutomessageInFlight[lockKey] = true
  return true
}

function finishChatAutomessageSend(tokenHash, eventKey, { success = false, nowTs = 0 } = {}) {
  if (!eventKey) return
  global.__chatAutomessageInFlight = global.__chatAutomessageInFlight || {}
  const lockKey = chatAutomessageLockKey(tokenHash, eventKey)
  delete global.__chatAutomessageInFlight[lockKey]

  if (success) {
    autolistMarkProcessed(tokenHash, eventKey, nowTs || Math.floor(Date.now() / 1000))
    return
  }

  const map = autolistGetProcessedMap(tokenHash)
  delete map[eventKey]
}

/** @deprecated используйте tryBeginChatAutomessageSend */
const tryBeginPostPurchaseAutomessageSend = tryBeginChatAutomessageSend
/** @deprecated используйте finishChatAutomessageSend */
const finishPostPurchaseAutomessageSend = finishChatAutomessageSend

function tryBeginApprouteChatSend(tokenHash, eventKey) {
  if (!eventKey) return false
  global.__approuteChatInFlight = global.__approuteChatInFlight || {}
  const lockKey = approuteChatLockKey(tokenHash, eventKey)
  if (global.__approuteChatInFlight[lockKey]) return false
  global.__approuteChatInFlight[lockKey] = true
  return true
}

function finishApprouteChatSend(tokenHash, eventKey) {
  if (!eventKey) return
  global.__approuteChatInFlight = global.__approuteChatInFlight || {}
  const lockKey = approuteChatLockKey(tokenHash, eventKey)
  delete global.__approuteChatInFlight[lockKey]
}

module.exports = {
  AUTOLIST_LAST_CHAT_FRESH_SEC,
  AUTOLIST_MAX_CHATS_TO_SCAN,
  AUTOLIST_PROCESSED_TTL_SEC,
  AUTOLIST_SEEN_CHAT_TTL_SEC,
  AUTOLIST_ITEM_STATE_TTL_SEC,
  AUTOLIST_COMPLETED_SCAN_INTERVAL_SEC,
  CHAT_AUTOMESSAGE_MAX_TRIGGER_AGE_SEC,
  PAID_CHAT_AUTOMESSAGE_MAX_DEAL_AGE_SEC,
  autolistGetProcessedMap,
  autolistPruneProcessedMap,
  autolistWasProcessed,
  autolistMarkProcessed,
  autolistClearProcessed,
  autolistClearApprouteChatProcessed,
  autolistGetApprouteRetryMap,
  autolistGetSeenChatsMap,
  autolistPruneSeenChatsMap,
  autolistWasChatSeen,
  autolistMarkChatSeen,
  autolistGetItemStateMap,
  autolistPruneItemStateMap,
  autolistSetItemState,
  autolistGetItemState,
  autolistGetCompletedScanMap,
  autolistGetLastChatMeta,
  autolistGetSupercellFlowMap,
  autolistPruneSupercellFlowMap,
  buildPostPurchaseAutomessageEventKey,
  buildDealConfirmedAutomessageEventKey,
  buildPaidChatAutomessageEventKey,
  tryBeginChatAutomessageSend,
  finishChatAutomessageSend,
  tryBeginPostPurchaseAutomessageSend,
  finishPostPurchaseAutomessageSend,
  tryBeginApprouteChatSend,
  finishApprouteChatSend,
}

