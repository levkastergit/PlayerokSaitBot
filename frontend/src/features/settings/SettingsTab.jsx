import React, { useEffect, useMemo, useState } from 'react'
import { DdosTab } from '../ddos/DdosTab.jsx'
import { ChatLoggingTab } from '../chat-logging/ChatLoggingTab.jsx'
import { TestTab } from '../test/TestTab.jsx'
import { changeAccountPassword, fetchAuthMe } from '../../services/authApi'
import {
  OUTBOUND_IP_DISABLED,
  OUTBOUND_IP_ROTATE,
  fetchOutboundIpSettings,
  fetchOutboundIps,
  saveOutboundIpSettings,
} from '../../services/outboundIpApi'
import {
  fetchApprouteSettings,
  saveApprouteApiKey,
  clearApprouteApiKey,
} from '../../services/approuteApi'
import {
  fetchClodeSettings,
  saveClodeApiKey,
  clearClodeApiKey,
} from '../../services/clodeApi'
import { fetchSwizzyerSettings, saveSwizzyerSettings } from '../../services/swizzyerApi'
import { fetchPartnerGptSettings, savePartnerGptApiKey } from '../../services/partnerGptApi'

const SETTINGS_SUB_TABS = [
  { id: '', label: 'Основные' },
  { id: 'ddos', label: 'Ddos' },
  { id: 'chat-logging', label: 'Логирование чата' },
  { id: 'test', label: 'Тест' },
]

