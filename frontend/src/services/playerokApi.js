import { trackedFetch } from './requestTracker'
import { logChatAutomationEvents } from '../debug/chatLoggingLog.js'

const ENV_ORIGIN = (import.meta.env.VITE_BACKEND_ORIGIN || '').trim()
const RUNTIME_ORIGIN = typeof window !== 'undefined' ? window.location.origin : ''

// Важно: если `VITE_BACKEND_ORIGIN` задан (dev/prod), используем его напрямую.
// Иначе пробуем вывести origin из текущего порта (например, Vite 5173 -> backend 3000).
function inferBackendOrigin() {
  if (ENV_ORIGIN) return ENV_ORIGIN
  if (RUNTIME_ORIGIN && /:(5173|4173)$/i.test(RUNTIME_ORIGIN)) return 'http://localhost:3000'
  return RUNTIME_ORIGIN || 'http://localhost:3000'
}
const BACKEND_ORIGIN = inferBackendOrigin()
const BACKEND_ACTIVE_LOTS_URL =
  import.meta.env.VITE_BACKEND_ACTIVE_LOTS_URL ||
  `${BACKEND_ORIGIN}/api/playerok/active-lots`
const BACKEND_COMPLETED_LOTS_URL =
  import.meta.env.VITE_BACKEND_COMPLETED_LOTS_URL ||
  `${BACKEND_ORIGIN}/api/playerok/completed-lots`
const BACKEND_IN_PROGRESS_DEALS_URL = `${BACKEND_ORIGIN}/api/playerok/in-progress-deals`
const BACKEND_COMPLETED_DEALS_URL = `${BACKEND_ORIGIN}/api/playerok/completed-deals`
const BACKEND_DEAL_CHAT_MESSAGES_URL = `${BACKEND_ORIGIN}/api/playerok/deal-chat-messages`
const BACKEND_DEAL_CHAT_MESSAGES_BATCH_URL = `${BACKEND_ORIGIN}/api/playerok/deal-chat-messages-batch`
const BACKEND_APPROUTE_CHAT_RESCAN_URL = `${BACKEND_ORIGIN}/api/playerok/approute-chat-rescan`
const BACKEND_REQUEST_SUPERCELL_CODE_URL = `${BACKEND_ORIGIN}/api/playerok/request-supercell-code`
const BACKEND_REQUEST_SUPERCELL_CODE_TEST_URL = `${BACKEND_ORIGIN}/api/playerok/request-supercell-code-test`
const BACKEND_CANCEL_DEAL_URL = `${BACKEND_ORIGIN}/api/playerok/cancel-deal`
const BACKEND_CONFIRM_DEAL_URL = `${BACKEND_ORIGIN}/api/playerok/confirm-deal`
const BACKEND_USER_CHATS_URL = `${BACKEND_ORIGIN}/api/playerok/chats`
const BACKEND_HIDE_CHAT_URL = `${BACKEND_ORIGIN}/api/playerok/hide-chat`
const BACKEND_UNHIDE_CHAT_URL = `${BACKEND_ORIGIN}/api/playerok/unhide-chat`
const BACKEND_PRODUCT_SETTINGS_URL = `${BACKEND_ORIGIN}/api/product-settings`
const BACKEND_PRODUCT_SETTINGS_DELETE_URL = `${BACKEND_ORIGIN}/api/product-settings/delete`
const BACKEND_TOKEN_URL = `${BACKEND_ORIGIN}/api/token`
const BACKEND_CATEGORY_COMMANDS_LIST_URL = `${BACKEND_ORIGIN}/api/category-commands/list`
const BACKEND_CATEGORY_COMMANDS_URL = `${BACKEND_ORIGIN}/api/category-commands`
const BACKEND_BALANCE_OVERVIEW_URL = `${BACKEND_ORIGIN}/api/playerok/balance-overview`
const BACKEND_TRANSACTION_PROVIDERS_URL = `${BACKEND_ORIGIN}/api/playerok/transaction-providers`
const BACKEND_TRANSACTIONS_URL = `${BACKEND_ORIGIN}/api/playerok/transactions`
const BACKEND_VERIFIED_CARDS_URL = `${BACKEND_ORIGIN}/api/playerok/verified-cards`
const BACKEND_REQUEST_WITHDRAWAL_URL = `${BACKEND_ORIGIN}/api/playerok/request-withdrawal`
const BACKEND_REMOVE_TRANSACTION_URL = `${BACKEND_ORIGIN}/api/playerok/remove-transaction`
const BACKEND_DDOS_COOKIE_URL = `${BACKEND_ORIGIN}/api/playerok/ddos-cookie`
const BACKEND_DDOS_CHECK_URL = `${BACKEND_ORIGIN}/api/playerok/ddos-check`
const BACKEND_CHATS_PROBE_STEP_URL = `${BACKEND_ORIGIN}/api/playerok/chats-probe-step`
const BACKEND_CHAT_DB_LIST_URL = `${BACKEND_ORIGIN}/api/chat-db/list`
const BACKEND_CHAT_DB_MESSAGES_URL = `${BACKEND_ORIGIN}/api/chat-db/messages`
const BACKEND_CHAT_DB_MARK_READ_URL = `${BACKEND_ORIGIN}/api/chat-db/mark-read`
const BACKEND_CHAT_DB_SEND_URL = `${BACKEND_ORIGIN}/api/chat-db/send`
const BACKEND_CHAT_DB_TEST_PURCHASE_URL = `${BACKEND_ORIGIN}/api/chat-db/test-purchase`
const BACKEND_CHAT_DB_TEST_PURCHASE_MESSAGE_URL = `${BACKEND_ORIGIN}/api/chat-db/test-purchase-message`
const BACKEND_CHAT_DB_TEST_PURCHASE_EVENT_URL = `${BACKEND_ORIGIN}/api/chat-db/test-purchase-event`
const BACKEND_CHAT_DB_FULL_SCAN_URL = `${BACKEND_ORIGIN}/api/chat-db/full-scan`
const BACKEND_CHAT_DB_FULL_SCAN_RESET_URL = `${BACKEND_ORIGIN}/api/chat-db/full-scan-reset`
const BACKEND_CHAT_DB_RECHECK_CHAT_URL = `${BACKEND_ORIGIN}/api/chat-db/recheck-chat`
const BACKEND_CHAT_DB_SCAN_PAUSE_URL = `${BACKEND_ORIGIN}/api/chat-db/scan-pause`
const BACKEND_CHAT_DB_SCAN_STOP_URL = `${BACKEND_ORIGIN}/api/chat-db/scan-stop`
const BACKEND_CHAT_DB_FULL_SCAN_STATUS_URL = `${BACKEND_ORIGIN}/api/chat-db/full-scan-status`
const BACKEND_CHAT_DB_SYNC_STEP_LOG_URL = `${BACKEND_ORIGIN}/api/chat-db/sync-step-log`
const BACKEND_CHAT_DB_SYNC_STEP_LOG_CLEAR_URL = `${BACKEND_ORIGIN}/api/chat-db/sync-step-log/clear`
const BACKEND_TABLE_CODES_URL = `${BACKEND_ORIGIN}/api/table-codes`
const BACKEND_TABLE_CODES_USED_URL = `${BACKEND_ORIGIN}/api/table-codes/used`
const BACKEND_TABLE_CODES_DELETE_URL = `${BACKEND_ORIGIN}/api/table-codes/delete`
const BACKEND_TABLE_TABS_URL = `${BACKEND_ORIGIN}/api/table-tabs`
const BACKEND_TABLE_SUBTABS_URL = `${BACKEND_ORIGIN}/api/table-subtabs`
const BACKEND_TABLE_SUBTABS_RENAME_URL = `${BACKEND_ORIGIN}/api/table-subtabs/rename`
const BACKEND_TABLE_TABS_DELETE_URL = `${BACKEND_ORIGIN}/api/table-tabs/delete`
const BACKEND_TABLE_SUBTABS_DELETE_URL = `${BACKEND_ORIGIN}/api/table-subtabs/delete`
const BACKEND_TABLE_COLUMNS_URL = `${BACKEND_ORIGIN}/api/table-columns`
const BACKEND_TABLE_COLUMNS_RENAME_URL = `${BACKEND_ORIGIN}/api/table-columns/rename`
const BACKEND_TABLE_COLUMNS_DELETE_URL = `${BACKEND_ORIGIN}/api/table-columns/delete`
const BACKEND_TABLE_CODES_CELL_VALUE_URL = `${BACKEND_ORIGIN}/api/table-codes/cell-value`

