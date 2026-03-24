import React, { useEffect, useState } from 'react'
import { changeAccountPassword, fetchAuthMe } from '../../services/authApi'

export function SettingsTab({ token, onTokenChange }) {
  const [value, setValue] = useState(token ?? '')
  const [savedAt, setSavedAt] = useState(null)
  const [isSaved, setIsSaved] = useState(Boolean(token))

  const [meLoading, setMeLoading] = useState(true)
  const [accountLogin, setAccountLogin] = useState(null)
  const [userId, setUserId] = useState(null)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [pwdSubmitting, setPwdSubmitting] = useState(false)
  const [pwdMessage, setPwdMessage] = useState(null)
  const [pwdError, setPwdError] = useState(null)

  useEffect(() => {
    setValue(token ?? '')
    setIsSaved(Boolean(token))
  }, [token])

  useEffect(() => {
    let cancelled = false
    setMeLoading(true)
    fetchAuthMe().then((r) => {
      if (cancelled) return
      if (r.ok) {
        setAccountLogin(r.login)
        setUserId(r.userId)
      } else {
        setAccountLogin(null)
        setUserId(null)
      }
      setMeLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  const accountLabel =
    accountLogin ||
    (userId != null && Number.isFinite(Number(userId)) ? `Пользователь #${userId}` : null) ||
    '—'

  const showLoginHint =
    !meLoading && accountLabel === '—'

  const handleSaveToken = (event) => {
    event.preventDefault()
    onTokenChange?.(value.trim())
    setValue('')
    setIsSaved(true)
    setSavedAt(new Date())
  }

  const handleClearToken = () => {
    setValue('')
    onTokenChange?.('')
    setIsSaved(false)
    setSavedAt(new Date())
  }

  const handlePasswordSubmit = async (event) => {
    event.preventDefault()
    setPwdMessage(null)
    setPwdError(null)
    if (newPassword !== confirmPassword) {
      setPwdError('Новый пароль и подтверждение не совпадают')
      return
    }
    setPwdSubmitting(true)
    const r = await changeAccountPassword(currentPassword, newPassword)
    setPwdSubmitting(false)
    if (r.ok) {
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setPwdMessage('Пароль обновлён')
    } else {
      setPwdError(r.error || 'Ошибка')
    }
  }

  return (
    <div className="tab-page">
      <div className="tab-page-header">
        <h1>Настройки</h1>
      </div>

      <div className="tab-grid">
        <section className="card" style={{ marginBottom: '1rem' }}>
          <h2 className="card-title" style={{ fontSize: '1rem', marginBottom: '0.75rem' }}>
            Аккаунт
          </h2>
          {meLoading ? (
            <p className="card-text" style={{ fontSize: '0.9rem' }}>Загрузка…</p>
          ) : (
            <>
              <p className="card-text" style={{ fontSize: '0.95rem' }}>
                <span style={{ color: 'var(--text-muted)' }}>Имя (логин): </span>
                <strong>{accountLabel}</strong>
              </p>
              {showLoginHint && (
                <p
                  className="card-text"
                  style={{ fontSize: '0.85rem', marginTop: '0.75rem', color: 'var(--text-muted)' }}
                >
                  Не удалось загрузить логин. Выйдите и войдите снова или обновите страницу.
                </p>
              )}
            </>
          )}
        </section>

        <section className="card">
          <h2 className="card-title" style={{ fontSize: '1rem', marginBottom: '0.75rem' }}>
            Токен Playerok
          </h2>
          <form onSubmit={handleSaveToken}>
            <label
              htmlFor="playerok-token"
              style={{ display: 'block', fontSize: '0.85rem', marginBottom: 6 }}
            >
              Токен
            </label>
            <input
              id="playerok-token"
              className="input-theme"
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={isSaved ? 'Токен сохранён (скрыт)' : 'Вставьте токен сюда'}
              autoComplete="off"
            />

            <div className="token-actions">
              <button type="submit" className="btn-primary">
                Сохранить токен
              </button>
              <button type="button" onClick={handleClearToken} className="btn-secondary">
                Очистить
              </button>

              {savedAt && (
                <span className="card-text" style={{ fontSize: '0.8rem', marginLeft: '0.5rem' }}>
                  Обновлён: {savedAt.toLocaleTimeString()}
                </span>
              )}
            </div>
          </form>
        </section>

        <section className="card" style={{ marginTop: '1rem' }}>
          <h2 className="card-title" style={{ fontSize: '1rem', marginBottom: '0.75rem' }}>
            Пароль от аккаунта
          </h2>
          <form onSubmit={handlePasswordSubmit}>
            <label htmlFor="settings-current-pwd" style={{ display: 'block', fontSize: '0.85rem', marginBottom: 6 }}>
              Текущий пароль
            </label>
            <input
              id="settings-current-pwd"
              className="input-theme"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              style={{ marginBottom: '0.75rem', width: '100%', maxWidth: '24rem' }}
            />
            <label htmlFor="settings-new-pwd" style={{ display: 'block', fontSize: '0.85rem', marginBottom: 6 }}>
              Новый пароль
            </label>
            <input
              id="settings-new-pwd"
              className="input-theme"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              style={{ marginBottom: '0.75rem', width: '100%', maxWidth: '24rem' }}
            />
            <label htmlFor="settings-confirm-pwd" style={{ display: 'block', fontSize: '0.85rem', marginBottom: 6 }}>
              Подтверждение нового пароля
            </label>
            <input
              id="settings-confirm-pwd"
              className="input-theme"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              style={{ marginBottom: '1rem', width: '100%', maxWidth: '24rem' }}
            />
            {pwdError && (
              <p style={{ color: 'var(--danger, #c62828)', fontSize: '0.85rem', marginBottom: '0.75rem' }}>
                {pwdError}
              </p>
            )}
            {pwdMessage && (
              <p style={{ color: 'var(--success, #2e7d32)', fontSize: '0.85rem', marginBottom: '0.75rem' }}>
                {pwdMessage}
              </p>
            )}
            <button type="submit" className="btn-primary" disabled={pwdSubmitting}>
              {pwdSubmitting ? 'Сохранение…' : 'Сменить пароль'}
            </button>
          </form>
        </section>
      </div>
    </div>
  )
}
