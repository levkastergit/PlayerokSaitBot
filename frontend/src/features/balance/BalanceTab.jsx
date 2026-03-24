import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  fetchBalanceOverview,
  fetchActionsHistory,
  fetchTransactionProviders,
  fetchTransactions,
  fetchVerifiedCards,
  requestWithdrawal,
} from '../../services/playerokApi'

function formatMoney(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return '—'
  return `${n.toLocaleString('ru-RU')} ₽`
}

function toRuDirection(v) {
  const key = String(v || '').toUpperCase()
  if (key === 'IN') return 'Пополнение'
  if (key === 'OUT') return 'Списание'
  return v || '—'
}

function toRuOperation(v) {
  const key = String(v || '').toUpperCase()
  if (key === 'DEPOSIT') return 'Пополнение'
  if (key === 'WITHDRAWAL') return 'Вывод'
  if (key === 'PAYMENT') return 'Оплата'
  if (key === 'REFUND') return 'Возврат'
  if (key === 'BONUS') return 'Бонус'
  if (key === 'DEAL') return 'Сделка'
  if (key === 'FEE') return 'Комиссия'
  if (key === 'BUY') return 'Покупка'
  if (key === 'ITEM_PREMIUM_PRIORITY') return 'Поднятие в приоритет'
  return v || '—'
}

function toRuStatus(v) {
  const key = String(v || '').toUpperCase()
  if (key === 'PENDING') return 'В ожидании'
  if (key === 'PROCESSING') return 'В обработке'
  if (key === 'COMPLETED') return 'Завершена'
  if (key === 'CANCELLED') return 'Отменена'
  if (key === 'FAILED') return 'Ошибка'
  if (key === 'CREATED') return 'Создана'
  if (key === 'EXPIRED') return 'Истекла'
  if (key === 'REJECTED') return 'Отклонена'
  if (key === 'ROLLED_BACK') return 'Возвращена'
  if (key === 'CONFIRMED') return 'Подтверждена'
  return v || '—'
}

function toRuStatusDescription(v) {
  const text = String(v || '').trim()
  if (!text) return ''
  const key = text.toLowerCase()
  if (key.includes('pending')) return 'В ожидании'
  if (key.includes('processing')) return 'В обработке'
  if (key.includes('completed')) return 'Завершена'
  if (key.includes('cancel')) return 'Отменена'
  if (key.includes('fail')) return 'Ошибка'
  if (key.includes('create')) return 'Создана'
  if (key.includes('expire')) return 'Истекла'
  if (key.includes('reject')) return 'Отклонена'
  return text
}

function toUnixTsFromAny(v) {
  if (v == null || v === '') return 0
  if (typeof v === 'number') return v > 1e12 ? Math.floor(v / 1000) : Math.floor(v)
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return 0
  return Math.floor(d.getTime() / 1000)
}

function buildTransactionProductMap(transactions, actionsHistory) {
  const candidates = Array.isArray(actionsHistory)
    ? actionsHistory
        .map((a, idx) => ({
          idx,
          ts: Number(a?.createdAt) || 0,
          amount: Number(a?.amount) || 0,
          productTitle: a?.productTitle || a?.productKey || '',
          used: false,
        }))
        .filter((a) => a.ts > 0 && a.amount > 0 && a.productTitle)
    : []

  const map = new Map()
  const txList = Array.isArray(transactions) ? transactions : []

  txList.forEach((tx) => {
    const txId = tx?.id
    if (!txId) return
    const operation = String(tx?.operation || '').toUpperCase()
    if (operation === 'BUY') return

    const txAmount = Math.abs(Number(tx?.value) || 0)
    const txTs = toUnixTsFromAny(tx?.createdAt)
    if (!txAmount || !txTs) return

    let best = null
    for (const c of candidates) {
      if (c.used) continue
      // Сумма должна строго совпадать, затем выбираем ближайшее по времени совпадение.
      const amountDiff = Math.abs(c.amount - txAmount)
      if (amountDiff !== 0) continue
      const timeDiff = Math.abs(c.ts - txTs)
      const score = timeDiff * 10 + amountDiff
      if (!best || score < best.score) best = { candidate: c, score }
    }

    if (best && best.candidate) {
      best.candidate.used = true
      map.set(txId, best.candidate.productTitle)
    }
  })

  return map
}