const FETCH_CREDENTIALS = { credentials: 'include' }

/** Собирает URL с безопасной передачей token в query.
 *  Важно: + в token должен быть закодирован как %2B, иначе при парсинге URL
 *  сервером + трактуется как пробел и настройки не находятся. */
function buildUrlWithToken(baseUrl, token, extraParams = {}) {
  const parts = []
  if (token) parts.push(`token=${encodeURIComponent(token)}`)
  for (const [k, v] of Object.entries(extraParams)) {
    if (v != null && v !== '') parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  }
  const queryStr = parts.join('&')
  return queryStr ? `${baseUrl}?${queryStr}` : baseUrl
}

function mapLotItem(item) {
  return {
    id: item.id ?? item.product_id ?? item.lot_id,
    title: item.title ?? item.name ?? 'Без названия',
    game: item.game ?? item.game_name ?? '',
    price: item.price ?? item.amount ?? 0,
    currency: item.currency ?? '₽',
    status: item.status ?? 'active',
    imageUrl: item.imageUrl ?? item.image ?? null,
    url:
      item.url ??
      item.link ??
      `https://playerok.com/profile/Levkaster/products`,
    discount: item.discount,
    oldPrice: item.oldPrice,
    tags: item.tags,
    autolistRuntime: item.autolistRuntime || null,
    createdAt: item.createdAt || null,
  }
}

export async function fetchActiveLots(token) {
  const response = await trackedFetch(BACKEND_ACTIVE_LOTS_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...(token ? { token } : {}),
      userAgent:
        typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
      username: 'Levkaster',
    }),
  })

  if (!response.ok) {
    let message = `Ошибка загрузки лотов: ${response.status}`
    let challengeHtml = null
    try {
      const errData = await response.json()
      if (errData && errData.error) {
        message = errData.error
      }
      if (errData && typeof errData.challengeHtml === 'string' && errData.challengeHtml.trim()) {
        challengeHtml = errData.challengeHtml
      }
    } catch {
      // ignore
    }
    const err = new Error(message)
    if (challengeHtml) err.challengeHtml = challengeHtml
    throw err
  }

  const data = await response.json()
  const rawItems = Array.isArray(data) ? data : data.items || []

  return rawItems.map(mapLotItem)
}

export async function loadStoredToken() {
  try {
    const response = await trackedFetch(BACKEND_TOKEN_URL, FETCH_CREDENTIALS)
    if (!response.ok) {
      if (response.status === 404) {
        return ''
      }
      const err = await response.json().catch(() => ({}))
      throw new Error(err.error || `Ошибка загрузки токена: ${response.status}`)
    }
    const data = await response.json().catch(() => ({}))
    return (data && typeof data.token === 'string' ? data.token : '') || ''
  } catch (_err) {
    return ''
  }
}

export async function saveStoredToken(token) {
  const response = await trackedFetch(BACKEND_TOKEN_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error || `Ошибка сохранения токена: ${response.status}`)
  }
  return data
}

export async function fetchCompletedLots(token) {
  const response = await trackedFetch(BACKEND_COMPLETED_LOTS_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...(token ? { token } : {}),
      userAgent:
        typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
      username: 'Levkaster',
    }),
  })

  if (!response.ok) {
    let message = `Ошибка загрузки завершённых лотов: ${response.status}`
    try {
      const errData = await response.json()
      if (errData && errData.error) {
        message = errData.error
      }
    } catch {
      // ignore
    }
    throw new Error(message)
  }

  const data = await response.json()
  const rawItems = Array.isArray(data) ? data : data.items || []

  const mapped = rawItems.map(mapLotItem)
  const withRt = mapped.filter((x) => x.autolistRuntime).length
  console.log(
    '[Playerok autolist] completed-lots загружено:',
    mapped.length,
    'с полем autolistRuntime:',
    withRt
  )
  return mapped
}

/** Ключ продукта для настроек: полностью повторяет normalizeKeyPart/buildProductKey на бэкенде */
export function getProductKey(lot) {
  const normalizeKeyPart = (v) =>
    String(v == null ? '' : v)
      .trim()
      .replace(/\s+/g, ' ')

  const game = normalizeKeyPart(lot?.game)
  const title = normalizeKeyPart(lot?.title)
  return game ? `${game}::${title}` : title
}

const GROUP_SETTINGS_PREFIX = '__group__::'

/** Ключ группы настроек: один на много лотов (по метке). */
export function getGroupSettingsKey(label) {
  const name = String(label || '').trim()
  return name ? `${GROUP_SETTINGS_PREFIX}${name}` : ''
}

export async function loadProductSettings(token, productKey) {
  if (!productKey) return { settings: null }
  const url = buildUrlWithToken(BACKEND_PRODUCT_SETTINGS_URL, token, { productKey })
  const response = await trackedFetch(url, FETCH_CREDENTIALS)
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `Ошибка загрузки настроек: ${response.status}`)
  }
  const data = await response.json()
  return data
}

