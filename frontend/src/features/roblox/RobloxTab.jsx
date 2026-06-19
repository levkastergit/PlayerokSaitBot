import { useEffect, useRef, useState } from 'react'
import {
  fetchRobloxAccounts,
  addRobloxAccount,
  refreshRobloxAccount,
  deleteRobloxAccount,
  fetchMsAccounts,
  addMsAccount,
  deleteMsAccount,
  fetchOrders,
  createOrder,
  orderLogin,
  cancelOrder,
} from '../../services/robloxApi'

function formatRobux(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  return `${Number(n).toLocaleString('ru-RU')} R$`
}

const ACCOUNT_STATUS = {
  active: { label: 'Активен', cls: 'ok' },
  error: { label: 'Ошибка', cls: 'err' },
  invalid: { label: 'Cookie невалидна', cls: 'err' },
}

const ORDER_STATUS = {
  awaiting_login: { label: 'Ожидает входа', cls: 'idle' },
  awaiting_captcha: { label: 'Ожидает капчи', cls: 'idle' },
  awaiting_2fa: { label: 'Ожидает 2FA', cls: 'idle' },
  ready: { label: 'Готов к выдаче', cls: 'ok' },
  claimed: { label: 'У воркера', cls: 'run' },
  purchasing: { label: 'Покупка', cls: 'run' },
  claiming: { label: 'Зачисление', cls: 'run' },
  verifying: { label: 'Проверка', cls: 'run' },
  delivered: { label: 'Выдано', cls: 'ok' },
  failed: { label: 'Ошибка', cls: 'err' },
  canceled: { label: 'Отменён', cls: 'muted' },
}

