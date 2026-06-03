const AUTOLIST_LAST_CHAT_FRESH_SEC = 600
const AUTOLIST_MAX_CHATS_TO_SCAN = 25
const AUTOLIST_PROCESSED_TTL_SEC = 60 * 60
const AUTOLIST_SEEN_CHAT_TTL_SEC = 24 * 60 * 60
const AUTOLIST_ITEM_STATE_TTL_SEC = 24 * 60 * 60
// Даже если новых чатов нет, периодически сканируем последние завершённые товары.
// Иначе "ожидает автовыставления" может висеть бесконечно. Интервал — 2 минуты.
const AUTOLIST_COMPLETED_SCAN_INTERVAL_SEC = 120
/** Макс. возраст системного триггера (подтверждение товара / сделки) для автосообщения в чат. */
// Окно «свежести» триггера автосообщения. Раньше было 10 минут, но при перезапуске
// сервера или задержке обработки чат мог простоять дольше, и автосообщение навсегда
// помечалось выполненным, так и не отправившись. Дедуп в рамках сделки надёжно не даёт
// дублей, поэтому окно увеличено до 2 часов — чтобы отложенная обработка/перезапуск
// всё же отправили автосообщение (лучше с опозданием, чем никогда).
const CHAT_AUTOMESSAGE_MAX_TRIGGER_AGE_SEC = 2 * 60 * 60
/** Макс. возраст сделки для paid_chat-автосообщения после покупки.
 *  Было 2 минуты — слишком жёстко: при любой задержке/перезапуске лот-автосообщение
 *  навсегда помечалось выполненным. Дедуп в рамках сделки не даёт дублей, поэтому окно
 *  увеличено до 2 часов. */
const PAID_CHAT_AUTOMESSAGE_MAX_DEAL_AGE_SEC = 2 * 60 * 60

// ── Персистентный дедуп автосообщений (журнал в БД) ──────────────────────────
// In-memory processed-map теряется при перезапуске, а дедуп по истории чата может
// промахнуться на устаревших сообщениях (гонка) → дубли. Журнал в таблице
// sent_automessages надёжно фиксирует факт отправки по (user, chat, deal, kind).
let _sentAutomsgWasStmt = null
let _sentAutomsgMarkStmt = null

function setAutolistPersistenceDb(db) {
  if (!db || typeof db.prepare !== 'function') return
  _sentAutomsgWasStmt = db.prepare(
    'SELECT 1 FROM sent_automessages WHERE user_id=? AND chat_id=? AND deal_id=? AND kind=? LIMIT 1'
  )
  _sentAutomsgMarkStmt = db.prepare(
    'INSERT OR IGNORE INTO sent_automessages (user_id, chat_id, deal_id, kind, sent_at) VALUES (?, ?, ?, ?, ?)'
  )
}

function autolistWasAutomessageSent(userId, chatId, dealId, kind) {
  if (!_sentAutomsgWasStmt) return false
  const c = String(chatId || '').trim()
  const d = String(dealId || '').trim()
  const k = String(kind || '').trim()
  if (!c || !d || !k) return false
  try {
    return Boolean(_sentAutomsgWasStmt.get(Number(userId), c, d, k))
  } catch (_) {
    return false
  }
}

function autolistMarkAutomessageSent(userId, chatId, dealId, kind, sentAt) {
  if (!_sentAutomsgMarkStmt) return
  const c = String(chatId || '').trim()
  const d = String(dealId || '').trim()
  const k = String(kind || '').trim()
  if (!c || !d || !k) return
  try {
    _sentAutomsgMarkStmt.run(Number(userId), c, d, k, Number(sentAt) || Math.floor(Date.now() / 1000))
  } catch (_) {}
}

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

function autolistGetTopupFlowMap(tokenHash) {
  global.__autolistTopupFlowByTokenHash = global.__autolistTopupFlowByTokenHash || {}
  const key = String(tokenHash)
  const map = global.__autolistTopupFlowByTokenHash[key]
  if (map && typeof map === 'object') return map
  global.__autolistTopupFlowByTokenHash[key] = {}
  return global.__autolistTopupFlowByTokenHash[key]
}

function autolistPruneTopupFlowMap(tokenHash, nowTs) {
  const map = autolistGetTopupFlowMap(tokenHash)
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

function buildPurchaseWindowAutomessageEventKey(chatId, dealId) {
  return buildChatAutomessageEventKey('purchase_window_auto_msg', chatId, dealId)
}

function buildImageAutomessageEventKey(chatId, dealId, itemKey) {
  const base = buildChatAutomessageEventKey('image_auto_msg', chatId, dealId)
  if (!base) return null
  const suffix =
    itemKey != null && String(itemKey).trim() !== '' ? String(itemKey).trim() : null
  return suffix ? `${base}::${suffix}` : base
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
  setAutolistPersistenceDb,
  autolistWasAutomessageSent,
  autolistMarkAutomessageSent,
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
  autolistGetTopupFlowMap,
  autolistPruneTopupFlowMap,
  buildPostPurchaseAutomessageEventKey,
  buildDealConfirmedAutomessageEventKey,
  buildPaidChatAutomessageEventKey,
  buildPurchaseWindowAutomessageEventKey,
  buildImageAutomessageEventKey,
  tryBeginChatAutomessageSend,
  finishChatAutomessageSend,
  tryBeginPostPurchaseAutomessageSend,
  finishPostPurchaseAutomessageSend,
  tryBeginApprouteChatSend,
  finishApprouteChatSend,
}