export async function saveProductSettings(token, productKey, settings) {
  if (!productKey) throw new Error('productKey обязателен')
  const response = await trackedFetch(BACKEND_PRODUCT_SETTINGS_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(token ? { token } : {}), productKey, settings }),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `Ошибка сохранения настроек: ${response.status}`)
  }
  return response.json()
}

export async function deleteProductSettings(token, productKey) {
  if (!productKey) throw new Error('productKey обязателен')
  const response = await trackedFetch(BACKEND_PRODUCT_SETTINGS_DELETE_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(token ? { token } : {}), productKey }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error || `Ошибка удаления настроек: ${response.status}`)
  }
  return data
}

/** Список всех настроек по токену (для фильтра «Автовыдача» и т.д.) */
export async function loadProductSettingsList(token) {
  const url = buildUrlWithToken(`${BACKEND_PRODUCT_SETTINGS_URL}/list`, token)
  const response = await trackedFetch(url, FETCH_CREDENTIALS)
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `Ошибка загрузки списка настроек: ${response.status}`)
  }
  const data = await response.json()
  return data
}

const BACKEND_BUMP_HISTORY_URL = `${BACKEND_ORIGIN}/api/bump-history`
const BACKEND_ACTIONS_HISTORY_URL = `${BACKEND_ORIGIN}/api/actions-history`
const BACKEND_SALES_HISTORY_URL = `${BACKEND_ORIGIN}/api/sales-history`
const BACKEND_RELIST_ITEM_URL = `${BACKEND_ORIGIN}/api/playerok/relist-item`
const BACKEND_AUTOLIST_TICK_URL = `${BACKEND_ORIGIN}/api/playerok/autolist-tick`
const BACKEND_BUMP_URL = `${BACKEND_ORIGIN}/api/playerok/bump`
const BACKEND_PRIORITY_STATUSES_URL = `${BACKEND_ORIGIN}/api/playerok/item-priority-statuses`
const BACKEND_SEND_CHAT_MESSAGE_URL = `${BACKEND_ORIGIN}/api/playerok/send-chat-message`
const BACKEND_LOGS_URL = `${BACKEND_ORIGIN}/api/logs`

/** История поднятий лотов */
export async function fetchBumpHistory(token) {
  const url = buildUrlWithToken(BACKEND_BUMP_HISTORY_URL, token)
  const response = await trackedFetch(url, FETCH_CREDENTIALS)
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `Ошибка загрузки истории: ${response.status}`)
  }
  const data = await response.json()
  return data
}

/** История действий: автовыставление и поднятия */
export async function fetchActionsHistory(token) {
  const url = buildUrlWithToken(BACKEND_ACTIONS_HISTORY_URL, token)
  const response = await trackedFetch(url, FETCH_CREDENTIALS)
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `Ошибка загрузки истории действий: ${response.status}`)
  }
  const data = await response.json()
  return data
}

/** История продаж (завершённые лоты со статусом SOLD) */
export async function fetchSalesHistory(token) {
  const url = buildUrlWithToken(BACKEND_SALES_HISTORY_URL, token)
  const response = await trackedFetch(url, FETCH_CREDENTIALS)
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `Ошибка загрузки истории продаж: ${response.status}`)
  }
  const data = await response.json()
  return data
}

/** Актуальные сделки в выполнении напрямую с Playerok (без БД) */
export async function fetchInProgressDeals(token) {
  const response = await trackedFetch(BACKEND_IN_PROGRESS_DEALS_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(token ? { token } : {}),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    }),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `Ошибка загрузки сделок в выполнении: ${response.status}`)
  }
  const data = await response.json()
  const list = Array.isArray(data?.list) ? data.list : []
  return { list }
}

/** Завершённые сделки (SENT, CONFIRMED) — для блока «Непрочитанные чаты» */
export async function fetchCompletedDeals(token) {
  const response = await trackedFetch(BACKEND_COMPLETED_DEALS_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(token ? { token } : {}),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    }),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `Ошибка загрузки завершённых сделок: ${response.status}`)
  }
  const data = await response.json()
  const list = Array.isArray(data?.list) ? data.list : []
  return { list }
}

/** Список чатов пользователя (как на странице /chats). Возвращает последние чаты постранично. */
export async function fetchUserChats(token, opts = {}) {
  const payload = {
    ...(token ? { token } : {}),
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
  }
  if (opts.afterCursor) payload.afterCursor = opts.afterCursor
  if (opts.limit != null) payload.limit = opts.limit
  if (opts.preferCache === false) payload.preferCache = false
  else payload.preferCache = true

  const response = await trackedFetch(BACKEND_USER_CHATS_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `Ошибка загрузки чатов: ${response.status}`)
  }
  const data = await response.json()
  const list = Array.isArray(data?.list) ? data.list : []
  const pageInfo =
    data && typeof data.pageInfo === 'object' && data.pageInfo !== null
      ? {
          hasNextPage: Boolean(data.pageInfo.hasNextPage),
          endCursor: data.pageInfo.endCursor || null,
        }
      : { hasNextPage: false, endCursor: null }
  return { list, pageInfo }
}

/** Список чатов из локальной БД (синхронизация выполняется на backend). */
export async function fetchChatDbList(token, opts = {}) {
  const response = await trackedFetch(BACKEND_CHAT_DB_LIST_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(token ? { token } : {}),
      ...(opts.limit != null ? { limit: opts.limit } : {}),
      ...(opts.offset != null ? { offset: opts.offset } : {}),
    }),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `Ошибка загрузки чатов из БД: ${response.status}`)
  }
  const data = await response.json()
  return {
    list: Array.isArray(data?.list) ? data.list : [],
    total: Number(data?.total || 0),
    pageInfo:
      data && typeof data.pageInfo === 'object'
        ? {
            hasNextPage: Boolean(data.pageInfo.hasNextPage),
            endCursor: data.pageInfo.endCursor || null,
          }
        : { hasNextPage: false, endCursor: null },
  }
}

/** Сообщения чата из локальной БД. */
export async function fetchChatDbMessages(token, { chatId, dealId, skipSmartEmail = true } = {}) {
  const response = await trackedFetch(BACKEND_CHAT_DB_MESSAGES_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(token ? { token } : {}),
      ...(chatId ? { chatId } : {}),
      ...(dealId ? { dealId } : {}),
      ...(skipSmartEmail ? { skipSmartEmail: true } : {}),
    }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `Ошибка загрузки сообщений из БД: ${response.status}`)
  return {
    list: Array.isArray(data?.list) ? data.list : [],
    buyerSupercellEmail: data?.buyerSupercellEmail || null,
    itemTitle: data?.itemTitle || null,
    itemImageUrl: data?.itemImageUrl || null,
    itemCategory: data?.itemCategory || null,
    viewerUsername: data?.viewerUsername || null,
    deals: Array.isArray(data?.deals) ? data.deals : [],
    review: data?.review != null ? data.review : null,
  }
}

