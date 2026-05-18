import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getProductKey, getGroupSettingsKey, loadProductSettingsList } from '../../services/playerokApi'

const FeatureFilterIcon = ({ id }) => {
  const common = {
    className: 'tab-button__icon-svg',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  }

  switch (id) {
    case 'active':
      return (
        <svg {...common}>
          <rect x="4.5" y="4.5" width="15" height="15" rx="4" opacity="0.22" fill="currentColor" stroke="none" />
          <path d="M8.4 12.2l2.2 2.2 5-5" />
        </svg>
      )
    case 'auto-listing':
      return (
        <svg {...common}>
          <rect x="4.5" y="4.5" width="15" height="15" rx="4" opacity="0.18" fill="currentColor" stroke="none" />
          <path d="M8.4 9.1h7.2" />
          <path d="M8.4 12h7.2" />
          <path d="M8.4 14.9h4.3" />
          <path d="M16.2 15.8h2.8" />
          <path d="M17.6 14.4v2.8" />
        </svg>
      )
    case 'lot-boost':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="7.4" opacity="0.18" fill="currentColor" stroke="none" />
          <path d="M12 16.7V8.8" />
          <path d="M9.2 11.6L12 8.8l2.8 2.8" />
        </svg>
      )
    case 'auto-delivery':
      return (
        <svg {...common}>
          <path d="M12 4.8l6.6 3.3L12 11.4 5.4 8.1 12 4.8z" opacity="0.2" fill="currentColor" stroke="none" />
          <path d="M5.4 8.1V16l6.6 3.2V11.4L5.4 8.1z" opacity="0.14" fill="currentColor" stroke="none" />
          <path d="M18.6 8.1V16L12 19.2v-7.8l6.6-3.3z" />
          <path d="M12 4.8l6.6 3.3L12 11.4 5.4 8.1 12 4.8z" />
          <path d="M14.8 13.2h4.2" />
          <path d="M17.7 11.1l2.1 2.1-2.1 2.1" />
        </svg>
      )
    default:
      return null
  }
}

export function ActiveLotsTab({
  token,
  lots = [],
  loadingLots = false,
  errorLots = null,
}) {
  const navigate = useNavigate()
  const [hiddenCategories, setHiddenCategories] = useState(() => new Set())
  const [soloCategory, setSoloCategory] = useState(null)
  const [featureFilter, setFeatureFilter] = useState('all')
  const [settingsList, setSettingsList] = useState([])
  const clickTimeoutRef = useRef(null)

  const hasToken = Boolean(token)
  const hasDdosError = /ddos-guard|js-challenge/i.test(String(errorLots || ''))
  const featureFilters = [
    { id: 'all', label: 'Все', iconId: 'active', iconClass: 'tab-button__icon--active' },
    { id: 'autodelivery', label: 'Автовыдача', iconId: 'auto-delivery', iconClass: 'tab-button__icon--auto-delivery' },
    { id: 'autolist', label: 'Автовыставление', iconId: 'auto-listing', iconClass: 'tab-button__icon--auto-listing' },
    { id: 'autobump', label: 'Автоподнятие', iconId: 'lot-boost', iconClass: 'tab-button__icon--lot-boost' },
  ]

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
      .catch(() => { })
    return () => { cancelled = true }
  }, [token, lots.length])

  return (
    <div className="tab-page">
      <div className="tab-page-header">
        <h1>Активные лоты</h1>
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

          {hasToken && loadingLots && (
            <p className="card-text">Загружаем лоты с Playerok...</p>
          )}

          {hasToken && !loadingLots && errorLots && (
            <>
              <p className="card-text card-text--error">
                Ошибка при загрузке лотов: {errorLots}
              </p>
              {hasDdosError && (
                <div className="ddos-guard-actions">
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => navigate('/ddos')}
                  >
                    Открыть вкладку Ddos
                  </button>
                </div>
              )}
            </>
          )}

          {hasToken && !loadingLots && !errorLots && lots.length === 0 && (
            <p className="card-text">
              Активных лотов не найдено или API вернул пустой список.
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
                {featureFilters.map(({ id, label, iconId, iconClass }) => (
                  <button
                    key={id}
                    type="button"
                    className={`active-lots-filter-chip active-lots-filter-chip--icon ${featureFilter === id ? 'active-lots-filter-chip--solo' : ''}`}
                    onClick={() => setFeatureFilter(id)}
                    title={label}
                    aria-label={label}
                  >
                    <span className={`tab-button__icon ${iconClass}`} aria-hidden="true">
                      <FeatureFilterIcon id={iconId} />
                    </span>
                  </button>
                ))}
              </div>
              {categories.length > 0 && (
                <div className="active-lots-filters">
                  <span className="active-lots-filters__label">🏷</span>
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
