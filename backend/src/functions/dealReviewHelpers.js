'use strict'

// Помощники по отзыву покупателя (testimonial) на сделке Playerok.
// Вынесены из dispatchChatDb в общий модуль, чтобы их мог переиспользовать фоновый
// бэкфилл (supercellEmailBackfillBackgroundJob) — старые чаты дотягивают отзыв сами,
// без ручного открытия/перепроверки.

// Как часто перепроверять «отзыва ещё нет» сетью (фоновая сверка троттлится этим окном).
const REVIEW_RECHECK_MS = 30 * 1000

function extractTestimonialFromDeal(deal) {
  const t = deal && typeof deal === 'object' ? deal.testimonial : null
  if (t == null || typeof t !== 'object') {
    return { left: false, rating: null, status: null }
  }
  const ratingRaw = Number(t.rating)
  return {
    left: true,
    rating: Number.isFinite(ratingRaw) ? Math.trunc(ratingRaw) : null,
    status: t.status != null ? String(t.status) : null,
    createdAt: t.createdAt != null ? String(t.createdAt) : (t.updatedAt != null ? String(t.updatedAt) : null),
  }
}

function reviewFromDealRow(dealRow) {
  if (!dealRow || dealRow.testimonial_left == null) return null
  return {
    left: Number(dealRow.testimonial_left) === 1,
    rating:
      dealRow.testimonial_rating != null && Number.isFinite(Number(dealRow.testimonial_rating))
        ? Math.trunc(Number(dealRow.testimonial_rating))
        : null,
    createdAt: dealRow.testimonial_created_at != null ? String(dealRow.testimonial_created_at) : null,
  }
}

// Возвращает {left, rating} для сделки. Берёт из БД, иначе тянет deal с Playerok и сохраняет.
async function resolveDealReview({ chatDbRepo, requestDealById, token, userAgent, userId, dealId, cachedOnly = false }) {
  const id = dealId != null ? String(dealId).trim() : ''
  if (!id) return null
  const row = chatDbRepo.getDealById.get(userId, id)
  const stored = reviewFromDealRow(row)
  const checkedAt = Number(row?.testimonial_checked_at || 0)
  // Отзыв уже оставлен и дата известна — он не изменится; сеть не дёргаем.
  if (stored?.left && stored.createdAt) return stored
  // Недавно проверяли «нет отзыва» — отдаём кеш из БД.
  if (!stored?.left && stored && Date.now() - checkedAt < REVIEW_RECHECK_MS) return stored
  // Быстрый путь открытия чата — сеть за отзывом не дёргаем, отдаём, что есть в БД.
  if (cachedOnly) return stored
  if (typeof requestDealById !== 'function' || !token) return stored
  try {
    const deal = await requestDealById(token, userAgent, id)
    const t = extractTestimonialFromDeal(deal)
    chatDbRepo.setDealTestimonial(userId, id, {
      status: t.status,
      rating: t.rating,
      left: t.left,
      checkedAt: Date.now(),
      createdAt: t.createdAt || null,
    })
    return { left: t.left, rating: t.rating, createdAt: t.createdAt || null }
  } catch (_) {
    return stored
  }
}

module.exports = {
  REVIEW_RECHECK_MS,
  extractTestimonialFromDeal,
  reviewFromDealRow,
  resolveDealReview,
}
