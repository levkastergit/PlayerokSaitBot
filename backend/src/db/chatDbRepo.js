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

  // Показываем ВСЕ треды чата для пользователя — список должен быть полным.
  // Раньше здесь был фильтр «мёртвых пустышек», но он заодно прятал реальные чаты,
  // где покупатель ещё ничего не написал и нет сделки (данные в БД есть, а в списке
  // их не видно). Ничего не скрываем; зацикливание превью на пустых тредах
  // лечится на фронте (cap на повторную загрузку пустого ответа), а не сокрытием.
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

  // Список категорий товаров по ВСЕМ чатам (с количеством) — для фильтра на фронте.
  const listThreadCategories = db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(category), ''), 'Без категории') AS category, COUNT(*) AS count
    FROM chat_threads
    WHERE user_id = ?
    GROUP BY COALESCE(NULLIF(TRIM(category), ''), 'Без категории')
    ORDER BY category COLLATE NOCASE
  `)

  // Серверный поиск/фильтрация чатов ПО ВСЕЙ БД (а не только по загруженным на фронте):
  // категория, имя заказчика (LIKE), текст сообщений (EXISTS по chat_messages), диапазон
  // дат (updated_at, unix-сек). SQL строится динамически; better-sqlite3 кэширует prepare
  // по тексту запроса, поэтому повторные одинаковые формы фильтра переиспользуют statement.
  function escapeLike(s) {
    return String(s).replace(/[\\%_]/g, '\\$&')
  }
  function searchThreads(userId, opts = {}) {
    const where = ['t.user_id = ?']
    const params = [userId]
    const cat = opts.category != null ? String(opts.category).trim() : ''
    if (cat && cat !== 'all') {
      if (cat === 'Без категории') {
        where.push("(t.category IS NULL OR TRIM(t.category) = '')")
      } else {
        where.push('t.category = ?')
        params.push(cat)
      }
    }
    const buyer = opts.buyerQuery != null ? String(opts.buyerQuery).trim().toLowerCase() : ''
    if (buyer) {
      where.push("LOWER(COALESCE(t.buyer_name,'')) LIKE ? ESCAPE '\\'")
      params.push('%' + escapeLike(buyer) + '%')
    }
    const dFrom = Number(opts.dateFrom)
    if (Number.isFinite(dFrom) && dFrom > 0) {
      where.push('t.updated_at >= ?')
      params.push(Math.floor(dFrom))
    }
    const dTo = Number(opts.dateTo)
    if (Number.isFinite(dTo) && dTo > 0) {
      where.push('t.updated_at <= ?')
      params.push(Math.floor(dTo))
    }
    const msg = opts.messageQuery != null ? String(opts.messageQuery).trim().toLowerCase() : ''
    if (msg) {
      where.push(
        "EXISTS (SELECT 1 FROM chat_messages m WHERE m.user_id = t.user_id AND m.chat_id = t.chat_id AND LOWER(COALESCE(m.text,'')) LIKE ? ESCAPE '\\')"
      )
      params.push('%' + escapeLike(msg) + '%')
    }
    const whereSql = where.join(' AND ')
    const limit = Math.min(200, Math.max(1, Math.floor(Number(opts.limit) || 50)))
    const offset = Math.max(0, Math.floor(Number(opts.offset) || 0))
    const rows = db
      .prepare(
        `SELECT t.* FROM chat_threads t WHERE ${whereSql} ORDER BY t.updated_at DESC, t.id DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset)
    const totalRow = db.prepare(`SELECT COUNT(*) AS total FROM chat_threads t WHERE ${whereSql}`).get(...params)
    return { rows, total: Number(totalRow?.total || 0) }
  }

  const listThreadsWithoutHistoryOldest = db.prepare(`
    SELECT t.*
    FROM chat_threads t
    WHERE t.user_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM chat_messages m
        WHERE m.user_id = t.user_id AND m.chat_id = t.chat_id
      )
    ORDER BY t.last_message_created_at ASC, t.id ASC
    LIMIT ?
  `)

  const countThreadsWithoutHistory = db.prepare(`
    SELECT COUNT(*) AS total
    FROM chat_threads t
    WHERE t.user_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM chat_messages m
        WHERE m.user_id = t.user_id AND m.chat_id = t.chat_id
      )
  `)

  const upsertThread = db.prepare(`
    INSERT INTO chat_threads (
      user_id, chat_id, buyer_name, item_title, item_image_url, category, status,
      last_message_id, last_message_text, last_message_created_at, last_deal_id, last_item_id,
      unread_count, last_message_sender_username, last_message_from_buyer, updated_at, synced_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      last_message_sender_username = excluded.last_message_sender_username,
      last_message_from_buyer = excluded.last_message_from_buyer,
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
  const countMessagesByChatId = db.prepare(`
    SELECT COUNT(*) AS total
    FROM chat_messages
    WHERE user_id = ? AND chat_id = ?
  `)

  // Кол-во НЕпрочитанных сообщений от покупателя: пришедшие после метки прочтения
  // (created_ts > last_read_ts), не от нас (sender != viewer) и не системные ({{...}}).
  const countUnreadBuyerMessages = db.prepare(`
    SELECT COUNT(*) AS total
    FROM chat_messages
    WHERE user_id = ? AND chat_id = ? AND created_ts > ?
      AND sender_username IS NOT NULL
      AND lower(sender_username) <> lower(?)
      AND (text IS NULL OR text NOT LIKE '{{%')
  `)

  // Отметить чат прочитанным «на нашем сайте»: метка прочтения = последнее сообщение/текущий момент.
  const markThreadReadStmt = db.prepare(`
    UPDATE chat_threads
    SET last_read_message_id = last_message_id,
        last_read_ts = ?,
        unread_count = 0
    WHERE user_id = ? AND chat_id = ?
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
  // Состояние «проблемы» по сделке: время последнего открытия проблемы и последнего её закрытия.
  // Проблему закрывает не только {{DEAL_PROBLEM_RESOLVED}}, но и терминальные статусы сделки:
  // отмена/возврат ({{DEAL_ROLLED_BACK}}) и подтверждение ({{DEAL_CONFIRMED*}}).
  const getDealProblemState = db.prepare(`
    SELECT
      MAX(CASE WHEN text = '{{DEAL_HAS_PROBLEM}}' THEN created_ts END) AS last_problem_ts,
      MAX(CASE WHEN text IN (
        '{{DEAL_PROBLEM_RESOLVED}}',
        '{{DEAL_ROLLED_BACK}}',
        '{{DEAL_CONFIRMED}}',
        '{{DEAL_CONFIRMED_AUTOMATICALLY}}'
      ) THEN created_ts END) AS last_resolved_ts
    FROM chat_messages
    WHERE user_id = ? AND chat_id = ?
  `)
  const getDealById = db.prepare(`
    SELECT *
    FROM chat_deals
    WHERE user_id = ? AND deal_id = ?
    LIMIT 1
  `)

  const updateDealTestimonial = db.prepare(`
    UPDATE chat_deals
    SET testimonial_status = ?,
        testimonial_rating = ?,
        testimonial_left = ?,
        testimonial_checked_at = ?,
        testimonial_created_at = ?,
        updated_at = ?
    WHERE user_id = ? AND deal_id = ?
  `)

  function setDealTestimonial(userId, dealId, { status = null, rating = null, left = null, checkedAt = Date.now(), createdAt = null } = {}) {
    const uid = Number(userId)
    const id = dealId != null ? String(dealId).trim() : ''
    if (!Number.isFinite(uid) || uid <= 0 || !id) return
    const now = Date.now()
    updateDealTestimonial.run(
      status != null ? String(status) : null,
      rating != null && Number.isFinite(Number(rating)) ? Math.trunc(Number(rating)) : null,
      left == null ? null : left ? 1 : 0,
      Number(checkedAt || now),
      createdAt != null ? String(createdAt) : null,
      now,
      uid,
      id
    )
  }

  // UPSERT: для НОВОЙ сделки строки chat_deals может ещё не быть (гонка автоматики с синком) —
  // раньше был чистый UPDATE и запись почты терялась (0 строк). Теперь создаём строку при
  // отсутствии. last_seen_at/updated_at — NOT NULL, поэтому задаём их в INSERT;
  // is_paid_marker_seen имеет DEFAULT 0. ON CONFLICT по уникальному (user_id, deal_id).
  const upsertDealSupercellEmail = db.prepare(`
    INSERT INTO chat_deals (
      user_id, deal_id, buyer_supercell_email, buyer_supercell_email_checked_at, last_seen_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, deal_id) DO UPDATE SET
      buyer_supercell_email = excluded.buyer_supercell_email,
      buyer_supercell_email_checked_at = excluded.buyer_supercell_email_checked_at,
      updated_at = excluded.updated_at
  `)

  // Сохраняем извлечённую почту Supercell в БД (устойчивость к 429: показ не зависит от
  // живого запроса сделки). Пустым значением НЕ затираем — раз извлекли, храним.
  function setDealSupercellEmail(userId, dealId, email) {
    const uid = Number(userId)
    const id = dealId != null ? String(dealId).trim() : ''
    const value = email != null ? String(email).trim() : ''
    if (!Number.isFinite(uid) || uid <= 0 || !id || !value) return
    const now = Date.now()
    upsertDealSupercellEmail.run(uid, id, value, now, now, now)
  }

  const getSyncState = db.prepare(`
    SELECT *
    FROM chat_sync_state
    WHERE user_id = ?
  `)

  const upsertSyncState = db.prepare(`
    INSERT INTO chat_sync_state (
      user_id, poll_cursor, last_poll_at, last_success_at, scan_in_progress,
      scan_progress_total, scan_progress_done, full_scan_completed_at, full_scan_requested_at,
      last_error, scan_current_chat_id, scan_current_label, scan_step,
      scan_phase, scan_paused, list_cursor, list_scan_completed_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      scan_phase = excluded.scan_phase,
      scan_paused = excluded.scan_paused,
      list_cursor = excluded.list_cursor,
      list_scan_completed_at = excluded.list_scan_completed_at,
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
      fields.scanPhase !== undefined ? fields.scanPhase : prev.scan_phase ?? null,
      fields.scanPaused !== undefined ? (fields.scanPaused ? 1 : 0) : Number(prev.scan_paused || 0),
      fields.listCursor !== undefined ? fields.listCursor : prev.list_cursor ?? null,
      fields.listScanCompletedAt !== undefined
        ? fields.listScanCompletedAt
        : Number(prev.list_scan_completed_at || 0),
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

    // Кто отправил последнее сообщение. Привязано к last_message_id: если
    // входящая синхронизация не знает отправителя, но id того же сообщения —
    // сохраняем прошлое значение, иначе сбрасываем в неизвестно (NULL).
    const incomingSender =
      chat?.lastMessageSenderUsername != null
        ? String(chat.lastMessageSenderUsername).trim() || null
        : null
    const incomingFromBuyer =
      typeof chat?.lastMessageFromBuyer === 'boolean' ? chat.lastMessageFromBuyer : null
    const incomingHasSenderInfo = incomingSender != null || incomingFromBuyer != null
    const sameMessageAsPrev =
      prev?.last_message_id != null && lastMessageId === String(prev.last_message_id)

    let senderUsernameValue
    let fromBuyerValue
    if (incomingHasSenderInfo) {
      senderUsernameValue = incomingSender
      fromBuyerValue = incomingFromBuyer == null ? null : incomingFromBuyer ? 1 : 0
    } else if (sameMessageAsPrev) {
      senderUsernameValue = prev?.last_message_sender_username || null
      fromBuyerValue =
        prev?.last_message_from_buyer == null ? null : Number(prev.last_message_from_buyer)
    } else {
      senderUsernameValue = null
      fromBuyerValue = null
    }

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
      senderUsernameValue,
      fromBuyerValue,
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

  function markThreadRead(userId, chatId, { readTs = Math.floor(Date.now() / 1000) } = {}) {
    const uid = Number(userId)
    const cid = String(chatId || '').trim()
    if (!Number.isFinite(uid) || uid <= 0 || !cid) return false
    const res = markThreadReadStmt.run(Math.floor(Number(readTs) || Date.now() / 1000), uid, cid)
    return Number(res?.changes || 0) > 0
  }

  return {
    getThreadByChatId,
    listThreads,
    countThreads,
    searchThreads,
    listThreadCategories,
    listThreadsWithoutHistoryOldest,
    countThreadsWithoutHistory,
    listMessages,
    getLatestMessageByChatId,
    countMessagesByChatId,
    countUnreadBuyerMessages,
    markThreadRead,
    deleteMessageById,
    listDealsByChatId,
    getDealProblemState,
    getDealById,
    setDealTestimonial,
    setDealSupercellEmail,
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

