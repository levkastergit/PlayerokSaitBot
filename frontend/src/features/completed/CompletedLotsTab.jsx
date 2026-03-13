import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getProductKey, getGroupSettingsKey, loadProductSettingsList } from '../../services/playerokApi'

export function CompletedLotsTab({ token, lots = [], loadingLots = false, errorLots = null }) {
  const navigate = useNavigate()
  const [hiddenCategories, setHiddenCategories] = useState(() => new Set())
  const [soloCategory, setSoloCategory] = useState(null)
  const [featureFilter, setFeatureFilter] = useState('all')
  const [settingsList, setSettingsList] = useState([])
  const clickTimeoutRef = useRef(null)

  const hasToken = Boolean(token)

  const categories = useMemo(() => {
    const names = new Set()
    lots.forEach((lot) => {
      const name = (lot.game || '').trim() || 'Без категории'
      names.add(name)
    })
    return [...names].sort((a, b) => a.localeCompare(b))
  }, [lots])

  const settingsByKey = useMemo(() => {
    const map = {}
    settingsList.forEach(({ productKey, settings }) => {
      if (productKey && settings) map[productKey] = settings
    })
    return map
  }, [settingsList])

  const resolveSettingsForLot = (lot) => {
    const key = getProductKey(lot)
    let s = settingsByKey[key]
    const label = s && typeof s.settingsLabel === 'string' ? s.settingsLabel.trim() : ''
    if (label) {
      const gk = getGroupSettingsKey(label)
      if (settingsByKey[gk]) s = settingsByKey[gk]
    }
    return s
  }

  const getAutolistBadge = (lot) => {
    const s = resolveSettingsForLot(lot)
    const autolistEnabled = Boolean(s?.autolist?.enabled)
    const rt = lot && lot.autolistRuntime ? lot.autolistRuntime : null
    const status = rt && typeof rt.status === 'string' ? rt.status : null
    const error = rt && typeof rt.error === 'string' ? rt.error : null

    if (status === 'error' && error) return { type: 'error', title: error }
    if (status === 'processing') return { type: 'processing', title: 'В процессе автовыставления' }
    if (!autolistEnabled) return { type: 'disabled', title: 'Нет настройки автовыставления' }
    return { type: 'processing', title: 'Ожидает автовыставления' }
  }

  const filteredLots = useMemo(() => {
    let list = lots
    if (soloCategory !== null) {
      list = list.filter((lot) => {
        const name = (lot.game || '').trim() || 'Без категории'
        return name === soloCategory
      })
    } else if (hiddenCategories.size > 0) {
      list = list.filter((lot) => {
        const name = (lot.game || '').trim() || 'Без категории'
        return !hiddenCategories.has(name)
      })
    }
    if (featureFilter === 'all') return list
    list = list.filter((lot) => {
      const s = resolveSettingsForLot(lot)
      if (!s) return false
      if (featureFilter === 'autodelivery') return Boolean(s.autodelivery?.enabled)
      if (featureFilter === 'autolist') return Boolean(s.autolist?.enabled)
      if (featureFilter === 'autobump') return Boolean(s.autobump?.enabled)
      return true
    })
    return list
  }, [lots, hiddenCategories, soloCategory, featureFilter, settingsByKey])

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
    if (!token || lots.length === 0) return
    let cancelled = false
    loadProductSettingsList(token)
      .then((data) => {
        if (!cancelled) setSettingsList(data.list || [])
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [token, lots.length])

  return (
    <div className="tab-page">
      <div className="tab-page-header">
        <h1>Завершенные лоты</h1>
        <p className="tab-page-description">
          Список завершённых товаров из вашего профиля Playerok (проданы, отменены или истекли).
        </p>
      </div>

      <div className="tab-grid">
        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <h2 className="card-title">Список завершённых лотов</h2>

          {!hasToken && (
            <p className="card-text">
              Чтобы увидеть завершённые лоты, сначала укажите токен во вкладке
              «Токен».
            </p>
          )}

          {hasToken && loadingLots && (
            <p className="card-text">Загружаем лоты с Playerok...</p>
          )}

          {hasToken && !loadingLots && errorLots && (
            <p className="card-text card-text--error">
              Ошибка при загрузке лотов: {errorLots}
            </p>
          )}

          {hasToken && !loadingLots && !errorLots && lots.length === 0 && (
            <p className="card-text">
              Завершённых лотов не найдено или API вернул пустой список.
            </p>
          )}

          {hasToken && !loadingLots && !errorLots && lots.length > 0 && (
            <>
              <p className="card-text active-lots-total">
                Всего лотов: <strong>{lots.length}</strong>
                {filteredLots.length !== lots.length && (
                  <> (показано <strong>{filteredLots.length}</strong>)</>
                )}
              </p>
              <div className="active-lots-feature-filters">
                <span className="active-lots-filters__label">Показать:</span>
                {[
                  { id: 'all', label: 'Все' },
                  { id: 'autodelivery', label: 'Автовыдача' },
                  { id: 'autolist', label: 'Автовыставление' },
                  { id: 'autobump', label: 'Автоподнятие' },
                ].map(({ id, label }) => (
                  <button
                    key={id}
                    type="button"
                    className={`active-lots-filter-chip ${featureFilter === id ? 'active-lots-filter-chip--solo' : ''}`}
                    onClick={() => setFeatureFilter(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
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
                    onClick={() => navigate('/lot/' + lot.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        navigate('/lot/' + lot.id)
                      }
                    }}
                  >
                    <div className="lot-card__image-wrap">
                      {(() => {
                        const b = getAutolistBadge(lot)
                        const isError = b.type === 'error'
                        const isProcessing = b.type === 'processing'
                        const isDisabled = b.type === 'disabled'
                        const label = isError ? '?' : isProcessing ? '⏱' : '✕'
                        const cls =
                          'lot-card__autolist-badge ' +
                          (isError
                            ? 'lot-card__autolist-badge--error'
                            : isProcessing
                              ? 'lot-card__autolist-badge--processing'
                              : 'lot-card__autolist-badge--disabled')
                        return (
                          <span
                            className={cls}
                            title={b.title}
                            onClick={(e) => e.stopPropagation()}
                            role="img"
                            aria-label={b.title}
                          >
                            {label}
                          </span>
                        )
                      })()}
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
        </section>
      </div>
    </div>
  )
}
