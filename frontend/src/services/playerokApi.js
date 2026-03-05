const BACKEND_ACTIVE_LOTS_URL =
  import.meta.env.VITE_BACKEND_ACTIVE_LOTS_URL ||
  'http://localhost:3000/api/playerok/active-lots'

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
        message += ` (${errData.error})`
      }
    } catch {
      // ignore
    }
    throw new Error(message)
  }

  const data = await response.json()
  const rawItems = Array.isArray(data) ? data : data.items || []

  return rawItems.map((item) => ({
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
  }))
}


