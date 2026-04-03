import React, { useEffect, useState } from 'react'
import { changeAccountPassword, fetchAuthMe } from '../../services/authApi'

export function SettingsTab({ token, onTokenChange, onLogout }) {
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
    <div className="tab-page settings-page">
      <div className="tab-page-header tab-page-header--settings">
        <h1>Настройки</h1>
      </div>

      <div className="settings-layout">
        <section className="card settings-card settings-card--account">
          <div className="card-title-row settings-account-head">
            <div>
              <h2 className="card-title">Аккаунт</h2>
              <p className="card-text settings-hint settings-account-hint">
                Основная информация по текущей сессии.
              </p>
            </div>
            <span className="settings-chip">
              {meLoading ? 'Проверка соединения...' : 'Аккаунт подключён'}
            </span>
          </div>
          {meLoading ? (
            <p className="card-text">Загрузка…</p>
          ) : (
            <>
              <p className="card-text">
                <span className="settings-meta-key">Имя (логин): </span>
                <strong className="settings-meta-value">{accountLabel}</strong>
              </p>
              {showLoginHint && (
                <p className="card-text settings-hint">
                  Не удалось загрузить логин. Выйдите и войдите снова или обновите страницу.
                </p>
              )}
              <div className="settings-account-actions">
                <button
                  type="button"
                  className="btn-secondary settings-logout-btn"
                  onClick={onLogout}
                >
                  Выйти из аккаунта
                </button>
              </div>
            </>
          )}
        </section>

        <section className="card settings-card settings-card--token">
          <h2 className="card-title">Токен Playerok</h2>
          <p className="card-text settings-hint">Токен хранится в скрытом виде и используется для запросов к API.</p>
          <form className="settings-form" onSubmit={handleSaveToken}>
            <label htmlFor="playerok-token" className="settings-label">
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
                <span className="card-text settings-updated-at">
                  Обновлён: {savedAt.toLocaleTimeString()}
                </span>
              )}
            </div>
          </form>
        </section>

        <section className="card settings-card settings-card--password">
          <h2 className="card-title">Пароль от аккаунта</h2>
          <p className="card-text settings-hint">Используйте надежный пароль и не передавайте его третьим лицам.</p>
          <form className="settings-form" onSubmit={handlePasswordSubmit}>
            <label htmlFor="settings-current-pwd" className="settings-label">
              Текущий пароль
            </label>
            <input
              id="settings-current-pwd"
              className="input-theme settings-input"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
            />
            <label htmlFor="settings-new-pwd" className="settings-label">
              Новый пароль
            </label>
            <input
              id="settings-new-pwd"
              className="input-theme settings-input"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
            />
            <label htmlFor="settings-confirm-pwd" className="settings-label">
              Подтверждение нового пароля
            </label>
            <input
              id="settings-confirm-pwd"
              className="input-theme settings-input"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
            />
            {pwdError && (
              <p className="settings-message settings-message--error">
                {pwdError}
              </p>
            )}
            {pwdMessage && (
              <p className="settings-message settings-message--success">
                {pwdMessage}
              </p>
            )}
            <button type="submit" className="btn-primary settings-password-submit" disabled={pwdSubmitting}>
              {pwdSubmitting ? 'Сохранение…' : 'Сменить пароль'}
            </button>
          </form>
        </section>
      </div>
    </div>
  )
}
