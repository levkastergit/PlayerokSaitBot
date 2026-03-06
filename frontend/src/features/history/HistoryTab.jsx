import React, { useEffect, useState } from 'react'
import { fetchBumpHistory, fetchSalesHistory } from '../../services/playerokApi'

function formatHistoryDate(ts) {
  if (!ts) return '—'
  const d = new Date(ts * 1000)
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

const SALE_STATUS_LABELS = {
  PENDING: 'В ожидании',
  CONFIRMED: 'Подтверждение',
  CONFIRMED_AUTOMATICALLY: 'Завершено',
  ROLLED_BACK: 'Возврат средств',
}

const HIDE_STATUS = ['PAID', 'SENT']

export function HistoryTab({ token }) {
  const [list, setList] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const hasToken = Boolean(token)

  useEffect(() => {
    if (!token) {
      setList([])
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    Promise.all([fetchBumpHistory(token), fetchSalesHistory(token)])
      .then(([bumpData, salesData]) => {
        if (cancelled) return
        const bumps = (bumpData.list || []).map((it) => ({
          type: 'bump',
          productTitle: it.productTitle,
          ts: it.bumpedAt,
          price: it.price,
        }))
        const sales = (salesData.list || []).map((it) => ({
          type: 'sale',
          productTitle: it.productTitle,
          ts: it.soldAt,
          price: it.price,
          status: it.status,
        }))
        const merged = [...bumps, ...sales].sort((a, b) => (b.ts || 0) - (a.ts || 0))
        setList(merged)
        setLoading(false)
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Ошибка загрузки')
          setList([])
          setLoading(false)
        }
      })
    return () => { cancelled = true }
  }, [token])

  return (
    <div className="tab-page">
      <div className="tab-page-header">
        <h1>История операций</h1>
        <p className="tab-page-description">
          Поднятия лотов и продажи: название товара, время операции и цена.
        </p>
      </div>

      <div className="tab-grid">
        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <h2 className="card-title">История операций</h2>

          {!hasToken && (
            <p className="card-text">
              Укажите токен во вкладке «Токен», чтобы увидеть историю.
            </p>
          )}

          {hasToken && loading && (
            <p className="card-text">Загрузка истории…</p>
          )}

          {hasToken && !loading && error && (
            <p className="card-text card-text--error">{error}</p>
          )}

          {hasToken && !loading && !error && list.length === 0 && (
            <p className="card-text">Пока нет записей о поднятиях и продажах.</p>
          )}

          {hasToken && !loading && !error && list.length > 0 && (
            <div className="history-table-wrap">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Тип</th>
                    <th>Название товара</th>
                    <th>Время</th>
                    <th>Цена</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((item, index) => (
                    <tr key={`${item.type}-${item.ts}-${item.status || ''}-${index}`}>
                      <td className="history-table__type">
                        {item.type === 'sale'
                          ? item.status && !HIDE_STATUS.includes(item.status)
                            ? `Продажа (${SALE_STATUS_LABELS[item.status] || item.status})`
                            : 'Продажа'
                          : 'Поднятие'}
                      </td>
                      <td className="history-table__title">{item.productTitle}</td>
                      <td className="history-table__time">{formatHistoryDate(item.ts)}</td>
                      <td className="history-table__price">
                        {item.price != null && item.price > 0
                          ? `${Number(item.price).toLocaleString('ru-RU')} ₽`
                          : '—'}
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
