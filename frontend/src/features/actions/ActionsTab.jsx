import React, { useCallback, useEffect, useState } from 'react'
import { fetchActionsHistory } from '../../services/playerokApi'

function formatDateTime(ts) {
  if (!ts) return '—'
  const d = new Date(Number(ts) * 1000)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatAmount(value) {
  const n = Number(value) || 0
  return `${n.toLocaleString('ru-RU')} ₽`
}

function actionLabel(actionType) {
  if (actionType === 'autolist') return 'Выставление'
  if (actionType === 'bump') return 'Поднятие'
  return 'Действие'
}

export function ActionsTab({ token }) {
  const [list, setList] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const hasToken = Boolean(token)

  const refresh = useCallback(() => {
    if (!token) return Promise.resolve()
    setLoading(true)
    setError(null)
    return fetchActionsHistory(token)
      .then((data) => {
        setList(Array.isArray(data?.list) ? data.list : [])
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Ошибка загрузки')
        setList([])
      })
      .finally(() => setLoading(false))
  }, [token])

  useEffect(() => {
    if (!token) {
      setList([])
      setError(null)
      return
    }
    refresh()
    const timer = setInterval(refresh, 10_000)
    return () => clearInterval(timer)
  }, [token, refresh])

  return (
    <div className="tab-page">
      <div className="tab-page-header">
        <h1>Действия</h1>
        <p className="tab-page-description">
          История автовыставления и поднятия лотов: дата, сумма и ID товара.
        </p>
      </div>

      <div className="tab-grid">
        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <div className="card-title-row">
            <h2 className="card-title" style={{ margin: 0 }}>Последние действия</h2>
            {hasToken && (
              <button
                type="button"
                className="btn-secondary"
                onClick={refresh}
                disabled={loading}
              >
                Обновить
              </button>
            )}
          </div>

          {!hasToken && (
            <p className="card-text">Укажите токен во вкладке «Настройки», чтобы увидеть историю действий.</p>
          )}

          {hasToken && loading && <p className="card-text">Загрузка…</p>}
          {hasToken && !loading && error && <p className="card-text card-text--error">{error}</p>}
          {hasToken && !loading && !error && list.length === 0 && (
            <p className="card-text">Пока нет записей. После автовыставления или поднятия здесь появятся действия.</p>
          )}

          {hasToken && !loading && !error && list.length > 0 && (
            <div className="history-table-wrap">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Тип</th>
                    <th>Дата</th>
                    <th>Сумма</th>
                    <th>ID товара</th>
                    <th>Товар</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((item, index) => (
                    <tr key={`${item.actionType}-${item.createdAt}-${item.itemId || 'no-item'}-${index}`}>
                      <td>{actionLabel(item.actionType)}</td>
                      <td className="history-table__time">{formatDateTime(item.createdAt)}</td>
                      <td className="history-table__price">{formatAmount(item.amount)}</td>
                      <td>{item.itemId || '—'}</td>
                      <td className="history-table__title" title={item.productTitle || item.productKey || ''}>
                        {item.productTitle || item.productKey || '—'}
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
