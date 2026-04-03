import React, { useEffect, useMemo, useState } from 'react'
import { loadCategoryCommandsList, saveCategoryCommands } from '../../services/playerokApi'

export function CommandsTab({ token, lots = [], loadingLots = false, errorLots = null }) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [allCategoryCommands, setAllCategoryCommands] = useState([]) // [{ category, commands }]
  const [selectedCategory, setSelectedCategory] = useState('')
  const [draftCommands, setDraftCommands] = useState([]) // команды текущей категории
  const [toast, setToast] = useState(null)

  const hasToken = Boolean(token)

  // Категории из активных лотов (вкладка «Активные») — поле game
  const categoriesFromLots = useMemo(() => {
    const set = new Set()
    for (const lot of lots || []) {
      const game = (lot.game ?? '').trim()
      if (game) set.add(game)
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'ru'))
  }, [lots])

  useEffect(() => {
    if (!token) {
      setAllCategoryCommands([])
      setSelectedCategory('')
      setDraftCommands([])
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    loadCategoryCommandsList(token)
      .then(({ list }) => {
        if (cancelled) return
        setAllCategoryCommands(list || [])
        if (!selectedCategory && (list || []).length > 0) {
          setSelectedCategory((list[0] && list[0].category) || '')
          setDraftCommands((list[0] && Array.isArray(list[0].commands) ? list[0].commands : []) || [])
        }
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Ошибка загрузки команд категорий')
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  // При появлении категорий из лотов выбираем первую, если ничего не выбрано
  useEffect(() => {
    if (categoriesFromLots.length > 0 && !selectedCategory) {
      setSelectedCategory(categoriesFromLots[0])
      const found = (allCategoryCommands || []).find((c) => c.category === categoriesFromLots[0])
      setDraftCommands(found && Array.isArray(found.commands) ? found.commands : [])
    }
  }, [categoriesFromLots, allCategoryCommands, selectedCategory])

  // При смене категории или загрузке сохранённых команд — показывать команды для выбранной категории
  useEffect(() => {
    if (!selectedCategory) return
    const found = (allCategoryCommands || []).find((c) => c.category === selectedCategory)
    setDraftCommands(found && Array.isArray(found.commands) ? found.commands : [])
  }, [allCategoryCommands, selectedCategory])

  const handleSelectCategory = (category) => {
    setSelectedCategory(category)
    const found = (allCategoryCommands || []).find((c) => c.category === category)
    setDraftCommands(found && Array.isArray(found.commands) ? found.commands : [])
  }

  const handleAddCommandRow = () => {
    setDraftCommands((prev) => [
      ...prev,
      {
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        label: '',
        text: '',
        color: '#6c757d', // серый цвет по умолчанию
      },
    ])
  }

  const handleChangeCommand = (index, field, value) => {
    setDraftCommands((prev) => {
      const next = [...prev]
      if (!next[index]) return prev
      next[index] = { ...next[index], [field]: value }
      return next
    })
  }

  const handleRemoveCommand = (index) => {
    setDraftCommands((prev) => prev.filter((_, i) => i !== index))
  }

  const showToast = (type, message) => {
    setToast({ type, message })
    setTimeout(() => {
      setToast(null)
    }, 2500)
  }

  const handleSave = async () => {
    const category = (selectedCategory || '').trim()
    if (!category) {
      showToast('error', 'Сначала выберите категорию из списка')
      return
    }
    const cleanedCommands = draftCommands
      .map((c) => ({
        ...c,
        label: (c.label || '').trim(),
        text: (c.text || '').trim(),
        color: (c.color || '#6c757d').trim(), // сохраняем цвет или используем серый по умолчанию
      }))
      .filter((c) => c.label || c.text)

    try {
      setSaving(true)
      await saveCategoryCommands(token, category, cleanedCommands)
      const { list } = await loadCategoryCommandsList(token)
      setAllCategoryCommands(list || [])
      setSelectedCategory(category)
      const found = (list || []).find((c) => c.category === category)
      setDraftCommands(found && Array.isArray(found.commands) ? found.commands : cleanedCommands)
      showToast('success', 'Команды сохранены')
    } catch (err) {
      showToast(
        'error',
        err instanceof Error ? err.message : 'Ошибка сохранения команд'
      )
    } finally {
      setSaving(false)
    }
  }

  const effectiveSelectedCategory = (selectedCategory || '').trim()

  return (
    <div className="tab-page">
      <div className="tab-page-header">
        <h1>Команды по категориям</h1>
      </div>

      <div className="tab-grid">
        <section className="card">
          <h2 className="card-title">Категории (из активных лотов)</h2>
          {!hasToken && (
            <p className="card-text">
              Укажите токен во вкладке «Токен», чтобы настраивать команды по
              категориям.
            </p>
          )}
          {hasToken && (loadingLots || loading) && (
            <p className="card-text">Загружаем категории и команды…</p>
          )}
          {hasToken && !loading && error && (
            <p className="card-text card-text--error">{error}</p>
          )}
          {hasToken && errorLots && (
            <p className="card-text card-text--error">
              Ошибка загрузки лотов: {errorLots}
            </p>
          )}
          {hasToken && !loading && !error && !loadingLots && (
            <>
              {categoriesFromLots.length === 0 && (
                <p className="card-text">
                  Список категорий берётся из вкладки «Активные». Зайдите в
                  «Активные» и дождитесь загрузки лотов — здесь появятся
                  категории (игры).
                </p>
              )}
              {categoriesFromLots.length > 0 && (
                <div className="deal-category-filter">
                  {categoriesFromLots.map((cat) => (
                    <button
                      key={cat}
                      type="button"
                      className={
                        effectiveSelectedCategory === cat
                          ? 'deal-category-filter__chip deal-category-filter__chip--active'
                          : 'deal-category-filter__chip'
                      }
                      onClick={() => handleSelectCategory(cat)}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </section>

        <section className="card">
          <div className="card-title-row">
            <h2 className="card-title">Команды категории</h2>
          </div>

          {!hasToken && (
            <p className="card-text">
              Настройка команд недоступна без токена.
            </p>
          )}

          {hasToken && (
            <>
              <div className="field" style={{ marginBottom: '0.75rem' }}>
                <label className="field-label">Категория</label>
                {categoriesFromLots.length === 0 ? (
                  <p className="card-text" style={{ fontSize: '0.9rem' }}>
                    Сначала загрузите активные лоты (вкладка «Активные») — список
                    категорий подставится автоматически.
                  </p>
                ) : (
                  <select
                    className="input"
                    value={effectiveSelectedCategory}
                    onChange={(e) => handleSelectCategory(e.target.value)}
                    style={{ maxWidth: '20rem' }}
                  >
                    {categoriesFromLots.map((cat) => (
                      <option key={cat} value={cat}>
                        {cat}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div className="field" style={{ marginBottom: '0.75rem' }}>
                <div className="field-label">Команды</div>
                {draftCommands.length === 0 && (
                  <p className="card-text" style={{ fontSize: '0.9rem' }}>
                    Пока нет ни одной команды. Добавьте кнопку, например
                    «Тест2» с текстом сообщения для покупателя.
                  </p>
                )}
                <div className="commands-list">
                  {draftCommands.map((cmd, index) => (
                    <div key={cmd.id || index} className="commands-list__row">
                      <input
                        type="text"
                        className="commands-list__input commands-list__input--label"
                        placeholder="Название кнопки (например, Тест2)"
                        value={cmd.label || ''}
                        onChange={(e) =>
                          handleChangeCommand(index, 'label', e.target.value)
                        }
                      />
                      <input
                        type="text"
                        className="commands-list__input commands-list__input--text"
                        placeholder="Текст сообщения, которое уйдёт в чат"
                        value={cmd.text || ''}
                        onChange={(e) =>
                          handleChangeCommand(index, 'text', e.target.value)
                        }
                      />
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <label
                          style={{
                            fontSize: '0.875rem',
                            color: 'var(--text-secondary, #666)',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          Цвет:
                        </label>
                        <input
                          type="color"
                          value={cmd.color || '#6c757d'}
                          onChange={(e) =>
                            handleChangeCommand(index, 'color', e.target.value)
                          }
                          style={{
                            width: '40px',
                            height: '32px',
                            border: '1px solid var(--border-color, #ddd)',
                            borderRadius: '4px',
                            cursor: 'pointer',
                          }}
                          title="Выберите цвет кнопки"
                        />
                      </div>
                      <button
                        type="button"
                        className="commands-list__delete"
                        onClick={() => handleRemoveCommand(index)}
                      >
                        Удалить
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div
                style={{
                  display: 'flex',
                  gap: '0.5rem',
                  flexWrap: 'wrap',
                  marginTop: '0.5rem',
                }}
              >
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={handleAddCommandRow}
                  disabled={!hasToken}
                >
                  Добавить команду
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={handleSave}
                  disabled={!hasToken || saving}
                >
                  {saving ? 'Сохраняем…' : 'Сохранить команды'}
                </button>
              </div>
            </>
          )}
        </section>
      </div>

      {toast && (
        <div
          className={
            toast.type === 'success' ? 'toast toast--success' : 'toast toast--error'
          }
        >
          {toast.message}
        </div>
      )}
    </div>
  )
}

