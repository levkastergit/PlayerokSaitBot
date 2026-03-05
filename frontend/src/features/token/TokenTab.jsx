import React, { useState } from 'react'

export function TokenTab({ token, onTokenChange }) {
  const [value, setValue] = useState(token ?? '')
  const [savedAt, setSavedAt] = useState(null)

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
        <p className="tab-page-description">
          Введите токен доступа к аккаунту на Playerok. Он будет использован для
          загрузки активных лотов и других действий.
        </p>
      </div>

      <div className="tab-grid">
        <section className="card">
          <h2 className="card-title">Токен доступа</h2>
          <p className="card-text">
            Токен хранится только локально в вашем браузере (localStorage) и не
            отправляется никуда кроме запросов к Playerok.
          </p>

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

        <section className="card">
          <h2 className="card-title">Безопасность</h2>
          <p className="card-text">
            Не передавайте токен третьим лицам. При утечке просто сгенерируйте
            новый токен на сайте Playerok и замените его здесь.
          </p>
        </section>
      </div>
    </div>
  )
}
