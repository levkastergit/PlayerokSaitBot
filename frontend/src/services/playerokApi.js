const BACKEND_ORIGIN =
  import.meta.env.VITE_BACKEND_ORIGIN || 'http://localhost:3000'
const BACKEND_ACTIVE_LOTS_URL =
  import.meta.env.VITE_BACKEND_ACTIVE_LOTS_URL ||
  `${BACKEND_ORIGIN}/api/playerok/active-lots`
const BACKEND_COMPLETED_LOTS_URL =
  import.meta.env.VITE_BACKEND_COMPLETED_LOTS_URL ||
  `${BACKEND_ORIGIN}/api/playerok/completed-lots`
const BACKEND_IN_PROGRESS_DEALS_URL = `${BACKEND_ORIGIN}/api/playerok/in-progress-deals`
const BACKEND_DEAL_CHAT_MESSAGES_URL = `${BACKEND_ORIGIN}/api/playerok/deal-chat-messages`
const BACKEND_PRODUCT_SETTINGS_URL = `${BACKEND_ORIGIN}/api/product-settings`
const BACKEND_TOKEN_URL = `${BACKEND_ORIGIN}/api/token`

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
  }
}

export async function fetchActiveLots(token) {
  if (!token) {
    throw new Error('Токен не задан')
  }

  const response = await fetch(BACKEND_ACTIVE_LOTS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      token,
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
    const response = await fetch(BACKEND_TOKEN_URL)
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
  const response = await fetch(BACKEND_TOKEN_URL, {
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
  if (!token) {
    throw new Error('Токен не задан')
  }

  const response = await fetch(BACKEND_COMPLETED_LOTS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      token,
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

/** Ключ продукта для настроек: по нему сохраняем настройки для всех лотов с этим названием и игрой */
export function getProductKey(lot) {
  const game = (lot?.game ?? '').trim()
  const title = (lot?.title ?? '').trim()
  return `${game}::${title}`
}

export async function loadProductSettings(token, productKey) {
  if (!token || !productKey) return { settings: null }
  const url = `${BACKEND_PRODUCT_SETTINGS_URL}?${new URLSearchParams({
    token,
    productKey,
  })}`
  const response = await fetch(url)
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `Ошибка загрузки настроек: ${response.status}`)
  }
  const data = await response.json()
  return data
}

export async function saveProductSettings(token, productKey, settings) {
  if (!token || !productKey) throw new Error('Токен и ключ продукта обязательны')
  const response = await fetch(BACKEND_PRODUCT_SETTINGS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, productKey, settings }),
  })
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `Ошибка сохранения настроек: ${response.status}`)
  }
  return response.json()
}

/** Список всех настроек по токену (для фильтра «Автовыдача» и т.д.) */
export async function loadProductSettingsList(token) {
  if (!token) return { list: [] }
  const url = `${BACKEND_PRODUCT_SETTINGS_URL}/list?${new URLSearchParams({ token })}`
  const response = await fetch(url)
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

/** История поднятий лотов */
export async function fetchBumpHistory(token) {
  if (!token) return { list: [] }
  const url = `${BACKEND_BUMP_HISTORY_URL}?${new URLSearchParams({ token })}`
  const response = await fetch(url)
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `Ошибка загрузки истории: ${response.status}`)
  }
  const data = await response.json()
  return data
}

/** История продаж (завершённые лоты со статусом SOLD) */
export async function fetchSalesHistory(token) {
  if (!token) return { list: [] }
  const url = `${BACKEND_SALES_HISTORY_URL}?${new URLSearchParams({ token })}`
  const response = await fetch(url)
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `Ошибка загрузки истории продаж: ${response.status}`)
  }
  const data = await response.json()
  return data
}

