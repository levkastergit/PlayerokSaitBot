import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { fetchActiveLots } from '../../services/playerokApi'

export function ActiveLotsTab({ token, lotIdFromUrl }) {
  const navigate = useNavigate()
  const [lots, setLots] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [hiddenCategories, setHiddenCategories] = useState(() => new Set())
  const [soloCategory, setSoloCategory] = useState(null)
  const clickTimeoutRef = useRef(null)

  const hasToken = Boolean(token)
  const selectedLot =
    lotIdFromUrl && lots.length
      ? lots.find((l) => l.id === lotIdFromUrl) || null
      : null

  const categories = useMemo(() => {
    const names = new Set()
    lots.forEach((lot) => {
      const name = (lot.game || '').trim() || 'Без категории'
      names.add(name)
    })
    return [...names].sort((a, b) => a.localeCompare(b))
  }, [lots])

  const filteredLots = useMemo(() => {
    if (soloCategory !== null) {
      return lots.filter((lot) => {
        const name = (lot.game || '').trim() || 'Без категории'
        return name === soloCategory
      })
    }
    if (hiddenCategories.size === 0) return lots
    return lots.filter((lot) => {
      const name = (lot.game || '').trim() || 'Без категории'
      return !hiddenCategories.has(name)
    })
  }, [lots, hiddenCategories, soloCategory])

  const toggleCategory = (name) => {
    setSoloCategory(null)
    setHiddenCategories((prev) => {
      const next = new Set(prev)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const handleChipClick = (name) => {
    if (clickTimeoutRef.current) clearTimeout(clickTimeoutRef.current)
    clickTimeoutRef.current = setTimeout(() => {
      clickTimeoutRef.current = null
      toggleCategory(name)
    }, 250)
  }

  const handleChipDoubleClick = (name) => {
    if (clickTimeoutRef.current) {
      clearTimeout(clickTimeoutRef.current)
      clickTimeoutRef.current = null
    }
    setSoloCategory((prev) => (prev === name ? null : name))
  }

  useEffect(() => {
    let cancelled = false

    async function load() {
      if (!hasToken) {
        setLots([])
        setLoading(false)
        setError(null)
        return
      }

      setLoading(true)
      setError(null)

      try {
        const data = await fetchActiveLots(token)
        if (!cancelled) {
          setLots(data)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Неизвестная ошибка')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [token, hasToken])

  return (
    <div className="tab-page">
      <div className="tab-page-header">
        <h1>Активные лоты</h1>
        <p className="tab-page-description">
          Список всех активных лотов из вашего профиля Playerok.
        </p>
      </div>

      <div className="tab-grid">
        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <h2 className="card-title">Список активных лотов</h2>

          {!hasToken && (
            <p className="card-text">
              Чтобы увидеть активные лоты, сначала укажите токен во вкладке
              «Токен».
            </p>
          )}

          {hasToken && loading && (
            <p className="card-text">Загружаем лоты с Playerok...</p>
          )}

          {hasToken && !loading && error && (
            <p className="card-text card-text--error">
              Ошибка при загрузке лотов: {error}
            </p>
          )}

          {hasToken && !loading && !error && lots.length === 0 && (
            <p className="card-text">
              Активных лотов не найдено или API вернул пустой список.
            </p>
          )}

          {hasToken && !loading && !error && lots.length > 0 && !selectedLot && (
            <>
              <p className="card-text active-lots-total">
                Всего лотов: <strong>{lots.length}</strong>
                {filteredLots.length !== lots.length && (
                  <> (показано <strong>{filteredLots.length}</strong>)</>
                )}
              </p>
              {categories.length > 0 && (
                <div className="active-lots-filters">
                  <span className="active-lots-filters__label">Категории:</span>
                  <div className="active-lots-filters__chips">
                    {categories.map((name) => {
                      const isSolo = soloCategory === name
                      const isHidden = soloCategory !== null ? !isSolo : hiddenCategories.has(name)
                      return (
                        <button
                          key={name}
                          type="button"
                          className={`active-lots-filter-chip ${isHidden ? 'active-lots-filter-chip--hidden' : ''} ${isSolo ? 'active-lots-filter-chip--solo' : ''}`}
                          onClick={() => handleChipClick(name)}
                          onDoubleClick={() => handleChipDoubleClick(name)}
                          title={isSolo ? 'Двойной клик — показать все категории' : isHidden ? 'Клик — показать категорию. Двойной клик — оставить только эту' : 'Клик — скрыть категорию. Двойной клик — оставить только эту'}
                        >
                          {name}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
              <div className="lots-grid">
                {filteredLots.map((lot) => (
                  <article
                    key={lot.id}
                    className="lot-card"
                    onClick={() => navigate('/active/' + lot.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        navigate('/active/' + lot.id)
                      }
                    }}
                  >
                    <div className="lot-card__image-wrap">
                      {lot.imageUrl ? (
                        <img
                          src={lot.imageUrl}
                          alt=""
                          className="lot-card__image"
                          loading="lazy"
                        />
                      ) : (
                        <div className="lot-card__image-placeholder" aria-hidden="true">
                          Нет фото
                        </div>
                      )}
                    </div>
                    <div className="lot-card__body">
                      <p className="lot-card__price-row">
                        <span className="lot-card__price">
                          {Number(lot.price || 0).toLocaleString('ru-RU')}{' '}
                          {lot.currency || '₽'}
                        </span>
                        {lot.discount != null && lot.discount > 0 && (
                          <span className="lot-card__discount">
                            −{lot.discount}%
                          </span>
                        )}
                        {lot.oldPrice != null && Number(lot.oldPrice) > 0 && (
                          <span className="lot-card__old-price">
                            {Number(lot.oldPrice).toLocaleString('ru-RU')} ₽
                          </span>
                        )}
                      </p>
                      <h3 className="lot-card__title" title={lot.title}>
                        {lot.title}
                      </h3>
                      {(lot.game || lot.tags) && (
                        <p className="lot-card__tags">
                          {[lot.game, lot.tags].filter(Boolean).join(' · ')}
                        </p>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}

          {hasToken && !loading && !error && selectedLot && (
            <div className="lot-settings-page">
              <button
                type="button"
                className="lot-settings-page__back"
                onClick={() => navigate('/active')}
              >
                ← К списку лотов
              </button>
              <div className="lot-settings-page__header">
                <h2 className="lot-settings-page__title">Настройки товара</h2>
                <p className="lot-settings-page__product-name">{selectedLot.title}</p>
                {selectedLot.game && (
                  <p className="lot-settings-page__product-game">{selectedLot.game}</p>
                )}
              </div>

              <section className="lot-settings-block">
                <h3 className="lot-settings-block__title">Автовыдача</h3>
                <p className="card-text">
                  Здесь будут настройки автоматической выдачи товара покупателю.
                </p>
              </section>
              <section className="lot-settings-block">
                <h3 className="lot-settings-block__title">Автовыставление</h3>
                <p className="card-text">
                  Здесь будут настройки автоматического выставления лота.
                </p>
              </section>
              <section className="lot-settings-block">
                <h3 className="lot-settings-block__title">Автоподнятие</h3>
                <p className="card-text">
                  Здесь будут настройки автоматического поднятия лота в выдаче.
                </p>
              </section>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

