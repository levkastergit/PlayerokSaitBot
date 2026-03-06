const BACKEND_ORIGIN =
  import.meta.env.VITE_BACKEND_ORIGIN || 'http://localhost:3000'
const BACKEND_ACTIVE_LOTS_URL =
  import.meta.env.VITE_BACKEND_ACTIVE_LOTS_URL ||
  `${BACKEND_ORIGIN}/api/playerok/active-lots`
const BACKEND_COMPLETED_LOTS_URL =
  import.meta.env.VITE_BACKEND_COMPLETED_LOTS_URL ||
  `${BACKEND_ORIGIN}/api/playerok/completed-lots`
const BACKEND_PRODUCT_SETTINGS_URL = `${BACKEND_ORIGIN}/api/product-settings`

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


