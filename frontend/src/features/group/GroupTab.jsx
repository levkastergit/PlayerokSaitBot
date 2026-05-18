import React, { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getGroupSettingsKey, getProductKey, loadProductSettingsList, recordBump } from '../../services/playerokApi'

const GROUP_LAST_BUMP_STORAGE_KEY = 'group-last-bump-at-v1'

export function GroupTab({
  token,
  lots = [],
  completedLots = [],
  loadingLots = false,
  errorLots = null,
}) {
  const navigate = useNavigate()
  const [settingsList, setSettingsList] = useState([])
  const [groupBumpInFlight, setGroupBumpInFlight] = useState({})
  const [groupLastBumpAt, setGroupLastBumpAt] = useState(() => {
    if (typeof window === 'undefined') return {}
    try {
      const raw = window.localStorage.getItem(GROUP_LAST_BUMP_STORAGE_KEY)
      if (!raw) return {}
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  })

  const hasToken = Boolean(token)

  const allLots = useMemo(() => {
    const seen = new Set()
    const merged = []
    ;[...lots, ...completedLots].forEach((lot) => {
      const id = String(lot?.id || '')
      if (!id || seen.has(id)) return
      seen.add(id)
      merged.push(lot)
    })
    return merged
  }, [lots, completedLots])

  useEffect(() => {
    if (!token) {
      setSettingsList([])
      return
    }
    let cancelled = false
    loadProductSettingsList(token)
      .then((data) => {
        if (!cancelled) setSettingsList(Array.isArray(data?.list) ? data.list : [])
      })
      .catch(() => { })
    return () => {
      cancelled = true
    }
  }, [token])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(GROUP_LAST_BUMP_STORAGE_KEY, JSON.stringify(groupLastBumpAt))
    } catch {
      // ignore storage errors
    }
  }, [groupLastBumpAt])

  const settingsByKey = useMemo(() => {
    const map = {}
    settingsList.forEach(({ productKey, settings }) => {
      if (productKey && settings) map[productKey] = settings
    })
    return map
  }, [settingsList])

  const groups = useMemo(() => {
    const byGroup = new Map()

    allLots.forEach((lot) => {
      const key = getProductKey(lot)
      const itemSettings = settingsByKey[key] || null
      const label = itemSettings && typeof itemSettings.settingsLabel === 'string'
        ? itemSettings.settingsLabel.trim()
        : ''
      const effective = label ? (settingsByKey[getGroupSettingsKey(label)] || itemSettings) : itemSettings
      const groupNameRaw = itemSettings?.groupName || effective?.groupName || ''
      const groupName = String(groupNameRaw).trim()
      if (!groupName) return

      if (!byGroup.has(groupName)) byGroup.set(groupName, [])
      byGroup.get(groupName).push(lot)
    })

    return [...byGroup.entries()]
      .map(([name, groupLots]) => ({
        name,
        lots: groupLots.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'ru')),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'))
  }, [allLots, settingsByKey])

  const formatLastBumpTime = (ts) => {
    if (!ts) return 'Ещё не запускали'
    const date = new Date(ts)
    if (Number.isNaN(date.getTime())) return 'Ещё не запускали'
    return date.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  }

  const handleGroupBump = async (group) => {
    if (!token) return
    const groupName = String(group?.name || '').trim()
    const groupLots = Array.isArray(group?.lots) ? group.lots : []
    if (!groupName || groupLots.length === 0) return

    setGroupBumpInFlight((prev) => ({ ...prev, [groupName]: true }))
    try {
      const lotsToBump = groupLots
        .map((lot) => ({ lot, productKey: getProductKey(lot) }))
        .filter(({ lot, productKey }) => lot?.id && productKey)
      const results = await Promise.allSettled(
        lotsToBump.map(({ lot, productKey }) =>
          recordBump(token, {
            productKey,
            productTitle: lot.title || 'Товар',
            itemId: lot.id,
            price: lot.price,
          })
        )
      )
      const failed = results.filter((x) => x.status === 'rejected').length
      if (failed > 0 && typeof window !== 'undefined' && window.alert) {
        window.alert(`Поднятие завершено с ошибками: ${failed} из ${results.length}`)
      }
    } catch (error) {
      const message = error && error.message ? String(error.message) : 'Не удалось поднять товары группы'
      if (typeof window !== 'undefined' && window.alert) {
        window.alert(message)
      }
    } finally {
      setGroupLastBumpAt((prev) => ({
        ...prev,
        [groupName]: Date.now(),
      }))
      setGroupBumpInFlight((prev) => ({ ...prev, [groupName]: false }))
    }
  }

  return (
    <div className="tab-page">
      <div className="tab-page-header">
        <h1>Группы</h1>
      </div>

      <div className="tab-grid">
        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <h2 className="card-title">Группы товаров</h2>

          {!hasToken && (
            <p className="card-text">Чтобы увидеть группы, сначала укажите токен во вкладке «Токен».</p>
          )}

          {hasToken && loadingLots && (
            <p className="card-text">Загружаем лоты с Playerok…</p>
          )}

          {hasToken && !loadingLots && errorLots && (
            <p className="card-text card-text--error">Ошибка при загрузке лотов: {errorLots}</p>
          )}

          {hasToken && !loadingLots && !errorLots && groups.length === 0 && (
            <p className="card-text">Группы пока не заданы.</p>
          )}

          {hasToken && !loadingLots && !errorLots && groups.length > 0 && (
            <div className="group-list">
              {groups.map((group) => (
                <article key={group.name} className="group-card">
                  <div className="group-card__header">
                    <h3 className="group-card__title">{group.name}</h3>
                    <span className="group-card__count">{group.lots.length}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
                    <button
                      type="button"
                      className="lot-settings-btn lot-settings-btn--secondary"
                      onClick={() => handleGroupBump(group)}
                      disabled={Boolean(groupBumpInFlight[group.name])}
                    >
                      {groupBumpInFlight[group.name] ? 'Поднимаем товары…' : 'Поднять товары группы'}
                    </button>
                    <span className="card-text" style={{ margin: 0 }}>
                      Последний запуск: {formatLastBumpTime(groupLastBumpAt[group.name])}
                    </span>
                  </div>
                  <div className="lots-grid">
                    {group.lots.map((lot) => (
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
                            <img src={lot.imageUrl} alt="" className="lot-card__image" loading="lazy" />
                          ) : (
                            <div className="lot-card__image-placeholder" aria-hidden="true">
                              Нет фото
                            </div>
                          )}
                        </div>
                        <div className="lot-card__body">
                          <p className="lot-card__price-row">
                            <span className="lot-card__price">
                              {Number(lot.price || 0).toLocaleString('ru-RU')} {lot.currency || '₽'}
                            </span>
                          </p>
                          <h3 className="lot-card__title" title={lot.title}>
                            {lot.title}
                          </h3>
                          {lot.game && <p className="lot-card__tags">{lot.game}</p>}
                        </div>
                      </article>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