/** Актуальные сделки в выполнении напрямую с Playerok (без БД) */
export async function fetchInProgressDeals(token) {
  if (!token) return { list: [] }
  const response = await fetch(BACKEND_IN_PROGRESS_DEALS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
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

/** Сообщения чата по сделке (для вкладки Выполнение). chatId — если есть (из списка сделок), иначе бэкенд возьмёт по dealId. */
export async function fetchDealChatMessages(token, dealId, chatId) {
  if (!token) return { list: [] }
  if (!dealId && !chatId) return { list: [] }
  const response = await fetch(BACKEND_DEAL_CHAT_MESSAGES_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
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
  return { list }
}

/** Отправить сообщение в чат по сделке или chatId. */
export async function sendDealChatMessage(token, { dealId, chatId, text }) {
  if (!token) throw new Error('Токен обязателен')
  const trimmed = (text || '').trim()
  if (!trimmed) throw new Error('Пустое сообщение')
  if (!dealId && !chatId) throw new Error('dealId или chatId обязателен')

  const response = await fetch(BACKEND_SEND_CHAT_MESSAGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
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

/** Очистить таблицу продаж (история прибыли) для текущего токена */
export async function clearSalesHistory(token) {
  if (!token) throw new Error('Токен обязателен')
  const response = await fetch(`${BACKEND_ORIGIN}/api/sales-history/clear`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new Error(data.error || `Ошибка очистки: ${response.status}`)
  }
  return data
}

/** Аналитика прибыли: продажи с себестоимостью, расходами и прибылью */
export async function fetchProfitAnalytics(token, opts = {}) {
  if (!token) return { list: [], total: 0 }
  const params = new URLSearchParams({ token })
  if (opts.year != null && opts.year !== '') params.set('year', String(opts.year))
  if (opts.month != null && opts.month !== '') params.set('month', String(opts.month))
  if (opts.limit != null) params.set('limit', String(opts.limit))
  if (opts.offset != null) params.set('offset', String(opts.offset))
  const url = `${BACKEND_ORIGIN}/api/profit-analytics?${params.toString()}`
  const response = await fetch(url)
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `Ошибка загрузки аналитики: ${response.status}`)
  }
  const data = await response.json()
  return data
}

/** Метаданные для фильтров прибыли (доступные годы/месяцы) */
export async function fetchProfitMeta(token, opts = {}) {
  if (!token) return { years: [], months: [] }
  const params = new URLSearchParams({ token })
  if (opts.year != null && opts.year !== '') params.set('year', String(opts.year))
  const url = `${BACKEND_ORIGIN}/api/profit-analytics/meta?${params.toString()}`
  const response = await fetch(url)
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `Ошибка загрузки метаданных: ${response.status}`)
  }
  return response.json()
}

/** Статистика по прибыли (агрегаты + самое прибыльное время) */
export async function fetchProfitStats(token, opts = {}) {
  if (!token) {
    return {
      scope: { year: null, month: null },
      totals: { profit: 0, revenue: 0, cost: 0, listingCost: 0, bumpCost: 0 },
      counts: { sales: 0, refunds: 0 },
      averages: { profitPerSale: 0 },
      best: { hour: { hour: 0, profit: 0 }, weekday: { weekday: 0, profit: 0 } },
    }
  }
  const params = new URLSearchParams({ token })
  if (opts.year != null && opts.year !== '') params.set('year', String(opts.year))
  if (opts.month != null && opts.month !== '') params.set('month', String(opts.month))
  const url = `${BACKEND_ORIGIN}/api/profit-stats?${params.toString()}`
  const response = await fetch(url)
  if (!response.ok) {
    const err = await response.json().catch(() => ({}))
    throw new Error(err.error || `Ошибка загрузки статистики: ${response.status}`)
  }
  return response.json()
}

/** Синхронизировать все продажи с Playerok в локальную БД (вкладка «Прибыль») */
export async function syncSalesFromPlayerok(token) {
  if (!token) throw new Error('Токен обязателен')
  const response = await fetch(`${BACKEND_ORIGIN}/api/sync-sales`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
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
  if (!token) throw new Error('Токен обязателен')
  const response = await fetch(`${BACKEND_ORIGIN}/api/sync-sales-stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
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
  if (!token || !productKey) throw new Error('Токен и productKey обязательны')
  const response = await fetch(BACKEND_BUMP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
      productKey,
      productTitle: productTitle || 'Товар',
      itemId,
      priorityStatusId,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : undefined,
      price: Number(price) || 0,
    }),
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
  if (!token || !itemId) throw new Error('Токен и itemId обязательны')
  const response = await fetch(BACKEND_RELIST_ITEM_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
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
  if (!token) return { ok: true, skipped: 'no_token' }
  const response = await fetch(BACKEND_AUTOLIST_TICK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
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
  if (!token || !itemId) throw new Error('Токен и itemId обязательны')
  const response = await fetch(BACKEND_PRIORITY_STATUSES_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token,
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


