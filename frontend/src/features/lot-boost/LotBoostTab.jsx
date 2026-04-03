import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  getProductKey,
  loadProductSettingsList,
  fetchBumpHistory,
  recordBump,
  fetchSalesHistory,
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
  const [salesHistory, setSalesHistory] = useState([])
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
      setSalesHistory([])
      return
    }
    let cancelled = false
    const load = () => {
      loadProductSettingsList(token)
        .then((data) => {
          if (!cancelled) setSettingsList(data.list || [])
        })
        .catch((err) => {
          console.error('Ошибка загрузки настроек:', err)
        })
    }
    load()
    const interval = setInterval(load, 30 * 1000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [token])

  // Обновляем настройки при изменении списка лотов (если лоты загрузились после открытия страницы)
  useEffect(() => {
    if (!token || !allLots.length) return
    let cancelled = false
    loadProductSettingsList(token)
      .then((data) => {
        if (!cancelled) setSettingsList(data.list || [])
      })
      .catch((err) => {
        console.error('Ошибка загрузки настроек:', err)
      })
    return () => {
      cancelled = true
    }
  }, [token, allLots.length])

  // Перезагружаем историю поднятий после загрузки лотов, чтобы синхронизировать данные
  useEffect(() => {
    if (!token || !allLots.length) return
    let cancelled = false
    fetchBumpHistory(token)
      .then((data) => {
        if (!cancelled) setBumpHistory(data.list || [])
      })
      .catch((err) => {
        console.error('[LotBoostTab] Ошибка перезагрузки истории после загрузки лотов:', err)
      })
    return () => {
      cancelled = true
    }
  }, [token, allLots.length])

  useEffect(() => {
    if (!token) return
    let cancelled = false
    const load = () => {
      fetchBumpHistory(token)
        .then((data) => {
          if (!cancelled) setBumpHistory(data.list || [])
        })
        .catch((err) => {
          console.error('[LotBoostTab] Ошибка загрузки истории поднятий:', err)
        })
    }
    load()
    const interval = setInterval(load, 10 * 1000) // Обновляем каждые 10 секунд для быстрого отображения
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [token])

  useEffect(() => {
    if (!token) return
    let cancelled = false
    const load = () => {
      fetchSalesHistory(token)
        .then((data) => {
          if (!cancelled) setSalesHistory(data.list || [])
        })
        .catch((err) => {
          console.error('[LotBoostTab] Ошибка загрузки истории продаж:', err)
        })
    }
    load()
    const interval = setInterval(load, 30 * 1000) // Обновляем каждые 30 секунд
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [token])

  const settingsByKey = useMemo(() => {
    const map = {}
    settingsList.forEach(({ productKey, settings }) => {
      if (productKey && settings) {
        map[productKey] = settings
      }
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
      // Используем productKey из истории, если он есть, иначе пытаемся найти лот по itemId
      const key = item.productKey || item.productTitle
      if (key && (!map[key] || item.bumpedAt > map[key])) {
        map[key] = item.bumpedAt
      }
      // Также добавляем по itemId для обратной совместимости
      if (item.itemId) {
        const lot = allLots.find((l) => String(l.id) === String(item.itemId))
        if (lot) {
          const lotKey = getProductKey(lot)
          if (lotKey && (!map[lotKey] || item.bumpedAt > map[lotKey])) {
            map[lotKey] = item.bumpedAt
          }
        }
      }
    })
    return map
  }, [bumpHistory, allLots])

  const bumpCountByKey = useMemo(() => {
    const map = {}
    bumpHistory.forEach((item) => {
      // Сначала пытаемся найти лот по itemId и использовать его ключ
      if (item.itemId) {
        const lot = allLots.find((l) => String(l.id) === String(item.itemId))
        if (lot) {
          const lotKey = getProductKey(lot)
          if (lotKey) {
            map[lotKey] = (map[lotKey] || 0) + 1
            // Если ключ из истории совпадает с ключом лота, не дублируем
            const historyKey = item.productKey || item.productTitle
            if (historyKey && historyKey !== lotKey) {
              // Ключи разные - добавляем оба (может быть из-за нормализации)
              map[historyKey] = (map[historyKey] || 0) + 1
            }
            return // Уже добавили, не нужно добавлять еще раз
          }
        }
      }
      // Если лот не найден или нет itemId, используем ключ из истории
      const key = item.productKey || item.productTitle
      if (key) {
        map[key] = (map[key] || 0) + 1
      }
    })
    return map
  }, [bumpHistory, allLots])

  const bumpCountByItemId = useMemo(() => {
    const map = {}
    bumpHistory.forEach((item) => {
      if (!item.itemId) return
      const id = String(item.itemId)
      map[id] = (map[id] || 0) + 1
    })
    return map
  }, [bumpHistory])

  const lastSaleByKey = useMemo(() => {
    const map = {}
    salesHistory.forEach((item) => {
      const key = item.productKey
      if (key && item.soldAt) {
        if (!map[key] || item.soldAt > map[key]) {
          map[key] = item.soldAt
        }
      }
    })
    return map
  }, [salesHistory])

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

  const formatDate = (dateValue) => {
    if (!dateValue) return null
    // Если это строка ISO, преобразуем в timestamp
    let ts = dateValue
    if (typeof dateValue === 'string') {
      const d = new Date(dateValue)
      if (!isNaN(d.getTime())) {
        ts = Math.floor(d.getTime() / 1000)
      } else {
        return null
      }
    } else if (typeof dateValue === 'number') {
      // Если это уже timestamp в миллисекундах, конвертируем в секунды
      if (dateValue > 1e12) {
        ts = Math.floor(dateValue / 1000)
      }
    }
    const d = new Date(ts * 1000)
    return d.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const formatDateWithoutYear = (dateValue) => {
    if (!dateValue) return null
    // Если это строка ISO, преобразуем в timestamp
    let ts = dateValue
    if (typeof dateValue === 'string') {
      const d = new Date(dateValue)
      if (!isNaN(d.getTime())) {
        ts = Math.floor(d.getTime() / 1000)
      } else {
        return null
      }
    } else if (typeof dateValue === 'number') {
      // Если это уже timestamp в миллисекундах, конвертируем в секунды
      if (dateValue > 1e12) {
        ts = Math.floor(dateValue / 1000)
      }
    }
    const d = new Date(ts * 1000)
    return d.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const getLastSaleForLot = (lot) => {
    const key = getProductKey(lot)
    return lastSaleByKey[key] ?? null
  }

  const getNextBumpInfo = (lot) => {
    const key = getProductKey(lot)
    const s = settingsByKey[key]
    const lastBump = lastBumpByKey[key] || 0
    const lastSale = lastSaleByKey[key] || 0
    const enabledAt = Number(s?.autobump?.enabledAt || 0)
    if (!s?.autobump?.enabled || !Array.isArray(s.autobump.schedule) || s.autobump.schedule.length === 0) {
      return null
    }
    // Используем МСК время, как на сервере (важно для правильного расчета окон)
    const MSK_OFFSET_MINUTES = 3 * 60
    const MSK_OFFSET_MS = MSK_OFFSET_MINUTES * 60 * 1000
    const nowUtcMs = Date.now()
    const nowMsk = new Date(nowUtcMs + MSK_OFFSET_MS)
    const nowMins = nowMsk.getUTCHours() * 60 + nowMsk.getUTCMinutes()
    const nowSec = Math.floor(nowUtcMs / 1000)
    const mskStartOfDayUtcMs = Date.UTC(
      nowMsk.getUTCFullYear(),
      nowMsk.getUTCMonth(),
      nowMsk.getUTCDate()
    ) - MSK_OFFSET_MS
    const startOfDayTs = Math.floor(mskStartOfDayUtcMs / 1000)
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
      // Сейчас не попадаем ни в одно окно — считаем ближайшее будущее окно и первое поднятие в нем.
      const candidates = []
      windowsWithMeta.forEach(({ win, startMins }) => {
        const isToday = startMins > nowMins
        const dayOffset = isToday ? 0 : 1
        const candidateStartTs = startOfDayTs + dayOffset * 24 * 3600 + startMins * 60
        const intervalSec = (win.intervalMinutes || 3) * 60
        // Первое поднятие в окне = начало окна + интервал
        const firstBumpTs = candidateStartTs + intervalSec
        candidates.push({ win, ts: firstBumpTs, windowStartTs: candidateStartTs })
      })
      if (candidates.length === 0) return null
      candidates.sort((a, b) => a.ts - b.ts)
      const next = candidates[0]
      return {
        type: 'exact',
        ts: next.ts,
      }
    }
    const { win, startMins, endMins } = active
    const intervalSec = (win.intervalMinutes || 3) * 60
    let windowStartTs = startOfDayTs + startMins * 60
    let windowEndTs = startOfDayTs + endMins * 60
    if (endMins <= startMins) windowEndTs += 24 * 3600

    // На сервере baseTs = Math.max(lastBump, lastSale, enabledAt)
    // На клиенте теперь тоже учитываем lastSale, чтобы расчёты совпадали
    let baseTs = Math.max(lastBump, lastSale, enabledAt)
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
        if (baseTs < windowStartTs) baseTs = windowStartTs
      }
    } else {
      if (baseTs < windowStartTs) baseTs = windowStartTs
      // Не перезаписываем baseTs текущим временем - всегда считаем от последнего поднятия
      // Если baseTs в прошлом, но мы внутри окна, следующее поднятие все равно должно быть baseTs + interval
    }

    const nextBumpTs = baseTs + intervalSec
    if (nextBumpTs > windowEndTs) {
      // Следующее поднятие уже выпадет на следующее окно.
      const candidates = []
      windowsWithMeta.forEach(({ win: w, startMins: sM }) => {
        const isToday = sM > nowMins
        const dayOffset = isToday ? 0 : 1
        const candidateStartTs = startOfDayTs + dayOffset * 24 * 3600 + sM * 60
        const intervalSecNext = (w.intervalMinutes || 3) * 60
        // Первое поднятие в следующем окне = начало окна + интервал
        const firstBumpTs = candidateStartTs + intervalSecNext
        candidates.push({ win: w, ts: firstBumpTs })
      })
      if (candidates.length === 0) return null
      candidates.sort((a, b) => a.ts - b.ts)
      const next = candidates[0]
      return {
        type: 'exact',
        ts: next.ts,
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

  const formatDateTimeWithoutYear = (ts) => {
    if (!ts) return ''
    const d = new Date(ts * 1000)
    return d.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
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
      // НЕ передаем priorityStatusId - бэкенд всегда получает актуальный список статусов
      const bumpParams = {
        productKey,
        productTitle: lot.title || 'Товар',
        itemId: lot.id,
        price: lot.price,
        // priorityStatusId не передается - всегда используется актуальный список статусов
      }
      await recordBump(token, bumpParams)

      // Перезагружаем историю с сервера для получения актуальных данных
      // Это гарантирует, что счетчики будут правильными
      try {
        const data = await fetchBumpHistory(token)
        setBumpHistory(data.list || [])
      } catch (err) {
        console.error('[LotBoostTab] Ошибка перезагрузки истории после поднятия:', err)
        // В случае ошибки добавляем локально для оптимистичного обновления
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
      }
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

          {hasToken && !loadingLots && !errorLots && filteredLots.length === 0 && null}

          {hasToken && !loadingLots && !errorLots && filteredLots.length > 0 && (
            <>
              <p className="card-text active-lots-total">
                Лотов с автоподнятием: <strong>{filteredLots.length}</strong>
              </p>
              <div className="lots-grid">
                {filteredLots.map((lot) => {
                  const lastBump = getLastBumpForLot(lot)
                  const productKey = getProductKey(lot)
                  const settings = settingsByKey[productKey]
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

                  const schedule = settings?.autobump?.schedule || []
                  const intervalMinutes = schedule.length > 0
                    ? schedule[0].intervalMinutes || 3
                    : 3

                  let nextTitle = null
                  let nextValue = null
                  if (nextBumpInfo) {
                    if (nextBumpInfo.type === 'exact') {
                      nextTitle = 'Следующее поднятие'
                      nextValue = formatDateTimeWithoutYear(nextBumpInfo.ts)
                    } else if (nextBumpInfo.type === 'window') {
                      nextTitle = 'Следующее поднятие'
                      nextValue = formatDateTimeWithoutYear(nextBumpInfo.ts)
                    } else if (nextBumpInfo.type === 'now') {
                      nextTitle = 'Следующее поднятие'
                      // Короткий текст в строке, детальное пояснение ниже отдельным блоком
                      nextValue = 'Сейчас'
                    }
                  }
                  return (
                    <article
                      key={lot.id}
                      className="lot-card"
                      onDoubleClick={() => navigate('/lot/' + lot.id)}
                      role="button"
                      tabIndex={0}
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
                        <div className="lot-card__bump-info">
                          {lot.createdAt && (
                            <div className="bump-info__row">
                              <span className="bump-info__icon">📅</span>
                              <span className="bump-info__label">Дата выставления:</span>
                              <span className="bump-info__value">{formatDateWithoutYear(lot.createdAt)}</span>
                            </div>
                          )}
                          <div className="bump-info__row">
                            <span className="bump-info__icon">🕐</span>
                            <span className="bump-info__label">Последнее поднятие:</span>
                            <span className="bump-info__value">
                              {lastBump ? formatLastBump(lastBump) : <span className="bump-info__value--none">Ещё не поднимался</span>}
                            </span>
                          </div>
                          {nextTitle && nextValue && (
                            <div className="bump-info__row">
                              <span className="bump-info__icon">⏭️</span>
                              <span className="bump-info__label">{nextTitle}:</span>
                              <span className="bump-info__value bump-info__value--next">{nextValue}</span>
                            </div>
                          )}
                          {(() => {
                            const lastSale = getLastSaleForLot(lot)
                            return lastSale ? (
                              <div className="bump-info__row">
                                <span className="bump-info__icon">💰</span>
                                <span className="bump-info__label">Дата последней продажи:</span>
                                <span className="bump-info__value">{formatDate(lastSale)}</span>
                              </div>
                            ) : null
                          })()}
                          {schedule.length > 0 && (
                            <>
                              <div className="bump-info__row">
                                <span className="bump-info__icon">⏰</span>
                                <span className="bump-info__label">Окна поднятия:</span>
                                <span className="bump-info__value">
                                  {schedule.map((win, idx) => (
                                    <span key={idx} className="bump-info__schedule-time">
                                      {idx > 0 && ', '}
                                      {win.start || '00:00'}–{win.end || '23:59'}
                                    </span>
                                  ))}
                                </span>
                              </div>
                              {schedule.some(win => win.intervalMinutes) && (
                                <div className="bump-info__row">
                                  <span className="bump-info__icon">⏱️</span>
                                  <span className="bump-info__label">Интервал:</span>
                                  <span className="bump-info__value">
                                    {schedule
                                      .filter(win => win.intervalMinutes)
                                      .map(win => `Каждые ${win.intervalMinutes} мин`)
                                      .join(', ')}
                                  </span>
                                </div>
                              )}
                            </>
                          )}
                          {schedule.length === 0 && settings?.autobump?.enabled && (
                            <div className="bump-info__row bump-info__row--warning">
                              <span className="bump-info__icon">⚠️</span>
                              <span className="bump-info__value">Расписание не настроено</span>
                            </div>
                          )}
                          {!settings && (
                            <div className="bump-info__row bump-info__row--warning">
                              <span className="bump-info__icon">⚠️</span>
                              <span className="bump-info__value">Настройки не загружены (ключ: {productKey})</span>
                            </div>
                          )}
                          {/* Инфо-блок про автоподнятие убран по требованиям дизайна */}
                          <div className="bump-info__row">
                            <span className="bump-info__icon">📊</span>
                            <span className="bump-info__label">Всего поднятий по товару:</span>
                            <span className="bump-info__value bump-info__value--count">{bumpCountTotal}</span>
                          </div>
                          <div className="bump-info__row">
                            <span className="bump-info__icon">🔢</span>
                            <span className="bump-info__label">Поднятий этого лота:</span>
                            <span className="bump-info__value bump-info__value--count">{bumpCountForLot}</span>
                          </div>
                        </div>
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

