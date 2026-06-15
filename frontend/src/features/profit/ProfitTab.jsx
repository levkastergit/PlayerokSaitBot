import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fetchProfitAnalytics, fetchProfitMeta, fetchProfitStats, syncSalesFromPlayerokStream, clearSalesHistory } from '../../services/playerokApi'

function formatDate(ts) {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** Только день и время (без года и месяца) — для таблицы продаж */
function formatDateShort(ts) {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  const day = d.getDate()
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${day}, ${h}:${m}`
}

function getDaysInMonth(year, month) {
  if (!year || !month) return []
  const last = new Date(Number(year), Number(month), 0).getDate()
  return Array.from({ length: last }, (_, i) => i + 1)
}

function formatPrice(v) {
  if (v == null || (typeof v === 'number' && isNaN(v))) return '—'
  return `${Number(v).toLocaleString('ru-RU')} ₽`
}

/** Цена без копеек, округлённая — для KPI-карточек. */
function formatPriceRound(v) {
  if (v == null || (typeof v === 'number' && isNaN(v))) return '—'
  return `${Math.round(Number(v)).toLocaleString('ru-RU')} ₽`
}

function formatPercent(v) {
  if (v == null || (typeof v === 'number' && isNaN(v))) return '—'
  return `${Number(v).toFixed(1)}%`
}

function formatCount(v) {
  return Number(v || 0).toLocaleString('ru-RU')
}

/** YYYY-MM-DD → «5 июн» для подписи столбца графика. */
function formatChartDay(ymd) {
  if (!ymd) return ''
  const parts = String(ymd).split('-')
  if (parts.length !== 3) return ymd
  const monthsShort = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
  const m = monthsShort[Number(parts[1]) - 1] || ''
  return `${Number(parts[2])} ${m}`
}

const MONTHS_RU = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
]

const WEEKDAYS_RU = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота']

export function ProfitTab({ token }) {
  const [view, setView] = useState('sales') // 'sales' | 'stats'
  const [list, setList] = useState([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState(null)
  const [syncProgress, setSyncProgress] = useState(null) // { fetched, total, inserted }
  const [clearing, setClearing] = useState(false)
  const now = useMemo(() => new Date(), [])
  const [years, setYears] = useState(() => [now.getFullYear()])
  const [months, setMonths] = useState([])
  const [year, setYear] = useState(String(now.getFullYear()))
  const [month, setMonth] = useState(String(now.getMonth() + 1))
  const [day, setDay] = useState(String(now.getDate()))
  const [pageSize, setPageSize] = useState(100)
  const [page, setPage] = useState(1)
  const [statsLoading, setStatsLoading] = useState(false)
  const [statsError, setStatsError] = useState(null)
  const [stats, setStats] = useState(null)

  const hasToken = Boolean(token)

  const offset = useMemo(() => Math.max(0, (Math.max(1, page) - 1) * (Number(pageSize) || 100)), [page, pageSize])
  const totalPages = useMemo(() => {
    const ps = Number(pageSize) || 100
    return ps > 0 ? Math.max(1, Math.ceil((Number(total) || 0) / ps)) : 1
  }, [total, pageSize])

  const refresh = useCallback(() => {
    if (!token) return Promise.resolve()
    setLoading(true)
    setError(null)
    return fetchProfitAnalytics(token, {
      limit: pageSize,
      offset,
    })
      .then((data) => {
        setList(Array.isArray(data?.list) ? data.list : [])
        setTotal(Number(data?.total) || 0)
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Ошибка загрузки')
        setList([])
        setTotal(0)
      })
      .finally(() => setLoading(false))
  }, [token, pageSize, offset])

  const refreshStats = useCallback(() => {
    if (!token) return Promise.resolve()
    setStatsLoading(true)
    setStatsError(null)
    return fetchProfitStats(token, { year: year || undefined, month: month || undefined, day: day || undefined })
      .then((data) => {
        setStats(data || null)
      })
      .catch((err) => {
        setStatsError(err instanceof Error ? err.message : 'Ошибка загрузки')
        setStats(null)
      })
      .finally(() => setStatsLoading(false))
  }, [token, year, month, day])

  useEffect(() => {
    let cancelled = false
    if (!token) {
      setList([])
      setTotal(0)
      setError(null)
      setStats(null)
      setStatsError(null)
      return
    }
    setLoading(true)
    setError(null)

    // meta (years/months) — добавляем текущий год, если его ещё нет
    fetchProfitMeta(token)
      .then((meta) => {
        if (cancelled) return
        const ys = Array.isArray(meta?.years) ? meta.years : []
        const currentY = now.getFullYear()
        if (ys.indexOf(currentY) === -1) setYears([...ys, currentY].sort((a, b) => a - b))
        else setYears(ys)
      })
      .catch(() => { })

    refresh().finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [token])

  // months list when year changes (если API вернул пусто — показываем 1..12 для выбора)
  useEffect(() => {
    if (!token) return
    const y = year ? String(year) : ''
    if (!y) {
      setMonths([])
      setMonth('')
      return
    }
    fetchProfitMeta(token, { year: y })
      .then((meta) => {
        const ms = Array.isArray(meta?.months) ? meta.months : []
        const list = ms.length > 0 ? ms : Array.from({ length: 12 }, (_, i) => i + 1)
        setMonths(list)
        if (month && !list.includes(parseInt(String(month), 10))) {
          setMonth('')
          setPage(1)
        }
      })
      .catch(() => { })
  }, [token, year])

  // при смене месяца/года проверяем день (если выбранного дня нет в месяце — сбросим)
  const daysInMonth = useMemo(() => getDaysInMonth(year, month), [year, month])
  useEffect(() => {
    if (!day || daysInMonth.length === 0) return
    const dNum = parseInt(String(day), 10)
    if (!daysInMonth.includes(dNum)) {
      setDay('')
      setPage(1)
    }
  }, [year, month, day, daysInMonth])

  // reload when filters/pagination change
  useEffect(() => {
    if (!token) return
    if (view === 'sales') refresh()
    if (view === 'stats') refreshStats()
  }, [token, view, year, month, day, pageSize, page])

  // when switching to stats, ensure it loads immediately
  useEffect(() => {
    if (!token) return
    if (view !== 'stats') return
    refreshStats()
  }, [token, view])

  const refreshDuringSyncRef = useRef(null)
  const handleSyncSales = useCallback(() => {
    if (!token || syncing) return
    setSyncing(true)
    setSyncMessage(null)
    setSyncProgress(null)
    refreshDuringSyncRef.current = null
    syncSalesFromPlayerokStream(token, (p) => {
      setSyncProgress(p)
      if (p.inserted > 0) {
        const now = Date.now()
        if (!refreshDuringSyncRef.current || now - refreshDuringSyncRef.current > 1500) {
          refreshDuringSyncRef.current = now
          fetchProfitAnalytics(token, { limit: pageSize, offset })
            .then((data) => {
              setList(Array.isArray(data?.list) ? data.list : [])
              setTotal(Number(data?.total) || 0)
            })
            .catch(() => { })
        }
      }
    })
      .then((data) => {
        const msg =
          data.inserted !== undefined
            ? `Всего обработано: ${data.total ?? 0}, добавлено в таблицу: ${data.inserted}`
            : 'Синхронизация завершена.'
        setSyncMessage(msg)
        setSyncProgress(null)
        return refresh()
      })
      .catch((err) => {
        setSyncMessage(err instanceof Error ? err.message : 'Ошибка синхронизации')
        setSyncProgress(null)
      })
      .finally(() => setSyncing(false))
  }, [token, syncing, refresh, pageSize, offset])

  const handleClearSales = useCallback(() => {
    if (!token || clearing || syncing) return
    if (!window.confirm('Очистить всю историю продаж (таблица прибыли)? После этого можно заново загрузить продажи с Playerok.')) return
    setClearing(true)
    clearSalesHistory(token)
      .then(() => {
        setSyncMessage('История продаж очищена. Нажмите «Загрузить все продажи с Playerok» для повторной загрузки.')
        return refresh()
      })
      .catch((err) => {
        setSyncMessage(err instanceof Error ? err.message : 'Ошибка очистки')
      })
      .finally(() => setClearing(false))
  }, [token, clearing, syncing, refresh])

  const totalProfit = list.reduce((sum, it) => sum + (Number(it.profit) || 0), 0)
  const bestHourLabel = useMemo(() => {
    const h = stats?.best?.hour?.hour
    if (h == null) return '—'
    const hh = String(h).padStart(2, '0')
    return `${hh}:00–${hh}:59`
  }, [stats])
  const bestWeekdayLabel = useMemo(() => {
    const wd = stats?.best?.weekday?.weekday
    if (wd == null) return '—'
    return WEEKDAYS_RU[wd] || String(wd)
  }, [stats])

  // Данные для графика динамики прибыли по дням. Берём последние 30 дней с продажами,
  // масштабируем по максимальному |прибыль| — отдельная шкала вверх (прибыль) и вниз (убыток).
  const chartDaily = useMemo(() => {
    const daily = Array.isArray(stats?.daily) ? stats.daily : []
    const tail = daily.slice(-30)
    const maxAbs = tail.reduce((m, d) => Math.max(m, Math.abs(Number(d.profit) || 0)), 0) || 1
    return { items: tail, maxAbs }
  }, [stats])

  return (
    <div className="tab-page">
      <div className="tab-page-header">
        <h1>Прибыль</h1>
      </div>

      <div className="tab-grid">
        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <div className="card-title-row">
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
              <h2 className="card-title" style={{ margin: 0 }}>
                {view === 'sales' ? 'Прибыль по продажам' : 'Статистика'}
              </h2>
              <div className="profit-view-toggle" role="tablist" aria-label="Разделы прибыли">
                <button
                  type="button"
                  className={'profit-view-toggle__btn' + (view === 'sales' ? ' profit-view-toggle__btn--active' : '')}
                  onClick={() => setView('sales')}
                >
                  Продажи
                </button>
                <button
                  type="button"
                  className={'profit-view-toggle__btn' + (view === 'stats' ? ' profit-view-toggle__btn--active' : '')}
                  onClick={() => setView('stats')}
                >
                  Статистика
                </button>
              </div>
            </div>
            {hasToken && (
              <div className="profit-toolbar">
                {view === 'stats' && (
                  <>
                    <label className="field">
                      <span className="field-label">Год</span>
                      <select
                        value={year}
                        onChange={(e) => { setYear(e.target.value); setPage(1) }}
                        disabled={loading || syncing || statsLoading}
                        className="input"
                      >
                        <option value="">Все</option>
                        {years.map((y) => (
                          <option key={String(y)} value={String(y)}>{String(y)}</option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span className="field-label">Месяц</span>
                      <select
                        value={month}
                        onChange={(e) => { setMonth(e.target.value); setPage(1) }}
                        disabled={loading || syncing || statsLoading || !year}
                        className="input"
                      >
                        <option value="">Все</option>
                        {months.map((m) => (
                          <option key={String(m)} value={String(m)}>
                            {MONTHS_RU[Number(m) - 1] || `Месяц ${String(m)}`}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span className="field-label">День</span>
                      <select
                        value={day}
                        onChange={(e) => { setDay(e.target.value); setPage(1) }}
                        disabled={loading || syncing || statsLoading || !year || !month}
                        className="input"
                      >
                        <option value="">Все</option>
                        {daysInMonth.map((d) => (
                          <option key={String(d)} value={String(d)}>{String(d)}</option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
                {view === 'sales' && (
                  <>
                    <button
                      type="button"
                      className="btn-primary"
                      onClick={handleSyncSales}
                      disabled={syncing || loading}
                    >
                      {syncing ? 'Синхронизация…' : 'Загрузить все продажи с Playerok'}
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={handleClearSales}
                      disabled={syncing || clearing || loading}
                    >
                      {clearing ? 'Очистка…' : 'Очистить историю продаж'}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          {syncing && (
            <div className="profit-sync-progress" role="status" aria-live="polite">
              <div className="profit-sync-progress__bar-wrap">
                <div
                  className="profit-sync-progress__bar profit-sync-progress__bar--indeterminate"
                  style={{
                    width: syncProgress?.fetched
                      ? `${Math.min(95, 15 + Math.floor((syncProgress.fetched || 0) / 50))}%`
                      : '15%',
                  }}
                />
              </div>
              <p className="profit-sync-progress__text">
                {syncProgress
                  ? `Обработано: ${syncProgress.fetched ?? 0}${syncProgress.inserted != null ? `, добавлено в таблицу: ${syncProgress.inserted}` : ''}`
                  : 'Подключение к Playerok…'}
              </p>
            </div>
          )}
          {syncMessage && !syncing && (
            <p className="card-text" style={{ marginTop: '0.5rem' }}>{syncMessage}</p>
          )}

          {!hasToken && (
            <p className="card-text">
              Укажите токен во вкладке «Токен», чтобы увидеть аналитику.
            </p>
          )}

          {hasToken && view === 'sales' && loading && (
            <p className="card-text">Загрузка…</p>
          )}

          {hasToken && view === 'sales' && !loading && error && (
            <p className="card-text card-text--error">{error}</p>
          )}

          {hasToken && view === 'sales' && !loading && !error && list.length > 0 && (
            <>
              <div className="history-table-wrap">
                <table className="history-table profit-table">
                  <thead>
                    <tr>
                      <th>Название товара</th>
                      <th>Покупатель</th>
                      <th>Дата продажи</th>
                      <th>Продажа</th>
                      <th>Возврат</th>
                      <th>Себестоимость</th>
                      <th>Выставление + поднятия</th>
                      <th>Прибыль</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((item, index) => (
                      <tr key={`${item.productKey}-${item.soldAt}-${index}`}>
                        <td className="history-table__title">{item.productTitle}</td>
                        <td>{item.buyerName || '—'}</td>
                        <td className="history-table__time">{formatDate(item.soldAt)}</td>
                        <td className="history-table__price">{formatPrice(item.salePrice)}</td>
                        <td>{item.isRefund ? 'Да' : '—'}</td>
                        <td
                          title={
                            item.costUsd != null && item.usdRate
                              ? `$${Number(item.costUsd).toFixed(2)} × ${Number(item.usdRate).toFixed(2)} ₽/$`
                              : undefined
                          }
                        >
                          {formatPrice(item.cost)}
                        </td>
                        <td>{formatPrice((item.listingCost || 0) + (item.bumpCost || 0))}</td>
                        <td className={`profit-table__profit ${Number(item.profit) >= 0 ? 'profit-table__profit--positive' : 'profit-table__profit--negative'}`}>
                          {formatPrice(item.profit)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.75rem' }}>
                <span className="card-text" style={{ margin: 0 }}>
                  Показано: {list.length} из {total}
                </span>
                <label className="field" style={{ marginLeft: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                  <span className="field-label" style={{ margin: 0 }}>На странице</span>
                  <select
                    value={String(pageSize)}
                    onChange={(e) => { setPageSize(parseInt(e.target.value, 10) || 100); setPage(1) }}
                    disabled={loading || syncing}
                    className="input"
                  >
                    <option value="50">50</option>
                    <option value="100">100</option>
                    <option value="200">200</option>
                    <option value="500">500</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={loading || syncing || page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Назад
                </button>
                <span className="card-text" style={{ margin: 0 }}>
                  Страница <strong>{page}</strong> из <strong>{totalPages}</strong>
                </span>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={loading || syncing || page >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  Вперёд
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={loading || syncing}
                  onClick={() => refresh()}
                >
                  Обновить
                </button>
              </div>
            </>
          )}

          {hasToken && view === 'stats' && statsLoading && (
            <p className="card-text">Загрузка…</p>
          )}

          {hasToken && view === 'stats' && !statsLoading && statsError && (
            <p className="card-text card-text--error">{statsError}</p>
          )}

          {hasToken && view === 'stats' && !statsLoading && !statsError && stats && (
            <div className="profit-stats">
              {/* KPI-карточки: главные цифры за выбранный период */}
              <div className="profit-kpi-row">
                <div className={'profit-kpi' + (Number(stats?.totals?.profit) >= 0 ? ' profit-kpi--good' : ' profit-kpi--bad')}>
                  <span className="profit-kpi__label">Прибыль</span>
                  <span className="profit-kpi__value">{formatPriceRound(stats?.totals?.profit)}</span>
                  <span className="profit-kpi__sub">маржа {formatPercent(stats?.averages?.margin)}</span>
                </div>
                <div className="profit-kpi">
                  <span className="profit-kpi__label">Выручка</span>
                  <span className="profit-kpi__value">{formatPriceRound(stats?.totals?.revenue)}</span>
                  <span className="profit-kpi__sub">средний чек {formatPriceRound(stats?.averages?.salePrice)}</span>
                </div>
                <div className="profit-kpi">
                  <span className="profit-kpi__label">Расходы</span>
                  <span className="profit-kpi__value">{formatPriceRound(stats?.totals?.expenses)}</span>
                  <span className="profit-kpi__sub">себест. + выставл. + поднятия</span>
                </div>
                <div className="profit-kpi">
                  <span className="profit-kpi__label">Продаж</span>
                  <span className="profit-kpi__value">{formatCount(stats?.counts?.paid ?? stats?.counts?.sales)}</span>
                  <span className="profit-kpi__sub">{formatCount(stats?.counts?.refunds)} возвратов</span>
                </div>
              </div>

              {/* График динамики прибыли по дням */}
              <section className="card profit-chart-card">
                <h3 className="card-title">Прибыль по дням{chartDaily.items.length ? ` (${chartDaily.items.length})` : ''}</h3>
                {chartDaily.items.length === 0 ? (
                  <p className="card-text">Нет продаж за выбранный период.</p>
                ) : (
                  <div className="profit-chart" role="img" aria-label="График прибыли по дням">
                    {chartDaily.items.map((d) => {
                      const p = Number(d.profit) || 0
                      const heightPct = Math.max(2, Math.round((Math.abs(p) / chartDaily.maxAbs) * 100))
                      return (
                        <div
                          key={d.date}
                          className="profit-chart__col"
                          title={`${formatChartDay(d.date)}: ${formatPrice(p)} · ${formatCount(d.sales)} прод.`}
                        >
                          <div className="profit-chart__bar-wrap">
                            <span
                              className={'profit-chart__bar' + (p >= 0 ? ' profit-chart__bar--pos' : ' profit-chart__bar--neg')}
                              style={{ height: `${heightPct}%` }}
                            />
                          </div>
                          <span className="profit-chart__label">{formatChartDay(d.date)}</span>
                        </div>
                      )
                    })}
                  </div>
                )}
              </section>

              {/* Разбивка расходов + лучшее время */}
              <div className="profit-stats-grid">
                <section className="card">
                  <h3 className="card-title">Разбивка расходов</h3>
                  <div className="profit-breakdown">
                    <div className="profit-breakdown__row">
                      <span>Себестоимость</span>
                      <strong>{formatPrice(stats?.totals?.cost)}</strong>
                    </div>
                    <div className="profit-breakdown__row">
                      <span>Выставление</span>
                      <strong>{formatPrice(stats?.totals?.listingCost)}</strong>
                    </div>
                    <div className="profit-breakdown__row">
                      <span>Поднятия</span>
                      <strong>{formatPrice(stats?.totals?.bumpCost)}</strong>
                    </div>
                    <div className="profit-breakdown__row profit-breakdown__row--total">
                      <span>Средняя прибыль с продажи</span>
                      <strong>{formatPrice(stats?.averages?.profitPerSale)}</strong>
                    </div>
                  </div>
                </section>
                <section className="card">
                  <h3 className="card-title">Лучшее время</h3>
                  <div className="profit-breakdown">
                    <div className="profit-breakdown__row">
                      <span>Самый прибыльный час</span>
                      <strong>{bestHourLabel}</strong>
                    </div>
                    <div className="profit-breakdown__row">
                      <span></span>
                      <span className="card-text" style={{ margin: 0 }}>{formatPrice(stats?.best?.hour?.profit)}</span>
                    </div>
                    <div className="profit-breakdown__row">
                      <span>Самый прибыльный день</span>
                      <strong>{bestWeekdayLabel}</strong>
                    </div>
                    <div className="profit-breakdown__row">
                      <span></span>
                      <span className="card-text" style={{ margin: 0 }}>{formatPrice(stats?.best?.weekday?.profit)}</span>
                    </div>
                  </div>
                </section>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
