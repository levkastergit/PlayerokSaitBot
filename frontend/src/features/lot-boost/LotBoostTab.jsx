import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  getProductKey,
  loadProductSettingsList,
  fetchBumpHistory,
  recordBump,
} from '../../services/playerokApi'

export function LotBoostTab({
  token,
  lots = [],
  completedLots = [],
  loadingLots = false,
  errorLots = null,
}) {
  const navigate = useNavigate()
  const [settingsList, setSettingsList] = useState([])
  const [bumpHistory, setBumpHistory] = useState([])
  const [bumpInFlightKey, setBumpInFlightKey] = useState(null)
  const [bumpCooldownUntilByKey, setBumpCooldownUntilByKey] = useState({})

  const hasToken = Boolean(token)

  const allLots = useMemo(
    () => [...lots, ...completedLots],
    [lots, completedLots]
  )

  useEffect(() => {
    if (!token) {
      setSettingsList([])
      setBumpHistory([])
      return
    }
    let cancelled = false
    loadProductSettingsList(token)
      .then((data) => {
        if (!cancelled) setSettingsList(data.list || [])
      })
      .catch(() => { })
    return () => {
      cancelled = true
    }
  }, [token])

  useEffect(() => {
    if (!token) return
    let cancelled = false
    const load = () => {
      fetchBumpHistory(token)
        .then((data) => {
          if (!cancelled) setBumpHistory(data.list || [])
        })
        .catch(() => { })
    }
    load()
    const interval = setInterval(load, 30 * 1000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [token])

  const settingsByKey = useMemo(() => {
    const map = {}
    settingsList.forEach(({ productKey, settings }) => {
      if (productKey && settings) map[productKey] = settings
    })
    return map
  }, [settingsList])

  const filteredLots = useMemo(() => {
    return allLots.filter((lot) => {
      const key = getProductKey(lot)
      const s = settingsByKey[key]
      return Boolean(s?.autobump?.enabled)
    })
  }, [allLots, settingsByKey])

  const lastBumpByKey = useMemo(() => {
    const map = {}
    bumpHistory.forEach((item) => {
      const key = item.productKey || item.productTitle
      if (!map[key] || item.bumpedAt > map[key]) {
        map[key] = item.bumpedAt
      }
    })
    return map
  }, [bumpHistory])

  const bumpCountByKey = useMemo(() => {
    const map = {}
    bumpHistory.forEach((item) => {
      const key = item.productKey || item.productTitle
      map[key] = (map[key] || 0) + 1
    })
    return map
  }, [bumpHistory])

  const bumpCountByItemId = useMemo(() => {
    const map = {}
    bumpHistory.forEach((item) => {
      if (!item.itemId) return
      const id = String(item.itemId)
      map[id] = (map[id] || 0) + 1
    })
    return map
  }, [bumpHistory])

  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(t)
  }, [])

  const getLastBumpForLot = (lot) => {
    const key = getProductKey(lot)
    return lastBumpByKey[key] ?? null
  }

  const formatLastBump = (ts) => {
    if (!ts) return null
    const d = new Date(ts * 1000)
    return d.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const getNextBumpInfo = (lot) => {
    const key = getProductKey(lot)
    const s = settingsByKey[key]
    const lastBump = lastBumpByKey[key] || 0
    const enabledAt = Number(s?.autobump?.enabledAt || 0)
    if (!s?.autobump?.enabled || !Array.isArray(s.autobump.schedule) || s.autobump.schedule.length === 0) {
      return null
    }
    const nowSec = now
    const nowDate = new Date(nowSec * 1000)
    const nowMins = nowDate.getHours() * 60 + nowDate.getMinutes()
    const startOfDay = new Date(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate())
    const startOfDayTs = Math.floor(startOfDay.getTime() / 1000)
    const windowsWithMeta = s.autobump.schedule.map((win) => {
      const startParts = (win.start || '00:00').toString().split(':')
      const endParts = (win.end || '23:59').toString().split(':')
      const startMins = (parseInt(startParts[0], 10) * 60 + parseInt(startParts[1], 10)) || 0
      const endMins = (parseInt(endParts[0], 10) * 60 + parseInt(endParts[1], 10)) || 0
      const inWindow = startMins <= endMins
        ? (nowMins >= startMins && nowMins < endMins)
        : (nowMins >= startMins || nowMins < endMins)
      return { win, startMins, endMins, inWindow }
    })

    const windowsContainingNow = windowsWithMeta.filter((x) => x.inWindow)
    const byPriority = [...windowsContainingNow].sort(
      (a, b) => (Number(a.win.priority) ?? 1) - (Number(b.win.priority) ?? 1)
    )
    const active = byPriority[0]
    if (!active) {
      // Сейчас не попадаем ни в одно окно — считаем ближайшее будущее окно и его старт.
      const candidates = []
      windowsWithMeta.forEach(({ win, startMins }) => {
        const isToday = startMins > nowMins
        const dayOffset = isToday ? 0 : 1
        const candidateStartTs = startOfDayTs + dayOffset * 24 * 3600 + startMins * 60
        candidates.push({ win, ts: candidateStartTs })
      })
      if (candidates.length === 0) return null
      candidates.sort((a, b) => a.ts - b.ts)
      const next = candidates[0]
      return {
        type: 'window',
        ts: next.ts,
        label: `Следующее окно: ${next.win.start || '00:00'}–${next.win.end || '23:59'}`,
      }
    }
    const { win, startMins, endMins } = active
    const intervalSec = (win.intervalMinutes || 3) * 60
    let windowStartTs = startOfDayTs + startMins * 60
    let windowEndTs = startOfDayTs + endMins * 60
    if (endMins <= startMins) windowEndTs += 24 * 3600

    let baseTs = Math.max(lastBump, enabledAt)
    if (!lastBump && !enabledAt) {
      // Нет истории и нет enabledAt — считаем от текущего момента в окне.
      if (nowSec >= windowStartTs && nowSec <= windowEndTs) {
        const candidateNext = nowSec + intervalSec
        if (candidateNext > windowEndTs) {
          const nextWin = s.autobump.schedule[0]
          return `Следующее окно: ${nextWin.start || '00:00'}–${nextWin.end || '23:59'}`
        }
        baseTs = nowSec
      } else {
        baseTs = windowStartTs
      }
    } else if (baseTs < windowStartTs) {
      baseTs = windowStartTs
    }

    const nextBumpTs = baseTs + intervalSec
    if (nextBumpTs > windowEndTs) {
      // Следующее поднятие уже выпадет на следующее окно.
      const candidates = []
      windowsWithMeta.forEach(({ win: w, startMins: sM }) => {
        const isToday = sM > nowMins
        const dayOffset = isToday ? 0 : 1
        const candidateStartTs = startOfDayTs + dayOffset * 24 * 3600 + sM * 60
        candidates.push({ win: w, ts: candidateStartTs })
      })
      if (candidates.length === 0) return null
      candidates.sort((a, b) => a.ts - b.ts)
      const next = candidates[0]
      return {
        type: 'window',
        ts: next.ts,
        label: `Следующее окно: ${next.win.start || '00:00'}–${next.win.end || '23:59'}`,
      }
    }
    if (nowSec < nextBumpTs) {
      return {
        type: 'exact',
        ts: nextBumpTs,
      }
    }
    return {
      type: 'now',
      ts: nowSec,
    }
  }

  const formatDateTime = (ts) => {
    if (!ts) return ''
    const d = new Date(ts * 1000)
    return d.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const handleBumpOnce = async (event, lot) => {
    if (event) {
      event.preventDefault()
      event.stopPropagation()
    }
    if (!token) return
    if (!lot?.id) return
    const productKey = getProductKey(lot)
    if (!productKey) return

    const cooldownUntil = bumpCooldownUntilByKey[productKey] || 0
    if (cooldownUntil && Date.now() < cooldownUntil) return

    setBumpInFlightKey(productKey)
    setBumpCooldownUntilByKey((prev) => ({
      ...prev,
      [productKey]: Date.now() + 10_000,
    }))

    try {
      const settings = settingsByKey[productKey]
      const priorityStatusId = settings?.autobump?.priorityStatusId || null
      await recordBump(token, {
        productKey,
        productTitle: lot.title || 'Товар',
        itemId: lot.id,
        price: lot.price,
        priorityStatusId,
      })

      const bumpedAt = Math.floor(Date.now() / 1000)
      setBumpHistory((prev) => [
        {
          productKey,
          productTitle: lot.title || 'Товар',
          bumpedAt,
          price: Number(lot.price) || 0,
          itemId: lot.id,
        },
        ...prev,
      ])
    } catch (e) {
      const message =
        e && e.message
          ? String(e.message)
          : 'Не удалось поднять товар'
      if (typeof window !== 'undefined' && window.alert) {
        window.alert(message)
      } else {
        console.error(message)
      }
    } finally {
      setBumpInFlightKey((prev) => (prev === productKey ? null : prev))
    }
  }

  return (
    <div className="tab-page">
      <div className="tab-page-header">
        <h1>Поднятие лотов</h1>
        <p className="tab-page-description">
          Товары с включённым автоподнятием (из активных и завершённых). Откройте лот и включите автоподнятие в настройках.
        </p>
      </div>

      <div className="tab-grid">
        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <h2 className="card-title">Товары с автоподнятием</h2>

          {!hasToken && (
            <p className="card-text">
              Чтобы увидеть список, сначала укажите токен во вкладке «Токен».
            </p>
          )}

          {hasToken && loadingLots && (
            <p className="card-text">Загружаем лоты с Playerok…</p>
          )}

          {hasToken && !loadingLots && errorLots && (
            <p className="card-text card-text--error">
              Ошибка при загрузке лотов: {errorLots}
            </p>
          )}

          {hasToken && !loadingLots && !errorLots && filteredLots.length === 0 && (
            <p className="card-text">
              Пока нет лотов с включённым автоподнятием. Откройте лот во вкладке «Активные» или «Завершенные» и включите автоподнятие в настройках товара.
            </p>
          )}

          {hasToken && !loadingLots && !errorLots && filteredLots.length > 0 && (
            <>
              <p className="card-text active-lots-total">
                Лотов с автоподнятием: <strong>{filteredLots.length}</strong>
              </p>
              <div className="lots-grid">
                {filteredLots.map((lot) => {
                  const lastBump = getLastBumpForLot(lot)
                  const productKey = getProductKey(lot)
                  const nextBumpInfo = getNextBumpInfo(lot)
                  const bumpCountTotal = bumpCountByKey[productKey] || 0
                  const bumpCountForLot = bumpCountByItemId[String(lot.id)] || 0
                  const cooldownUntil = bumpCooldownUntilByKey[productKey] || 0
                  const remainingSec =
                    cooldownUntil && Date.now() < cooldownUntil
                      ? Math.max(
                          1,
                          Math.ceil((cooldownUntil - Date.now()) / 1000)
                        )
                      : 0
                  const bumpDisabled =
                    bumpInFlightKey === productKey || remainingSec > 0

                  let nextTitle = null
                  let nextValue = null
                  if (nextBumpInfo) {
                    if (nextBumpInfo.type === 'exact') {
                      nextTitle = 'Следующее поднятие'
                      nextValue = formatDateTime(nextBumpInfo.ts)
                    } else if (nextBumpInfo.type === 'window') {
                      nextTitle = nextBumpInfo.label
                      nextValue = `Начало: ${formatDateTime(nextBumpInfo.ts)}`
                    } else if (nextBumpInfo.type === 'now') {
                      nextTitle = 'Следующее поднятие'
                      nextValue =
                        'Должно подняться сейчас (если не поднимается — см. консоль/логи сервера)'
                    }
                  }
                  return (
                    <article
                      key={lot.id}
                      className="lot-card"
                      onClick={() => navigate('/lot/' + lot.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          navigate('/lot/' + lot.id)
                        }
                      }}
                    >
                      <div className="lot-card__image-wrap">
                        {lot.imageUrl ? (
                          <img
                            src={lot.imageUrl}
                            alt=""
                            className="lot-card__image"
                            loading="lazy"
                          />
                        ) : (
                          <div
                            className="lot-card__image-placeholder"
                            aria-hidden="true"
                          >
                            Нет фото
                          </div>
                        )}
                      </div>
                      <div className="lot-card__body">
                        <p className="lot-card__price-row">
                          <span className="lot-card__price">
                            {Number(lot.price || 0).toLocaleString('ru-RU')}{' '}
                            {lot.currency || '₽'}
                          </span>
                        </p>
                        <h3 className="lot-card__title" title={lot.title}>
                          {lot.title}
                        </h3>
                        {lot.game && (
                          <p className="lot-card__tags">
                            {lot.game}
                          </p>
                        )}
                        <p className="lot-card__last-bump">
                          {lastBump ? (
                            <>Последнее поднятие: {formatLastBump(lastBump)}</>
                          ) : (
                            <span className="lot-card__last-bump--none">Ещё не поднимался</span>
                          )}
                        </p>
                        {nextTitle && nextValue && (
                          <p className="lot-card__next-bump">
                            <span>{nextTitle}</span>
                            <br />
                            <span className="lot-card__next-bump-date">{nextValue}</span>
                          </p>
                        )}
                        <p className="lot-card__next-bump">
                          Всего поднятий по товару: <strong>{bumpCountTotal}</strong>
                        </p>
                        <p className="lot-card__next-bump">
                          Поднятий этого лота: <strong>{bumpCountForLot}</strong>
                        </p>
                        <button
                          type="button"
                          className="lot-settings-btn lot-settings-btn--secondary"
                          onClick={(e) => handleBumpOnce(e, lot)}
                          disabled={bumpDisabled}
                          title={
                            bumpDisabled
                              ? 'Подождите перед повторным поднятием'
                              : 'Поднять товар 1 раз'
                          }
                        >
                          {bumpInFlightKey === productKey
                            ? 'Поднимаем…'
                            : remainingSec
                              ? `Поднять товар (${remainingSec}с)`
                              : 'Поднять товар'}
                        </button>
                      </div>
                    </article>
                  )
                })}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  )
}