/** Отметить чат прочитанным на нашем сайте (локальная метка непрочитанности). */
export async function markChatDbRead(token, chatId) {
  const id = chatId != null ? String(chatId).trim() : ''
  if (!id) return { ok: false }
  const response = await trackedFetch(BACKEND_CHAT_DB_MARK_READ_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(token ? { token } : {}), chatId: id }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `Не удалось отметить чат прочитанным: ${response.status}`)
  return { ok: Boolean(data?.ok), chatId: id }
}

/** Batch-обертка над fetchChatDbMessages для совместимости ChatTab. */
export async function fetchChatDbMessagesBatch(token, chatEntries = [], opts = {}) {
  const entries = Array.isArray(chatEntries) ? chatEntries : []
  const concurrencyRaw = Number(opts?.concurrency)
  const concurrency =
    Number.isFinite(concurrencyRaw) && concurrencyRaw > 0
      ? Math.min(4, Math.max(1, Math.trunc(concurrencyRaw)))
      : 2
  const results = []

  for (let i = 0; i < entries.length; i += concurrency) {
    const chunk = entries.slice(i, i + concurrency)
    const chunkResults = await Promise.all(
      chunk.map(async (entry) => {
      const chatId = entry?.chatId || null
      const dealId = entry?.dealId || null
      try {
        const data = await fetchChatDbMessages(token, { chatId, dealId })
        return {
          chatId: chatId ? String(chatId) : null,
          dealId: dealId || null,
          ok: true,
          error: null,
          list: data.list,
          buyerSupercellEmail: data.buyerSupercellEmail || null,
          itemTitle: data.itemTitle,
          itemImageUrl: data.itemImageUrl,
          itemCategory: data.itemCategory,
          viewerUsername: data.viewerUsername || null,
          deals: data.deals,
          review: data.review != null ? data.review : null,
          automationEvents: [],
        }
      } catch (err) {
        return {
          chatId: chatId ? String(chatId) : null,
          dealId: dealId || null,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          list: [],
          buyerSupercellEmail: null,
          itemTitle: null,
          itemImageUrl: null,
          itemCategory: null,
          deals: [],
          review: null,
          automationEvents: [],
        }
      }
      })
    )
    results.push(...chunkResults)
  }

  return { results }
}

/** Отправка сообщения в Playerok и запись в локальную БД. */
export async function sendChatDbMessage(token, { dealId, chatId, text, clientMessageId, clientCreatedAt }) {
  const response = await trackedFetch(BACKEND_CHAT_DB_SEND_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(token ? { token } : {}),
      ...(dealId ? { dealId } : {}),
      ...(chatId ? { chatId } : {}),
      text,
      ...(clientMessageId ? { clientMessageId } : {}),
      ...(clientCreatedAt ? { clientCreatedAt } : {}),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `Ошибка отправки сообщения: ${response.status}`)
  return data
}

/** Тест-покупка: прогон реальной логики выдачи без сайд-эффектов, возвращает транскрипт. */
export async function testChatPurchase(token, { productKey, sessionId }) {
  const response = await trackedFetch(BACKEND_CHAT_DB_TEST_PURCHASE_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(token ? { token } : {}),
      productKey,
      ...(sessionId ? { sessionId } : {}),
    }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `Ошибка тест-покупки: ${response.status}`)
  return data
}

/** Интерактивная тест-покупка: сообщение продавца или покупателя (флоу продвигается при ответе покупателя). */
export async function sendTestPurchaseMessage(token, { sessionId, text, asRole = 'buyer' }) {
  const response = await trackedFetch(BACKEND_CHAT_DB_TEST_PURCHASE_MESSAGE_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(token ? { token } : {}),
      sessionId,
      text,
      asRole: asRole === 'seller' ? 'seller' : 'buyer',
    }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `Ошибка отправки: ${response.status}`)
  return data
}

/** Тест-покупка: системное событие «Товар отправлен» или «Сделка подтверждена» + автоматика. */
export async function sendTestPurchaseEvent(token, { sessionId, event, dealId }) {
  const response = await trackedFetch(BACKEND_CHAT_DB_TEST_PURCHASE_EVENT_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(token ? { token } : {}),
      sessionId,
      event,
      ...(dealId ? { dealId } : {}),
    }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `Ошибка события теста: ${response.status}`)
  return data
}

/** Принудительная перепроверка одного чата: тянет историю с Playerok и доливает недостающие сообщения в БД. */
export async function recheckChatDbChat(token, { chatId, dealId } = {}) {
  const response = await trackedFetch(BACKEND_CHAT_DB_RECHECK_CHAT_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(token ? { token } : {}),
      ...(chatId ? { chatId } : {}),
      ...(dealId ? { dealId } : {}),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `Ошибка перепроверки чата: ${response.status}`)
  return data
}

export async function startChatDbFullScan(token, opts = {}) {
  const response = await trackedFetch(BACKEND_CHAT_DB_FULL_SCAN_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(token ? { token } : {}),
      ...(opts.force ? { force: true } : {}),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `Ошибка запуска прогрузки чатов: ${response.status}`)
  return data
}

export async function fetchChatDbFullScanStatus() {
  const response = await trackedFetch(BACKEND_CHAT_DB_FULL_SCAN_STATUS_URL, FETCH_CREDENTIALS)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    // На проде endpoint статуса может кратковременно отдавать 502/503/504 через прокси.
    // Для UI это не критично: скрываем шум и просто считаем статус временно недоступным.
    if (response.status === 502 || response.status === 503 || response.status === 504) {
      return {
        ok: false,
        unavailable: true,
        statusCode: response.status,
        state: null,
        runs: [],
      }
    }
    throw new Error(data.error || `Ошибка статуса прогрузки: ${response.status}`)
  }
  return data
}

export async function fetchChatDbSyncStepLog() {
  const response = await trackedFetch(BACKEND_CHAT_DB_SYNC_STEP_LOG_URL, FETCH_CREDENTIALS)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `Ошибка лога синка: ${response.status}`)
  return data
}

export async function clearChatDbSyncStepLog() {
  const response = await trackedFetch(BACKEND_CHAT_DB_SYNC_STEP_LOG_CLEAR_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `Ошибка очистки лога синка: ${response.status}`)
  return data
}

export async function resetChatDbFullScan() {
  const response = await trackedFetch(BACKEND_CHAT_DB_FULL_SCAN_RESET_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `Ошибка сброса прогрузки: ${response.status}`)
  return data
}

export async function pauseChatDbScan() {
  const response = await trackedFetch(BACKEND_CHAT_DB_SCAN_PAUSE_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `Ошибка паузы прогрузки: ${response.status}`)
  return data
}