export function SettingsTab({ token, onTokenChange, onLogout, subTab = '', onSubTabChange }) {
  const activeSub = SETTINGS_SUB_TABS.some((t) => t.id === subTab) ? subTab : ''
  const [value, setValue] = useState(token ?? '')
  const [savedAt, setSavedAt] = useState(null)
  const [isSaved, setIsSaved] = useState(Boolean(token))

  const [meLoading, setMeLoading] = useState(true)
  const [accountLogin, setAccountLogin] = useState(null)
  const [userId, setUserId] = useState(null)

  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [pwdSubmitting, setPwdSubmitting] = useState(false)
  const [pwdMessage, setPwdMessage] = useState(null)
  const [pwdError, setPwdError] = useState(null)

  const [ipLoading, setIpLoading] = useState(true)
  const [ipAddresses, setIpAddresses] = useState([])
  const [ipChannels, setIpChannels] = useState([])
  const [ipBindings, setIpBindings] = useState({})
  const [ipLegacyEnv, setIpLegacyEnv] = useState(null)
  const [ipDisabledValue, setIpDisabledValue] = useState(OUTBOUND_IP_DISABLED)
  const [ipRotateValue, setIpRotateValue] = useState(OUTBOUND_IP_ROTATE)
  const [ipRotationEnabled, setIpRotationEnabled] = useState(false)
  const [ipExcludedIps, setIpExcludedIps] = useState([])
  const [ipSaving, setIpSaving] = useState(false)
  const [ipMessage, setIpMessage] = useState(null)
  const [ipError, setIpError] = useState(null)

  const [approuteKeyValue, setApprouteKeyValue] = useState('')
  const [approuteConfigured, setApprouteConfigured] = useState(false)
  const [approuteLoading, setApprouteLoading] = useState(true)
  const [approuteSaving, setApprouteSaving] = useState(false)
  const [approuteMessage, setApprouteMessage] = useState(null)
  const [approuteError, setApprouteError] = useState(null)
  const [clodeKeyValue, setClodeKeyValue] = useState('')
  const [clodeConfigured, setClodeConfigured] = useState(false)
  const [clodeLoading, setClodeLoading] = useState(true)
  const [clodeSaving, setClodeSaving] = useState(false)
  const [clodeMessage, setClodeMessage] = useState(null)
  const [clodeError, setClodeError] = useState(null)
  // Swizzyer (автовыдача Roblox): ключ API + секрет вебхука.
  const [swizzyerKeyValue, setSwizzyerKeyValue] = useState('')
  const [swizzyerWebhookValue, setSwizzyerWebhookValue] = useState('')
  const [swizzyerMeta, setSwizzyerMeta] = useState(null)
  const [swizzyerLoading, setSwizzyerLoading] = useState(true)
  const [swizzyerSaving, setSwizzyerSaving] = useState(false)
  const [swizzyerMessage, setSwizzyerMessage] = useState(null)
  const [swizzyerError, setSwizzyerError] = useState(null)
  // Partner ChatGPT API: ключ.
  const [partnerGptKeyValue, setPartnerGptKeyValue] = useState('')
  const [partnerGptConfigured, setPartnerGptConfigured] = useState(false)
  const [partnerGptLoading, setPartnerGptLoading] = useState(true)
  const [partnerGptSaving, setPartnerGptSaving] = useState(false)
  const [partnerGptMessage, setPartnerGptMessage] = useState(null)
  const [partnerGptError, setPartnerGptError] = useState(null)

  useEffect(() => {
    setValue(token ?? '')
    setIsSaved(Boolean(token))
  }, [token])

  useEffect(() => {
    let cancelled = false
    setMeLoading(true)
    fetchAuthMe().then((r) => {
      if (cancelled) return
      if (r.ok) {
        setAccountLogin(r.login)
        setUserId(r.userId)
      } else {
        setAccountLogin(null)
        setUserId(null)
      }
      setMeLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    setIpLoading(true)
    setIpError(null)
    Promise.all([fetchOutboundIps(), fetchOutboundIpSettings()]).then(([ips, settings]) => {
      if (cancelled) return
      if (!ips.ok) {
        setIpError(ips.error || 'Не удалось загрузить IP')
        setIpLoading(false)
        return
      }
      setIpAddresses(ips.addresses)
      setIpLegacyEnv(ips.legacyEnvIp)
      setIpDisabledValue(ips.disabledValue || OUTBOUND_IP_DISABLED)
      setIpRotateValue(ips.rotateValue || OUTBOUND_IP_ROTATE)
      const channels =
        (settings.ok && settings.channels?.length ? settings.channels : ips.channels) || []
      setIpChannels(channels)
      setIpBindings(settings.ok ? settings.bindings : {})
      setIpRotationEnabled(Boolean(settings.ok && settings.rotation && settings.rotation.enabled))
      setIpExcludedIps(
        settings.ok && settings.rotation && Array.isArray(settings.rotation.excludedIps)
          ? settings.rotation.excludedIps
          : []
      )
      if (!settings.ok) {
        setIpError(settings.error || null)
      }
      setIpLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  // Периодически обновляем список IP (вместе со статусом блокировки 429), чтобы
  // заблокированные адреса подсвечивались красным в реальном времени. Обновляем
  // только ipAddresses — выбор пользователя (ipBindings) не трогаем.
  useEffect(() => {
    if (activeSub !== '') return undefined
    let cancelled = false
    const id = setInterval(() => {
      fetchOutboundIps().then((ips) => {
        if (cancelled || !ips.ok) return
        setIpAddresses(ips.addresses)
        setIpLegacyEnv(ips.legacyEnvIp)
      })
    }, 8000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [activeSub])

  useEffect(() => {
    let cancelled = false
    setApprouteLoading(true)
    setApprouteError(null)
    fetchApprouteSettings().then((r) => {
      if (cancelled) return
      if (r.ok) {
        setApprouteConfigured(Boolean(r.configured))
      } else {
        setApprouteError(r.error || null)
      }
      setApprouteLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    setClodeLoading(true)
    setClodeError(null)
    fetchClodeSettings().then((r) => {
      if (cancelled) return
      if (r.ok) {
        setClodeConfigured(Boolean(r.configured))
      } else {
        setClodeError(r.error || null)
      }
      setClodeLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    setSwizzyerLoading(true)
    setSwizzyerError(null)
    fetchSwizzyerSettings().then((r) => {
      if (cancelled) return
      if (r.ok) setSwizzyerMeta(r)
      else setSwizzyerError(r.error || null)
      setSwizzyerLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    setPartnerGptLoading(true)
    setPartnerGptError(null)
    fetchPartnerGptSettings().then((r) => {
      if (cancelled) return
      if (r.ok) setPartnerGptConfigured(Boolean(r.configured))
      else setPartnerGptError(r.error || null)
      setPartnerGptLoading(false)
    })
    return () => { cancelled = true }
  }, [])

  const ipSelectOptions = useMemo(() => {
    const opts = [
      { value: ipDisabledValue, label: 'Выключено' },
      { value: '', label: 'Автовыбор (без привязки)' },
      { value: ipRotateValue, label: 'Чередование (ротация)' },
    ]
    for (const row of ipAddresses) {
      if (row?.address)
        opts.push({
          value: row.address,
          label: row.blocked ? `${row.address} — заблокирован (${row.blockLabel})` : row.address,
          blocked: Boolean(row.blocked),
        })
    }
    return opts
  }, [ipAddresses, ipDisabledValue, ipRotateValue])

  // Сколько IP реально участвует в ротации (нужно ≥2, иначе крутить нечего).
  // Вручную исключённые из ротации адреса (excludedIps) не считаем.
  const ipExcludedSet = useMemo(() => new Set(ipExcludedIps), [ipExcludedIps])
  const ipPoolSize = ipAddresses.filter((a) => a.address && !ipExcludedSet.has(a.address)).length
  // Какие категории фактически крутят IP: явное «Чередование» или «Автовыбор» при
  // включённом глобальном тумблере. Для подсказок/бейджей.
  const ipChannelRotates = (binding) =>
    binding !== ipDisabledValue && (binding === ipRotateValue || ipRotationEnabled)

  const handleIpBindingChange = (channelId, value) => {
    setIpBindings((prev) => ({ ...prev, [channelId]: value }))
    setIpMessage(null)
    setIpError(null)
  }

  const handleIpRotationToggle = (checked) => {
    setIpRotationEnabled(checked)
    setIpMessage(null)
    setIpError(null)
  }

  // Ручное исключение IP из ротации: переключаем адрес в списке excludedIps.
  const handleIpExcludedToggle = (address, excluded) => {
    const addr = String(address || '').trim()
    if (!addr) return
    setIpExcludedIps((prev) => {
      const set = new Set(prev)
      if (excluded) set.add(addr)
      else set.delete(addr)
      return Array.from(set)
    })
    setIpMessage(null)
    setIpError(null)
  }

  const handleSaveIpBindings = async (event) => {
    event.preventDefault()
    setIpSaving(true)
    setIpMessage(null)
    setIpError(null)
    const r = await saveOutboundIpSettings(ipBindings, {
      enabled: ipRotationEnabled,
      excludedIps: ipExcludedIps,
    })
    setIpSaving(false)
    if (r.ok) {
      setIpBindings(r.bindings || ipBindings)
      if (r.rotation) {
        setIpRotationEnabled(Boolean(r.rotation.enabled))
        if (Array.isArray(r.rotation.excludedIps)) setIpExcludedIps(r.rotation.excludedIps)
      }
      setIpMessage('Настройки IP сохранены')
    } else {
      setIpError(r.error || 'Ошибка сохранения')
    }
  }

  const accountLabel =
    accountLogin ||
    (userId != null && Number.isFinite(Number(userId)) ? `Пользователь #${userId}` : null) ||
    '—'

  const showLoginHint =
    !meLoading && accountLabel === '—'

  const handleSaveToken = (event) => {
    event.preventDefault()
    onTokenChange?.(value.trim())
    setValue('')
    setIsSaved(true)
    setSavedAt(new Date())
  }

  const handleClearToken = () => {
    setValue('')
    onTokenChange?.('')
    setIsSaved(false)
    setSavedAt(new Date())
  }

  const handleSaveApprouteKey = async (event) => {
    event.preventDefault()
    setApprouteSaving(true)
    setApprouteMessage(null)
    setApprouteError(null)
    const r = await saveApprouteApiKey(approuteKeyValue)
    setApprouteSaving(false)
    if (r.ok) {
      setApprouteConfigured(Boolean(r.configured))
      setApprouteKeyValue('')
      setApprouteMessage('Ключ AppRoute сохранён')
    } else {
      setApprouteError(r.error || 'Ошибка сохранения')
    }
  }

  const handleClearApprouteKey = async () => {
    setApprouteSaving(true)
    setApprouteMessage(null)
    setApprouteError(null)
    const r = await clearApprouteApiKey()
    setApprouteSaving(false)
    if (r.ok) {
      setApprouteConfigured(false)
      setApprouteKeyValue('')
      setApprouteMessage(null)
    } else {
      setApprouteError(r.error || 'Ошибка')
    }
  }

  const handleSaveClodeKey = async (event) => {
    event.preventDefault()
    setClodeSaving(true)
    setClodeMessage(null)
    setClodeError(null)
    const r = await saveClodeApiKey(clodeKeyValue)
    setClodeSaving(false)
    if (r.ok) {
      setClodeConfigured(Boolean(r.configured))
      setClodeKeyValue('')
      setClodeMessage('Ключ Clode сохранён')
    } else {
      setClodeError(r.error || 'Ошибка сохранения')
    }
  }

  const handleClearClodeKey = async () => {
    setClodeSaving(true)
    setClodeMessage(null)
    setClodeError(null)
    const r = await clearClodeApiKey()
    setClodeSaving(false)
    if (r.ok) {
      setClodeConfigured(false)
      setClodeKeyValue('')
      setClodeMessage(null)
    } else {
      setClodeError(r.error || 'Ошибка')
    }
  }

  const refreshSwizzyerMeta = async () => {
    const fresh = await fetchSwizzyerSettings()
    if (fresh.ok) setSwizzyerMeta(fresh)
  }

  const handleSaveSwizzyer = async (event) => {
    event.preventDefault()
    setSwizzyerSaving(true)
    setSwizzyerMessage(null)
    setSwizzyerError(null)
    // Отправляем только непустые поля — пустое не затирает уже сохранённое.
    const payload = {}
    if (swizzyerKeyValue.trim()) payload.apiKey = swizzyerKeyValue.trim()
    if (swizzyerWebhookValue.trim()) payload.webhookSecret = swizzyerWebhookValue.trim()
    if (!payload.apiKey && !payload.webhookSecret) {
      setSwizzyerSaving(false)
      setSwizzyerError('Введите ключ или секрет вебхука')
      return
    }
    const r = await saveSwizzyerSettings(payload)
    setSwizzyerSaving(false)
    if (r.ok) {
      setSwizzyerKeyValue('')
      setSwizzyerWebhookValue('')
      setSwizzyerMessage('Настройки Swizzyer сохранены')
      await refreshSwizzyerMeta()
    } else {
      setSwizzyerError(r.error || 'Ошибка сохранения')
    }
  }

  const handleClearSwizzyer = async () => {
    setSwizzyerSaving(true)
    setSwizzyerMessage(null)
    setSwizzyerError(null)
    const r = await saveSwizzyerSettings({ apiKey: '', webhookSecret: '' })
    setSwizzyerSaving(false)
    if (r.ok) {
      setSwizzyerKeyValue('')
      setSwizzyerWebhookValue('')
      setSwizzyerMessage(null)
      await refreshSwizzyerMeta()
    } else {
      setSwizzyerError(r.error || 'Ошибка')
    }
  }

  const handleSavePartnerGpt = async (event) => {
    event.preventDefault()
    setPartnerGptSaving(true)
    setPartnerGptMessage(null)
    setPartnerGptError(null)
    const r = await savePartnerGptApiKey(partnerGptKeyValue)
    setPartnerGptSaving(false)
    if (r.ok) {
      setPartnerGptConfigured(Boolean(r.configured))
      setPartnerGptKeyValue('')
      setPartnerGptMessage('Ключ Partner ChatGPT сохранён')
    } else {
      setPartnerGptError(r.error || 'Ошибка сохранения')
    }
  }

  const handleClearPartnerGpt = async () => {
    setPartnerGptSaving(true)
    setPartnerGptMessage(null)
    setPartnerGptError(null)
    const r = await savePartnerGptApiKey('')
    setPartnerGptSaving(false)
    if (r.ok) {
      setPartnerGptConfigured(false)
      setPartnerGptKeyValue('')
      setPartnerGptMessage(null)
    } else {
      setPartnerGptError(r.error || 'Ошибка')
    }
  }

  const handlePasswordSubmit = async (event) => {
    event.preventDefault()
    setPwdMessage(null)
    setPwdError(null)
    if (newPassword !== confirmPassword) {
      setPwdError('Новый пароль и подтверждение не совпадают')
      return
    }
    setPwdSubmitting(true)
    const r = await changeAccountPassword(currentPassword, newPassword)
    setPwdSubmitting(false)
    if (r.ok) {
      setCurrentPassword('')
      setNewPassword('')
      setConfirmPassword('')
      setPwdMessage('Пароль обновлён')
    } else {
      setPwdError(r.error || 'Ошибка')
    }
  }

  return (
    <div className="tab-page settings-page">
      <div className="tab-page-header tab-page-header--settings">
        <h1>Настройки</h1>
      </div>

      <div className="balance-hub__tabs settings-hub__tabs" role="tablist">
        {SETTINGS_SUB_TABS.map((t) => (
          <button
            key={t.id || 'main'}
            type="button"
            role="tab"
            aria-selected={activeSub === t.id}
            className={'balance-hub__tab' + (activeSub === t.id ? ' balance-hub__tab--active' : '')}
            onClick={() => onSubTabChange?.(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="balance-hub__panel" hidden={activeSub !== ''}>
      <div className="settings-layout">
        <section className="card settings-card settings-card--account">
          <div className="card-title-row settings-account-head">
            <div>
              <h2 className="card-title">Аккаунт</h2>
              <p className="card-text settings-hint settings-account-hint">
                Основная информация по текущей сессии.
              </p>
            </div>
            <span className="settings-chip">
              {meLoading ? 'Проверка соединения...' : 'Аккаунт подключён'}
            </span>
          </div>
          {meLoading ? (
            <p className="card-text">Загрузка…</p>
          ) : (
            <>
              <p className="card-text">
                <span className="settings-meta-key">Имя (логин): </span>
                <strong className="settings-meta-value">{accountLabel}</strong>
              </p>
              {showLoginHint && (
                <p className="card-text settings-hint">
                  Не удалось загрузить логин. Выйдите и войдите снова или обновите страницу.
                </p>
              )}
              <div className="settings-account-actions">
                <button
                  type="button"
                  className="btn-secondary settings-logout-btn"
                  onClick={onLogout}
                >
                  Выйти из аккаунта
                </button>
              </div>
            </>
          )}
        </section>

        <section className="card settings-card settings-card--approute">
          <h2 className="card-title">AppRoute API</h2>
          <p className="card-text settings-hint">
            Ключ для автовыдачи через{' '}
            <a href="https://approute.ru/" target="_blank" rel="noopener noreferrer">
              approute.ru
            </a>
            . Заголовок запроса: X-Api-Key.
          </p>
          {approuteLoading ? (
            <p className="card-text">Загрузка…</p>
          ) : (
            <form className="settings-form" onSubmit={handleSaveApprouteKey}>
              <label htmlFor="approute-api-key" className="settings-label">
                API-ключ
              </label>
              <input
                id="approute-api-key"
                className="input-theme"
                type="password"
                value={approuteKeyValue}
                onChange={(e) => setApprouteKeyValue(e.target.value)}
                placeholder={approuteConfigured ? 'Ключ сохранён (скрыт)' : 'Вставьте API-ключ'}
                autoComplete="off"
              />
              <div className="token-actions">
                <button type="submit" className="btn-primary" disabled={approuteSaving}>
                  Сохранить ключ
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={approuteSaving}
                  onClick={handleClearApprouteKey}
                >
                  Очистить
                </button>
              </div>
              {approuteMessage && (
                <p className="settings-message settings-message--success">{approuteMessage}</p>
              )}
              {approuteError && (
                <p className="settings-message settings-message--error">{approuteError}</p>
              )}
            </form>
          )}
        </section>

        <section className="card settings-card settings-card--clode">
          <h2 className="card-title">Clode API</h2>
          <p className="card-text settings-hint">
            Ключ для автовыдачи Claude (активация CDK) через{' '}
            <a href="https://dlsapi.6661231.xyz/" target="_blank" rel="noopener noreferrer">
              dlsapi.6661231.xyz
            </a>
            . Заголовок запроса: Authorization: Bearer.
          </p>
          {clodeLoading ? (
            <p className="card-text">Загрузка…</p>
          ) : (
            <form className="settings-form" onSubmit={handleSaveClodeKey}>
              <label htmlFor="clode-api-key" className="settings-label">
                API-ключ
              </label>
              <input
                id="clode-api-key"
                className="input-theme"
                type="password"
                value={clodeKeyValue}
                onChange={(e) => setClodeKeyValue(e.target.value)}
                placeholder={clodeConfigured ? 'Ключ сохранён (скрыт)' : 'Вставьте API-ключ (sk_…)'}
                autoComplete="off"
              />
              <div className="token-actions">
                <button type="submit" className="btn-primary" disabled={clodeSaving}>
                  Сохранить ключ
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={clodeSaving}
                  onClick={handleClearClodeKey}
                >
                  Очистить
                </button>
              </div>
              {clodeMessage && (
                <p className="settings-message settings-message--success">{clodeMessage}</p>
              )}
              {clodeError && (
                <p className="settings-message settings-message--error">{clodeError}</p>
              )}
            </form>
          )}
        </section>

        <section className="card settings-card settings-card--swizzyer">
          <h2 className="card-title">Swizzyer API (Roblox)</h2>
          <p className="card-text settings-hint">
            Ключ для автовыдачи Robux через{' '}
            <a href="https://swizzyer.com/" target="_blank" rel="noopener noreferrer">
              swizzyer.com
            </a>{' '}
            (rbcode.net). Заголовок: Authorization: Bearer. Секрет вебхука — необязательно.
          </p>
          {swizzyerLoading ? (
            <p className="card-text">Загрузка…</p>
          ) : (
            <form className="settings-form" onSubmit={handleSaveSwizzyer}>
              <label htmlFor="swizzyer-api-key" className="settings-label">
                API-ключ {swizzyerMeta?.apiKeyConfigured ? '(сохранён)' : ''}
              </label>
              <input
                id="swizzyer-api-key"
                className="input-theme"
                type="password"
                value={swizzyerKeyValue}
                onChange={(e) => setSwizzyerKeyValue(e.target.value)}
                placeholder={swizzyerMeta?.apiKeyConfigured ? 'Ключ сохранён (скрыт)' : 'Вставьте API-ключ (swz_live_…)'}
                autoComplete="off"
              />
              <label htmlFor="swizzyer-webhook" className="settings-label">
                Секрет вебхука {swizzyerMeta?.webhookConfigured ? '(сохранён)' : ''}
              </label>
              <input
                id="swizzyer-webhook"
                className="input-theme"
                type="password"
                value={swizzyerWebhookValue}
                onChange={(e) => setSwizzyerWebhookValue(e.target.value)}
                placeholder={swizzyerMeta?.webhookConfigured ? 'Секрет сохранён (скрыт)' : 'whsec_… (необязательно)'}
                autoComplete="off"
              />
              <div className="token-actions">
                <button type="submit" className="btn-primary" disabled={swizzyerSaving}>
                  Сохранить
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={swizzyerSaving}
                  onClick={handleClearSwizzyer}
                >
                  Очистить
                </button>
              </div>
              {swizzyerMeta?.webhookUrl && (
                <p className="card-text settings-hint">
                  URL вебхука для дашборда Swizzyer: <code>{swizzyerMeta.webhookUrl}</code>
                </p>
              )}
              {swizzyerMessage && (
                <p className="settings-message settings-message--success">{swizzyerMessage}</p>
              )}
              {swizzyerError && (
                <p className="settings-message settings-message--error">{swizzyerError}</p>
              )}
            </form>
          )}
        </section>

        <section className="card settings-card settings-card--partner-gpt">
          <h2 className="card-title">Partner ChatGPT / Claude API</h2>
          <p className="card-text settings-hint">
            Ключ для автовыдачи ChatGPT / Claude Pro (card_code → account_id или organization_id)
            через rootchatgptplus.com. Заголовок: Authorization: Bearer.
          </p>
          {partnerGptLoading ? (
            <p className="card-text">Загрузка…</p>
          ) : (
            <form className="settings-form" onSubmit={handleSavePartnerGpt}>
              <label htmlFor="partner-gpt-api-key" className="settings-label">
                API-ключ
              </label>
              <input
                id="partner-gpt-api-key"
                className="input-theme"
                type="password"
                value={partnerGptKeyValue}
                onChange={(e) => setPartnerGptKeyValue(e.target.value)}
                placeholder={partnerGptConfigured ? 'Ключ сохранён (скрыт)' : 'Вставьте API-ключ (ogp_live_…)'}
                autoComplete="off"
              />
              <div className="token-actions">
                <button type="submit" className="btn-primary" disabled={partnerGptSaving}>
                  Сохранить ключ
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={partnerGptSaving}
                  onClick={handleClearPartnerGpt}
                >
                  Очистить
                </button>
              </div>
              {partnerGptMessage && (
                <p className="settings-message settings-message--success">{partnerGptMessage}</p>
              )}
              {partnerGptError && (
                <p className="settings-message settings-message--error">{partnerGptError}</p>
              )}
            </form>
          )}
        </section>

        <section className="card settings-card settings-card--token">
          <h2 className="card-title">Токен Playerok</h2>
          <p className="card-text settings-hint">Токен хранится в скрытом виде и используется для запросов к API.</p>
          <form className="settings-form" onSubmit={handleSaveToken}>
            <label htmlFor="playerok-token" className="settings-label">
              Токен
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
              <button type="button" onClick={handleClearToken} className="btn-secondary">
                Очистить
              </button>

              {savedAt && (
                <span className="card-text settings-updated-at">
                  Обновлён: {savedAt.toLocaleTimeString()}
                </span>
              )}
            </div>
          </form>
        </section>

        <section className="card settings-card settings-card--outbound-ip">
          <h2 className="card-title">Исходящие IP для Playerok</h2>
          <p className="card-text settings-hint">
            Для каждой категории: IP с сервера, автовыбор, «Чередование» (ротация по кругу) или
            «Выключено» — тогда связанные запросы к Playerok не выполняются, пока категорию снова не
            включите.
          </p>
          {ipLoading ? (
            <p className="card-text">Загрузка адресов…</p>
          ) : ipChannels.length === 0 ? (
            <p className="card-text settings-hint">Не удалось загрузить категории.</p>
          ) : (
            <>
              {ipAddresses.length > 0 ? (
                <p className="card-text settings-outbound-ip-list">
                  <span className="settings-meta-key">Доступные на сервере: </span>
                  <strong className="settings-meta-value">
                    {ipAddresses.map((a, i) => (
                      <React.Fragment key={a.address}>
                        {i > 0 ? ', ' : ''}
                        <span
                          style={a.blocked ? { color: '#ff5555', fontWeight: 700 } : undefined}
                          title={
                            a.blocked
                              ? `Заблокирован Playerok (429). Разблокировка примерно через ${a.blockLabel}`
                              : undefined
                          }
                        >
                          {a.address}
                          {a.blocked ? ` (заблокирован · ${a.blockLabel})` : ''}
                        </span>
                      </React.Fragment>
                    ))}
                  </strong>
                </p>
              ) : (
                <p className="card-text settings-hint">
                  На сервере нет IPv4 для привязки — доступны «Автовыбор» и «Выключено».
                  {ipLegacyEnv ? (
                    <> В .env задан PLAYEROK_OUTBOUND_IP={ipLegacyEnv} (fallback при автовыборе).</>
                  ) : null}
                </p>
              )}
              <form className="settings-form settings-outbound-ip-form" onSubmit={handleSaveIpBindings}>
                <label className="settings-outbound-ip-rotation-toggle">
                  <input
                    type="checkbox"
                    checked={ipRotationEnabled}
                    onChange={(e) => handleIpRotationToggle(e.target.checked)}
                  />
                  <span>
                    <strong>Ротация IP</strong> — при включении ВСЕ категории (кроме «Выключено») по
                    очереди меняют исходящий IP из пула сервера, а повтор после ошибки 429 уходит уже с
                    другого IP. Выбранный для категории конкретный IP при этом игнорируется (он
                    действует только при выключенной ротации). IP, поймавший 429, временно выпадает из
                    ротации (подсвечен красным) — чем дольше он отвечает 429, тем дольше блок: 1 мин →
                    10 мин → 30 мин → 1 ч → 3 ч → 24 ч.
                  </span>
                </label>
                {ipRotationEnabled && ipPoolSize < 2 ? (
                  <p className="settings-hint settings-outbound-ip-hint">
                    ⚠ Для ротации нужно минимум 2 IP на сервере (сейчас {ipPoolSize}). С одним адресом
                    чередовать нечего — запросы пойдут с него же.
                  </p>
                ) : null}
                {ipAddresses.length > 0 ? (
                  <div className="settings-outbound-ip-pool">
                    <p className="settings-label settings-outbound-ip-label">
                      Пул ротации
                      <span className="settings-outbound-ip-badge settings-outbound-ip-badge--rotate">
                        {ipPoolSize} из {ipAddresses.length}
                      </span>
                    </p>
                    <p className="settings-hint settings-outbound-ip-hint">
                      Снимите галочку, чтобы вручную убрать IP из чередования — он перестанет
                      использоваться в ротации, пока вы не вернёте его обратно.
                    </p>
                    <div className="settings-outbound-ip-pool-list">
                      {ipAddresses.map((a) => {
                        const excluded = ipExcludedSet.has(a.address)
                        return (
                          <label
                            key={`pool-${a.address}`}
                            className={
                              excluded
                                ? 'settings-outbound-ip-pool-item settings-outbound-ip-pool-item--excluded'
                                : 'settings-outbound-ip-pool-item'
                            }
                          >
                            <input
                              type="checkbox"
                              checked={!excluded}
                              onChange={(e) => handleIpExcludedToggle(a.address, !e.target.checked)}
                            />
                            <span
                              style={a.blocked ? { color: '#ff5555', fontWeight: 700 } : undefined}
                              title={
                                a.blocked
                                  ? `Заблокирован Playerok (429). Разблокировка примерно через ${a.blockLabel}`
                                  : undefined
                              }
                            >
                              {a.address}
                              {a.blocked ? ` · 429 (${a.blockLabel})` : ''}
                              {excluded ? ' · вне ротации' : ''}
                            </span>
                          </label>
                        )
                      })}
                    </div>
                  </div>
                ) : null}
                <div className="settings-outbound-ip-grid">
                  {ipChannels.map((ch) => {
                    const binding = ipBindings[ch.id] ?? ''
                    const isOff = binding === ipDisabledValue
                    const rotates = !isOff && ipChannelRotates(binding)
                    return (
                      <div key={ch.id} className="settings-outbound-ip-row">
                        <label
                          htmlFor={`outbound-ip-${ch.id}`}
                          className="settings-label settings-outbound-ip-label"
                        >
                          {ch.label}
                          {isOff ? (
                            <span className="settings-outbound-ip-badge settings-outbound-ip-badge--off">
                              отключено
                            </span>
                          ) : null}
                          {rotates ? (
                            <span className="settings-outbound-ip-badge settings-outbound-ip-badge--rotate">
                              ротация
                            </span>
                          ) : null}
                        </label>
                        {ch.hint ? (
                          <p className="settings-hint settings-outbound-ip-hint">{ch.hint}</p>
                        ) : null}
                        <select
                          id={`outbound-ip-${ch.id}`}
                          className={
                            isOff
                              ? 'input-theme settings-outbound-ip-select settings-outbound-ip-select--off'
                              : 'input-theme settings-outbound-ip-select'
                          }
                          value={binding}
                          onChange={(e) => handleIpBindingChange(ch.id, e.target.value)}
                        >
                          {ipSelectOptions.map((opt) => (
                            <option
                              key={`${ch.id}-${opt.value === ipDisabledValue ? 'off' : opt.value || 'auto'}`}
                              value={opt.value}
                              style={opt.blocked ? { color: '#ff5555' } : undefined}
                            >
                              {opt.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    )
                  })}
                </div>
                {ipError && <p className="settings-message settings-message--error">{ipError}</p>}
                {ipMessage && <p className="settings-message settings-message--success">{ipMessage}</p>}
                <button type="submit" className="btn-primary" disabled={ipSaving}>
                  {ipSaving ? 'Сохранение…' : 'Сохранить IP-настройки'}
                </button>
              </form>
            </>
          )}
        </section>

        <section className="card settings-card settings-card--password">
          <h2 className="card-title">Пароль от аккаунта</h2>
          <p className="card-text settings-hint">Используйте надежный пароль и не передавайте его третьим лицам.</p>
          <form className="settings-form" onSubmit={handlePasswordSubmit}>
            <label htmlFor="settings-current-pwd" className="settings-label">
              Текущий пароль
            </label>
            <input
              id="settings-current-pwd"
              className="input-theme settings-input"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
            />
            <label htmlFor="settings-new-pwd" className="settings-label">
              Новый пароль
            </label>
            <input
              id="settings-new-pwd"
              className="input-theme settings-input"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
            />
            <label htmlFor="settings-confirm-pwd" className="settings-label">
              Подтверждение нового пароля
            </label>
            <input
              id="settings-confirm-pwd"
              className="input-theme settings-input"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
            />
            {pwdError && (
              <p className="settings-message settings-message--error">
                {pwdError}
              </p>
            )}
            {pwdMessage && (
              <p className="settings-message settings-message--success">
                {pwdMessage}
              </p>
            )}
            <button type="submit" className="btn-primary settings-password-submit" disabled={pwdSubmitting}>
              {pwdSubmitting ? 'Сохранение…' : 'Сменить пароль'}
            </button>
          </form>
        </section>
      </div>
      </div>

      <div className="balance-hub__panel" hidden={activeSub !== 'ddos'}>
        <DdosTab />
      </div>
      <div className="balance-hub__panel" hidden={activeSub !== 'chat-logging'}>
        <ChatLoggingTab />
      </div>
      <div className="balance-hub__panel" hidden={activeSub !== 'test'}>
        <TestTab token={token} />
      </div>
    </div>
  )
}