export function BalanceTab({ token }) {
  const hasToken = Boolean(token)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [viewer, setViewer] = useState(null)
  const [providers, setProviders] = useState([])
  const [transactions, setTransactions] = useState([])
  const [cards, setCards] = useState([])
  const [actionsHistory, setActionsHistory] = useState([])
  const [withdrawProviderId, setWithdrawProviderId] = useState('')
  const [withdrawAccount, setWithdrawAccount] = useState('')
  const [withdrawValue, setWithdrawValue] = useState('')
  const [withdrawing, setWithdrawing] = useState(false)
  const [actionMessage, setActionMessage] = useState(null)

  const loadAll = useCallback(async () => {
    if (!token) return
    setLoading(true)
    setError(null)
    try {
      const [overview, providersRes, txRes, cardsRes, actionsRes] = await Promise.all([
        fetchBalanceOverview(token),
        fetchTransactionProviders(token, 'OUT'),
        fetchTransactions(token, { count: 24 }),
        fetchVerifiedCards(token, { count: 24, direction: 'ASC' }),
        fetchActionsHistory(token),
      ])
      setViewer(overview?.viewer || null)
      setProviders(Array.isArray(providersRes?.list) ? providersRes.list : [])
      setTransactions(Array.isArray(txRes?.list) ? txRes.list : [])
      setCards(Array.isArray(cardsRes?.list) ? cardsRes.list : [])
      setActionsHistory(Array.isArray(actionsRes?.list) ? actionsRes.list : [])
      if (!withdrawProviderId && Array.isArray(providersRes?.list) && providersRes.list.length > 0) {
        setWithdrawProviderId(providersRes.list[0]?.id || '')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки')
    } finally {
      setLoading(false)
    }
  }, [token, withdrawProviderId])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  const providerOptions = useMemo(
    () => providers.map((p) => ({ id: p?.id || '', name: p?.name || p?.id || 'provider' })).filter((p) => p.id),
    [providers]
  )
  const txProductMap = useMemo(
    () => buildTransactionProductMap(transactions, actionsHistory),
    [transactions, actionsHistory]
  )

  const handleWithdraw = async () => {
    if (!token || withdrawing) return
    const value = Number(withdrawValue)
    if (!withdrawProviderId || !withdrawAccount.trim() || !Number.isFinite(value) || value <= 0) {
      setActionMessage('Заполните провайдера, реквизиты и сумму вывода.')
      return
    }
    setWithdrawing(true)
    setActionMessage(null)
    try {
      await requestWithdrawal(token, {
        providerId: withdrawProviderId,
        account: withdrawAccount.trim(),
        value,
      })
      setActionMessage('Заявка на вывод отправлена.')
      setWithdrawValue('')
      await loadAll()
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : 'Ошибка вывода')
    } finally {
      setWithdrawing(false)
    }
  }

  return (
    <div className="tab-page">
      <div className="tab-page-header">
        <h1>Баланс</h1>
      </div>

      <div className="tab-grid">
        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <h2 className="card-title">Статус кошелька</h2>
          {!hasToken && (
            <p className="card-text">
              Укажите токен во вкладке «Настройки», чтобы подключить операции по кошельку.
            </p>
          )}
          {hasToken && loading && <p className="card-text">Загрузка…</p>}
          {hasToken && !loading && error && <p className="card-text card-text--error">{error}</p>}
          {hasToken && !loading && !error && (
            <div>
              <p className="card-text">Пользователь: <strong>{viewer?.username || '—'}</strong></p>
              <p className="card-text">Email: <strong>{viewer?.email || '—'}</strong></p>
              <p className="card-text">Замороженный баланс: <strong>{viewer?.hasFrozenBalance ? 'Да' : 'Нет'}</strong></p>
            </div>
          )}
        </section>

        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <h2 className="card-title">Вывод средств</h2>
          <div className="profit-toolbar">
            <label className="field">
              <span className="field-label">Провайдер</span>
              <select className="input" value={withdrawProviderId} onChange={(e) => setWithdrawProviderId(e.target.value)}>
                <option value="">Выберите провайдера</option>
                {providerOptions.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Реквизиты (карта/телефон)</span>
              <input className="input" value={withdrawAccount} onChange={(e) => setWithdrawAccount(e.target.value)} />
            </label>
            <label className="field">
              <span className="field-label">Сумма</span>
              <input className="input" type="number" min="1" value={withdrawValue} onChange={(e) => setWithdrawValue(e.target.value)} />
            </label>
            <button type="button" className="btn-primary" onClick={handleWithdraw} disabled={!hasToken || withdrawing || loading}>
              {withdrawing ? 'Отправка…' : 'Создать вывод'}
            </button>
            <button type="button" className="btn-secondary" onClick={loadAll} disabled={!hasToken || loading}>
              Обновить
            </button>
          </div>
          {actionMessage && <p className="card-text" style={{ marginTop: '0.75rem' }}>{actionMessage}</p>}
        </section>

        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <h2 className="card-title">Последние транзакции</h2>
          <div className="history-table-wrap">
            <table className="history-table">
              <thead>
                <tr>
                  <th>Дата</th>
                  <th>Операция</th>
                  <th>Направление</th>
                  <th>Провайдер</th>
                  <th>Статус</th>
                  <th>Товар</th>
                  <th>Сумма</th>
                  <th>Комиссия</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((tx) => (
                  <tr key={tx.id}>
                    <td>{tx.createdAt ? new Date(tx.createdAt).toLocaleString('ru-RU') : '—'}</td>
                    <td>{toRuOperation(tx.operation)}</td>
                    <td>{toRuDirection(tx.direction)}</td>
                    <td>{tx.provider?.name || tx.providerId || '—'}</td>
                    <td>{toRuStatus(tx.status) || toRuStatusDescription(tx.statusDescription) || '—'}</td>
                    <td className="history-table__title">{txProductMap.get(tx.id) || '—'}</td>
                    <td>{formatMoney(tx.value)}</td>
                    <td>{formatMoney(tx.fee)}</td>
                  </tr>
                ))}
                {transactions.length === 0 && (
                  <tr>
                    <td colSpan={8}>Нет транзакций</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <h2 className="card-title">Привязанные карты</h2>
          {cards.length === 0 ? (
            <p className="card-text">Карт не найдено.</p>
          ) : (
            <div className="history-table-wrap">
              <table className="history-table">
                <thead>
                  <tr>
                    <th>Значение</th>
                    <th>Тип</th>
                  </tr>
                </thead>
                <tbody>
                  {cards.map((card) => (
                    <tr key={card.id}>
                      <td>{card.value || '—'}</td>
                      <td>{card.type || '—'}</td>
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
