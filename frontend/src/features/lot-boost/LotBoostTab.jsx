import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  getProductKey,
  loadProductSettingsList,
  fetchBumpHistory,
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
      .catch(() => {})
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
        .catch(() => {})
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

  const getNextBumpLabel = (lot) => {
    const key = getProductKey(lot)
    const s = settingsByKey[key]
    const lastBump = lastBumpByKey[key]
    if (!s?.autobump?.enabled || !Array.isArray(s.autobump.schedule) || s.autobump.schedule.length === 0) {
      return null
    }
    const nowMins = new Date().getHours() * 60 + new Date().getMinutes()
    for (const win of s.autobump.schedule) {
      const startParts = (win.start || '00:00').toString().split(':')
      const endParts = (win.end || '23:59').toString().split(':')
      const startMins = parseInt(startParts[0], 10) * 60 + parseInt(startParts[1], 10) || 0
      const endMins = parseInt(endParts[0], 10) * 60 + parseInt(endParts[1], 10) || 0
      const inWindow = startMins <= endMins
        ? (nowMins >= startMins && nowMins < endMins)
        : (nowMins >= startMins || nowMins < endMins)
      if (!inWindow) continue
      const intervalSec = (win.intervalMinutes || 3) * 60
      const last = lastBump || 0
      const nextBumpTs = last + intervalSec
      if (now < nextBumpTs) {
        const secLeft = nextBumpTs - now
        const mins = Math.floor(secLeft / 60)
        const secs = secLeft % 60
        if (mins >= 1) return `Следующее поднятие через ${mins} мин`
        return `Следующее поднятие через ${secs} сек`
      }
      return 'Должно подняться сейчас (если не поднимается — см. консоль/логи сервера)'
    }
    const nextWin = s.autobump.schedule[0]
    return `Следующее окно: ${nextWin.start || '00:00'}–${nextWin.end || '23:59'}`
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
                  const nextBumpLabel = getNextBumpLabel(lot)
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
                        {nextBumpLabel && (
                          <p className="lot-card__next-bump">
                            {nextBumpLabel}
                          </p>
                        )}
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

