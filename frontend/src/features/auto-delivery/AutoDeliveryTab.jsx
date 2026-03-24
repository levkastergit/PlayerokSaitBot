import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  getProductKey,
  getGroupSettingsKey,
  loadProductSettingsList,
} from '../../services/playerokApi'

export function AutoDeliveryTab({
  token,
  lots = [],
  completedLots = [],
  loadingLots = false,
  errorLots = null,
}) {
  const navigate = useNavigate()
  const [settingsList, setSettingsList] = useState([])

  const hasToken = Boolean(token)

  const allLots = useMemo(
    () => [...lots, ...completedLots],
    [lots, completedLots]
  )

  useEffect(() => {
    if (!token) {
      setSettingsList([])
      return
    }
    let cancelled = false
    loadProductSettingsList(token)
      .then((data) => {
        if (!cancelled) setSettingsList(data.list || [])
      })
      .catch(() => { })
    return () => {
      cancelled = true
    }
  }, [token])

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
    return allLots.filter((lot) => {
      const s = resolveSettingsForLot(lot)
      return Boolean(s?.autodelivery?.enabled)
    })
  }, [allLots, settingsByKey])

  return (
    <div className="tab-page">
      <div className="tab-page-header">
        <h1>Автовыдача</h1>
        <p className="tab-page-description">
          Товары с включённой автовыдачей (из активных и завершённых). Откройте лот и включите автовыдачу в настройках.
        </p>
      </div>

      <div className="tab-grid">
        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <h2 className="card-title">Товары с автовыдачей</h2>

          {!hasToken && (
            <p className="card-text">
              Чтобы увидеть список, сначала укажите токен во вкладке «Токен».
            </p>
          )}

          {hasToken && loadingLots && (
            <p className="card-text">Загружаем лоты с Playerok…</p>
          )}

          {hasToken && !loadingLots && errorLots && (
            <p className="card-text card-text--error">
              Ошибка при загрузке лотов: {errorLots}
            </p>
          )}

          {hasToken && !loadingLots && !errorLots && filteredLots.length === 0 && (
            <p className="card-text">
              Пока нет лотов с включённой автовыдачей. Откройте лот во вкладке «Активные» или «Завершенные» и включите автовыдачу в настройках товара.
            </p>
          )}

          {hasToken && !loadingLots && !errorLots && filteredLots.length > 0 && (
            <>
              <p className="card-text active-lots-total">
                Лотов с автовыдачей: <strong>{filteredLots.length}</strong>
              </p>
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
                        <div
                          className="lot-card__image-placeholder"
                          aria-hidden="true"
                        >
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
                      </p>
                      <h3 className="lot-card__title" title={lot.title}>
                        {lot.title}
                      </h3>
                      {lot.game && (
                        <p className="lot-card__tags">
                          {lot.game}
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

