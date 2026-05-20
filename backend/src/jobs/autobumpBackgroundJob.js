const { runWithPlayerokUser } = require('../infra/playerokRequestContext')

function setupAutobumpBackgroundJob({
  getStoredToken,
  getAllSettings,
  getBumpHistory,
  getSalesHistoryAll,
  fetchActiveItemsFromPlayerok,
  buildProductKey,
  postLocal,
  getDefaultUserAgent,
  intervalMs = 15000,
}) {
  // Автоподнятие: раз в 15 сек проверяем для каждого товара «пора ли поднять» по его расписанию.
  // Отдельный таймер на каждый товар не делаем — один общий цикл проще и надёжнее при перезапуске процесса.
  const autobumpLastAttemptByKey = {}
  let autobumpViewerBackoffUntil = 0
  let autobumpViewerFailStreak = 0
  let autobumpLastErrorLogTs = 0
  console.log('[autobump] фоновое задание запланировано (интервал: 15 с)')

  setInterval(async () => {
    try {
      if (Date.now() < autobumpViewerBackoffUntil) {
        return
      }
      // Пока фоновое автоподнятие работает только для базового пользователя id=1
      const userId = 1
      await runWithPlayerokUser(userId, async () => {
      const row = getStoredToken.get(userId)
      if (!row || !row.token) return
      const token = row.token
      const userAgent = getDefaultUserAgent()
      const tokenHash = token

      const [settingsRows, bumpRows, salesRows, activeResult] = await Promise.all([
        Promise.resolve(getAllSettings.all(userId)),
        Promise.resolve(getBumpHistory.all(userId)),
        Promise.resolve(getSalesHistoryAll.all(userId)),
        fetchActiveItemsFromPlayerok(token, userAgent),
      ])

      autobumpViewerFailStreak = 0
      autobumpViewerBackoffUntil = 0

      const settingsByKey = {}
      for (const r of settingsRows || []) {
        if (r.product_key && r.settings) {
          try {
            settingsByKey[r.product_key] = JSON.parse(r.settings)
          } catch (_) {}
        }
      }

      const lastBumpByKey = {}
      for (const r of bumpRows || []) {
        const k = r.product_key || r.product_title
        if (!k) continue
        const t = r.bumped_at || 0
        if (!lastBumpByKey[k] || t > lastBumpByKey[k]) lastBumpByKey[k] = t
      }

      // Последняя продажа по товару (без возвратов): сбрасывает «интервал» — следующее поднятие = sold_at + interval.
      const lastSaleByKey = {}
      for (const r of salesRows || []) {
        if (r.is_refund) continue
        const k = r.product_key || r.product_title
        if (!k) continue
        const t = r.sold_at || 0
        if (!lastSaleByKey[k] || t > lastSaleByKey[k]) lastSaleByKey[k] = t
      }

      const items = activeResult.items || []
      const activeLotByKey = {}
      for (const lot of items) {
        const st = String(lot?.status || '').toUpperCase()
        if (st && st !== 'APPROVED' && st !== 'ACTIVE' && st !== 'PUBLISHED') continue
        const key = buildProductKey(lot.game || '', lot.title || '')
        if (!activeLotByKey[key]) activeLotByKey[key] = lot
      }

      // Вся логика автоподнятия работает в часовом поясе МСК (Europe/Moscow),
      // независимо от локального часового пояса сервера.
      const MSK_OFFSET_MINUTES = 3 * 60
      const MSK_OFFSET_MS = MSK_OFFSET_MINUTES * 60 * 1000
      const nowUtcMs = Date.now()
      const nowMsk = new Date(nowUtcMs + MSK_OFFSET_MS)
      const nowMins = nowMsk.getUTCHours() * 60 + nowMsk.getUTCMinutes()
      const nowTs = Math.floor(nowUtcMs / 1000)
      const mskStartOfDayUtcMs = Date.UTC(
        nowMsk.getUTCFullYear(),
        nowMsk.getUTCMonth(),
        nowMsk.getUTCDate()
      ) - MSK_OFFSET_MS
      const startOfDayTs = Math.floor(mskStartOfDayUtcMs / 1000)

      for (const [key, s] of Object.entries(settingsByKey)) {
        if (String(key).startsWith('__group__::')) continue
        if (!s?.autobump?.enabled || !Array.isArray(s.autobump.schedule) || s.autobump.schedule.length === 0) {
          continue
        }

        const lot = activeLotByKey[key]
        if (!lot) continue

        const schedule = s.autobump.schedule || []
        const windowsContainingNow = schedule
          .map((win) => {
            const startParts = (win.start || '00:00').toString().split(':')
            const endParts = (win.end || '23:59').toString().split(':')
            const startMins =
              parseInt(startParts[0], 10) * 60 + parseInt(startParts[1], 10) || 0
            const endMins = parseInt(endParts[0], 10) * 60 + parseInt(endParts[1], 10) || 0
            const inWindow = startMins <= endMins
              ? nowMins >= startMins && nowMins < endMins
              : nowMins >= startMins || nowMins < endMins
            return inWindow ? { win, startMins, endMins } : null
          })
          .filter(Boolean)

        const byPriority = windowsContainingNow.sort(
          (a, b) => (Number(a.win.priority) ?? 1) - (Number(b.win.priority) ?? 1)
        )
        const active = byPriority[0]
        if (!active) continue

        const { win } = active
        const startMins = active.startMins
        const endMins = active.endMins
        const intervalSec = (win.intervalMinutes || 3) * 60
        let windowStartTs = startOfDayTs + startMins * 60
        let windowEndTs = startOfDayTs + endMins * 60
        if (endMins <= startMins) windowEndTs += 24 * 3600

        const lastBump = lastBumpByKey[key] || 0
        const lastSale = lastSaleByKey[key] || 0
        const enabledAt = Number(s?.autobump?.enabledAt || 0)
        let baseTs = Math.max(lastBump, lastSale, enabledAt)

        if (!lastBump && !lastSale && !enabledAt) {
          // Новый товар без истории и без явного enabledAt:
          // - если сейчас внутри окна, считаем первое поднятие от «сейчас» + интервал
          // - если сейчас вне окна, просто используем логику «от начала окна»
          if (nowTs >= windowStartTs && nowTs <= windowEndTs) {
            const candidateNext = nowTs + intervalSec
            if (candidateNext > windowEndTs) continue
            baseTs = nowTs
          } else {
            if (baseTs < windowStartTs) baseTs = windowStartTs
          }
        } else {
          if (baseTs < windowStartTs) baseTs = windowStartTs
        }

        const nextBumpTs = baseTs + intervalSec

        if (nextBumpTs > windowEndTs) continue
        if (nowTs < nextBumpTs) continue

        const lastAttempt = autobumpLastAttemptByKey[key] || 0
        if (nowTs - lastAttempt < 60) continue
        autobumpLastAttemptByKey[key] = nowTs

        // НЕ передаем priorityStatusId из настроек - endpoint /api/playerok/bump всегда получает актуальный список статусов
        const res = await postLocal('/api/playerok/bump', {
          token,
          userAgent,
          productKey: key,
          productTitle: lot.title || 'Товар',
          itemId: lot.id,
          price: Number(lot.price) || 0,
          // priorityStatusId не передается - всегда используется актуальный список статусов
        })

        if (res.ok && res.bumpedAt) {
          lastBumpByKey[key] = res.bumpedAt
        } else {
          console.warn('[autobump-tick] поднятие не удалось', { key, res })
        }
      }
      })
    } catch (err) {
      // Обработка ошибок Redis OOM и других
      const errMsg = err?.message || String(err || '')
      if (errMsg.includes('OOM') || errMsg.includes('maxmemory')) {
        console.warn('[autobump-tick] Redis OOM — пропуск этого тика', { error: errMsg })
        return
      }

      const statusCode = Number(err?.statusCode)
      const isViewerUpstream =
        errMsg.includes('Playerok viewer:') ||
        (Number.isFinite(statusCode) && statusCode >= 500 && statusCode < 600)

      if (isViewerUpstream) {
        autobumpViewerFailStreak += 1
        const backoffSec = Math.min(
          300,
          30 * 2 ** Math.min(autobumpViewerFailStreak - 1, 4)
        )
        autobumpViewerBackoffUntil = Date.now() + backoffSec * 1000
        const now = Date.now()
        if (now - autobumpLastErrorLogTs > 120000) {
          autobumpLastErrorLogTs = now
          console.warn(
            '[autobump-tick] Playerok viewer недоступен (5xx/сеть). Пауза',
            { backoffSec, message: errMsg.slice(0, 280) }
          )
        }
        return
      }

      console.error('[autobump-tick] ошибка', err)
    }
  }, intervalMs)
}

module.exports = { setupAutobumpBackgroundJob }

