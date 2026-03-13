import React, { useEffect, useMemo, useState } from 'react'
import { requestTracker } from '../../services/requestTracker'

function formatTs(ts) {
  if (!ts) return ''
  try {
    return new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return ''
  }
}

function shortUrl(url) {
  const s = String(url || '')
  try {
    const u = new URL(s, window.location.origin)
    // Redact tokens and other sensitive query params (case-insensitive by key).
    const params = new URLSearchParams(u.search || '')
    const redactKeys = ['token', 'access_token', 'auth', 'authorization', 'cookie', 'session', 'productkey']
    for (const [key] of params.entries()) {
      if (redactKeys.includes(String(key).toLowerCase())) {
        params.set(key, '***')
      }
    }
    const q = params.toString()
    return u.pathname + (q ? `?${q}` : '')
  } catch {
    return s
  }
}

function groupByEndpoint(events) {
  const map = new Map()
  for (const e of events) {
    const key = `${e.method} ${shortUrl(e.url)}`
    const cur = map.get(key) || {
      key,
      method: e.method,
      url: shortUrl(e.url),
      target: e.target,
      count: 0,
      errors: 0,
      totalMs: 0,
      maxMs: 0,
      lastTs: 0,
      statusCounts: {},
    }
    cur.count += 1
    cur.totalMs += Number(e.durationMs || 0)
    cur.maxMs = Math.max(cur.maxMs, Number(e.durationMs || 0))
    cur.lastTs = Math.max(cur.lastTs, Number(e.ts || 0))
    if (e.ok === false || e.error) cur.errors += 1
    const st = e.status == null ? '—' : String(e.status)
    cur.statusCounts[st] = (cur.statusCounts[st] || 0) + 1
    map.set(key, cur)
  }
  return [...map.values()]
}

function pickExplanationFromUrl(url, stackFirstLine) {
  const u = String(url || '')
  const path = u.split('?')[0] || u
  const s = String(stackFirstLine || '')

  // Specific flows (most important first)
  if (path.includes('/api/bump-history') || path.includes('/api/playerok/bump')) {
    if (s.includes('/src/App.jsx')) return 'Автоподнятие (планировщик)'
    return 'Поднятие лотов / история поднятий'
  }
  if (path.includes('/api/product-settings/list')) {
    if (s.includes('/src/App.jsx')) return 'Автоподнятие: загрузка настроек'
    return 'Настройки товаров (список)'
  }
  if (path.includes('/api/product-settings')) return 'Настройки товара (просмотр/сохранение)'

  if (path.includes('/api/playerok/deal-chat-messages')) return 'Обновление чатов (выполнение)'
  if (path.includes('/api/playerok/in-progress-deals')) return 'Сделки в выполнении (список)'
  if (path.includes('/api/playerok/completed-deals')) return 'Завершённые сделки (для чатов)'
  if (path.includes('/api/playerok/send-chat-message')) return 'Отправка сообщения в чат'
  if (path.includes('/api/playerok/cancel-deal')) return 'Отмена сделки'
  if (path.includes('/api/playerok/confirm-deal')) return 'Подтверждение сделки'

  if (path.includes('/api/playerok/active-lots')) return 'Загрузка активных лотов'
  if (path.includes('/api/playerok/completed-lots')) return 'Загрузка завершённых лотов'

  if (path.includes('/api/playerok/item-priority-statuses')) return 'Статусы поднятия (кнопка/настройки)'

  if (path.includes('/api/category-commands/list')) return 'Команды по категориям (загрузка)'
  if (path.includes('/api/category-commands')) return 'Команды по категориям (сохранение)'

  if (path.includes('/api/auth/me')) return 'Проверка сессии'
  if (path.includes('/api/auth/login')) return 'Вход'
  if (path.includes('/api/auth/logout')) return 'Выход'

  if (path.includes('/api/token')) return 'Токен (загрузка/сохранение)'

  if (path.includes('/api/profit-analytics') || path.includes('/api/profit-stats')) return 'Статистика/прибыль'
  if (path.includes('/api/sales-history')) return 'История продаж (локально)'
  if (path.includes('/api/sync-sales')) return 'Синхронизация продаж'

  // Fallback: infer from source file
  if (s.includes('/InProgressLotsTab.jsx')) return 'Выполнение (фоновое обновление)'
  if (s.includes('/LotBoostTab.jsx')) return 'Поднятие лотов (экран)'
  if (s.includes('/ActiveLotsTab.jsx')) return 'Активные лоты (экран)'
  if (s.includes('/CompletedLotsTab.jsx')) return 'Завершённые лоты (экран)'
  if (s.includes('/LotSettingsPage.jsx')) return 'Настройки лота (экран)'
  if (s.includes('/CommandsTab.jsx')) return 'Команды (экран)'
  if (s.includes('/ProfitTab.jsx')) return 'Статистика (экран)'

  return '—'
}