export async function stopChatDbScan() {
  const response = await trackedFetch(BACKEND_CHAT_DB_SCAN_STOP_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `Ошибка остановки прогрузки: ${response.status}`)
  return data
}

/** Пометить чат скрытым (ручное скрытие в UI). */
export async function hideChat(token, chatId) {
  if (!chatId) throw new Error('chatId обязателен')
  const response = await trackedFetch(BACKEND_HIDE_CHAT_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(token ? { token } : {}),
      chatId,
    }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error || `Ошибка скрытия чата: ${response.status}`)
  }
  return data
}

/** Снять пометку скрытия чата. */
export async function unhideChat(token, chatId) {
  if (!chatId) throw new Error('chatId обязателен')
  const response = await trackedFetch(BACKEND_UNHIDE_CHAT_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(token ? { token } : {}),
      chatId,
    }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error || `Ошибка показа чата: ${response.status}`)
  }
  return data
}

/** Batch-загрузка сообщений нескольких чатов одним запросом. */
export async function fetchDealChatMessagesBatch(token, chatEntries = [], opts = {}) {
  const chats = (chatEntries || [])
    .filter((entry) => entry && (entry.chatId || entry.dealId))
    .map((entry) => ({
      chatId: entry.chatId || undefined,
      dealId: entry.dealId || undefined,
      buyerName:
        typeof entry.buyerName === 'string' && entry.buyerName.trim()
          ? entry.buyerName.trim()
          : undefined,
      category:
        typeof entry.category === 'string' && entry.category.trim()
          ? entry.category.trim()
          : undefined,
    }))

  if (chats.length === 0) {
    return { results: [] }
  }

  const response = await trackedFetch(BACKEND_DEAL_CHAT_MESSAGES_BATCH_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(token ? { token } : {}),
      chats,
      ...(opts.messagesOnly === true ? { messagesOnly: true } : {}),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    }),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `Ошибка batch-загрузки чатов: ${response.status}`)
  }
  const data = await response.json()
  const results = Array.isArray(data?.results)
    ? data.results.map((entry) => ({
        chatId: entry?.chatId != null ? String(entry.chatId) : null,
        dealId: entry?.dealId || null,
        ok: Boolean(entry?.ok),
        error: entry?.error ? String(entry.error) : null,
        list: Array.isArray(entry?.list) ? entry.list : [],
        buyerSupercellEmail:
          entry && typeof entry.buyerSupercellEmail === 'string' ? entry.buyerSupercellEmail : null,
        itemTitle: entry && typeof entry.itemTitle === 'string' ? entry.itemTitle : null,
        itemImageUrl: entry && typeof entry.itemImageUrl === 'string' ? entry.itemImageUrl : null,
        itemCategory: entry && typeof entry.itemCategory === 'string' ? entry.itemCategory : null,
        automationEvents: Array.isArray(entry?.automationEvents) ? entry.automationEvents : [],
      }))
    : []

  for (const entry of results) {
    if (entry.automationEvents?.length > 0) {
      logChatAutomationEvents(entry.automationEvents)
    }
  }

  return { results }
}

/** Сообщения чата по сделке (для вкладок Выполнение и Чат). chatId — если есть (из списка сделок), иначе бэкенд возьмёт по dealId. */
export async function fetchDealChatMessages(token, dealId, chatId, options = {}) {
  const messagesOnly = options.messagesOnly === true
  if (!dealId && !chatId) {
    return {
      list: [],
      buyerSupercellEmail: null,
      itemTitle: null,
      itemImageUrl: null,
      itemCategory: null,
    }
  }
  const buyerName =
    options && typeof options.buyerName === 'string' && options.buyerName.trim()
      ? options.buyerName.trim()
      : undefined
  const category =
    options && typeof options.category === 'string' && options.category.trim()
      ? options.category.trim()
      : undefined

  const { results } = await fetchDealChatMessagesBatch(
    token,
    [
      {
        dealId: dealId || undefined,
        chatId: chatId || undefined,
        buyerName,
        category,
      },
    ],
    { messagesOnly }
  )

  const entry =
    (chatId && results.find((item) => item.chatId === String(chatId))) || results[0] || null
  if (!entry || !entry.ok) {
    throw new Error(entry?.error || 'Ошибка загрузки чата сделки')
  }

  return {
    list: entry.list,
    buyerSupercellEmail: entry.buyerSupercellEmail,
    itemTitle: entry.itemTitle,
    itemImageUrl: entry.itemImageUrl,
    itemCategory: entry.itemCategory,
  }
}

/** Ручной запуск автовыдачи Api для чата (сброс очереди и повтор). */
export async function rescanApprouteChat(token, { chatId, dealId, dealItemId, itemId }) {
  const cid = chatId != null ? String(chatId).trim() : ''
  if (!cid) throw new Error('chatId обязателен')

  const response = await trackedFetch(BACKEND_APPROUTE_CHAT_RESCAN_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(token ? { token } : {}),
      chatId: cid,
      dealId: dealId || undefined,
      dealItemId: dealItemId || itemId || undefined,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(
      (typeof data.error === 'string' && data.error.trim()) ||
        (typeof data.reason === 'string' && data.reason.trim()) ||
        `Ошибка рескана: ${response.status}`
    )
  }
  if (data && data.ok === false) {
    const msg =
      (typeof data.error === 'string' && data.error.trim()) ||
      (typeof data.reason === 'string' && data.reason.trim()) ||
      'Автовыдача Api не выполнена'
    if (data.pending) {
      const err = new Error(msg)
      err.pending = true
      throw err
    }
    throw new Error(msg)
  }
  return data
}

/** Отправить сообщение в чат по сделке или chatId. */
export async function sendDealChatMessage(token, { dealId, chatId, text }) {
  const trimmed = (text || '').trim()
  if (!trimmed) throw new Error('Пустое сообщение')
  if (!dealId && !chatId) throw new Error('dealId или chatId обязателен')

  const response = await trackedFetch(BACKEND_SEND_CHAT_MESSAGE_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(token ? { token } : {}),
      dealId: dealId || undefined,
      chatId: chatId || undefined,
      text: trimmed,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error || `Ошибка отправки сообщения: ${response.status}`)
  }
  return data
}

/** Запросить код Supercell и отправить сервисное сообщение в чат сделки. */
export async function requestSupercellCode(token, { dealId, chatId, email, category }) {
  const trimmedEmail = String(email || '').trim()
  const trimmedCategory = String(category || '').trim()
  if (!trimmedEmail) throw new Error('Почта обязательна')
  if (!trimmedCategory) throw new Error('Категория обязательна')
  if (!dealId && !chatId) throw new Error('dealId или chatId обязателен')

  const response = await trackedFetch(BACKEND_REQUEST_SUPERCELL_CODE_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(token ? { token } : {}),
      dealId: dealId || undefined,
      chatId: chatId || undefined,
      email: trimmedEmail,
      category: trimmedCategory,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error || `Ошибка запроса кода Supercell: ${response.status}`)
  }
  return data
}

