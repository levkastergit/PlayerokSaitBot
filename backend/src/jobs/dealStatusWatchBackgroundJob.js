'use strict'

// ---------------------------------------------------------------------------
// Фоновый наблюдатель статусов сделок.
// Проблема: автосообщения этапов «Отправка товара» ({{ITEM_SENT}}) и
// «Подтверждение товара» ({{DEAL_CONFIRMED}}) триггерятся только при изменении
// последнего сообщения чата. Если продавец отмечает выполнение/подтверждает
// сделку НАПРЯМУЮ на playerok.com (без нового сообщения в чате), смена статуса
// не детектится и текст этапа не отправляется.
//
// Решение: периодически опрашиваем сделки в статусах PAID/SENT (type OUT).
// Когда сделка переходит в новый статус (PAID→SENT) или исчезает из набора
// (завершена/подтверждена), дёргаем /api/playerok/deal-chat-messages в режиме
// automessagesOnly — он прогоняет ТОЛЬКО автосообщения этапов (идемпотентно,
// по маркеру в истории чата) и НЕ вызывает повторную автовыдачу/публикацию.
// ---------------------------------------------------------------------------

const ACTIVE_STATUSES = ['PAID', 'SENT']
const MAX_PAGES = 20

function setupDealStatusWatchBackgroundJob({
  getAllStoredTokens,
  loadStoredTokenPlain,
  getUserAgent,
  getViewer,
  requestDealsPage,
  triggerChatAutomation,
  isAllActionsStopped = () => false,
  intervalMs = 6000,
}) {
  if (typeof requestDealsPage !== 'function' || typeof getViewer !== 'function') {
    console.warn('[deal-status-watch] отключён: нет requestDealsPage/getViewer')
    return
  }
  if (typeof triggerChatAutomation !== 'function') {
    console.warn('[deal-status-watch] отключён: нет triggerChatAutomation')
    return
  }

  // userId -> Map(dealId -> { status, chatId, itemId })
  const lastByUser = new Map()
  const inFlightByUser = new Set()

  async function fetchActiveDeals(token, ua) {
    const viewer = await getViewer(token, ua)
    if (!viewer || viewer.id == null) return []
    const out = []
    let after = null
    let pages = 0
    do {
      const page = await requestDealsPage(token, ua, viewer.id, after, ACTIVE_STATUSES, 'OUT')
      if (Array.isArray(page?.deals)) out.push(...page.deals)
      after = page?.hasNextPage ? page.endCursor || null : null
      pages += 1
    } while (after && pages < MAX_PAGES)
    return out
  }

  setInterval(async () => {
    if (isAllActionsStopped()) return
    const rows = typeof getAllStoredTokens?.all === 'function' ? getAllStoredTokens.all() : null
    if (!Array.isArray(rows) || rows.length === 0) return

    for (const row of rows) {
      const userId = Number(row?.user_id)
      if (!Number.isFinite(userId) || userId <= 0) continue
      if (inFlightByUser.has(userId)) continue
      const stored = loadStoredTokenPlain(userId)
      if (!stored || !stored.token) continue

      inFlightByUser.add(userId)
      try {
        const ua = getUserAgent()
        const deals = await fetchActiveDeals(stored.token, ua)

        const prevMap = lastByUser.get(userId) || null
        const nextMap = new Map()
        const triggers = []

        for (const d of deals) {
          const dealId = d?.id != null ? String(d.id).trim() : ''
          if (!dealId) continue
          const status = String(d?.status || '').trim().toUpperCase()
          const chatId = d?.chatId != null ? String(d.chatId).trim() : ''
          const itemId = d?.itemId != null ? String(d.itemId).trim() : ''
          nextMap.set(dealId, { status, chatId, itemId })

          if (prevMap) {
            const prev = prevMap.get(dealId)
            // Смена статуса (например PAID→SENT) — этап «Отправка товара».
            if (prev && prev.status !== status && chatId) {
              triggers.push({ chatId, dealId, dealItemId: itemId || prev.itemId || null })
            }
          }
        }

        // Сделки, исчезнувшие из PAID/SENT — вероятно завершены/подтверждены
        // (этап «Подтверждение товара»). Обработчик сам проверит наличие маркера,
        // так что для отменённых сделок ничего не отправится.
        if (prevMap) {
          for (const [dealId, prev] of prevMap) {
            if (nextMap.has(dealId)) continue
            if (prev.chatId) {
              triggers.push({ chatId: prev.chatId, dealId, dealItemId: prev.itemId || null })
            }
          }
        }

        lastByUser.set(userId, nextMap)

        // На первом проходе prevMap == null — только запоминаем снимок, без триггеров,
        // чтобы не слать сообщения по уже старым сделкам при старте сервера.
        for (const t of triggers) {
          try {
            await triggerChatAutomation({
              userId,
              token: stored.token,
              userAgent: ua,
              chatId: t.chatId,
              dealId: t.dealId,
              dealItemId: t.dealItemId,
            })
          } catch (_) {
            // ignore single-trigger errors
          }
        }
      } catch (_) {
        // молча игнорируем (rate limit/сеть) — повторим на следующем тике
      } finally {
        inFlightByUser.delete(userId)
      }
    }
  }, intervalMs)
}

module.exports = { setupDealStatusWatchBackgroundJob }
