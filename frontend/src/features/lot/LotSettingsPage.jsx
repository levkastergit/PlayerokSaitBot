import React, { useEffect, useRef, useState } from 'react'
import {
  getProductKey,
  getGroupSettingsKey,
  loadProductSettings,
  loadProductSettingsList,
  saveProductSettings,
  deleteProductSettings,
  fetchItemPriorityStatuses,
  recordBump,
} from '../../services/playerokApi'

export function LotSettingsPage({ lot, token, onBack, loading = false }) {
  const [productSettings, setProductSettings] = useState(null)
  const [loadingSettings, setLoadingSettings] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)
  const [settingsError, setSettingsError] = useState(null)
  const [toast, setToast] = useState(null)
  const [codesModalOpen, setCodesModalOpen] = useState(false)
  const [newCodeInput, setNewCodeInput] = useState('')
  const [settingsLabelInput, setSettingsLabelInput] = useState('')
  const [settingsLabel, setSettingsLabel] = useState('')
  const [priorityStatuses, setPriorityStatuses] = useState([])
  const [loadingPriorityStatuses, setLoadingPriorityStatuses] = useState(false)
  const [priorityStatusesError, setPriorityStatusesError] = useState(null)
  const [bumpInFlight, setBumpInFlight] = useState(false)
  const [bumpCooldownUntil, setBumpCooldownUntil] = useState(0)
  const [nowTs, setNowTs] = useState(() => Date.now())
  const [scheduleDragOverIndex, setScheduleDragOverIndex] = useState(null)

  const baseProductKey = lot ? getProductKey(lot) : null
  const groupKey = settingsLabel ? getGroupSettingsKey(settingsLabel) : ''
  const effectiveProductKey = groupKey || baseProductKey

  const splitSettingsForSave = (allSettings, label) => {
    const full = allSettings && typeof allSettings === 'object' ? allSettings : {}
    const trimmedLabel = String(label || '').trim()
    const groupSettings = trimmedLabel
      ? { ...full, settingsLabel: trimmedLabel }
      : { ...full, settingsLabel: '' }

    // Автоподнятие не должно попадать в метку (групповые настройки).
    delete groupSettings.autobump

    const itemSettings = trimmedLabel
      ? { settingsLabel: trimmedLabel, autobump: full.autobump || { enabled: false, schedule: [], priorityStatusId: null } }
      : { ...full, settingsLabel: '' }

    return { groupSettings, itemSettings, trimmedLabel }
  }

  // Проверка почты Supercell ID только для категорий: Brawl Stars, Clash Royale, Clash of Clans
  const SUPERCELL_EMAIL_GAMES = [
    'brawl stars', 'clash royale', 'clash of clans',
    'бравл старс', 'клеш рояль', 'клеш оф кланс',
  ]
  const lotGameNorm = (lot?.game || '').trim().toLowerCase()
  const showSupercellEmailValidation = SUPERCELL_EMAIL_GAMES.some((g) => g === lotGameNorm)

  const defaultProductSettings = () => ({
    cost: 0,
    settingsLabel: '',
    autodelivery: {
      enabled: false,
      codes: [],
      messageOnPurchase: '',
      autoCompleteDeal: false,
    },
    autolist: { enabled: false },
    automessage: {
      enabled: false,
      messages: [],
    },
    emailValidation: {
      enabled: false,
      invalidEmailMessage: '',
    },
    autobump: {
      enabled: false,
      schedule: [],
      priorityStatusId: null,
    },
  })

  useEffect(() => {
    if (!token || !lot?.id) {
      setPriorityStatuses([])
      setPriorityStatusesError(null)
      setLoadingPriorityStatuses(false)
      return
    }
    let cancelled = false
    setLoadingPriorityStatuses(true)
    setPriorityStatusesError(null)
    fetchItemPriorityStatuses(token, { itemId: lot.id, price: lot.price })
      .then((data) => {
        if (cancelled) return
        const list = Array.isArray(data?.list) ? data.list : []
        setPriorityStatuses(list)
        // Если статус ещё не выбран — сразу ставим первый доступный (то, что в списке сразу после "(по умолчанию)").
        const firstId = list[0]?.id || null
        if (firstId) {
          setProductSettings((prev) => {
            if (!prev) return prev
            const cur = prev?.autobump?.priorityStatusId || null
            if (cur) return prev
            return {
              ...prev,
              autobump: { ...(prev.autobump || {}), priorityStatusId: firstId },
            }
          })
        }
        setLoadingPriorityStatuses(false)
      })
      .catch((err) => {
        if (cancelled) return
        setPriorityStatuses([])
        setPriorityStatusesError(err instanceof Error ? err.message : 'Ошибка загрузки статусов поднятия')
        setLoadingPriorityStatuses(false)
      })
    return () => { cancelled = true }
  }, [token, lot?.id, lot?.price])

  useEffect(() => {
    if (!token || !baseProductKey) {
      setProductSettings(null)
      setLoadingSettings(false)
      setSettingsError(null)
      return
    }
    let cancelled = false
    setLoadingSettings(true)
    setSettingsError(null)
    const normalizeLoadedSettings = (loadedRaw) => {
      const base = defaultProductSettings()
      const loaded = loadedRaw && typeof loadedRaw === 'object' ? loadedRaw : {}
      const loadedAutobump = loaded.autobump || {}
      const loadedEmailValidation = loaded.emailValidation || {}
      return {
        ...base,
        ...loaded,
        cost: typeof loaded.cost === 'number' ? loaded.cost : (parseFloat(loaded.cost) || 0),
        autodelivery: { ...base.autodelivery, ...(loaded.autodelivery || {}) },
        autolist: { ...base.autolist, ...(loaded.autolist || {}) },
        automessage: (() => {
          const loadedAm = loaded.automessage || {}
          const raw = loadedAm.messages
          const messages = Array.isArray(raw)
            ? raw.filter((m) => typeof m === 'string')
            : typeof raw === 'string' && raw.trim()
              ? raw.split('\n').map((s) => s.trim()).filter(Boolean)
              : []
          return { ...base.automessage, ...loadedAm, messages }
        })(),
        emailValidation: {
          ...base.emailValidation,
          ...loadedEmailValidation,
          enabled: Boolean(loadedEmailValidation.enabled),
          invalidEmailMessage:
            typeof loadedEmailValidation.invalidEmailMessage === 'string'
              ? loadedEmailValidation.invalidEmailMessage
              : '',
        },
        autobump: {
          ...base.autobump,
          ...loadedAutobump,
          schedule: Array.isArray(loadedAutobump.schedule) ? loadedAutobump.schedule : [],
          priorityStatusId: loadedAutobump.priorityStatusId || null,
        },
      }
    }

    ;(async () => {
      try {
        // 1) Сначала читаем настройки привязки для конкретного лота (по game::title)
        const baseData = await loadProductSettings(token, baseProductKey)
        if (cancelled) return

        const baseLoaded = baseData?.settings && typeof baseData.settings === 'object' ? baseData.settings : null
        const baseLinkedLabel = (baseLoaded && typeof baseLoaded.settingsLabel === 'string' ? baseLoaded.settingsLabel : '') || ''
        const trimmedLinked = baseLinkedLabel.trim()

        // Если товар уже привязан к метке — всегда работаем по метке.
        if (trimmedLinked) {
          const gk = getGroupSettingsKey(trimmedLinked)
          const groupData = await loadProductSettings(token, gk)
          if (cancelled) return
          const groupLoaded = groupData?.settings && typeof groupData.settings === 'object' ? groupData.settings : null
          // ВАЖНО: автоподнятие всегда индивидуальное для товара (из baseLoaded), даже если есть метка.
          const merged = {
            ...(groupLoaded || {}),
            settingsLabel: trimmedLinked,
            autobump: baseLoaded?.autobump || null,
          }
          setSettingsLabel(trimmedLinked)
          setSettingsLabelInput(trimmedLinked)
          setProductSettings(
            normalizeLoadedSettings(merged)
          )
          setLoadingSettings(false)
          return
        }

        // Метки нет — используем собственные настройки товара.
        setProductSettings(normalizeLoadedSettings(baseLoaded))
        setLoadingSettings(false)
      } catch (err) {
        if (cancelled) return
        setSettingsError(err instanceof Error ? err.message : 'Ошибка загрузки')
        setProductSettings(defaultProductSettings())
        setLoadingSettings(false)
      }
    })()
    return () => { cancelled = true }
  }, [token, baseProductKey, settingsLabel])

  const handleApplyLabel = () => {
    const nextLabel = (settingsLabelInput || '').trim()
    setSettingsLabel(nextLabel)

    if (!token || !baseProductKey) return

    // 1) Если метка очищена — возвращаемся к индивидуальным настройкам товара.
    if (!nextLabel) {
      // Сбрасываем ссылку на метку у товара, но не трогаем существующую групповую запись.
      saveProductSettings(token, baseProductKey, {
        ...(productSettings && typeof productSettings === 'object' ? productSettings : {}),
        settingsLabel: '',
      }).catch(() => { })
      return
    }

    // 2) Если метка указана — сначала пробуем загрузить уже существующие настройки метки.
    const gk = getGroupSettingsKey(nextLabel)
    ;(async () => {
      try {
        const groupData = await loadProductSettings(token, gk)
        const existing =
          groupData && groupData.settings && typeof groupData.settings === 'object'
            ? groupData.settings
            : null

        let effective
        if (existing) {
          // Метка уже существует — просто подхватываем её настройки.
          effective = { ...existing, settingsLabel: nextLabel }
        } else {
          // Метка новая — создаём её на основе текущих настроек товара (или дефолтных).
          const base =
            productSettings && typeof productSettings === 'object'
              ? productSettings
              : defaultProductSettings()
          effective = { ...base, settingsLabel: nextLabel }
          // В метку не пишем autobump — он индивидуальный.
          const { groupSettings } = splitSettingsForSave(effective, nextLabel)
          await saveProductSettings(token, gk, groupSettings)
        }

        // У товара сохраняем ссылку на метку + его индивидуальный autobump.
        const { itemSettings } = splitSettingsForSave(productSettings || defaultProductSettings(), nextLabel)
        await saveProductSettings(token, baseProductKey, itemSettings).catch(() => {})

        // Переключаем UI на настройки метки.
        setProductSettings(
          // Используем тот же нормализатор, что и при обычной загрузке.
          ((loadedRaw) => {
            const base = defaultProductSettings()
            const loaded = loadedRaw && typeof loadedRaw === 'object' ? loadedRaw : {}
            const loadedAutobump = loaded.autobump || {}
            const loadedEmailValidation = loaded.emailValidation || {}
            return {
              ...base,
              ...loaded,
              cost:
                typeof loaded.cost === 'number'
                  ? loaded.cost
                  : (parseFloat(loaded.cost) || 0),
              autodelivery: { ...base.autodelivery, ...(loaded.autodelivery || {}) },
              autolist: { ...base.autolist, ...(loaded.autolist || {}) },
              automessage: (() => {
                const loadedAm = loaded.automessage || {}
                const raw = loadedAm.messages
                const messages = Array.isArray(raw)
                  ? raw.filter((m) => typeof m === 'string')
                  : typeof raw === 'string' && raw.trim()
                    ? raw.split('\n').map((s) => s.trim()).filter(Boolean)
                    : []
                return { ...base.automessage, ...loadedAm, messages }
              })(),
              emailValidation: {
                ...base.emailValidation,
                ...loadedEmailValidation,
                enabled: Boolean(loadedEmailValidation.enabled),
                invalidEmailMessage:
                  typeof loadedEmailValidation.invalidEmailMessage === 'string'
                    ? loadedEmailValidation.invalidEmailMessage
                    : '',
              },
              autobump: {
                ...base.autobump,
                ...loadedAutobump,
                schedule: Array.isArray(loadedAutobump.schedule)
                  ? loadedAutobump.schedule
                  : [],
                priorityStatusId: loadedAutobump.priorityStatusId || null,
              },
            }
          })({
            ...effective,
            // автоподнятие оставляем индивидуальным (из текущих настроек товара)
            autobump: (productSettings && productSettings.autobump) ? productSettings.autobump : undefined,
          })
        )
      } catch {
        // В случае ошибки просто оставляем текущие настройки и метку в UI.
      }
    })()
  }

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 3000)
    return () => clearTimeout(t)
  }, [toast])

  useEffect(() => {
    if (!bumpCooldownUntil) return
    if (Date.now() >= bumpCooldownUntil) return
    const t = setInterval(() => setNowTs(Date.now()), 250)
    return () => clearInterval(t)
  }, [bumpCooldownUntil])

  const handleSaveSettings = () => {
    if (!token || !effectiveProductKey || productSettings == null) return
    setSavingSettings(true)
    setSettingsError(null)
    const label = (settingsLabel || '').trim()
    const { groupSettings, itemSettings, trimmedLabel } = splitSettingsForSave(productSettings, label)
    const groupKeyToSave = trimmedLabel ? getGroupSettingsKey(trimmedLabel) : null

    const savePromise = trimmedLabel && groupKeyToSave
      ? Promise.all([
        saveProductSettings(token, groupKeyToSave, groupSettings),
        saveProductSettings(token, baseProductKey, itemSettings).catch(() => {}),
      ])
      : saveProductSettings(token, baseProductKey, itemSettings)

    savePromise
      .then(async () => {
        setSavingSettings(false)
        setToast({ type: 'success', message: 'Настройки сохранены' })
        loadProductSettingsList(token).catch(() => { })
      })
      .catch((err) => {
        setSavingSettings(false)
        setToast({ type: 'error', message: err instanceof Error ? err.message : 'Ошибка сохранения' })
      })
  }

  const bumpRemainingSec = bumpCooldownUntil && nowTs < bumpCooldownUntil
    ? Math.max(1, Math.ceil((bumpCooldownUntil - nowTs) / 1000))
    : 0

  const bumpDisabled = bumpInFlight || (bumpCooldownUntil && Date.now() < bumpCooldownUntil)

  const handleBumpOnce = async () => {
    if (bumpDisabled) return
    if (!token) {
      setToast({ type: 'error', message: 'Токен не задан' })
      return
    }
    if (!lot?.id) {
      setToast({ type: 'error', message: 'Не удалось определить ID лота' })
      return
    }
    if (!baseProductKey) {
      setToast({ type: 'error', message: 'Не удалось определить ключ товара' })
      return
    }

    setBumpInFlight(true)
    setBumpCooldownUntil(Date.now() + 10_000)
    setNowTs(Date.now())
    try {
      await recordBump(token, {
        productKey: baseProductKey,
        productTitle: lot.title || 'Товар',
        itemId: lot.id,
        price: lot.price,
        priorityStatusId: productSettings?.autobump?.priorityStatusId || null,
      })
      setToast({ type: 'success', message: 'Товар поднят' })
    } catch (e) {
      setToast({ type: 'error', message: e instanceof Error ? e.message : 'Не удалось поднять товар' })
    } finally {
      setBumpInFlight(false)
    }
  }

  const setAutodelivery = (field, value) => {
    setProductSettings((prev) => ({
      ...prev,
      autodelivery: { ...(prev?.autodelivery || {}), [field]: value },
    }))
  }

  const persistCodes = async (nextSettings) => {
    if (!token || !effectiveProductKey) return
    const label = (settingsLabel || '').trim()
    try {
      const { groupSettings, itemSettings, trimmedLabel } = splitSettingsForSave(nextSettings, label)
      const groupKeyToSave = trimmedLabel ? getGroupSettingsKey(trimmedLabel) : null
      if (trimmedLabel && groupKeyToSave) {
        await Promise.all([
          saveProductSettings(token, groupKeyToSave, groupSettings),
          saveProductSettings(token, baseProductKey, itemSettings).catch(() => {}),
        ])
      } else {
        await saveProductSettings(token, baseProductKey, itemSettings)
      }
      loadProductSettingsList(token).catch(() => { })
      setToast({ type: 'success', message: 'Коды сохранены' })
    } catch (e) {
      setToast({ type: 'error', message: e instanceof Error ? e.message : 'Не удалось сохранить коды' })
    }
  }

  const addCode = (code) => {
    const trimmed = String(code).trim()
    if (!trimmed) return
    setProductSettings((prev) => {
      const next = {
        ...prev,
        autodelivery: {
          ...(prev?.autodelivery || {}),
          codes: [...(prev?.autodelivery?.codes || []), trimmed],
        },
      }
      persistCodes(next)
      return next
    })
  }

  const removeCode = (index) => {
    setProductSettings((prev) => {
      const codes = [...(prev?.autodelivery?.codes || [])]
      codes.splice(index, 1)
      const next = {
        ...prev,
        autodelivery: { ...(prev?.autodelivery || {}), codes },
      }
      persistCodes(next)
      return next
    })
  }

  const setFeature = (name, field, value) => {
    setProductSettings((prev) => ({
      ...prev,
      [name]: { ...(prev?.[name] || {}), [field]: value },
    }))
  }

  const setAutomessage = (field, value) => {
    setProductSettings((prev) => ({
      ...prev,
      automessage: { ...(prev?.automessage || {}), [field]: value },
    }))
  }

  const setEmailValidation = (field, value) => {
    setProductSettings((prev) => ({
      ...prev,
      emailValidation: { ...(prev?.emailValidation || {}), [field]: value },
    }))
  }

  const addAutomessageRow = () => {
    setProductSettings((prev) => ({
      ...prev,
      automessage: {
        ...(prev?.automessage || {}),
        messages: [...(prev?.automessage?.messages || []), ''],
      },
    }))
  }

  const removeAutomessageRow = (index) => {
    setProductSettings((prev) => {
      const messages = [...(prev?.automessage?.messages || [])]
      messages.splice(index, 1)
      return {
        ...prev,
        automessage: { ...(prev?.automessage || {}), messages },
      }
    })
  }

  const updateAutomessageRow = (index, value) => {
    setProductSettings((prev) => {
      const messages = [...(prev?.automessage?.messages || [])]
      if (messages[index] === undefined) return prev
      messages[index] = value
      return {
        ...prev,
        automessage: { ...(prev?.automessage || {}), messages },
      }
    })
  }

  const addAutobumpScheduleItem = () => {
    setProductSettings((prev) => {
      const prevAutobump = prev?.autobump || {}
      const schedule = prevAutobump.schedule || []
      const maxPriority = schedule.length > 0
        ? Math.max(...schedule.map((w) => Number(w.priority) || 1), 0)
        : 0
      const nowSec = Math.floor(Date.now() / 1000)
      const enabled = Boolean(prevAutobump.enabled)
      return {
        ...prev,
        autobump: {
          ...prevAutobump,
          schedule: [...schedule, { start: '12:00', end: '13:00', intervalMinutes: 3, priority: maxPriority + 1 }],
          enabledAt: enabled ? nowSec : prevAutobump.enabledAt || null,
        },
      }
    })
  }

  const removeAutobumpScheduleItem = (index) => {
    setProductSettings((prev) => {
      const prevAutobump = prev?.autobump || {}
      const schedule = [...(prevAutobump.schedule || [])]
      schedule.splice(index, 1)
      const nowSec = Math.floor(Date.now() / 1000)
      const enabled = Boolean(prevAutobump.enabled)
      return {
        ...prev,
        autobump: {
          ...prevAutobump,
          schedule,
          enabledAt: enabled ? nowSec : prevAutobump.enabledAt || null,
        },
      }
    })
  }

  const updateAutobumpScheduleItem = (index, field, value) => {
    setProductSettings((prev) => {
      const prevAutobump = prev?.autobump || {}
      const schedule = [...(prevAutobump.schedule || [])]
      if (!schedule[index]) return prev
      schedule[index] = { ...schedule[index], [field]: value }
      const nowSec = Math.floor(Date.now() / 1000)
      const enabled = Boolean(prevAutobump.enabled)
      return {
        ...prev,
        autobump: {
          ...prevAutobump,
          schedule,
          enabledAt: enabled ? nowSec : prevAutobump.enabledAt || null,
        },
      }
    })
  }

  const moveAutobumpScheduleItem = (fromIndex, toIndex) => {
    if (fromIndex === toIndex) return
    setProductSettings((prev) => {
      const prevAutobump = prev?.autobump || {}
      const schedule = [...(prevAutobump.schedule || [])]
      if (fromIndex < 0 || fromIndex >= schedule.length || toIndex < 0 || toIndex >= schedule.length) return prev
      const [moved] = schedule.splice(fromIndex, 1)
      schedule.splice(toIndex, 0, moved)
      const withPriority = schedule.map((item, i) => ({ ...item, priority: i + 1 }))
      const nowSec = Math.floor(Date.now() / 1000)
      const enabled = Boolean(prevAutobump.enabled)
      return {
        ...prev,
        autobump: {
          ...prevAutobump,
          schedule: withPriority,
          enabledAt: enabled ? nowSec : prevAutobump.enabledAt || null,
        },
      }
    })
  }

  const handleScheduleDragStart = (e, index) => {
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(index))
    e.currentTarget.closest('.lot-settings-schedule-item')?.classList.add('lot-settings-schedule-item--dragging')
  }

  const handleScheduleDragEnd = (e) => {
    e.currentTarget.closest('.lot-settings-schedule-item')?.classList.remove('lot-settings-schedule-item--dragging')
    setScheduleDragOverIndex(null)
  }

  const handleScheduleDragOver = (e, toIndex) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setScheduleDragOverIndex(toIndex)
  }

  const handleScheduleDragLeave = () => {
    setScheduleDragOverIndex(null)
  }

  const handleScheduleDrop = (e, toIndex) => {
    e.preventDefault()
    setScheduleDragOverIndex(null)
    const fromIndex = parseInt(e.dataTransfer.getData('text/plain'), 10)
    if (Number.isNaN(fromIndex)) return
    moveAutobumpScheduleItem(fromIndex, toIndex)
  }

  if (!lot) {
    return (
      <div className="tab-page">
        <div className="tab-page-header">
          <h1>Настройки товара</h1>
        </div>
        <div className="tab-grid">
          <section className="card" style={{ gridColumn: '1 / -1' }}>
            <button type="button" className="lot-settings-page__back" onClick={onBack}>
              ← Назад
            </button>
            {loading ? (
              <p className="card-text">Загрузка…</p>
            ) : (
              <p className="card-text">Лот не найден.</p>
            )}
          </section>
        </div>
      </div>
    )
  }

  return (
    <div className="tab-page">
      <div className="tab-page-header">
        <h1>Настройки товара</h1>
      </div>
      {toast && (
        <div className={`toast toast--${toast.type}`} role="status" aria-live="polite">
          {toast.message}
        </div>
      )}
      <div className="tab-grid">
        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <div className="lot-settings-page">
            <button type="button" className="lot-settings-page__back" onClick={onBack}>
              ← Назад
            </button>
            <div className="lot-settings-page__header">
              <div className="lot-settings-page__product-image-wrap">
                {lot.imageUrl ? (
                  <img
                    src={lot.imageUrl}
                    alt=""
                    className="lot-settings-page__product-image"
                  />
                ) : (
                  <div className="lot-settings-page__product-image-placeholder" aria-hidden="true">
                    Нет фото
                  </div>
                )}
              </div>
              <div className="lot-settings-page__header-text">
                <h2 className="lot-settings-page__title">Настройки товара</h2>
                <p className="lot-settings-page__product-name">{lot.title}</p>
                {lot.game && (
                  <p className="lot-settings-page__product-game">{lot.game}</p>
                )}
              </div>
            </div>

            {loadingSettings && <p className="card-text">Загрузка настроек…</p>}
            {settingsError && (
              <p className="card-text card-text--error">{settingsError}</p>
            )}

            {!loadingSettings && productSettings != null && (
              <>
                <section className="lot-settings-block">
                  <h3 className="lot-settings-block__title">Общие настройки для нескольких лотов</h3>
                  <div className="lot-settings-row" style={{ alignItems: 'flex-end', gap: 8 }}>
                    <label className="lot-settings-field" style={{ flex: 1 }}>
                      <span className="lot-settings-field__label">Метка</span>
                      <input
                        type="text"
                        className="lot-settings-input"
                        value={settingsLabelInput}
                        onChange={(e) => setSettingsLabelInput(e.target.value)}
                        placeholder="Без метки — настройки только для этого товара"
                      />
                    </label>
                    <button
                      type="button"
                      className="lot-settings-btn lot-settings-btn--secondary"
                      onClick={handleApplyLabel}
                    >
                      Применить
                    </button>
                  </div>
                </section>
                <section className="lot-settings-block">
                  <h3 className="lot-settings-block__title">Себестоимость</h3>
                  <label className="lot-settings-field">
                    <span className="lot-settings-field__label">Себестоимость товара (₽)</span>
                    <input
                      type="number"
                      className="lot-settings-input lot-settings-input--price"
                      min={0}
                      step={0.01}
                      value={productSettings?.cost ?? 0}
                      onChange={(e) => setProductSettings((p) => ({ ...p, cost: parseFloat(e.target.value) || 0 }))}
                    />
                  </label>
                </section>
                <section className="lot-settings-block">
                  <h3 className="lot-settings-block__title">Автовыдача</h3>
                  <label className="lot-settings-toggle">
                    <input
                      type="checkbox"
                      className="lot-settings-toggle__input"
                      checked={Boolean(productSettings?.autodelivery?.enabled)}
                      onChange={(e) => setAutodelivery('enabled', e.target.checked)}
                    />
                    <span className="lot-settings-toggle__switch">
                      <span className="lot-settings-toggle__knob" />
                    </span>
                    <span className="lot-settings-toggle__label">Включить автовыдачу</span>
                  </label>
                  {Boolean(productSettings?.autodelivery?.enabled) && (
                    <div className="lot-settings-autodelivery-extra">
                      <div className="lot-settings-row">
                        <input
                          type="text"
                          className="lot-settings-input"
                          placeholder="Ввести код"
                          value={newCodeInput}
                          onChange={(e) => setNewCodeInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              addCode(newCodeInput)
                              setNewCodeInput('')
                            }
                          }}
                        />
                        <button
                          type="button"
                          className="lot-settings-btn lot-settings-btn--secondary"
                          onClick={() => { addCode(newCodeInput); setNewCodeInput('') }}
                        >
                          Добавить код
                        </button>
                      </div>
                      <button
                        type="button"
                        className="lot-settings-btn lot-settings-btn--secondary"
                        onClick={() => setCodesModalOpen(true)}
                      >
                        Посмотреть все коды
                      </button>
                      <label className="lot-settings-field">
                        <span className="lot-settings-field__label">Сообщение при покупке</span>
                        <textarea
                          className="lot-settings-textarea"
                          value={productSettings?.autodelivery?.messageOnPurchase ?? ''}
                          onChange={(e) => setAutodelivery('messageOnPurchase', e.target.value)}
                          placeholder="Текст сообщения покупателю после выдачи кода"
                          rows={3}
                        />
                      </label>
                      <label className="lot-settings-toggle">
                        <input
                          type="checkbox"
                          className="lot-settings-toggle__input"
                          checked={Boolean(productSettings?.autodelivery?.autoCompleteDeal)}
                          onChange={(e) => setAutodelivery('autoCompleteDeal', e.target.checked)}
                        />
                        <span className="lot-settings-toggle__switch">
                          <span className="lot-settings-toggle__knob" />
                        </span>
                        <span className="lot-settings-toggle__label">Автозавершение сделки после выдачи кода</span>
                      </label>
                    </div>
                  )}
                </section>
                <section className="lot-settings-block">
                  <h3 className="lot-settings-block__title">Автовыставление</h3>
                  <label className="lot-settings-toggle">
                    <input
                      type="checkbox"
                      className="lot-settings-toggle__input"
                      checked={Boolean(productSettings?.autolist?.enabled)}
                      onChange={(e) => setFeature('autolist', 'enabled', e.target.checked)}
                    />
                    <span className="lot-settings-toggle__switch">
                      <span className="lot-settings-toggle__knob" />
                    </span>
                    <span className="lot-settings-toggle__label">Включить автовыставление</span>
                  </label>
                </section>
                <section className="lot-settings-block">
                  <h3 className="lot-settings-block__title">Автосообщение</h3>
                  <label className="lot-settings-toggle">
                    <input
                      type="checkbox"
                      className="lot-settings-toggle__input"
                      checked={Boolean(productSettings?.automessage?.enabled)}
                      onChange={(e) => setAutomessage('enabled', e.target.checked)}
                    />
                    <span className="lot-settings-toggle__switch">
                      <span className="lot-settings-toggle__knob" />
                    </span>
                    <span className="lot-settings-toggle__label">Включить автосообщение</span>
                  </label>
                  {Boolean(productSettings?.automessage?.enabled) && (
                    <div className="lot-settings-automessage-list">
                      <span className="lot-settings-field__label">Сообщения (отправляются по порядку)</span>
                      {(productSettings?.automessage?.messages || []).map((text, index) => (
                        <div key={index} className="lot-settings-automessage-row">
                          <input
                            type="text"
                            className="lot-settings-input"
                            value={text}
                            onChange={(e) => updateAutomessageRow(index, e.target.value)}
                            placeholder={`Сообщение ${index + 1}`}
                          />
                          <button
                            type="button"
                            className="lot-settings-btn lot-settings-btn--secondary lot-settings-automessage-remove"
                            onClick={() => removeAutomessageRow(index)}
                            title="Удалить сообщение"
                          >
                            Удалить
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        className="lot-settings-btn lot-settings-btn--secondary"
                        onClick={addAutomessageRow}
                      >
                        + Добавить сообщение
                      </button>
                    </div>
                  )}
                </section>
                {showSupercellEmailValidation && (
                  <section className="lot-settings-block">
                    <h3 className="lot-settings-block__title">Проверка почты Supercell ID</h3>
                    <label className="lot-settings-toggle">
                      <input
                        type="checkbox"
                        className="lot-settings-toggle__input"
                        checked={Boolean(productSettings?.emailValidation?.enabled)}
                        onChange={(e) => setEmailValidation('enabled', e.target.checked)}
                      />
                      <span className="lot-settings-toggle__switch">
                        <span className="lot-settings-toggle__knob" />
                      </span>
                      <span className="lot-settings-toggle__label">
                        Включить проверку валидности почты
                      </span>
                    </label>
                    {Boolean(productSettings?.emailValidation?.enabled) && (
                      <label className="lot-settings-field">
                        <span className="lot-settings-field__label">
                          Сообщение покупателю при невалидной почте
                        </span>
                        <textarea
                          className="lot-settings-textarea"
                          value={productSettings?.emailValidation?.invalidEmailMessage ?? ''}
                          onChange={(e) =>
                            setEmailValidation('invalidEmailMessage', e.target.value)
                          }
                          placeholder="Текст сообщения, которое автоматически отправится в чат, если почта Supercell ID невалидна"
                          rows={3}
                        />
                      </label>
                    )}
                  </section>
                )}
                <section className="lot-settings-block">
                  <h3 className="lot-settings-block__title">Автоподнятие</h3>
                  <div className="lot-settings-row" style={{ alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: '0.75rem' }}>
                    <button
                      type="button"
                      className="lot-settings-btn lot-settings-btn--secondary"
                      onClick={handleBumpOnce}
                      disabled={bumpDisabled}
                      title={bumpDisabled ? 'Подождите перед повторным поднятием' : 'Поднять товар 1 раз'}
                    >
                      {bumpInFlight
                        ? 'Поднимаем…'
                        : bumpRemainingSec
                          ? `Поднять товар (${bumpRemainingSec}с)`
                          : 'Поднять товар'}
                    </button>
                    <span className="card-text" style={{ margin: 0 }}>
                      Защита от повторного поднятия: 10 сек
                    </span>
                  </div>
                  <label className="lot-settings-toggle">
                    <input
                      type="checkbox"
                      className="lot-settings-toggle__input"
                      checked={Boolean(productSettings?.autobump?.enabled)}
                      onChange={(e) => {
                        const checked = e.target.checked
                        setProductSettings((prev) => {
                          const prevAutobump = prev?.autobump || {}
                          return {
                            ...prev,
                            autobump: {
                              ...prevAutobump,
                              enabled: checked,
                              enabledAt: checked ? Math.floor(Date.now() / 1000) : null,
                            },
                          }
                        })
                      }}
                    />
                    <span className="lot-settings-toggle__switch">
                      <span className="lot-settings-toggle__knob" />
                    </span>
                    <span className="lot-settings-toggle__label">Включить автоподнятие</span>
                  </label>
                  {Boolean(productSettings?.autobump?.enabled) && (
                    <div className="lot-settings-autobump-extra">
                      <div className="lot-settings-row" style={{ marginBottom: '0.75rem' }}>
                        <label className="lot-settings-field">
                          <span className="lot-settings-field__label">Статус поднятия</span>
                          {loadingPriorityStatuses ? (
                            <p className="card-text">Загружаем статусы поднятия…</p>
                          ) : priorityStatusesError ? (
                            <p className="card-text card-text--error">{priorityStatusesError}</p>
                          ) : priorityStatuses.length === 0 ? (
                            <p className="card-text">Статусы поднятия не найдены для этого лота.</p>
                          ) : (
                            <select
                              className="lot-settings-input"
                              value={productSettings?.autobump?.priorityStatusId || ''}
                              onChange={(e) => setFeature('autobump', 'priorityStatusId', e.target.value || null)}
                            >
                              {priorityStatuses.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.name || s.id}
                                  {typeof s.price === 'number' ? ` — ${s.price}₽` : ''}
                                  {s.period ? ` (${s.period})` : ''}
                                </option>
                              ))}
                            </select>
                          )}
                        </label>
                      </div>
                      <div className="lot-settings-schedule-list">
                        {(productSettings?.autobump?.schedule || []).map((item, index) => (
                          <div
                            key={index}
                            className={`lot-settings-schedule-item${scheduleDragOverIndex === index ? ' lot-settings-schedule-item--drag-over' : ''}`}
                            onDragOver={(e) => handleScheduleDragOver(e, index)}
                            onDragLeave={handleScheduleDragLeave}
                            onDrop={(e) => handleScheduleDrop(e, index)}
                          >
                            <span
                              className="lot-settings-schedule-drag-handle"
                              draggable
                              onDragStart={(e) => handleScheduleDragStart(e, index)}
                              onDragEnd={handleScheduleDragEnd}
                              title="Перетащите для смены порядка (приоритета)"
                              aria-label="Перетащить для смены порядка"
                            >
                              ⋮⋮
                            </span>
                            <label className="lot-settings-schedule-row">
                              <span className="lot-settings-schedule-priority-badge" title="Приоритет задаётся порядком (перетащите строку)">№{item.priority ?? index + 1}</span>
                              <span className="lot-settings-schedule__label">С</span>
                              <input
                                type="time"
                                className="lot-settings-input lot-settings-input--time"
                                value={item.start || '12:00'}
                                onChange={(e) => updateAutobumpScheduleItem(index, 'start', e.target.value)}
                              />
                              <span className="lot-settings-schedule__label">до</span>
                              <input
                                type="time"
                                className="lot-settings-input lot-settings-input--time"
                                value={item.end || '13:00'}
                                onChange={(e) => updateAutobumpScheduleItem(index, 'end', e.target.value)}
                              />
                              <span className="lot-settings-schedule__label">каждые</span>
                              <input
                                type="number"
                                className="lot-settings-input lot-settings-input--num lot-settings-input--interval"
                                min={1}
                                max={1440}
                                value={item.intervalMinutes ?? 3}
                                onChange={(e) => updateAutobumpScheduleItem(index, 'intervalMinutes', Math.max(1, parseInt(e.target.value, 10) || 1))}
                              />
                              <span className="lot-settings-schedule__label">мин</span>
                            </label>
                            <button
                              type="button"
                              className="lot-settings-btn lot-settings-btn--secondary lot-settings-schedule__remove"
                              onClick={() => removeAutobumpScheduleItem(index)}
                              title="Удалить окно"
                            >
                              Удалить
                            </button>
                          </div>
                        ))}
                      </div>
                      <button
                        type="button"
                        className="lot-settings-btn lot-settings-btn--secondary"
                        onClick={addAutobumpScheduleItem}
                      >
                        + Добавить временное окно
                      </button>
                    </div>
                  )}
                </section>

                {codesModalOpen && (
                  <div className="modal-backdrop" onClick={() => setCodesModalOpen(false)} role="presentation">
                    <div className="modal" onClick={(e) => e.stopPropagation()}>
                      <div className="modal__header">
                        <h3 className="modal__title">Все коды</h3>
                        <button type="button" className="modal__close" onClick={() => setCodesModalOpen(false)} aria-label="Закрыть">×</button>
                      </div>
                      <div className="modal__body">
                        {(productSettings?.autodelivery?.codes?.length ?? 0) === 0 ? (
                          <p className="card-text">Кодов пока нет. Добавьте их в поле «Ввести код» выше.</p>
                        ) : (
                          <ul className="codes-list">
                            {productSettings.autodelivery.codes.map((code, index) => (
                              <li key={`${code}-${index}`} className="codes-list__item">
                                <span className="codes-list__code">{code}</span>
                                <button type="button" className="codes-list__delete" onClick={() => removeCode(index)} title="Удалить">Удалить</button>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                <div className="lot-settings-page__actions">
                  <button
                    type="button"
                    className="lot-settings-save-btn"
                    onClick={handleSaveSettings}
                    disabled={savingSettings}
                  >
                    {savingSettings ? 'Сохранение…' : 'Сохранить настройки'}
                  </button>
                </div>
              </>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
