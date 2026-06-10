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

const { registerJob, markTickStart, markTickEnd, setJobDetails } = require('../infra/jobsRegistry')
const { runWithPlayerokUser } = require('../infra/playerokRequestContext')
const {
  autolistGetSupercellFlowMap,
  autolistGetTopupFlowMap,
  autolistGetClodeFlowMap,
  autolistGetGptFlowMap,
} = require('../features/autolist/autolistState')

const JOB_ID = 'deal-status-watch'

const ACTIVE_STATUSES = ['PAID', 'SENT']
const MAX_PAGES = 20
// Потолок числа сделок/флоу в снимке для интерфейса. Полный счётчик считается
// отдельно (dealsTotal/dealsByStatus) и остаётся честным даже при обрезке списка.
const DEAL_DETAILS_CAP = 300

// Активные флоу автовыдачи (по чату) — что именно сейчас «зависло в ожидании»:
// почта Supercell, ссылка/доступ GPT/Clode, пополнение Approute и т.д.
function collectActiveFlows(token, nowTsSec) {
  const sources = [
    ['supercell', autolistGetSupercellFlowMap],
    ['topup', autolistGetTopupFlowMap],
    ['clode', autolistGetClodeFlowMap],
    ['gpt', autolistGetGptFlowMap],
  ]
  const out = []
  for (const [kind, getter] of sources) {
    let map = null
    try {
      map = getter(token)
    } catch (_) {
      map = null
    }
    if (!map || typeof map !== 'object') continue
    for (const [chatId, state] of Object.entries(map)) {
      if (!state || typeof state !== 'object' || !state.active) continue
      const updatedAt = Number(state.updatedAt || state.createdAt || 0)
      out.push({
        kind,
        chatId: String(chatId),
        dealId: state.dealId != null ? String(state.dealId) : null,
        stage: state.stage != null ? String(state.stage) : null,
        email: state.email != null ? String(state.email) : (state.latestEmail != null ? String(state.latestEmail) : null),
        ageSec: updatedAt ? Math.max(0, nowTsSec - updatedAt) : null,
      })
    }
  }
  return out
}

function setupDealStatusWatchBackgroundJob({
  getAllStoredTokens,
  loadStoredTokenPlain,
  getUserAgent,
  getViewer,
  requestDealsPage,
  triggerChatAutomation,
  // Локальная БД чатов — чтобы достать chat_id по deal_id, когда страница продаж
  // его не вернула (нужно для кнопки «Перейти в чат» в интерфейсе наблюдателя).
  chatDbRepo = null,
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

  registerJob({
    id: JOB_ID,
    label: 'Наблюдатель сделок',
    description: 'Следит за сменой статусов сделок и шлёт автосообщения этапов',
    intervalMs,
  })

  // userId -> Map(dealId -> { status, chatId, itemId })
  const lastByUser = new Map()
  const inFlightByUser = new Set()
  // Общий флаг тика: не даём проходам наложиться (тик может длиться дольше 6 с),
  // иначе портится учёт тиков (totalRuns/lastTickStartAt/inFlight) в реестре.
  let tickInFlight = false

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
    if (tickInFlight) return

    tickInFlight = true
    markTickStart(JOB_ID)
    let tickError = null
    const nowTsSec = Math.floor(Date.now() / 1000)
    const allDeals = []
    const allFlows = []
    try {
    for (const row of rows) {
      const userId = Number(row?.user_id)
      if (!Number.isFinite(userId) || userId <= 0) continue
      if (inFlightByUser.has(userId)) continue
      const stored = loadStoredTokenPlain(userId)
      if (!stored || !stored.token) continue

      inFlightByUser.add(userId)
      // Все исходящие запросы Playerok этого пользователя — в его контексте,
      // иначе resolveOutboundLocalAddress не увидит userId и привязки/ротация IP
      // не применятся (запросы уйдут с env-фолбэка PLAYEROK_OUTBOUND_IP).
      await runWithPlayerokUser(userId, async () => {
      try {
        const ua = getUserAgent()
        const deals = await fetchActiveDeals(stored.token, ua)

        for (const d of deals) {
          const dealId = d?.id != null ? String(d.id).trim() : ''
          if (!dealId) continue
          // Страница продаж часто не отдаёт chatId — добираем его из локальной БД
          // чатов по deal_id, чтобы кнопка «Перейти в чат» работала.
          let resolvedChatId = d?.chatId != null ? String(d.chatId).trim() : null
          if (!resolvedChatId && chatDbRepo && typeof chatDbRepo.getDealById?.get === 'function') {
            try {
              const row = chatDbRepo.getDealById.get(userId, dealId)
              if (row && row.chat_id) resolvedChatId = String(row.chat_id).trim() || null
            } catch (_) {
              // ignore lookup errors
            }
          }
          allDeals.push({
            dealId,
            status: String(d?.status || '').trim().toUpperCase(),
            chatId: resolvedChatId,
            itemId: d?.itemId != null ? String(d.itemId).trim() : null,
            title: d?.productTitle != null ? String(d.productTitle) : null,
            category: d?.category != null ? String(d.category) : null,
            price: Number(d?.price) || 0,
            buyerName: d?.buyerName != null ? String(d.buyerName) : null,
            soldAt: Number(d?.soldAt) || null,
          })
        }
        allFlows.push(...collectActiveFlows(stored.token, nowTsSec))

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
      })
    }

    // Честные счётчики по всем сделкам (не по обрезанному снимку).
    const dealsByStatus = {}
    for (const d of allDeals) {
      const st = d.status || 'OTHER'
      dealsByStatus[st] = (dealsByStatus[st] || 0) + 1
    }
    setJobDetails(JOB_ID, {
      updatedAt: nowTsSec,
      deals: allDeals.slice(0, DEAL_DETAILS_CAP),
      dealsTotal: allDeals.length,
      dealsByStatus,
      dealsCapped: allDeals.length > DEAL_DETAILS_CAP,
      flows: allFlows.slice(0, DEAL_DETAILS_CAP),
      flowsTotal: allFlows.length,
    })
    } catch (err) {
      tickError = err
    } finally {
      tickInFlight = false
      markTickEnd(JOB_ID, tickError)
    }
  }, intervalMs)
}

module.exports = { setupDealStatusWatchBackgroundJob }
