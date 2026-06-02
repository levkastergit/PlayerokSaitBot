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
import { fetchApprouteServices, fetchApprouteServiceVariants, formatApprouteVariantLabel } from '../../services/approuteApi'

export function LotSettingsPage({ lot, token, onBack, loading = false }) {
  const [productSettings, setProductSettings] = useState(null)
  const [settingsTab, setSettingsTab] = useState('general')
  const [loadingSettings, setLoadingSettings] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)
  const [settingsError, setSettingsError] = useState(null)
  const [toast, setToast] = useState(null)
  const [codesModalOpen, setCodesModalOpen] = useState(false)
  const [newCodeInput, setNewCodeInput] = useState('')
  const [settingsLabel, setSettingsLabel] = useState('')
  const [priorityStatuses, setPriorityStatuses] = useState([])
  const [loadingPriorityStatuses, setLoadingPriorityStatuses] = useState(false)
  const [priorityStatusesError, setPriorityStatusesError] = useState(null)
  const [groupSuggestions, setGroupSuggestions] = useState([])
  const [bumpInFlight, setBumpInFlight] = useState(false)
  const [bumpCooldownUntil, setBumpCooldownUntil] = useState(0)
  const [nowTs, setNowTs] = useState(() => Date.now())
  const [scheduleDragOverIndex, setScheduleDragOverIndex] = useState(null)
  const [approuteServices, setApprouteServices] = useState([])
  const [approuteServicesLoading, setApprouteServicesLoading] = useState(false)
  const [approuteServicesError, setApprouteServicesError] = useState(null)
  const [approuteVariants, setApprouteVariants] = useState([])
  const [approuteVariantsLoading, setApprouteVariantsLoading] = useState(false)
  const [approuteVariantsError, setApprouteVariantsError] = useState(null)
  const [topupVariants, setTopupVariants] = useState([])
  const [topupVariantsLoading, setTopupVariantsLoading] = useState(false)
  const [topupVariantsError, setTopupVariantsError] = useState(null)
  // Скрытый режим отладки: включается набором слова «дебаг» на странице.
  const [debugMode, setDebugMode] = useState(false)
  const debugBufferRef = useRef('')

  useEffect(() => {
    const TARGET = 'дебаг'
    const onKeyDown = (e) => {
      const k = e.key
      if (!k || k.length !== 1) return
      const buf = (debugBufferRef.current + k.toLowerCase()).slice(-TARGET.length)
      debugBufferRef.current = buf
      if (buf === TARGET) {
        debugBufferRef.current = ''
        setDebugMode((prev) => !prev)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const baseProductKey = lot ? getProductKey(lot) : null
  const groupKey = settingsLabel ? getGroupSettingsKey(settingsLabel) : ''
  const effectiveProductKey = groupKey || baseProductKey

  const splitSettingsForSave = (allSettings, label) => {
    const full = allSettings && typeof allSettings === 'object' ? allSettings : {}
    const trimmedLabel = String(label || '').trim()

    // Убираем priorityStatusId из autobump и autolist перед сохранением - всегда используем актуальные данные
    const cleaned = { ...full }
    if (cleaned.autobump && typeof cleaned.autobump === 'object') {
      const { priorityStatusId, ...autobumpWithoutPriority } = cleaned.autobump
      cleaned.autobump = autobumpWithoutPriority
    }
    if (cleaned.autolist && typeof cleaned.autolist === 'object') {
      const { priorityStatusId, ...autolistWithoutPriority } = cleaned.autolist
      cleaned.autolist = autolistWithoutPriority
    }

    const groupSettings = trimmedLabel
      ? { ...cleaned, settingsLabel: trimmedLabel }
      : { ...cleaned, settingsLabel: '' }

    // Автоподнятие не должно попадать в метку (групповые настройки).
    delete groupSettings.autobump

    const itemSettings = trimmedLabel
      ? {
          settingsLabel: trimmedLabel,
          groupName: typeof cleaned.groupName === 'string' ? cleaned.groupName : '',
          autobump: cleaned.autobump || { enabled: false, schedule: [] },
          autodeliveryApi: cleaned.autodeliveryApi || { enabled: false },
          autotopupApi: cleaned.autotopupApi || { enabled: false },
        }
      : { ...cleaned, settingsLabel: '' }

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
    costUsd: 0,
    settingsLabel: '',
    groupName: '',
    autodelivery: {
      enabled: false,
      codes: [],
      messageOnPurchase: '',
      autoCompleteDeal: false,
    },
    autodeliveryApi: {
      enabled: false,
      serviceId: '',
      serviceName: '',
      variantId: '',
      variantName: '',
      variantOrderServiceId: '',
      denominationId: '',
      variantRequired: false,
      ordersType: 'shop',
      quantity: 1,
      messageOnPurchase: '',
      deliveryMessage: '{delivery}',
      autoCompleteDeal: false,
    },
    autotopupApi: {
      enabled: false,
      serviceId: '',
      serviceName: '',
      variantId: '',
      variantName: '',
      variantOrderServiceId: '',
      denominationId: '',
      variantRequired: false,
      quantity: 1,
      amount: '',
      amountCurrencyCode: 'RUB',
      askIdMessage: 'Для пополнения напишите ваш игровой ID/логин.',
      confirmTemplate: 'Подтвердите: ваш ID/логин — {id}. Всё верно? Напишите «да» или «нет».',
      invalidIdMessage: 'ID/логин не прошёл проверку. Пришлите, пожалуйста, корректный ID/логин ещё раз.',
      successMessage: 'Готово! Пополнение выполнено. Спасибо за покупку.',
      autoCompleteDeal: false,
    },
    autolist: { enabled: false },
    automessage: {
      enabled: false,
      messages: [],
    },
    postPurchaseAutomessage: {
      enabled: false,
      message: '',
    },
    dealConfirmedAutomessage: {
      enabled: false,
      message: '',
    },
    purchaseWindowAutomessage: {
      enabled: false,
      message: '',
      start: '12:00',
      end: '13:00',
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
    if (!token) {
      setGroupSuggestions([])
      return
    }
    let cancelled = false
    loadProductSettingsList(token)
      .then((data) => {
        if (cancelled) return
        const list = Array.isArray(data?.list) ? data.list : []
        const groups = new Set()
        list.forEach((entry) => {
          const groupFromSettings = String(entry?.settings?.groupName || '').trim()
          if (groupFromSettings) groups.add(groupFromSettings)
        })
        setGroupSuggestions([...groups].sort((a, b) => a.localeCompare(b, 'ru')))
      })
      .catch(() => { })
    return () => { cancelled = true }
  }, [token])

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
    if (!productSettings?.autodeliveryApi?.enabled && !productSettings?.autotopupApi?.enabled) {
      setApprouteServices([])
      setApprouteServicesError(null)
      setApprouteServicesLoading(false)
      return
    }
    let cancelled = false
    setApprouteServicesLoading(true)
    setApprouteServicesError(null)
    fetchApprouteServices()
      .then((r) => {
        if (cancelled) return
        if (!r.ok) {
          setApprouteServices([])
          setApprouteServicesError(r.error || 'Не удалось загрузить услуги AppRoute')
        } else {
          setApprouteServices(r.services || [])
          setApprouteServicesError(null)
        }
        setApprouteServicesLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setApprouteServices([])
        setApprouteServicesError('Не удалось загрузить услуги AppRoute')
        setApprouteServicesLoading(false)
      })
    return () => { cancelled = true }
  }, [productSettings?.autodeliveryApi?.enabled, productSettings?.autotopupApi?.enabled])

  const approuteServiceId = productSettings?.autodeliveryApi?.serviceId ?? ''

  useEffect(() => {
    if (!productSettings?.autodeliveryApi?.enabled) {
      setApprouteVariants([])
      setApprouteVariantsError(null)
      setApprouteVariantsLoading(false)
      return
    }
    const sid = String(approuteServiceId || '').trim()
    if (!sid) {
      setApprouteVariants([])
      setApprouteVariantsError(null)
      setApprouteVariantsLoading(false)
      return
    }
    let cancelled = false
    setApprouteVariantsLoading(true)
    setApprouteVariantsError(null)
    fetchApprouteServiceVariants(sid)
      .then((r) => {
        if (cancelled) return
        if (!r.ok) {
          setApprouteVariants([])
          setApprouteVariantsError(r.error || 'Не удалось загрузить номиналы')
          setProductSettings((prev) => {
            if (!prev?.autodeliveryApi) return prev
            return {
              ...prev,
              autodeliveryApi: { ...prev.autodeliveryApi, variantRequired: false },
            }
          })
        } else {
          const variants = r.variants || []
          setApprouteVariants(variants)
          setApprouteVariantsError(null)
          setProductSettings((prev) => {
            if (!prev?.autodeliveryApi) return prev
            const api = prev.autodeliveryApi
            const curVariant = String(api.variantId || '').trim()
            const stillValid = variants.some((v) => String(v.id) === curVariant)
            const variantRequired = variants.length > 0
            let nextVariantId = api.variantId
            let nextVariantName = api.variantName
            let nextVariantOrderServiceId = api.variantOrderServiceId || ''
            let nextDenominationId = api.denominationId || ''
            if (!stillValid && curVariant) {
              nextVariantId = ''
              nextVariantName = ''
              nextVariantOrderServiceId = ''
              nextDenominationId = ''
            } else if (stillValid && curVariant) {
              const picked = variants.find((v) => String(v.id) === curVariant)
              nextVariantName = picked ? formatApprouteVariantLabel(picked) : api.variantName
              nextVariantOrderServiceId = picked?.orderServiceId
                ? String(picked.orderServiceId)
                : curVariant
              nextDenominationId = picked?.denominationId
                ? String(picked.denominationId)
                : curVariant
            }
            const nextOrdersType =
              r.ordersType != null && String(r.ordersType).trim()
                ? String(r.ordersType).trim().toLowerCase()
                : api.ordersType || 'shop'
            return {
              ...prev,
              autodeliveryApi: {
                ...api,
                variantId: nextVariantId,
                variantName: nextVariantName,
                variantOrderServiceId: nextVariantOrderServiceId,
                denominationId: nextDenominationId,
                variantRequired,
                ordersType: nextOrdersType,
              },
            }
          })
        }
        setApprouteVariantsLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setApprouteVariants([])
        setApprouteVariantsError('Не удалось загрузить номиналы')
        setApprouteVariantsLoading(false)
      })
    return () => { cancelled = true }
  }, [productSettings?.autodeliveryApi?.enabled, approuteServiceId])

  const topupServiceId = productSettings?.autotopupApi?.serviceId ?? ''

  // Услуги AppRoute делим по типу: direct_topup -> автопополнение, остальные
  // (voucher и т.п.) -> автовыдача. Услуги без типа показываем в обоих (фолбэк).
  const serviceTypeOf = (s) => String(s?.serviceType || '').trim().toLowerCase()
  const isDtuService = (s) => serviceTypeOf(s) === 'direct_topup'
  const shopServices = approuteServices.filter((s) => !isDtuService(s))
  const dtuServices = approuteServices.filter((s) => {
    const t = serviceTypeOf(s)
    return !t || t === 'direct_topup'
  })

  useEffect(() => {
    if (!productSettings?.autotopupApi?.enabled) {
      setTopupVariants([])
      setTopupVariantsError(null)
      setTopupVariantsLoading(false)
      return
    }
    const sid = String(topupServiceId || '').trim()
    if (!sid) {
      setTopupVariants([])
      setTopupVariantsError(null)
      setTopupVariantsLoading(false)
      return
    }
    let cancelled = false
    setTopupVariantsLoading(true)
    setTopupVariantsError(null)
    fetchApprouteServiceVariants(sid)
      .then((r) => {
        if (cancelled) return
        if (!r.ok) {
          setTopupVariants([])
          setTopupVariantsError(r.error || 'Не удалось загрузить номиналы')
          setProductSettings((prev) => {
            if (!prev?.autotopupApi) return prev
            return { ...prev, autotopupApi: { ...prev.autotopupApi, variantRequired: false } }
          })
        } else {
          const variants = r.variants || []
          setTopupVariants(variants)
          setTopupVariantsError(null)
          setProductSettings((prev) => {
            if (!prev?.autotopupApi) return prev
            const api = prev.autotopupApi
            const curVariant = String(api.variantId || '').trim()
            const stillValid = variants.some((v) => String(v.id) === curVariant)
            const variantRequired = variants.length > 0
            let nextVariantId = api.variantId
            let nextVariantName = api.variantName
            let nextVariantOrderServiceId = api.variantOrderServiceId || ''
            let nextDenominationId = api.denominationId || ''
            if (!stillValid && curVariant) {
              nextVariantId = ''
              nextVariantName = ''
              nextVariantOrderServiceId = ''
              nextDenominationId = ''
            } else if (stillValid && curVariant) {
              const picked = variants.find((v) => String(v.id) === curVariant)
              nextVariantName = picked ? formatApprouteVariantLabel(picked) : api.variantName
              nextVariantOrderServiceId = picked?.orderServiceId ? String(picked.orderServiceId) : curVariant
              nextDenominationId = picked?.denominationId ? String(picked.denominationId) : curVariant
            }
            return {
              ...prev,
              autotopupApi: {
                ...api,
                variantId: nextVariantId,
                variantName: nextVariantName,
                variantOrderServiceId: nextVariantOrderServiceId,
                denominationId: nextDenominationId,
                variantRequired,
              },
            }
          })
        }
        setTopupVariantsLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setTopupVariants([])
        setTopupVariantsError('Не удалось загрузить номиналы')
        setTopupVariantsLoading(false)
      })
    return () => { cancelled = true }
  }, [productSettings?.autotopupApi?.enabled, topupServiceId])

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
        costUsd: typeof loaded.costUsd === 'number' ? loaded.costUsd : (parseFloat(loaded.costUsd) || 0),
        groupName: typeof loaded.groupName === 'string' ? loaded.groupName : '',
        autodelivery: { ...base.autodelivery, ...(loaded.autodelivery || {}) },
        autodeliveryApi: {
          ...base.autodeliveryApi,
          ...(loaded.autodeliveryApi || {}),
          serviceId:
            loaded.autodeliveryApi?.serviceId != null
              ? String(loaded.autodeliveryApi.serviceId)
              : '',
          serviceName:
            typeof loaded.autodeliveryApi?.serviceName === 'string'
              ? loaded.autodeliveryApi.serviceName
              : '',
          quantity: Math.max(1, Math.min(99, Math.floor(Number(loaded.autodeliveryApi?.quantity) || 1))),
          variantId:
            loaded.autodeliveryApi?.variantId != null
              ? String(loaded.autodeliveryApi.variantId)
              : '',
          variantName:
            typeof loaded.autodeliveryApi?.variantName === 'string'
              ? loaded.autodeliveryApi.variantName
              : '',
          variantRequired: Boolean(loaded.autodeliveryApi?.variantRequired),
          variantOrderServiceId:
            typeof loaded.autodeliveryApi?.variantOrderServiceId === 'string'
              ? loaded.autodeliveryApi.variantOrderServiceId
              : '',
          denominationId:
            loaded.autodeliveryApi?.denominationId != null
              ? String(loaded.autodeliveryApi.denominationId)
              : '',
          ordersType:
            loaded.autodeliveryApi?.ordersType != null
              ? String(loaded.autodeliveryApi.ordersType).toLowerCase()
              : 'shop',
        },
        autotopupApi: {
          ...base.autotopupApi,
          ...(loaded.autotopupApi || {}),
          enabled: Boolean(loaded.autotopupApi?.enabled),
          serviceId:
            loaded.autotopupApi?.serviceId != null ? String(loaded.autotopupApi.serviceId) : '',
          serviceName:
            typeof loaded.autotopupApi?.serviceName === 'string' ? loaded.autotopupApi.serviceName : '',
          quantity: Math.max(1, Math.min(99, Math.floor(Number(loaded.autotopupApi?.quantity) || 1))),
          variantId:
            loaded.autotopupApi?.variantId != null ? String(loaded.autotopupApi.variantId) : '',
          variantName:
            typeof loaded.autotopupApi?.variantName === 'string' ? loaded.autotopupApi.variantName : '',
          variantRequired: Boolean(loaded.autotopupApi?.variantRequired),
          variantOrderServiceId:
            typeof loaded.autotopupApi?.variantOrderServiceId === 'string'
              ? loaded.autotopupApi.variantOrderServiceId
              : '',
          denominationId:
            loaded.autotopupApi?.denominationId != null ? String(loaded.autotopupApi.denominationId) : '',
          amount:
            loaded.autotopupApi?.amount != null ? String(loaded.autotopupApi.amount) : '',
          amountCurrencyCode:
            typeof loaded.autotopupApi?.amountCurrencyCode === 'string' && loaded.autotopupApi.amountCurrencyCode
              ? loaded.autotopupApi.amountCurrencyCode
              : 'RUB',
          askIdMessage:
            typeof loaded.autotopupApi?.askIdMessage === 'string'
              ? loaded.autotopupApi.askIdMessage
              : base.autotopupApi.askIdMessage,
          confirmTemplate:
            typeof loaded.autotopupApi?.confirmTemplate === 'string'
              ? loaded.autotopupApi.confirmTemplate
              : base.autotopupApi.confirmTemplate,
          invalidIdMessage:
            typeof loaded.autotopupApi?.invalidIdMessage === 'string'
              ? loaded.autotopupApi.invalidIdMessage
              : base.autotopupApi.invalidIdMessage,
          successMessage:
            typeof loaded.autotopupApi?.successMessage === 'string'
              ? loaded.autotopupApi.successMessage
              : base.autotopupApi.successMessage,
          autoCompleteDeal: Boolean(loaded.autotopupApi?.autoCompleteDeal),
        },
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
        postPurchaseAutomessage: {
          ...base.postPurchaseAutomessage,
          ...(loaded.postPurchaseAutomessage || {}),
          enabled: Boolean(loaded.postPurchaseAutomessage?.enabled),
          message:
            typeof loaded.postPurchaseAutomessage?.message === 'string'
              ? loaded.postPurchaseAutomessage.message
              : '',
        },
        dealConfirmedAutomessage: {
          ...base.dealConfirmedAutomessage,
          ...(loaded.dealConfirmedAutomessage || {}),
          enabled: Boolean(loaded.dealConfirmedAutomessage?.enabled),
          message:
            typeof loaded.dealConfirmedAutomessage?.message === 'string'
              ? loaded.dealConfirmedAutomessage.message
              : '',
        },
        purchaseWindowAutomessage: {
          ...base.purchaseWindowAutomessage,
          ...(loaded.purchaseWindowAutomessage || {}),
          enabled: Boolean(loaded.purchaseWindowAutomessage?.enabled),
          message:
            typeof loaded.purchaseWindowAutomessage?.message === 'string'
              ? loaded.purchaseWindowAutomessage.message
              : '',
          start:
            typeof loaded.purchaseWindowAutomessage?.start === 'string' &&
            loaded.purchaseWindowAutomessage.start
              ? loaded.purchaseWindowAutomessage.start
              : base.purchaseWindowAutomessage.start,
          end:
            typeof loaded.purchaseWindowAutomessage?.end === 'string' &&
            loaded.purchaseWindowAutomessage.end
              ? loaded.purchaseWindowAutomessage.end
              : base.purchaseWindowAutomessage.end,
        },
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

      ; (async () => {
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
              groupName: typeof baseLoaded?.groupName === 'string'
                ? baseLoaded.groupName
                : (typeof groupLoaded?.groupName === 'string' ? groupLoaded.groupName : ''),
              autobump: baseLoaded?.autobump || null,
            }
            setSettingsLabel(trimmedLinked)
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
        saveProductSettings(token, baseProductKey, itemSettings).catch(() => { }),
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
      // НЕ передаем priorityStatusId - бэкенд всегда получает актуальный список статусов
      await recordBump(token, {
        productKey: baseProductKey,
        productTitle: lot.title || 'Товар',
        itemId: lot.id,
        price: lot.price,
        // priorityStatusId не передается - всегда используется актуальный список статусов
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
          saveProductSettings(token, baseProductKey, itemSettings).catch(() => { }),
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

  const setPostPurchaseAutomessage = (field, value) => {
    setProductSettings((prev) => ({
      ...prev,
      postPurchaseAutomessage: { ...(prev?.postPurchaseAutomessage || {}), [field]: value },
    }))
  }

  const setDealConfirmedAutomessage = (field, value) => {
    setProductSettings((prev) => ({
      ...prev,
      dealConfirmedAutomessage: { ...(prev?.dealConfirmedAutomessage || {}), [field]: value },
    }))
  }

  const setPurchaseWindowAutomessage = (field, value) => {
    setProductSettings((prev) => ({
      ...prev,
      purchaseWindowAutomessage: { ...(prev?.purchaseWindowAutomessage || {}), [field]: value },
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
                <h2 className="lot-settings-page__title">
                  Настройки товара
                  {debugMode && (
                    <span style={{ marginLeft: 8, fontSize: '0.7em', color: '#ef4444', fontWeight: 600 }}>
                      • режим отладки
                    </span>
                  )}
                </h2>
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
                <div className="lot-settings-tabs" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={settingsTab === 'general'}
                    className={
                      'lot-settings-tab' + (settingsTab === 'general' ? ' lot-settings-tab--active' : '')
                    }
                    onClick={() => setSettingsTab('general')}
                  >
                    Основные настройки
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={settingsTab === 'automessage'}
                    className={
                      'lot-settings-tab' + (settingsTab === 'automessage' ? ' lot-settings-tab--active' : '')
                    }
                    onClick={() => setSettingsTab('automessage')}
                  >
                    Настройки автосообщения
                  </button>
                </div>
                {settingsTab === 'general' && (
                <>
                <section className="lot-settings-block">
                  <h3 className="lot-settings-block__title">Группа товара</h3>
                  <div className="lot-settings-row" style={{ alignItems: 'flex-end', gap: 8 }}>
                    <label className="lot-settings-field" style={{ flex: 1 }}>
                      <span className="lot-settings-field__label">Группа</span>
                      <input
                        type="text"
                        className="lot-settings-input"
                        value={productSettings?.groupName ?? ''}
                        onChange={(e) => setProductSettings((prev) => ({ ...prev, groupName: e.target.value }))}
                        list="lot-group-suggestions"
                        placeholder="Новая или существующая группа"
                      />
                      <datalist id="lot-group-suggestions">
                        {groupSuggestions.map((groupName) => (
                          <option key={groupName} value={groupName} />
                        ))}
                      </datalist>
                    </label>
                  </div>
                </section>
                <section className="lot-settings-block">
                  <h3 className="lot-settings-block__title">Себестоимость</h3>
                  <label className="lot-settings-field">
                    <span className="lot-settings-field__label">Себестоимость товара ($)</span>
                    <input
                      type="number"
                      className="lot-settings-input lot-settings-input--price"
                      min={0}
                      step={0.01}
                      value={productSettings?.costUsd ?? 0}
                      onChange={(e) => setProductSettings((p) => ({ ...p, costUsd: parseFloat(e.target.value) || 0 }))}
                    />
                    <span className="lot-settings-field__hint">
                      В долларах. Для прибыли конвертируется в ₽ по курсу ЦБ на дату продажи.
                    </span>
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
                  <h3 className="lot-settings-block__title">Автовыдача Api</h3>
                  <label className="lot-settings-toggle">
                    <input
                      type="checkbox"
                      className="lot-settings-toggle__input"
                      checked={Boolean(productSettings?.autodeliveryApi?.enabled)}
                      onChange={(e) => setFeature('autodeliveryApi', 'enabled', e.target.checked)}
                    />
                    <span className="lot-settings-toggle__switch">
                      <span className="lot-settings-toggle__knob" />
                    </span>
                    <span className="lot-settings-toggle__label">Включить автовыдачу Api</span>
                  </label>
                  {Boolean(productSettings?.autodeliveryApi?.enabled) && (
                    <div className="lot-settings-autodelivery-extra">
                      {approuteServicesLoading && (
                        <p className="lot-settings-field__label">Загрузка услуг AppRoute…</p>
                      )}
                      {approuteServicesError && (
                        <p className="lot-settings-field__label">{approuteServicesError}</p>
                      )}
                      <label className="lot-settings-field">
                        <span className="lot-settings-field__label">Услуга AppRoute</span>
                        <select
                          className="lot-settings-input"
                          value={productSettings?.autodeliveryApi?.serviceId ?? ''}
                          onChange={(e) => {
                            const id = e.target.value
                            const picked = approuteServices.find((s) => String(s.id) === String(id))
                            setProductSettings((prev) => ({
                              ...prev,
                              autodeliveryApi: {
                                ...(prev?.autodeliveryApi || {}),
                                serviceId: id,
                                serviceName: picked?.name || '',
                                variantId: '',
                                variantName: '',
                                variantOrderServiceId: '',
                                variantRequired: false,
                              },
                            }))
                          }}
                        >
                          <option value="">— выберите услугу —</option>
                          {shopServices.map((svc) => (
                            <option key={svc.id} value={svc.id}>
                              {svc.name}
                              {svc.price != null ? ` (${svc.price} ₽)` : ''}
                            </option>
                          ))}
                        </select>
                      </label>
                      {String(approuteServiceId || '').trim() && (
                        <>
                          {approuteVariantsLoading && (
                            <p className="lot-settings-field__label">Загрузка номиналов…</p>
                          )}
                          {approuteVariantsError && (
                            <p className="lot-settings-field__label">{approuteVariantsError}</p>
                          )}
                          {approuteVariants.length > 0 && (
                            <label className="lot-settings-field">
                              <span className="lot-settings-field__label">Номинал</span>
                              <select
                                className="lot-settings-input"
                                value={productSettings?.autodeliveryApi?.variantId ?? ''}
                                  onChange={(e) => {
                                    const vid = e.target.value
                                    const picked = approuteVariants.find((v) => String(v.id) === String(vid))
                                    setProductSettings((prev) => ({
                                      ...prev,
                                      autodeliveryApi: {
                                        ...(prev?.autodeliveryApi || {}),
                                        variantId: vid,
                                        variantName: picked ? formatApprouteVariantLabel(picked) : '',
                                        variantOrderServiceId: picked?.orderServiceId
                                          ? String(picked.orderServiceId)
                                          : vid,
                                        denominationId: picked?.denominationId
                                          ? String(picked.denominationId)
                                          : vid,
                                      },
                                    }))
                                  }}
                              >
                                <option value="">— выберите номинал —</option>
                                {approuteVariants.map((v) => (
                                  <option key={v.id} value={v.id}>
                                    {formatApprouteVariantLabel(v)}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                        </>
                      )}
                      {debugMode && (
                        <label className="lot-settings-field">
                          <span className="lot-settings-field__label">ID услуги (если нет в списке)</span>
                          <input
                            type="text"
                            className="lot-settings-input"
                            value={productSettings?.autodeliveryApi?.serviceId ?? ''}
                            onChange={(e) =>
                              setProductSettings((prev) => ({
                                ...prev,
                                autodeliveryApi: {
                                  ...(prev?.autodeliveryApi || {}),
                                  serviceId: e.target.value,
                                  variantId: '',
                                  variantName: '',
                                  variantOrderServiceId: '',
                                  variantRequired: false,
                                },
                              }))
                            }
                          />
                        </label>
                      )}
                      {debugMode && approuteVariants.length > 0 && (
                        <label className="lot-settings-field">
                          <span className="lot-settings-field__label">ID номинала (если нет в списке)</span>
                          <input
                            type="text"
                            className="lot-settings-input"
                            value={productSettings?.autodeliveryApi?.variantId ?? ''}
                            onChange={(e) => setFeature('autodeliveryApi', 'variantId', e.target.value)}
                          />
                        </label>
                      )}
                      <label className="lot-settings-field">
                        <span className="lot-settings-field__label">Сообщение с выдачей ({'{delivery}'}, {'{Kod}'})</span>
                        <textarea
                          className="lot-settings-textarea"
                          value={productSettings?.autodeliveryApi?.deliveryMessage ?? '{delivery}'}
                          onChange={(e) => setFeature('autodeliveryApi', 'deliveryMessage', e.target.value)}
                          rows={3}
                        />
                      </label>
                      <label className="lot-settings-toggle">
                        <input
                          type="checkbox"
                          className="lot-settings-toggle__input"
                          checked={Boolean(productSettings?.autodeliveryApi?.autoCompleteDeal)}
                          onChange={(e) => setFeature('autodeliveryApi', 'autoCompleteDeal', e.target.checked)}
                        />
                        <span className="lot-settings-toggle__switch">
                          <span className="lot-settings-toggle__knob" />
                        </span>
                        <span className="lot-settings-toggle__label">Автозавершение сделки</span>
                      </label>
                    </div>
                  )}
                </section>
                <section className="lot-settings-block">
                  <h3 className="lot-settings-block__title">Автопополнение по API</h3>
                  <p className="card-text">
                    После оплаты бот попросит покупателя прислать игровой ID/логин, проверит его через
                    AppRoute и переспросит подтверждение. После «да» — пополнит аккаунт напрямую.
                  </p>
                  <label className="lot-settings-toggle">
                    <input
                      type="checkbox"
                      className="lot-settings-toggle__input"
                      checked={Boolean(productSettings?.autotopupApi?.enabled)}
                      onChange={(e) => setFeature('autotopupApi', 'enabled', e.target.checked)}
                    />
                    <span className="lot-settings-toggle__switch">
                      <span className="lot-settings-toggle__knob" />
                    </span>
                    <span className="lot-settings-toggle__label">Включить автопополнение по API</span>
                  </label>
                  {Boolean(productSettings?.autotopupApi?.enabled) && (
                    <div className="lot-settings-autodelivery-extra">
                      {approuteServicesLoading && (
                        <p className="lot-settings-field__label">Загрузка услуг AppRoute…</p>
                      )}
                      {approuteServicesError && (
                        <p className="lot-settings-field__label">{approuteServicesError}</p>
                      )}
                      <label className="lot-settings-field">
                        <span className="lot-settings-field__label">Услуга AppRoute (пополнение)</span>
                        <select
                          className="lot-settings-input"
                          value={productSettings?.autotopupApi?.serviceId ?? ''}
                          onChange={(e) => {
                            const id = e.target.value
                            const picked = approuteServices.find((s) => String(s.id) === String(id))
                            setProductSettings((prev) => ({
                              ...prev,
                              autotopupApi: {
                                ...(prev?.autotopupApi || {}),
                                serviceId: id,
                                serviceName: picked?.name || '',
                                variantId: '',
                                variantName: '',
                                variantOrderServiceId: '',
                                denominationId: '',
                                variantRequired: false,
                              },
                            }))
                          }}
                        >
                          <option value="">— выберите услугу —</option>
                          {dtuServices.map((svc) => (
                            <option key={svc.id} value={svc.id}>
                              {svc.name}
                              {svc.price != null ? ` (${svc.price} ₽)` : ''}
                            </option>
                          ))}
                        </select>
                      </label>
                      {String(topupServiceId || '').trim() && (
                        <>
                          {topupVariantsLoading && (
                            <p className="lot-settings-field__label">Загрузка номиналов…</p>
                          )}
                          {topupVariantsError && (
                            <p className="lot-settings-field__label">{topupVariantsError}</p>
                          )}
                          {topupVariants.length > 0 && (
                            <label className="lot-settings-field">
                              <span className="lot-settings-field__label">Номинал</span>
                              <select
                                className="lot-settings-input"
                                value={productSettings?.autotopupApi?.variantId ?? ''}
                                onChange={(e) => {
                                  const vid = e.target.value
                                  const picked = topupVariants.find((v) => String(v.id) === String(vid))
                                  setProductSettings((prev) => ({
                                    ...prev,
                                    autotopupApi: {
                                      ...(prev?.autotopupApi || {}),
                                      variantId: vid,
                                      variantName: picked ? formatApprouteVariantLabel(picked) : '',
                                      variantOrderServiceId: picked?.orderServiceId
                                        ? String(picked.orderServiceId)
                                        : vid,
                                      denominationId: picked?.denominationId
                                        ? String(picked.denominationId)
                                        : vid,
                                    },
                                  }))
                                }}
                              >
                                <option value="">— выберите номинал —</option>
                                {topupVariants.map((v) => (
                                  <option key={v.id} value={v.id}>
                                    {formatApprouteVariantLabel(v)}
                                  </option>
                                ))}
                              </select>
                            </label>
                          )}
                        </>
                      )}
                      {debugMode && (
                        <label className="lot-settings-field">
                          <span className="lot-settings-field__label">ID номинала (denominationId, если нет в списке)</span>
                          <input
                            type="text"
                            className="lot-settings-input"
                            value={productSettings?.autotopupApi?.denominationId ?? ''}
                            onChange={(e) => setFeature('autotopupApi', 'denominationId', e.target.value)}
                          />
                        </label>
                      )}
                      <label className="lot-settings-field">
                        <span className="lot-settings-field__label">Сообщение «запросить ID/логин»</span>
                        <textarea
                          className="lot-settings-textarea"
                          rows={2}
                          value={productSettings?.autotopupApi?.askIdMessage ?? ''}
                          onChange={(e) => setFeature('autotopupApi', 'askIdMessage', e.target.value)}
                        />
                      </label>
                      <label className="lot-settings-field">
                        <span className="lot-settings-field__label">Сообщение подтверждения ({'{id}'} — подставится ID)</span>
                        <textarea
                          className="lot-settings-textarea"
                          rows={2}
                          value={productSettings?.autotopupApi?.confirmTemplate ?? ''}
                          onChange={(e) => setFeature('autotopupApi', 'confirmTemplate', e.target.value)}
                        />
                      </label>
                      <label className="lot-settings-field">
                        <span className="lot-settings-field__label">Сообщение при неверном ID</span>
                        <textarea
                          className="lot-settings-textarea"
                          rows={2}
                          value={productSettings?.autotopupApi?.invalidIdMessage ?? ''}
                          onChange={(e) => setFeature('autotopupApi', 'invalidIdMessage', e.target.value)}
                        />
                      </label>
                      <label className="lot-settings-field">
                        <span className="lot-settings-field__label">Сообщение об успешном пополнении</span>
                        <textarea
                          className="lot-settings-textarea"
                          rows={2}
                          value={productSettings?.autotopupApi?.successMessage ?? ''}
                          onChange={(e) => setFeature('autotopupApi', 'successMessage', e.target.value)}
                        />
                      </label>
                      <label className="lot-settings-toggle">
                        <input
                          type="checkbox"
                          className="lot-settings-toggle__input"
                          checked={Boolean(productSettings?.autotopupApi?.autoCompleteDeal)}
                          onChange={(e) => setFeature('autotopupApi', 'autoCompleteDeal', e.target.checked)}
                        />
                        <span className="lot-settings-toggle__switch">
                          <span className="lot-settings-toggle__knob" />
                        </span>
                        <span className="lot-settings-toggle__label">Автозавершение сделки после пополнения</span>
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
                </>
                )}
                {settingsTab === 'automessage' && (
                <>
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
                <section className="lot-settings-block">
                  <h3 className="lot-settings-block__title">Автосообщение после покупки товара</h3>
                  <p className="card-text">
                    Отправляется в чат после системного сообщения «Товар отправлен».
                  </p>
                  <label className="lot-settings-toggle">
                    <input
                      type="checkbox"
                      className="lot-settings-toggle__input"
                      checked={Boolean(productSettings?.postPurchaseAutomessage?.enabled)}
                      onChange={(e) => setPostPurchaseAutomessage('enabled', e.target.checked)}
                    />
                    <span className="lot-settings-toggle__switch">
                      <span className="lot-settings-toggle__knob" />
                    </span>
                    <span className="lot-settings-toggle__label">
                      Включить автосообщение после покупки товара
                    </span>
                  </label>
                  {Boolean(productSettings?.postPurchaseAutomessage?.enabled) && (
                    <label className="lot-settings-field">
                      <span className="lot-settings-field__label">Текст сообщения</span>
                      <textarea
                        className="lot-settings-textarea"
                        rows={4}
                        value={productSettings?.postPurchaseAutomessage?.message ?? ''}
                        onChange={(e) => setPostPurchaseAutomessage('message', e.target.value)}
                        placeholder="Сообщение покупателю после отправки товара"
                      />
                    </label>
                  )}
                </section>
                <section className="lot-settings-block">
                  <h3 className="lot-settings-block__title">Автосообщение после подтверждения сделки</h3>
                  <p className="card-text">
                    Отправляется в чат после системного сообщения «Сделка подтверждена» (или «подтверждена автоматически»).
                  </p>
                  <label className="lot-settings-toggle">
                    <input
                      type="checkbox"
                      className="lot-settings-toggle__input"
                      checked={Boolean(productSettings?.dealConfirmedAutomessage?.enabled)}
                      onChange={(e) => setDealConfirmedAutomessage('enabled', e.target.checked)}
                    />
                    <span className="lot-settings-toggle__switch">
                      <span className="lot-settings-toggle__knob" />
                    </span>
                    <span className="lot-settings-toggle__label">
                      Включить автосообщение после подтверждения сделки
                    </span>
                  </label>
                  {Boolean(productSettings?.dealConfirmedAutomessage?.enabled) && (
                    <label className="lot-settings-field">
                      <span className="lot-settings-field__label">Текст сообщения</span>
                      <textarea
                        className="lot-settings-textarea"
                        rows={4}
                        value={productSettings?.dealConfirmedAutomessage?.message ?? ''}
                        onChange={(e) => setDealConfirmedAutomessage('message', e.target.value)}
                        placeholder="Сообщение покупателю после подтверждения сделки"
                      />
                    </label>
                  )}
                </section>
                <section className="lot-settings-block">
                  <h3 className="lot-settings-block__title">Автосообщение по времени покупки</h3>
                  <p className="card-text">
                    Если покупатель оплатит товар в указанный промежуток времени (по МСК), ему
                    отправится это сообщение. Если покупка вне промежутка — сообщение не отправляется,
                    задание считается выполненным.
                  </p>
                  <label className="lot-settings-toggle">
                    <input
                      type="checkbox"
                      className="lot-settings-toggle__input"
                      checked={Boolean(productSettings?.purchaseWindowAutomessage?.enabled)}
                      onChange={(e) => setPurchaseWindowAutomessage('enabled', e.target.checked)}
                    />
                    <span className="lot-settings-toggle__switch">
                      <span className="lot-settings-toggle__knob" />
                    </span>
                    <span className="lot-settings-toggle__label">
                      Включить автосообщение по времени покупки
                    </span>
                  </label>
                  {Boolean(productSettings?.purchaseWindowAutomessage?.enabled) && (
                    <>
                      <div className="lot-settings-time-window">
                        <label className="lot-settings-field lot-settings-time-window__field">
                          <span className="lot-settings-field__label">С (МСК)</span>
                          <input
                            type="time"
                            className="lot-settings-input"
                            value={productSettings?.purchaseWindowAutomessage?.start ?? '12:00'}
                            onChange={(e) => setPurchaseWindowAutomessage('start', e.target.value)}
                          />
                        </label>
                        <label className="lot-settings-field lot-settings-time-window__field">
                          <span className="lot-settings-field__label">До (МСК)</span>
                          <input
                            type="time"
                            className="lot-settings-input"
                            value={productSettings?.purchaseWindowAutomessage?.end ?? '13:00'}
                            onChange={(e) => setPurchaseWindowAutomessage('end', e.target.value)}
                          />
                        </label>
                      </div>
                      <label className="lot-settings-field">
                        <span className="lot-settings-field__label">Текст сообщения</span>
                        <textarea
                          className="lot-settings-textarea"
                          rows={4}
                          value={productSettings?.purchaseWindowAutomessage?.message ?? ''}
                          onChange={(e) => setPurchaseWindowAutomessage('message', e.target.value)}
                          placeholder="Сообщение покупателю при покупке в заданное время"
                        />
                      </label>
                    </>
                  )}
                </section>
                </>
                )}
                {settingsTab === 'general' && (
                <>
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
                </>
                )}

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
