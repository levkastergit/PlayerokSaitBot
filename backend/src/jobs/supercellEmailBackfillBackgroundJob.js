'use strict'

// Фоновый бэкфилл почты Supercell (и отзыва) для СТАРЫХ чатов.
//
// ЗАЧЕМ: резолв почты Supercell срабатывает только когда фронт открывает чат
// (/api/chat-db/messages дёргает resolveBuyerSupercellEmailFromDeal). Чаты, синканутые
// ДО появления этого резолва, остаются с buyer_supercell_email = NULL до тех пор, пока
// оператор вручную не откроет/не нажмёт «Перепроверка» на каждом из них. Это и есть
// «старые чаты с почтой/отзывом не чинятся сами». Диагностика подтвердила: сама функция
// резолва работает (deal.obtainingFields содержит почту, извлекается за ~0.4с) — не хватало
// именно ПРОАКТИВНОГО триггера. Этот job и есть триггер.
//
// КАК: медленно (по умолчанию раз в 45с), маленькими батчами, через СЕРИЙНЫЙ gate
// (requestDealById сам идёт через withPlayerokGate) и только когда circuit-breaker закрыт —
// чтобы не усиливать 429-шторм. Один запрос сделки на кандидата → достаём И почту, И отзыв.
// Заполненные навсегда выпадают из выборки (SQL фильтрует по пустой почте). Кандидаты, где
// почты реально нет, держим в in-memory «attempted» с TTL, чтобы не дёргать их каждый тик.

const { registerJob, markTickStart, markTickEnd } = require('../infra/jobsRegistry')
const { runWithPlayerokUser } = require('../infra/playerokRequestContext')
const { isOutboundCircuitOpen } = require('../infra/playerokOutboundIp')
const { startAdaptiveLoop } = require('../infra/adaptiveLoop')
const { getSpeed } = require('../infra/playerokSpeedSettings')
const { getSupercellGameByCategory } = require('../functions/supercellHelpers')
const { extractSupercellEmailFromDealObject } = require('../functions/resolveBuyerSupercellEmailFromDeal')
const { extractTestimonialFromDeal } = require('../functions/dealReviewHelpers')

const JOB_ID = 'supercell-email-backfill'

function setupSupercellEmailBackfillBackgroundJob({
  getAllStoredTokens,
  loadStoredTokenPlain,
  getUserAgent,
  chatDbRepo,
  requestDealById,
  isAllActionsStopped = () => false,
  intervalMs = 45000,
  // Сколько кандидатов выбираем из БД и сколько максимум обрабатываем за один тик.
  candidateLimit = 30,
  perTick = 3,
  // Как долго не трогать кандидата, у которого почта так и не нашлась (мс).
  attemptedTtlMs = 6 * 60 * 60 * 1000,
}) {
  if (!chatDbRepo || typeof chatDbRepo.listDealsMissingSupercellEmail?.all !== 'function') {
    // Репозиторий без нужного запроса — job не поднимаем (старый билд БД).
    return
  }

  registerJob({
    id: JOB_ID,
    label: 'Бэкфилл почты Supercell',
    description: 'Дотягивает почту Supercell и отзыв для старых чатов (без открытия вручную)',
    intervalMs,
  })

  // dealId -> ts последней попытки (для кандидатов без почты, чтобы не дёргать каждый тик).
  const attemptedAt = new Map()
  let tickInFlight = false

  function pruneAttempted(now) {
    if (attemptedAt.size < 5000) return
    for (const [id, ts] of attemptedAt) {
      if (now - ts > attemptedTtlMs) attemptedAt.delete(id)
    }
  }

  async function processOne(userId, token, ua, deal) {
    const dealId = deal?.deal_id ? String(deal.deal_id) : ''
    const category = deal?.category != null ? String(deal.category) : ''
    if (!dealId) return
    let fullDeal = null
    try {
      fullDeal = await requestDealById(token, ua, dealId)
    } catch (_) {
      return // сетевая ошибка/429 — попробуем в другой раз (attempted уже помечен)
    }
    if (!fullDeal || typeof fullDeal !== 'object') return

    // Почта Supercell.
    try {
      const email = extractSupercellEmailFromDealObject(fullDeal, category || undefined)
      if (email) {
        chatDbRepo.setDealSupercellEmail(userId, dealId, String(email).trim())
      }
    } catch (_) {}

    // Отзыв — заодно (тот же запрос сделки). Персистим всегда (в т.ч. «отзыва ещё нет»,
    // чтобы зафиксировать checked_at и не дёргать сеть на каждом открытии чата).
    try {
      if (typeof chatDbRepo.setDealTestimonial === 'function') {
        const t = extractTestimonialFromDeal(fullDeal)
        chatDbRepo.setDealTestimonial(userId, dealId, {
          status: t.status,
          rating: t.rating,
          left: t.left,
          checkedAt: Date.now(),
          createdAt: t.createdAt || null,
        })
      }
    } catch (_) {}
  }

  startAdaptiveLoop({ jobId: JOB_ID, getIntervalMs: () => getSpeed('supercellBackfillIntervalMs'), minMs: 5000 }, async () => {
    if (isAllActionsStopped()) return
    if (isOutboundCircuitOpen()) return
    if (tickInFlight) return
    const rows = getAllStoredTokens.all()
    if (!Array.isArray(rows) || rows.length === 0) return

    tickInFlight = true
    const now = Date.now()
    pruneAttempted(now)
    markTickStart(JOB_ID)
    let tickError = null
    try {
      for (const row of rows) {
        const userId = Number(row?.user_id)
        if (!Number.isFinite(userId) || userId <= 0) continue

        await runWithPlayerokUser(userId, async () => {
          const stored = loadStoredTokenPlain(userId)
          if (!stored || !stored.token) return
          const ua = typeof getUserAgent === 'function' ? getUserAgent() : null

          let candidates = []
          try {
            candidates = chatDbRepo.listDealsMissingSupercellEmail.all(userId, candidateLimit) || []
          } catch (_) {
            return
          }

          let processed = 0
          for (const deal of candidates) {
            if (processed >= perTick) break
            const dealId = deal?.deal_id ? String(deal.deal_id) : ''
            if (!dealId) continue
            // Только Supercell-категории (в SQL это не выразить).
            if (!getSupercellGameByCategory(deal?.category || null)) continue
            // Не дёргаем кандидата, которого недавно уже пробовали (почты у него нет).
            const lastTry = attemptedAt.get(dealId)
            if (lastTry && now - lastTry < attemptedTtlMs) continue

            attemptedAt.set(dealId, now)
            processed += 1
            await processOne(userId, stored.token, ua, deal)
          }
        })
      }
    } catch (err) {
      tickError = err
    } finally {
      tickInFlight = false
      markTickEnd(JOB_ID, tickError)
    }
  })
}

module.exports = { setupSupercellEmailBackfillBackgroundJob }