// ── Заказы (метод MS Store) ──────────────────────────────────────────────────
function OrderRow({ order, msAccounts, onLogin, onCancel }) {
  const meta = ORDER_STATUS[order.status] || { label: order.status, cls: 'muted' }
  const [open, setOpen] = useState(false)
  const [showLogin, setShowLogin] = useState(false)
  const [username, setUsername] = useState(order.buyerUsername || '')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [loginResult, setLoginResult] = useState(null)

  const ms = msAccounts.find((m) => m.id === order.microsoftAccountId)
  const lastLog = order.log && order.log.length ? order.log[order.log.length - 1] : null

  const doLogin = async (e) => {
    e.preventDefault()
    setBusy(true)
    setLoginResult(null)
    const res = await onLogin(order.id, username.trim(), password)
    setBusy(false)
    setLoginResult(res)
    if (res.ok && res.status === 'ready') {
      setShowLogin(false)
      setPassword('')
    }
  }

  return (
    <article className={`card roblox-order roblox-order--${meta.cls}`}>
      <div className="roblox-order__top">
        <span className="roblox-order__pid">{order.publicId}</span>
        <span className="roblox-order__amount">{formatRobux(order.robuxAmount)}</span>
        <span className="roblox-order__buyer">@{order.buyerUsername || '—'}</span>
        <span className={`roblox-chip roblox-chip--${meta.cls}`}>{meta.label}</span>
      </div>
      <div className="roblox-order__meta">
        <span>MS: {ms ? ms.label || ms.email || ms.id : '—'}</span>
        {lastLog ? <span className="roblox-order__phase" title={lastLog.message}>· {lastLog.message}</span> : null}
      </div>

      <div className="roblox-order__actions">
        {order.status === 'awaiting_login' || order.status === 'awaiting_captcha' || order.status === 'awaiting_2fa' ? (
          <button type="button" className="btn-secondary" onClick={() => setShowLogin((v) => !v)}>
            {showLogin ? 'Скрыть вход' : 'Войти в аккаунт покупателя'}
          </button>
        ) : null}
        {order.log && order.log.length ? (
          <button type="button" className="btn-secondary" onClick={() => setOpen((v) => !v)}>
            {open ? 'Скрыть лог' : `Лог (${order.log.length})`}
          </button>
        ) : null}
        {order.status !== 'delivered' && order.status !== 'canceled' && order.status !== 'failed' ? (
          <button type="button" className="btn-secondary roblox-order__cancel" onClick={() => onCancel(order.id)}>
            Отменить
          </button>
        ) : null}
      </div>

      {showLogin ? (
        <form className="roblox-order__login" onSubmit={doLogin}>
          <input
            className="input-theme"
            placeholder="Логин Roblox покупателя"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="off"
          />
          <input
            className="input-theme"
            type="password"
            placeholder="Пароль покупателя"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="off"
          />
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? 'Входим…' : 'Войти'}
          </button>
          {loginResult && !loginResult.ok ? (
            <p className="settings-message settings-message--error">{loginResult.error}</p>
          ) : null}
          {loginResult && loginResult.ok && loginResult.needsCaptcha ? (
            <div className="roblox-order__twofa">
              <p className="settings-message settings-message--success">
                Нужна капча. Отправьте покупателю ссылку — он решит проверку, и вход продолжится:
              </p>
              <div className="roblox-inline-row">
                <input className="input-theme" readOnly value={loginResult.captchaUrl} onFocus={(e) => e.target.select()} />
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => navigator.clipboard?.writeText(loginResult.captchaUrl)}
                >
                  Копировать
                </button>
              </div>
            </div>
          ) : null}
          {loginResult && loginResult.ok && loginResult.needs2fa ? (
            <div className="roblox-order__twofa">
              <p className="settings-message settings-message--success">
                Нужна 2FA ({loginResult.mediaType}). Отправьте покупателю ссылку для ввода кода:
              </p>
              <div className="roblox-inline-row">
                <input className="input-theme" readOnly value={loginResult.twofaUrl} onFocus={(e) => e.target.select()} />
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => navigator.clipboard?.writeText(loginResult.twofaUrl)}
                >
                  Копировать
                </button>
              </div>
            </div>
          ) : null}
        </form>
      ) : null}

      {open && order.log ? (
        <ul className="roblox-order__log">
          {order.log.map((l, i) => (
            <li key={i}>
              <span className="roblox-order__log-phase">{l.phase || '—'}</span>
              <span>{l.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </article>
  )
}

function OrdersPanel({ msAccounts }) {
  const [orders, setOrders] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [amount, setAmount] = useState('')
  const [buyer, setBuyer] = useState('')
  const [msId, setMsId] = useState('')
  const [note, setNote] = useState('')
  const [creating, setCreating] = useState(false)
  const pollRef = useRef(null)

  const load = async () => {
    const res = await fetchOrders()
    if (res.ok) {
      setOrders(res.orders)
      setError(null)
    } else {
      setError(res.error)
    }
    setLoading(false)
  }

  useEffect(() => {
    load()
    pollRef.current = setInterval(load, 3000)
    return () => clearInterval(pollRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleCreate = async (e) => {
    e.preventDefault()
    setCreating(true)
    const res = await createOrder({
      robuxAmount: Number(amount),
      buyerUsername: buyer.trim() || undefined,
      microsoftAccountId: msId ? Number(msId) : undefined,
      note: note.trim() || undefined,
    })
    setCreating(false)
    if (res.ok) {
      setAmount('')
      setBuyer('')
      setNote('')
      await load()
    } else {
      setError(res.error)
    }
  }

  const handleLogin = async (orderId, username, password) => {
    const res = await orderLogin({ orderId, username, password })
    await load()
    return res
  }

  const handleCancel = async (orderId) => {
    await cancelOrder(orderId)
    await load()
  }

  return (
    <div className="tab-grid">
      <section className="card" style={{ gridColumn: '1 / -1' }}>
        <h2 className="roblox-section-title">Новый заказ</h2>
        <form className="settings-form" onSubmit={handleCreate}>
          <div className="roblox-deliver-controls">
            <div className="roblox-field roblox-field--narrow">
              <label className="roblox-field-label">Robux</label>
              <input
                className="input-theme"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
                placeholder="напр. 1000"
                inputMode="numeric"
              />
            </div>
            <div className="roblox-field">
              <label className="roblox-field-label">Логин покупателя (необязательно)</label>
              <input className="input-theme" value={buyer} onChange={(e) => setBuyer(e.target.value)} placeholder="username" />
            </div>
            <div className="roblox-field">
              <label className="roblox-field-label">Microsoft-аккаунт (оплата)</label>
              <select className="input-theme" value={msId} onChange={(e) => setMsId(e.target.value)}>
                <option value="">— выбрать —</option>
                {msAccounts.map((m) => (
                  <option key={m.id} value={m.id}>
                    {(m.label || m.email || `MS ${m.id}`)}{m.region ? ` · ${m.region}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <button type="submit" className="btn-primary roblox-deliver-btn" disabled={creating || !amount}>
              {creating ? 'Создаём…' : 'Создать заказ'}
            </button>
          </div>
        </form>
        {error ? <p className="settings-message settings-message--error">{error}</p> : null}
      </section>

      <section className="card" style={{ gridColumn: '1 / -1' }}>
        <h2 className="roblox-section-title">Заказы ({orders.length})</h2>
        {loading ? (
          <p className="roblox-empty">Загрузка…</p>
        ) : orders.length === 0 ? (
          <p className="roblox-empty">Заказов пока нет.</p>
        ) : (
          <div className="roblox-order-list">
            {orders.map((o) => (
              <OrderRow key={o.id} order={o} msAccounts={msAccounts} onLogin={handleLogin} onCancel={handleCancel} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

// ── Microsoft-аккаунты ───────────────────────────────────────────────────────
function MsAccountsPanel({ accounts, reload }) {
  const [label, setLabel] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [region, setRegion] = useState('')
  const [balance, setBalance] = useState('')
  const [currency, setCurrency] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const handleAdd = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const res = await addMsAccount({
      label: label.trim() || undefined,
      email: email.trim(),
      password,
      region: region.trim() || undefined,
      balanceAmount: balance ? Number(balance) : undefined,
      balanceCurrency: currency.trim() || undefined,
    })
    setBusy(false)
    if (res.ok) {
      setLabel('')
      setEmail('')
      setPassword('')
      setRegion('')
      setBalance('')
      setCurrency('')
      await reload()
    } else {
      setError(res.error)
    }
  }

  const handleDelete = async (m) => {
    if (!window.confirm(`Удалить MS-аккаунт ${m.label || m.email}?`)) return
    await deleteMsAccount(m.id)
    await reload()
  }

  return (
    <div className="tab-grid">
      <section className="card" style={{ gridColumn: '1 / -1' }}>
        <h2 className="roblox-section-title">Добавить Microsoft-аккаунт</h2>
        <p className="roblox-hint" style={{ marginTop: 0 }}>
          Баланс MS Store (от подарочных карт) тратится на покупку Robux. Microsoft привязывает
          валюту к рынку аккаунта — указывайте регион (напр. TR, AR), VPN это не обходит.
        </p>
        <form className="settings-form" onSubmit={handleAdd}>
          <div className="roblox-deliver-controls">
            <div className="roblox-field"><label className="roblox-field-label">Название</label>
              <input className="input-theme" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="напр. MS-01" /></div>
            <div className="roblox-field"><label className="roblox-field-label">Email</label>
              <input className="input-theme" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="account@outlook.com" autoComplete="off" /></div>
            <div className="roblox-field"><label className="roblox-field-label">Пароль</label>
              <input className="input-theme" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" /></div>
            <div className="roblox-field roblox-field--narrow"><label className="roblox-field-label">Регион</label>
              <input className="input-theme" value={region} onChange={(e) => setRegion(e.target.value)} placeholder="TR" /></div>
            <div className="roblox-field roblox-field--narrow"><label className="roblox-field-label">Баланс</label>
              <input className="input-theme" value={balance} onChange={(e) => setBalance(e.target.value.replace(/[^\d.]/g, ''))} placeholder="50" inputMode="decimal" /></div>
            <div className="roblox-field roblox-field--narrow"><label className="roblox-field-label">Валюта</label>
              <input className="input-theme" value={currency} onChange={(e) => setCurrency(e.target.value)} placeholder="TRY" /></div>
            <button type="submit" className="btn-primary roblox-deliver-btn" disabled={busy || !email}>
              {busy ? 'Добавляем…' : 'Добавить'}
            </button>
          </div>
          {error ? <p className="settings-message settings-message--error">{error}</p> : null}
        </form>
      </section>

      <section className="card" style={{ gridColumn: '1 / -1' }}>
        <h2 className="roblox-section-title">Microsoft-аккаунты ({accounts.length})</h2>
        {accounts.length === 0 ? (
          <p className="roblox-empty">Аккаунтов пока нет.</p>
        ) : (
          <div className="roblox-acc-grid">
            {accounts.map((m) => (
              <article key={m.id} className="card roblox-acc">
                <div className="roblox-acc__head">
                  <div className="roblox-acc__id">
                    <span className="roblox-acc__name">{m.label || m.email}</span>
                    <span className="roblox-acc__login">{m.email}{m.region ? ` · ${m.region}` : ''}</span>
                  </div>
                </div>
                <div className="roblox-acc__stats">
                  <div><span className="roblox-acc__stat-label">Баланс</span>
                    <span className="roblox-acc__stat-value">{m.balanceAmount != null ? `${m.balanceAmount} ${m.balanceCurrency || ''}` : '—'}</span></div>
                  <div><span className="roblox-acc__stat-label">Статус</span>
                    <span className="roblox-acc__stat-value">{m.status}</span></div>
                </div>
                <div className="roblox-acc__actions">
                  <button type="button" className="btn-secondary roblox-acc__del" onClick={() => handleDelete(m)}>Удалить</button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

// ── Аккаунты Roblox (общие для метода MS Store) ──────────────────────────────
function AccountsPanel() {
  const [accounts, setAccounts] = useState([])
  const [loading, setLoading] = useState(true)
  const [cookie, setCookie] = useState('')
  const [adding, setAdding] = useState(false)
  const [addMessage, setAddMessage] = useState(null)
  const [addError, setAddError] = useState(null)

  const loadAccounts = async () => {
    const res = await fetchRobloxAccounts()
    if (res.ok) setAccounts(res.accounts)
    setLoading(false)
  }

  useEffect(() => {
    loadAccounts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleAdd = async (e) => {
    e.preventDefault()
    setAddMessage(null)
    setAddError(null)
    if (!cookie.trim()) return setAddError('Вставьте cookie .ROBLOSECURITY')
    setAdding(true)
    const res = await addRobloxAccount(cookie.trim())
    setAdding(false)
    if (!res.ok) return setAddError(res.error)
    setCookie('')
    setAddMessage(`Аккаунт ${res.account?.username || res.account?.robloxUserId} добавлен`)
    await loadAccounts()
  }

  const handleDelete = async (account) => {
    if (!window.confirm(`Удалить аккаунт ${account.username || account.robloxUserId}?`)) return
    await deleteRobloxAccount(account.id)
    await loadAccounts()
  }

  return (
    <div className="tab-grid">
      <section className="card" style={{ gridColumn: '1 / -1' }}>
        <p className="roblox-hint" style={{ marginTop: 0 }}>
          Аккаунты Roblox метода MS Store: ваши seed-аккаунты (добавленные по cookie) и сохранённые
          сессии покупателей после входа. Используются для проверки баланса и выдачи воркером.
        </p>
        <h2 className="roblox-section-title">Добавить аккаунт (cookie)</h2>
        <form className="settings-form" onSubmit={handleAdd}>
          <textarea
            className="input-theme roblox-cookie-input"
            value={cookie}
            onChange={(e) => setCookie(e.target.value)}
            placeholder="_|WARNING:-DO-NOT-SHARE-THIS...|_AB12..."
            rows={2}
            spellCheck={false}
          />
          <div className="token-actions">
            <button type="submit" className="btn-primary" disabled={adding}>
              {adding ? 'Проверяем…' : 'Добавить аккаунт'}
            </button>
          </div>
          {addMessage ? <p className="settings-message settings-message--success">{addMessage}</p> : null}
          {addError ? <p className="settings-message settings-message--error">{addError}</p> : null}
        </form>
      </section>

      <section className="card" style={{ gridColumn: '1 / -1' }}>
        <h2 className="roblox-section-title">Аккаунты ({accounts.length})</h2>
        {loading ? (
          <p className="roblox-empty">Загрузка…</p>
        ) : accounts.length === 0 ? (
          <p className="roblox-empty">Аккаунтов пока нет.</p>
        ) : (
          <div className="roblox-acc-grid">
            {accounts.map((acc) => {
              const meta = ACCOUNT_STATUS[acc.status] || { label: acc.status, cls: 'muted' }
              return (
                <article key={acc.id} className={`card roblox-acc roblox-acc--${meta.cls}`}>
                  <div className="roblox-acc__head">
                    {acc.avatarUrl ? <img className="roblox-acc__avatar" src={acc.avatarUrl} alt="" /> : <span className="roblox-acc__avatar roblox-acc__avatar--empty">🎮</span>}
                    <div className="roblox-acc__id">
                      <span className="roblox-acc__name">{acc.displayName || acc.username || acc.robloxUserId}</span>
                      <span className="roblox-acc__login">@{acc.username || acc.robloxUserId}</span>
                    </div>
                    <span className={`roblox-chip roblox-chip--${meta.cls}`}>{meta.label}</span>
                  </div>
                  <div className="roblox-acc__stats">
                    <div><span className="roblox-acc__stat-label">Баланс</span><span className="roblox-acc__stat-value">{formatRobux(acc.robux)}</span></div>
                    <div><span className="roblox-acc__stat-label">User ID</span><span className="roblox-acc__stat-value">{acc.robloxUserId}</span></div>
                  </div>
                  <div className="roblox-acc__actions">
                    <button type="button" className="btn-secondary" onClick={() => refreshRobloxAccount(acc.id).then(loadAccounts)}>Обновить</button>
                    <button type="button" className="btn-secondary roblox-acc__del" onClick={() => handleDelete(acc)}>Удалить</button>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>
    </div>
  )
}

const VIEWS = [
  { id: 'orders', label: 'Заказы (MS Store)' },
  { id: 'ms', label: 'Microsoft-аккаунты' },
  { id: 'accounts', label: 'Аккаунты Roblox' },
]

export function RobloxTab() {
  const [view, setView] = useState('orders')
  const [msAccounts, setMsAccounts] = useState([])

  const reloadMs = async () => {
    const res = await fetchMsAccounts()
    if (res.ok) setMsAccounts(res.accounts)
  }

  useEffect(() => {
    reloadMs()
  }, [])

  return (
    <div className="tab-page">
      <div className="tab-page-header">
        <h1>Роблокс</h1>
        <div className="exec-subtabs" role="tablist" aria-label="Разделы Roblox">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={view === v.id}
              className={`exec-subtab${view === v.id ? ' exec-subtab--active' : ''}`}
              onClick={() => setView(v.id)}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>
      <p className="tab-page-description">
        Автовыдача Robux методом «Microsoft Store» (как swizzyer.com): заказ → вход в аккаунт покупателя
        (hosted 2FA) → Windows-воркер покупает Robux за баланс MS-аккаунта. Шаг покупки выполняет
        отдельный воркер на Windows (см. worker/msstore-worker).
      </p>

      {view === 'orders' ? <OrdersPanel msAccounts={msAccounts} /> : null}
      {view === 'ms' ? <MsAccountsPanel accounts={msAccounts} reload={reloadMs} /> : null}
      {view === 'accounts' ? <AccountsPanel /> : null}
    </div>
  )
}