/** Тестовый ручной запрос кода Supercell без привязки к сделке. */
export async function requestSupercellCodeTest({ email, category }) {
  const trimmedEmail = String(email || '').trim()
  const trimmedCategory = String(category || '').trim()
  if (!trimmedEmail) throw new Error('Почта обязательна')
  if (!trimmedCategory) throw new Error('Категория обязательна')

  const response = await trackedFetch(BACKEND_REQUEST_SUPERCELL_CODE_TEST_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: trimmedEmail,
      category: trimmedCategory,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error || `Ошибка тестового запроса кода Supercell: ${response.status}`)
  }
  return data
}

/** Отменить сделку (оформить возврат) */
export async function cancelDeal(token, dealId) {
  if (!dealId) throw new Error('dealId обязателен')
  const response = await trackedFetch(BACKEND_CANCEL_DEAL_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(token ? { token } : {}),
      dealId,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error || `Ошибка отмены сделки: ${response.status}`)
  }
  return data
}

/** Подтвердить выполнение сделки (продавец отправил товар) */
export async function confirmDeal(token, dealId) {
  if (!dealId) throw new Error('dealId обязателен')
  const response = await trackedFetch(BACKEND_CONFIRM_DEAL_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(token ? { token } : {}),
      dealId,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error || `Ошибка подтверждения сделки: ${response.status}`)
  }
  return data
}

/** Очистить таблицу продаж (история прибыли) для текущего токена */
export async function clearSalesHistory(token) {
  const response = await trackedFetch(`${BACKEND_ORIGIN}/api/sales-history/clear`, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(token ? { token } : {}) }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error || `Ошибка очистки: ${response.status}`)
  }
  return data
}

/** Аналитика прибыли: продажи с себестоимостью, расходами и прибылью */
export async function fetchProfitAnalytics(token, opts = {}) {
  const extra = {}
  if (opts.year != null && opts.year !== '') extra.year = opts.year
  if (opts.month != null && opts.month !== '') extra.month = opts.month
  if (opts.day != null && opts.day !== '') extra.day = opts.day
  if (opts.limit != null) extra.limit = opts.limit
  if (opts.offset != null) extra.offset = opts.offset
  const url = buildUrlWithToken(`${BACKEND_ORIGIN}/api/profit-analytics`, token, extra)
  const response = await trackedFetch(url, FETCH_CREDENTIALS)
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `Ошибка загрузки аналитики: ${response.status}`)
  }
  const data = await response.json()
  return data
}

/** Метаданные для фильтров прибыли (доступные годы/месяцы) */
export async function fetchProfitMeta(token, opts = {}) {
  const extra = opts.year != null && opts.year !== '' ? { year: opts.year } : {}
  const url = buildUrlWithToken(`${BACKEND_ORIGIN}/api/profit-analytics/meta`, token, extra)
  const response = await trackedFetch(url, FETCH_CREDENTIALS)
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `Ошибка загрузки метаданных: ${response.status}`)
  }
  return response.json()
}

/** Статистика по прибыли (агрегаты + самое прибыльное время) */
export async function fetchProfitStats(token, opts = {}) {
  const extra = {}
  if (opts.year != null && opts.year !== '') extra.year = opts.year
  if (opts.month != null && opts.month !== '') extra.month = opts.month
  if (opts.day != null && opts.day !== '') extra.day = opts.day
  const url = buildUrlWithToken(`${BACKEND_ORIGIN}/api/profit-stats`, token, extra)
  const response = await trackedFetch(url, FETCH_CREDENTIALS)
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `Ошибка загрузки статистики: ${response.status}`)
  }
  return response.json()
}

/** Синхронизировать все продажи с Playerok в локальную БД (вкладка «Прибыль») */
export async function syncSalesFromPlayerok(token) {
  const response = await trackedFetch(`${BACKEND_ORIGIN}/api/sync-sales`, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(token ? { token } : {}) }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error || `Ошибка синхронизации: ${response.status}`)
  }
  return data
}

/**
 * Синхронизация с прогрессом (SSE). Вызывает onProgress({ fetched, total, inserted }) по мере обработки.
 * @returns {Promise<{ total: number, inserted: number }>}
 */
export async function syncSalesFromPlayerokStream(token, onProgress) {
  const response = await trackedFetch(`${BACKEND_ORIGIN}/api/sync-sales-stream`, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(token ? { token } : {}) }),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `Ошибка: ${response.status}`)
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result = null
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const data = JSON.parse(line.slice(6))
          if (data.error) throw new Error(data.error)
          if (data.done) {
            result = { total: data.total ?? 0, inserted: data.inserted ?? 0 }
          } else if (onProgress && data.fetched != null) {
            onProgress({
              fetched: data.fetched,
              inserted: data.inserted ?? 0,
            })
          }
        } catch (e) {
          if (e instanceof SyntaxError) continue
          throw e
        }
      }
    }
  }
  if (buffer.startsWith('data: ')) {
    try {
      const data = JSON.parse(buffer.slice(6))
      if (data.error) throw new Error(data.error)
      if (data.done) result = { total: data.total ?? 0, inserted: data.inserted ?? 0 }
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e
    }
  }
  return result ?? { total: 0, inserted: 0 }
}

/** Записать поднятие лота (вызов после поднятия на Playerok или для учёта) */
export async function recordBump(token, { productKey, productTitle, itemId, price = 0, priorityStatusId }) {
  if (!productKey) throw new Error('productKey обязателен')
  const body = {
    ...(token ? { token } : {}),
    productKey,
    productTitle: productTitle || 'Товар',
    itemId,
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    price: Number(price) || 0,
  }
  // Отправляем priorityStatusId только если он валидный (не null, не undefined, не пустая строка)
  if (priorityStatusId && String(priorityStatusId).trim()) {
    body.priorityStatusId = priorityStatusId
  }
  const response = await trackedFetch(BACKEND_BUMP_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    if (response.status === 402 && err.paymentURL) {
      throw new Error((err.error || 'Требуется оплата поднятия') + `: ${err.paymentURL}`)
    }
    const reqIdSuffix = err && err.reqId ? ` (reqId: ${err.reqId})` : ''
    throw new Error((err.error || `Ошибка поднятия: ${response.status}`) + reqIdSuffix)
  }
  return response.json()
}

/** Выставить снова завершённый товар (автовыставление). Настройки привязаны к productKey (игра::название), новый лот получит тот же productKey. */
export async function relistItem(token, { itemId, priorityStatusId }) {
  if (!itemId) throw new Error('itemId обязателен')
  const response = await trackedFetch(BACKEND_RELIST_ITEM_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(token ? { token } : {}),
      itemId,
      priorityStatusId: priorityStatusId || undefined,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    }),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `Ошибка повторного выставления: ${response.status}`)
  }
  return response.json()
}

