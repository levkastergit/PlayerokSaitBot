import React, { useEffect, useState } from 'react'

export function TokenTab({ token, onTokenChange }) {
  const [value, setValue] = useState(token ?? '')
  const [savedAt, setSavedAt] = useState(null)

  useEffect(() => {
    setValue(token ?? '')
  }, [token])

  const handleSave = (event) => {
    event.preventDefault()
    onTokenChange?.(value.trim())
    setSavedAt(new Date())
  }

  const handleClear = () => {
    setValue('')
    onTokenChange?.('')
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
            <textarea
              id="playerok-token"
              className="input-theme"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              rows={3}
              placeholder="Вставьте токен сюда"
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
