function toUnixTsFromAny(value) {
  if (value == null || value === '') return 0
  if (typeof value === 'number') {
    return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value)
  }
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return 0
  return Math.floor(d.getTime() / 1000)
}

function setupChatDbRepo(db) {
  const getThreadByChatId = db.prepare(`
    SELECT *
    FROM chat_threads
    WHERE user_id = ? AND chat_id = ?
  `)

  const listThreads = db.prepare(`
    SELECT *
    FROM chat_threads
    WHERE user_id = ?
    ORDER BY updated_at DESC, id DESC
    LIMIT ? OFFSET ?
  `)

  const countThreads = db.prepare(`
    SELECT COUNT(*) AS total
    FROM chat_threads
    WHERE user_id = ?
  `)

  const upsertThread = db.prepare(`
    INSERT INTO chat_threads (
      user_id, chat_id, buyer_name, item_title, item_image_url, category, status,
      last_message_id, last_message_text, last_message_created_at, last_deal_id, last_item_id,
      unread_count, updated_at, synced_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, chat_id) DO UPDATE SET
      buyer_name = excluded.buyer_name,
      item_title = excluded.item_title,
      item_image_url = excluded.item_image_url,
      category = excluded.category,
      status = excluded.status,
      last_message_id = excluded.last_message_id,
      last_message_text = excluded.last_message_text,
      last_message_created_at = excluded.last_message_created_at,
      last_deal_id = excluded.last_deal_id,
      last_item_id = excluded.last_item_id,
      unread_count = excluded.unread_count,
      updated_at = excluded.updated_at,
      synced_at = excluded.synced_at
  `)

  const upsertMessage = db.prepare(`
    INSERT INTO chat_messages (
      user_id, chat_id, message_id, deal_id, sender_username, text,
      image_url, created_at, created_ts, raw_json, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, chat_id, message_id) DO UPDATE SET
      deal_id = excluded.deal_id,
      sender_username = excluded.sender_username,
      text = excluded.text,
      image_url = excluded.image_url,
      created_at = excluded.created_at,
      created_ts = excluded.created_ts,
      raw_json = excluded.raw_json,
      updated_at = excluded.updated_at
  `)

  const listMessages = db.prepare(`
    SELECT *
    FROM chat_messages
    WHERE user_id = ? AND chat_id = ?
    ORDER BY created_ts ASC, id ASC
  `)

  const getLatestMessageByChatId = db.prepare(`
    SELECT *
    FROM chat_messages
    WHERE user_id = ? AND chat_id = ?
    ORDER BY created_ts DESC, id DESC
    LIMIT 1
  `)
  const deleteMessageById = db.prepare(`
    DELETE FROM chat_messages
    WHERE user_id = ? AND chat_id = ? AND message_id = ?
  `)

  const upsertDeal = db.prepare(`
    INSERT INTO chat_deals (
      user_id, deal_id, chat_id, item_id, item_title, item_image_url, category, buyer_name, status,
      is_paid_marker_seen, last_message_id, last_seen_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, deal_id) DO UPDATE SET
      chat_id = excluded.chat_id,
      item_id = COALESCE(excluded.item_id, chat_deals.item_id),
      item_title = excluded.item_title,
      item_image_url = excluded.item_image_url,
      category = excluded.category,
      buyer_name = excluded.buyer_name,
      status = excluded.status,
      is_paid_marker_seen = excluded.is_paid_marker_seen,
      last_message_id = excluded.last_message_id,
      last_seen_at = excluded.last_seen_at,
      updated_at = excluded.updated_at
  `)

  const listDealsByChatId = db.prepare(`
    SELECT *
    FROM chat_deals
    WHERE user_id = ? AND chat_id = ?
    ORDER BY last_seen_at DESC, id DESC
  `)
  const getDealById = db.prepare(`
    SELECT *
    FROM chat_deals
    WHERE user_id = ? AND deal_id = ?
    LIMIT 1
  `)

  const getSyncState = db.prepare(`
    SELECT *
    FROM chat_sync_state
    WHERE user_id = ?
  `)

  const upsertSyncState = db.prepare(`
    INSERT INTO chat_sync_state (
      user_id, poll_cursor, last_poll_at, last_success_at, scan_in_progress,
      scan_progress_total, scan_progress_done, full_scan_completed_at, full_scan_requested_at,
      last_error, scan_current_chat_id, scan_current_label, scan_step, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      poll_cursor = excluded.poll_cursor,
      last_poll_at = excluded.last_poll_at,
      last_success_at = excluded.last_success_at,
      scan_in_progress = excluded.scan_in_progress,
      scan_progress_total = excluded.scan_progress_total,
      scan_progress_done = excluded.scan_progress_done,
      full_scan_completed_at = excluded.full_scan_completed_at,
      full_scan_requested_at = excluded.full_scan_requested_at,
      last_error = excluded.last_error,
      scan_current_chat_id = excluded.scan_current_chat_id,
      scan_current_label = excluded.scan_current_label,
      scan_step = excluded.scan_step,
      updated_at = excluded.updated_at
  `)

  function writeSyncState(userId, fields) {
    const uid = Number(userId)
    const prev = getSyncState.get(uid) || {}
    const now = Date.now()
    upsertSyncState.run(
      uid,
      fields.pollCursor !== undefined ? fields.pollCursor : prev.poll_cursor ?? null,
      fields.lastPollAt !== undefined ? fields.lastPollAt : Number(prev.last_poll_at || 0),
      fields.lastSuccessAt !== undefined ? fields.lastSuccessAt : Number(prev.last_success_at || 0),
      fields.scanInProgress !== undefined ? fields.scanInProgress : Number(prev.scan_in_progress || 0),
      fields.scanProgressTotal !== undefined ? fields.scanProgressTotal : Number(prev.scan_progress_total || 0),
      fields.scanProgressDone !== undefined ? fields.scanProgressDone : Number(prev.scan_progress_done || 0),
      fields.fullScanCompletedAt !== undefined
        ? fields.fullScanCompletedAt
        : Number(prev.full_scan_completed_at || 0),
      fields.fullScanRequestedAt !== undefined
        ? fields.fullScanRequestedAt
        : Number(prev.full_scan_requested_at || 0),
      fields.lastError !== undefined ? fields.lastError : prev.last_error ?? null,
      fields.scanCurrentChatId !== undefined ? fields.scanCurrentChatId : prev.scan_current_chat_id ?? null,
      fields.scanCurrentLabel !== undefined ? fields.scanCurrentLabel : prev.scan_current_label ?? null,
      fields.scanStep !== undefined ? fields.scanStep : prev.scan_step ?? null,
      now
    )
  }

  const startSyncRun = db.prepare(`
    INSERT INTO chat_sync_runs (
      run_id, user_id, mode, status, total_chats, processed_chats, started_at, finished_at, error
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
  `)

  const finishSyncRun = db.prepare(`
    UPDATE chat_sync_runs
    SET status = ?, total_chats = ?, processed_chats = ?, finished_at = ?, error = ?
    WHERE run_id = ?
  `)

  const listSyncRuns = db.prepare(`
    SELECT *
    FROM chat_sync_runs
    WHERE user_id = ?
    ORDER BY started_at DESC
    LIMIT 20
  `)
  const clearViewerAsThreadBuyer = db.prepare(`
    UPDATE chat_threads
    SET buyer_name = NULL, updated_at = ?
    WHERE user_id = ?
      AND LOWER(TRIM(COALESCE(buyer_name, ''))) = LOWER(TRIM(?))
  `)
  const clearViewerAsDealBuyer = db.prepare(`
    UPDATE chat_deals
    SET buyer_name = NULL, updated_at = ?
    WHERE user_id = ?
      AND LOWER(TRIM(COALESCE(buyer_name, ''))) = LOWER(TRIM(?))
  `)

  function pickNonemptyString(incoming, fallback) {
    const inc = incoming != null ? String(incoming).trim() : ''
    if (inc) return inc
    const fb = fallback != null ? String(fallback).trim() : ''
    return fb || null
  }

  /** Не затирает в БД уже сохранённые поля пустыми значениями из ответа Playerok. */
  function putThread(userId, chat, { syncedAt = Date.now(), forceBuyerNameNull = false } = {}) {
    const uid = Number(userId)
    const chatId = String(chat?.id || '').trim()
    if (!chatId) return
    const prev = getThreadByChatId.get(uid, chatId)
    const now = Date.now()

    const incomingLastMessageId =
      chat?.lastMessageId != null ? String(chat.lastMessageId).trim() : ''
    const lastMessageId = incomingLastMessageId
      ? incomingLastMessageId
      : prev?.last_message_id != null
        ? String(prev.last_message_id)
        : null

    const unreadRaw = chat?.unreadCount
    const unreadCount = Number.isFinite(Number(unreadRaw))
      ? Math.max(0, Math.trunc(Number(unreadRaw)))
      : Number.isFinite(Number(prev?.unread_count))
        ? Math.max(0, Math.trunc(Number(prev.unread_count)))
        : 0

    const buyerNameValue = forceBuyerNameNull
      ? null
      : pickNonemptyString(chat?.buyerName, prev?.buyer_name)

    upsertThread.run(
      uid,
      chatId,
      buyerNameValue,
      pickNonemptyString(chat?.itemTitle, prev?.item_title),
      pickNonemptyString(chat?.itemImageUrl, prev?.item_image_url),
      pickNonemptyString(chat?.category, prev?.category),
      pickNonemptyString(chat?.status, prev?.status),
      lastMessageId,
      pickNonemptyString(chat?.lastMessageText, prev?.last_message_text),
      chat?.lastMessageCreatedAt || prev?.last_message_created_at || null,
      pickNonemptyString(chat?.dealId, prev?.last_deal_id),
      pickNonemptyString(chat?.itemId, prev?.last_item_id),
      unreadCount,
      now,
      Number(syncedAt || now)
    )
  }

  function putMessages(userId, chatId, messages, { syncedAt = Date.now() } = {}) {
    const uid = Number(userId)
    const cid = String(chatId || '')
    const now = Number(syncedAt || Date.now())
    for (const m of Array.isArray(messages) ? messages : []) {
      const messageId =
        m?.id != null && String(m.id).trim() ? String(m.id).trim() : `fallback-${cid}-${toUnixTsFromAny(m?.createdAt)}-${Math.random().toString(36).slice(2, 8)}`
      upsertMessage.run(
        uid,
        cid,
        messageId,
        m?.dealId != null ? String(m.dealId) : m?.deal?.id != null ? String(m.deal.id) : null,
        m?.user?.username || m?.user?.name || null,
        m?.text != null ? String(m.text) : null,
        m?.imageUrl || null,
        m?.createdAt || null,
        toUnixTsFromAny(m?.createdAt),
        JSON.stringify(m || {}),
        now
      )
    }
  }

  function clearViewerAsBuyer(userId, viewerUsername, { updatedAt = Date.now() } = {}) {
    const uid = Number(userId)
    const viewer = viewerUsername != null ? String(viewerUsername).trim() : ''
    if (!Number.isFinite(uid) || uid <= 0) return
    if (!viewer) return
    clearViewerAsThreadBuyer.run(Number(updatedAt || Date.now()), uid, viewer)
    clearViewerAsDealBuyer.run(Number(updatedAt || Date.now()), uid, viewer)
  }

  return {
    getThreadByChatId,
    listThreads,
    countThreads,
    listMessages,
    getLatestMessageByChatId,
    deleteMessageById,
    listDealsByChatId,
    getDealById,
    getSyncState,
    upsertSyncState,
    writeSyncState,
    startSyncRun,
    finishSyncRun,
    listSyncRuns,
    upsertDeal,
    putThread,
    putMessages,
    clearViewerAsBuyer,
    toUnixTsFromAny,
  }
}

module.exports = { setupChatDbRepo, toUnixTsFromAny }