/** Автовыставление: проверка последнего чата и перевыставление, если нужно */
export async function autolistTick(token) {
  console.log('[Playerok autolist] → POST /api/playerok/autolist-tick')
  const response = await trackedFetch(BACKEND_AUTOLIST_TICK_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(token ? { token } : {}),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    console.warn('[Playerok autolist] ← autolist-tick HTTP', response.status, data)
    throw new Error(data.error || `Ошибка автoвыставления: ${response.status}`)
  }
  console.log('[Playerok autolist] ← autolist-tick ответ', data)
  return data
}

/** Получить доступные статусы поднятия (кнопка "Поднять в топ") */
export async function fetchItemPriorityStatuses(token, { itemId, price }) {
  if (!itemId) throw new Error('itemId обязателен')
  const response = await trackedFetch(BACKEND_PRIORITY_STATUSES_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(token ? { token } : {}),
      itemId,
      price: Number(price) || 0,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    }),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `Ошибка загрузки статусов поднятия: ${response.status}`)
  }
  return response.json()
}

/** Список команд по категориям для вкладки «Команды» и «Выполнение» */
export async function loadCategoryCommandsList(token) {
  const url = buildUrlWithToken(BACKEND_CATEGORY_COMMANDS_LIST_URL, token)
  const response = await trackedFetch(url, FETCH_CREDENTIALS)
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `Ошибка загрузки команд категорий: ${response.status}`)
  }
  const data = await response.json()
  const list = Array.isArray(data?.list) ? data.list : []
  return { list }
}

/** Сохранить список команд для одной категории */
export async function saveCategoryCommands(token, category, commands) {
  const trimmedCategory = String(category || '').trim()
  if (!trimmedCategory) throw new Error('Категория обязательна')
  const response = await trackedFetch(BACKEND_CATEGORY_COMMANDS_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(token ? { token } : {}),
      category: trimmedCategory,
      commands: Array.isArray(commands) ? commands : [],
    }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error || `Ошибка сохранения команд: ${response.status}`)
  }
  return data
}

export async function fetchTableTabs() {
  const response = await trackedFetch(BACKEND_TABLE_TABS_URL, FETCH_CREDENTIALS)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error || `Ошибка загрузки вкладок: ${response.status}`)
  }
  return { list: Array.isArray(data?.list) ? data.list : [] }
}

/** Абсолютный URL картинки автосообщения (бэкенд на другом порту в dev). */
export function automessageImageUrl(relativeOrAbsolute) {
  const u = String(relativeOrAbsolute || '')
  if (!u) return ''
  if (/^https?:\/\//i.test(u)) return u
  return `${BACKEND_ORIGIN}${u.startsWith('/') ? '' : '/'}${u}`
}

/** Загрузка картинки автосообщения на сервер. Возвращает { imageId, ext, filename, url }. */
export async function uploadAutomessageImage(file) {
  if (!file) throw new Error('Файл не выбран')
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'))
    reader.readAsDataURL(file)
  })
  const response = await fetch(`${BACKEND_ORIGIN}/api/automessage-image`, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataUrl, filename: file.name || '' }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || !data?.image) {
    throw new Error(data.error || `Ошибка загрузки картинки (${response.status})`)
  }
  return data.image
}

export async function createTableTab(name) {
  const trimmedName = String(name || '').trim()
  if (!trimmedName) throw new Error('Название вкладки обязательно')
  const response = await trackedFetch(BACKEND_TABLE_TABS_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: trimmedName }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error || `Ошибка создания вкладки: ${response.status}`)
  }
  return data
}

export async function createTableSubtab(tabId, name) {
  const id = Number(tabId)
  const trimmedName = String(name || '').trim()
  if (!Number.isFinite(id) || id <= 0) throw new Error('Некорректный tabId')
  if (!trimmedName) throw new Error('Название подвкладки обязательно')
  const response = await trackedFetch(BACKEND_TABLE_SUBTABS_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tabId: id, name: trimmedName }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error || `Ошибка создания таблицы: ${response.status}`)
  }
  return data
}

export async function renameTableSubtab(id, name) {
  const subtabId = Number(id)
  const trimmedName = String(name || '').trim()
  if (!Number.isFinite(subtabId) || subtabId <= 0) throw new Error('Некорректный id')
  if (!trimmedName) throw new Error('Название обязательно')
  const response = await trackedFetch(BACKEND_TABLE_SUBTABS_RENAME_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: subtabId, name: trimmedName }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error || `Ошибка переименования: ${response.status}`)
  }
  return data
}

export async function deleteTableTab(id) {
  const tabId = Number(id)
  if (!Number.isFinite(tabId) || tabId <= 0) throw new Error('Некорректный id')
  const response = await trackedFetch(BACKEND_TABLE_TABS_DELETE_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: tabId }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error || `Ошибка удаления вкладки: ${response.status}`)
  }
  return data
}

export async function deleteTableSubtab(id) {
  const subtabId = Number(id)
  if (!Number.isFinite(subtabId) || subtabId <= 0) throw new Error('Некорректный id')
  const response = await trackedFetch(BACKEND_TABLE_SUBTABS_DELETE_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: subtabId }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error || `Ошибка удаления таблицы: ${response.status}`)
  }
  return data
}

export async function fetchTableColumns(subtabId) {
  const id = Number(subtabId)
  if (!Number.isFinite(id) || id <= 0) throw new Error('Подвкладка обязательна')
  const url = buildUrlWithToken(BACKEND_TABLE_COLUMNS_URL, null, { subtabId: id })
  const response = await trackedFetch(url, FETCH_CREDENTIALS)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error || `Ошибка загрузки столбцов: ${response.status}`)
  }
  return { list: Array.isArray(data?.list) ? data.list : [] }
}

export async function createTableColumn(subtabId, name) {
  const id = Number(subtabId)
  const trimmedName = String(name || '').trim()
  if (!Number.isFinite(id) || id <= 0) throw new Error('Подвкладка обязательна')
  if (!trimmedName) throw new Error('Название столбца обязательно')
  const response = await trackedFetch(BACKEND_TABLE_COLUMNS_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subtabId: id, name: trimmedName }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error || `Ошибка создания столбца: ${response.status}`)
  }
  return data
}

export async function renameTableColumn(id, name) {
  const columnId = Number(id)
  const trimmedName = String(name || '').trim()
  if (!Number.isFinite(columnId) || columnId <= 0) throw new Error('Некорректный id')
  if (!trimmedName) throw new Error('Название обязательно')
  const response = await trackedFetch(BACKEND_TABLE_COLUMNS_RENAME_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: columnId, name: trimmedName }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error || `Ошибка переименования столбца: ${response.status}`)
  }
  return data
}

