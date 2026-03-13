import React, { useEffect, useState } from 'react'

export function TokenTab({ token, onTokenChange }) {
  const [value, setValue] = useState(token ?? '')
  const [savedAt, setSavedAt] = useState(null)
  const [isSaved, setIsSaved] = useState(Boolean(token))

  useEffect(() => {
    setValue(token ?? '')
    setIsSaved(Boolean(token))
  }, [token])

  const handleSave = (event) => {
    event.preventDefault()
    onTokenChange?.(value.trim())
    setValue('')
    setIsSaved(true)
    setSavedAt(new Date())
  }

  const handleClear = () => {
    setValue('')
    onTokenChange?.('')
    setIsSaved(false)
    setSavedAt(new Date())
  }

  return (
    <div className="tab-page">
      <div className="tab-page-header">
        <h1>Токен</h1>
      </div>

      <div className="tab-grid">
        <section className="card">
          <form onSubmit={handleSave} style={{ marginTop: '1rem' }}>
            <label
              htmlFor="playerok-token"
              style={{ display: 'block', fontSize: '0.85rem', marginBottom: 6 }}
            >
              Токен Playerok
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
              <button type="button" onClick={handleClear} className="btn-secondary">
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
      </div>
    </div>
  )
}
