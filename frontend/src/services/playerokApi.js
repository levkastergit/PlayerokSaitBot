import { trackedFetch } from './requestTracker'

const BACKEND_ORIGIN =
  import.meta.env.VITE_BACKEND_ORIGIN ||
  (typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000')
const BACKEND_ACTIVE_LOTS_URL =
  import.meta.env.VITE_BACKEND_ACTIVE_LOTS_URL ||
  `${BACKEND_ORIGIN}/api/playerok/active-lots`
const BACKEND_COMPLETED_LOTS_URL =
  import.meta.env.VITE_BACKEND_COMPLETED_LOTS_URL ||
  `${BACKEND_ORIGIN}/api/playerok/completed-lots`
const BACKEND_IN_PROGRESS_DEALS_URL = `${BACKEND_ORIGIN}/api/playerok/in-progress-deals`
const BACKEND_COMPLETED_DEALS_URL = `${BACKEND_ORIGIN}/api/playerok/completed-deals`
const BACKEND_DEAL_CHAT_MESSAGES_URL = `${BACKEND_ORIGIN}/api/playerok/deal-chat-messages`
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

  return rawItems.map(mapLotItem)
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

/** Сообщения чата по сделке (для вкладок Выполнение и Чат). chatId — если есть (из списка сделок), иначе бэкенд возьмёт по dealId. */
export async function fetchDealChatMessages(token, dealId, chatId) {
  if (!dealId && !chatId) return { list: [], buyerSupercellEmail: null, itemTitle: null, itemImageUrl: null }
  const response = await trackedFetch(BACKEND_DEAL_CHAT_MESSAGES_URL, {
    ...FETCH_CREDENTIALS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...(token ? { token } : {}),
      dealId: dealId || undefined,
      chatId: chatId || undefined,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
    }),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `Ошибка загрузки чата сделки: ${response.status}`)
  }
  const data = await response.json()
  const list = Array.isArray(data?.list) ? data.list : []
  const buyerSupercellEmail = data && typeof data.buyerSupercellEmail === 'string'
    ? data.buyerSupercellEmail
    : null
  const itemTitle = data && typeof data.itemTitle === 'string' ? data.itemTitle : null
  const itemImageUrl = data && typeof data.itemImageUrl === 'string' ? data.itemImageUrl : null
  return { list, buyerSupercellEmail, itemTitle, itemImageUrl }
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
  const response = await trackedFetch(BACKEND_AUTOLIST_TICK_URL, {
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
    throw new Error(err.error || `Ошибка автoвыставления: ${response.status}`)
  }
  return response.json()
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