export async function deleteTableColumn(id) {
  const columnId = Number(id)
  if (!Number.isFinite(columnId) || columnId <= 0) throw new Error('Некорректный id')
  const response = await trackedFetch(BACKEND_TABLE_COLUMNS_DELETE_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: columnId }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error || `Ошибка удаления столбца: ${response.status}`)
  }
  return data
}

export async function updateTableCodeCellValue(codeId, columnId, value) {
  const id = Number(codeId)
  const colId = Number(columnId)
  if (!Number.isFinite(id) || id <= 0) throw new Error('Некорректный codeId')
  if (!Number.isFinite(colId) || colId <= 0) throw new Error('Некорректный columnId')
  const response = await trackedFetch(BACKEND_TABLE_CODES_CELL_VALUE_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codeId: id, columnId: colId, value: String(value ?? '') }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error || `Ошибка сохранения ячейки: ${response.status}`)
  }
  return data
}

export async function fetchTableCodes(subtabId) {
  const id = Number(subtabId)
  if (!Number.isFinite(id) || id <= 0) throw new Error('Подвкладка обязательна')
  const url = buildUrlWithToken(BACKEND_TABLE_CODES_URL, null, { subtabId: id })
  const response = await trackedFetch(url, FETCH_CREDENTIALS)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error || `Ошибка загрузки кодов: ${response.status}`)
  }
  return { list: Array.isArray(data?.list) ? data.list : [] }
}

export async function addTableCode(subtabId, code) {
  const id = Number(subtabId)
  const trimmedCode = String(code || '').trim()
  if (!Number.isFinite(id) || id <= 0) throw new Error('Подвкладка обязательна')
  if (!trimmedCode) throw new Error('Код обязателен')
  const response = await trackedFetch(BACKEND_TABLE_CODES_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subtabId: id, code: trimmedCode }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error || `Ошибка добавления кода: ${response.status}`)
  }
  return data
}

export async function addTableCodes(subtabId, codes) {
  const id = Number(subtabId)
  if (!Number.isFinite(id) || id <= 0) throw new Error('Подвкладка обязательна')
  const list = Array.isArray(codes) ? codes.map((value) => String(value || '').trim()).filter(Boolean) : []
  if (list.length === 0) throw new Error('Код обязателен')
  const response = await trackedFetch(BACKEND_TABLE_CODES_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subtabId: id, codes: list }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error || `Ошибка добавления кодов: ${response.status}`)
  }
  return { list: Array.isArray(data?.list) ? data.list : [] }
}

// status — один из 'unused' | 'pending' | 'used'. Для обратной совместимости
// принимаем и булево (true → 'used', false → 'unused') и шлём used вместе со status.
export async function updateTableCodeUsed(id, status) {
  const codeId = Number(id)
  if (!Number.isFinite(codeId) || codeId <= 0) throw new Error('Некорректный id')
  const normalized =
    status === true || status === 'used'
      ? 'used'
      : status === 'pending'
        ? 'pending'
        : 'unused'
  const response = await trackedFetch(BACKEND_TABLE_CODES_USED_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: codeId, status: normalized, used: normalized === 'used' }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error || `Ошибка обновления статуса: ${response.status}`)
  }
  return data
}

export async function deleteTableCode(id) {
  const codeId = Number(id)
  if (!Number.isFinite(codeId) || codeId <= 0) throw new Error('Некорректный id')
  const response = await trackedFetch(BACKEND_TABLE_CODES_DELETE_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: codeId }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error || `Ошибка удаления кода: ${response.status}`)
  }
  return data
}

/** Получение логов сервера */
export async function fetchLogs(token) {
  const url = buildUrlWithToken(BACKEND_LOGS_URL, token)
  const response = await trackedFetch(url, FETCH_CREDENTIALS)
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `Ошибка загрузки логов: ${response.status}`)
  }
  const data = await response.json()
  return data
}

export async function fetchBalanceOverview(token) {
  const response = await trackedFetch(BACKEND_BALANCE_OVERVIEW_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(token ? { token } : {}),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `Ошибка загрузки баланса: ${response.status}`)
  return data
}

export async function fetchTransactionProviders(token, direction = 'OUT') {
  const response = await trackedFetch(BACKEND_TRANSACTION_PROVIDERS_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(token ? { token } : {}),
      direction,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `Ошибка загрузки провайдеров: ${response.status}`)
  return data
}

export async function fetchTransactions(token, opts = {}) {
  const response = await trackedFetch(BACKEND_TRANSACTIONS_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(token ? { token } : {}),
      ...opts,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `Ошибка загрузки транзакций: ${response.status}`)
  return data
}

export async function fetchVerifiedCards(token, opts = {}) {
  const response = await trackedFetch(BACKEND_VERIFIED_CARDS_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(token ? { token } : {}),
      ...opts,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `Ошибка загрузки карт: ${response.status}`)
  return data
}

export async function requestWithdrawal(token, payload) {
  const response = await trackedFetch(BACKEND_REQUEST_WITHDRAWAL_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(token ? { token } : {}),
      ...payload,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `Ошибка создания вывода: ${response.status}`)
  return data
}

export async function removeTransaction(token, transactionId) {
  const response = await trackedFetch(BACKEND_REMOVE_TRANSACTION_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(token ? { token } : {}),
      transactionId,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `Ошибка отмены транзакции: ${response.status}`)
  return data
}

export async function setPlayerokDdosCookie(cookie) {
  const response = await trackedFetch(BACKEND_DDOS_COOKIE_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cookie: String(cookie || '') }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `Ошибка сохранения cookie: ${response.status}`)
  return data
}

export async function getPlayerokDdosCookieStatus() {
  const response = await trackedFetch(BACKEND_DDOS_COOKIE_URL, FETCH_CREDENTIALS)
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `Ошибка статуса cookie: ${response.status}`)
  return data
}

/** Одна загрузка списка чатов (userChats, referer /chats) для теста лимита 429. */
export async function fetchChatsProbeStep(token, opts = {}) {
  const response = await trackedFetch(BACKEND_CHATS_PROBE_STEP_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(token ? { token } : {}),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
      ...(opts.userId ? { userId: opts.userId } : {}),
      ...(opts.limit != null ? { limit: opts.limit } : {}),
    }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error || `Ошибка загрузки чатов: ${response.status}`)
  }
  return data
}

export async function checkPlayerokDdosAccess(token) {
  const response = await trackedFetch(BACKEND_DDOS_CHECK_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(token ? { token } : {}),
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    const err = new Error(data.error || `Ошибка проверки доступа: ${response.status}`)
    err.isDdosGuard = Boolean(data && data.isDdosGuard)
    throw err
  }
  return data
}