export function OptimizationTab() {
  const [tick, setTick] = useState(0)
  const [targetFilter, setTargetFilter] = useState('all')

  useEffect(() => {
    const unsub = requestTracker.subscribe(() => setTick((t) => t + 1))
    const t = setInterval(() => setTick((x) => x + 1), 1000)
    return () => {
      unsub()
      clearInterval(t)
    }
  }, [])

  const snap = requestTracker.getSnapshot()
  const now = Date.now()
  const events = snap.events || []

  const last60 = useMemo(
    () => events.filter((e) => e.ts >= now - 60_000),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tick]
  )
  const last5m = useMemo(
    () => events.filter((e) => e.ts >= now - 5 * 60_000),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tick]
  )

  const playerok60 = useMemo(
    () => last60.filter((e) => e.target === 'playerok' || e.target === 'playerok-proxy'),
    [last60]
  )
  const playerok5m = useMemo(
    () => last5m.filter((e) => e.target === 'playerok' || e.target === 'playerok-proxy'),
    [last5m]
  )

  const topEndpoints5m = useMemo(() => {
    const rows = groupByEndpoint(playerok5m)
      .map((r) => ({
        ...r,
        rpm: Math.round((r.count / 5) * 10) / 10,
        avgMs: r.count ? Math.round(r.totalMs / r.count) : 0,
        errRate: r.count ? Math.round((r.errors / r.count) * 100) : 0,
      }))
      .sort((a, b) => b.count - a.count)
    return rows.slice(0, 25)
  }, [playerok5m])

  const lastEvents = useMemo(() => {
    const list = [...events]
    list.sort((a, b) => (b.ts || 0) - (a.ts || 0))
    return list.slice(0, 80)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick])

  const filteredLastEvents = useMemo(() => {
    return lastEvents.filter((e) => {
      if (targetFilter === 'all') return true
      if (targetFilter === 'playerok') return e.target === 'playerok' || e.target === 'playerok-proxy'
      if (targetFilter === 'backend') return e.target === 'backend'
      if (targetFilter === 'other') return e.target !== 'playerok' && e.target !== 'playerok-proxy' && e.target !== 'backend'
      return true
    })
  }, [lastEvents, targetFilter])

  const hotHint = useMemo(() => {
    const byTarget = groupByEndpoint(playerok60)
      .sort((a, b) => b.count - a.count)
      .slice(0, 3)
    return byTarget
  }, [playerok60])

  return (
    <div className="tab-page">
      <div className="tab-page-header">
        <h1>Оптимизация</h1>
        <p className="tab-page-description">
          Живая диагностика запросов. Здесь видно, какие эндпоинты чаще всего дергаются и что потенциально создаёт перегруз.
        </p>
      </div>

      <div className="tab-grid">
        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <div className="card-title-row" style={{ alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <h2 className="card-title" style={{ margin: 0 }}>Сводка по запросам</h2>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => requestTracker.setEnabled(!snap.enabled)}
              >
                {snap.enabled ? 'Пауза' : 'Возобновить'}
              </button>
              <button type="button" className="btn-secondary" onClick={() => requestTracker.clear()}>
                Очистить
              </button>
            </div>
          </div>

          <div className="optimization-summary">
            <div className="optimization-summary__item">
              <div className="optimization-summary__label">Playerok запросов (60с)</div>
              <div className="optimization-summary__value">{playerok60.length}</div>
            </div>
            <div className="optimization-summary__item">
              <div className="optimization-summary__label">Playerok запросов (5 мин)</div>
              <div className="optimization-summary__value">{playerok5m.length}</div>
            </div>
            <div className="optimization-summary__item">
              <div className="optimization-summary__label">Всего запросов (5 мин)</div>
              <div className="optimization-summary__value">{last5m.length}</div>
            </div>
            <div className="optimization-summary__item">
              <div className="optimization-summary__label">Сейчас</div>
              <div className="optimization-summary__value">{formatTs(now)}</div>
            </div>
          </div>

          {hotHint.length > 0 && (
            <p className="card-text" style={{ marginTop: 12 }}>
              Чаще всего за последнюю минуту: {hotHint.map((h) => `${h.count}× ${h.key}`).join(' · ')}
            </p>
          )}

          <div className="optimization-callouts">
            <div className="optimization-callout optimization-callout--warn">
              <div className="optimization-callout__title">Что обычно перегружает Playerok</div>
              <ul className="optimization-callout__list">
                <li>Частое обновление чатов по каждой сделке (вкладка «Выполнение» обновляет чаты циклом примерно раз в 15с).</li>
                <li>Параллельные «фоновые» циклы: автоподнятие в `App` (раз в 30с) + история поднятий в «Поднятие лотов» (раз в 30с).</li>
                <li>Большое число сделок: если сделок много, обновление чатов растёт линейно.</li>
              </ul>
            </div>
          </div>
        </section>

        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <h2 className="card-title">Топ запросов к Playerok (за 5 минут)</h2>
          {topEndpoints5m.length === 0 ? (
            <p className="card-text">Пока нет данных. Перейдите на вкладки, которые делают запросы, и вернитесь сюда.</p>
          ) : (
            <div className="optimization-table-wrap">
              <table className="optimization-table">
                <thead>
                  <tr>
                    <th>Эндпоинт</th>
                    <th>Пояснение</th>
                    <th>Кол-во</th>
                    <th>RPM</th>
                    <th>Avg ms</th>
                    <th>Max ms</th>
                    <th>Ошибки</th>
                    <th>Статусы</th>
                    <th>Последний</th>
                  </tr>
                </thead>
                <tbody>
                  {topEndpoints5m.map((r) => (
                    <tr key={r.key} className={r.errors ? 'optimization-row--error' : ''}>
                      <td className="optimization-td--endpoint">
                        <div className="optimization-endpoint">
                          <span className="optimization-endpoint__method">{r.method}</span>
                          <span className="optimization-endpoint__url">{r.url}</span>
                          <span className="optimization-endpoint__tag">{r.target}</span>
                        </div>
                      </td>
                      <td className="optimization-td--explain">
                        {pickExplanationFromUrl(r.url, '')}
                      </td>
                      <td>{r.count}</td>
                      <td>{r.rpm}</td>
                      <td>{r.avgMs}</td>
                      <td>{Math.round(r.maxMs)}</td>
                      <td>{r.errors ? `${r.errors} (${r.errRate}%)` : '0'}</td>
                      <td className="optimization-td--statuses">
                        {Object.entries(r.statusCounts)
                          .sort((a, b) => b[1] - a[1])
                          .slice(0, 4)
                          .map(([st, c]) => `${st}:${c}`)
                          .join(' ')}
                      </td>
                      <td>{formatTs(r.lastTs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <div className="card-title-row" style={{ alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <h2 className="card-title" style={{ margin: 0 }}>Последние запросы</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                <span style={{ color: 'var(--text-muted)' }}>Фильтр по цели:</span>
                <select
                  value={targetFilter}
                  onChange={(e) => setTargetFilter(e.target.value)}
                  className="input"
                  style={{ minWidth: 140, padding: '4px 8px' }}
                >
                  <option value="all">Все</option>
                  <option value="playerok">Playerok + proxy</option>
                  <option value="backend">Только backend</option>
                  <option value="other">Прочее</option>
                </select>
              </label>
            </div>
          </div>
          {filteredLastEvents.length === 0 ? (
            <p className="card-text">Пока пусто.</p>
          ) : (
            <div className="optimization-table-wrap">
              <table className="optimization-table optimization-table--compact">
                <thead>
                  <tr>
                    <th>Время</th>
                    <th>Цель</th>
                    <th>Метод</th>
                    <th>URL</th>
                    <th>Пояснение</th>
                    <th>Статус</th>
                    <th>ms</th>
                    <th>Источник</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredLastEvents.map((e) => (
                    <tr key={e.id} className={(e.ok === false || e.error) ? 'optimization-row--error' : ''}>
                      <td>{formatTs(e.ts)}</td>
                      <td>{e.target}</td>
                      <td>{e.method}</td>
                      <td className="optimization-td--url">{shortUrl(e.url)}</td>
                      <td className="optimization-td--explain">
                        {pickExplanationFromUrl(shortUrl(e.url), Array.isArray(e.stack) && e.stack.length > 0 ? e.stack[0] : '')}
                      </td>
                      <td>{e.status == null ? '—' : e.status}</td>
                      <td>{Math.round(e.durationMs || 0)}</td>
                      <td className="optimization-td--stack">
                        {Array.isArray(e.stack) && e.stack.length > 0 ? e.stack[0] : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

