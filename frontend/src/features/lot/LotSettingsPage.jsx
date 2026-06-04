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
  fetchTableTabs,
  uploadAutomessageImage,
  automessageImageUrl,
} from '../../services/playerokApi'
import { fetchApprouteServices, fetchApprouteServiceVariants, formatApprouteVariantLabel } from '../../services/approuteApi'
import { TopupApiFlowDiagram } from './TopupApiFlowDiagram'

const IMAGE_AUTO_TRIGGERS = ['purchase', 'sent', 'confirmed']

const AUTO_MESSAGE_STAGES = [
  { trigger: 'purchase', label: 'Покупка товара' },
  { trigger: 'sent', label: 'Отправка товара' },
  { trigger: 'confirmed', label: 'Подтверждение товара' },
]

const AUTO_PALETTE_TILES = [
  { id: 'text', label: 'Текст' },
  { id: 'time', label: 'Время' },
  { id: 'image', label: 'Картинка' },
  { id: 'autodelivery', label: 'Автовыдача' },
  { id: 'autodeliveryApi', label: 'API' },
  { id: 'autoComplete', label: 'Автозавершение' },
  { id: 'emailValidation', label: 'Валид.Почта' },
  { id: 'supercellAutoRequestCode', label: 'Автозапрос' },
  { id: 'autotopupApi', label: 'Api.Пополнение' },
]

const AUTO_TILE_MIME = 'application/x-lot-auto-tile'

function canDropAutoTile(tileId, stageTrigger, ps) {
  if (
    tileId === 'time' ||
    tileId === 'autodelivery' ||
    tileId === 'autodeliveryApi' ||
    tileId === 'emailValidation' ||
    tileId === 'supercellAutoRequestCode' ||
    tileId === 'autotopupApi'
  ) {
    return stageTrigger === 'purchase'
  }
  if (tileId === 'autoComplete') {
    return stageTrigger === 'purchase' && canBindAutoCompleteTile(ps)
  }
  return AUTO_PALETTE_TILES.some((t) => t.id === tileId)
}

function normalizePurchasePlacementOrder(order) {
  const list = dedupePlacementOrder(order)
  if (!list.includes('c')) return list
  const withoutC = list.filter((k) => k !== 'c')
  if (list.includes('d')) {
    const dIdx = withoutC.indexOf('d')
    if (dIdx >= 0) {
      const next = [...withoutC]
      next.splice(dIdx + 1, 0, 'c')
      return next
    }
  }
  for (const anchor of ['a', 'u']) {
    if (!list.includes(anchor)) continue
    const anchorIdx = withoutC.indexOf(anchor)
    if (anchorIdx >= 0) {
      const next = [...withoutC]
      next.splice(anchorIdx + 1, 0, 'c')
      return next
    }
  }
  return list
}

function canBindAutoCompleteTile(ps) {
  return (
    stageHasAutodeliveryBlock(ps) ||
    purchasePlacementIncludes(ps, 'a') ||
    purchasePlacementIncludes(ps, 'u')
  )
}

function stageTextMessages(trigger, ps) {
  if (!ps) return []
  if (trigger === 'purchase') {
    return Array.isArray(ps.automessage?.messages) ? ps.automessage.messages : []
  }
  if (trigger === 'sent') {
    return Array.isArray(ps.postPurchaseAutomessage?.messages)
      ? ps.postPurchaseAutomessage.messages
      : []
  }
  if (trigger === 'confirmed') {
    return Array.isArray(ps.dealConfirmedAutomessage?.messages)
      ? ps.dealConfirmedAutomessage.messages
      : []
  }
  return []
}

function stageHasTimeBlock(ps) {
  return Boolean(ps?.purchaseWindowAutomessage?.enabled)
}

function stageHasAutodeliveryBlock(ps) {
  return Boolean(ps?.autodelivery?.enabled)
}

function stageHasAutoCompleteBlock(ps) {
  return Boolean(ps?.autodelivery?.autoCompleteDeal)
}

function purchasePlacementIncludes(ps, key) {
  const orders = normalizeAutoPlacementOrder(ps?.autoPlacementOrder)
  return Array.isArray(orders.purchase) && orders.purchase.includes(key)
}

function appendPurchasePlacementKey(ps, key) {
  const orders = normalizeAutoPlacementOrder(ps.autoPlacementOrder)
  let purchase = [...(orders.purchase || [])]
  if (!purchase.includes(key)) purchase.push(key)
  purchase = normalizePurchasePlacementOrder(purchase)
  return {
    ...ps,
    autoPlacementOrder: { ...orders, purchase },
  }
}

function removePurchasePlacementKey(ps, key) {
  const orders = normalizeAutoPlacementOrder(ps.autoPlacementOrder)
  let purchase = (orders.purchase || []).filter((k) => k !== key)
  purchase = normalizePurchasePlacementOrder(purchase)
  return {
    ...ps,
    autoPlacementOrder: { ...orders, purchase },
  }
}

const PLACEMENT_ROW_MIME = 'application/x-lot-placement-row'

function buildPlacementOrder(stage, ps) {
  if (!ps) return []
  const order = []
  stageTextMessages(stage, ps).forEach((_, i) => order.push(`t:${i}`))
  if (stage === 'purchase' && stageHasTimeBlock(ps)) order.push('w')
  if (stage === 'purchase' && stageHasAutodeliveryBlock(ps)) order.push('d')
  if (stage === 'purchase' && stageHasAutoCompleteBlock(ps)) order.push('c')
  imageAutomessageEntriesForTrigger(ps.imageAutomessage?.items, stage).forEach(({ index }) => {
    order.push(`i:${index}`)
  })
  return order
}

function mergePlacementOrder(prevOrder, builtOrder) {
  const builtSet = new Set(builtOrder)
  const kept = (prevOrder || []).filter(
    (k) => builtSet.has(k) || k === 'a' || k === 'e' || k === 's' || k === 'u'
  )
  const keptSet = new Set(kept)
  const added = builtOrder.filter((k) => !keptSet.has(k))
  return [...kept, ...added]
}

function placementTileLabel(key) {
  if (key === 'w') return 'Время'
  if (key === 'd') return 'Автовыдача'
  if (key === 'c') return 'Автозавершение'
  if (key === 'a') return 'Автовыдача Api'
  if (key === 'e') return 'Валид.Почта'
  if (key === 's') return 'Автозапрос'
  if (key === 'u') return 'Api.Пополнение'
  if (key.startsWith('i:')) return 'Картинка'
  return 'Текст'
}

// Тип плитки по ключу размещения — чтобы рисовать одинаковую иконку
// и в палитре, и в размещённой строке.
function placementTileKind(key) {
  if (key === 'w') return 'time'
  if (key === 'd') return 'autodelivery'
  if (key === 'c') return 'autoComplete'
  if (key === 'a') return 'autodeliveryApi'
  if (key === 'e') return 'emailValidation'
  if (key === 's') return 'supercellAutoRequestCode'
  if (key === 'u') return 'autotopupApi'
  if (key && key.startsWith('i:')) return 'image'
  return 'text'
}

// Иконка плитки автосообщений (inline SVG, 16px, наследует currentColor).
function AutoTileIcon({ kind }) {
  const common = {
    viewBox: '0 0 24 24',
    width: 15,
    height: 15,
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.9,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  }
  switch (kind) {
    case 'time':
      return (
        <svg {...common}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 1.8" /></svg>
      )
    case 'image':
      return (
        <svg {...common}><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><circle cx="9" cy="10" r="1.6" /><path d="m4.5 17 4.5-4 4 3.2 3-2.7 3.5 3.5" /></svg>
      )
    case 'autodelivery':
      return (
        <svg {...common}><path d="M12 2.8 4 6.6v8.2l8 3.8 8-3.8V6.6z" /><path d="m4 6.6 8 3.8 8-3.8M12 10.4V18" /></svg>
      )
    case 'autodeliveryApi':
      return (
        <svg {...common}><path d="m9 8-4 4 4 4M15 8l4 4-4 4" /></svg>
      )
    case 'autoComplete':
      return (
        <svg {...common}><circle cx="12" cy="12" r="8.5" /><path d="m8.5 12 2.4 2.4L16 9.5" /></svg>
      )
    case 'emailValidation':
      return (
        <svg {...common}><rect x="3.5" y="5.5" width="17" height="13" rx="2.5" /><path d="m4 7 8 5.5L20 7" /></svg>
      )
    case 'supercellAutoRequestCode':
      return (
        <svg {...common}><circle cx="8" cy="14" r="3.2" /><path d="m10.2 11.8 6-6M14 5.5h3v3" /></svg>
      )
    case 'autotopupApi':
      return (
        <svg {...common}><rect x="3.5" y="6.5" width="17" height="11.5" rx="2.5" /><path d="M16 12h2.5M3.5 10h17" /></svg>
      )
    case 'text':
    default:
      return (
        <svg {...common}><path d="M5 7h14M5 12h14M5 17h9" /></svg>
      )
  }
}

function dedupePlacementOrder(order) {
  const seen = new Set()
  return order.filter((key) => {
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function applyPlacementOrderToSettings(stage, order, prev) {
  if (!prev) return prev
  const safeOrder = dedupePlacementOrder(order)
  const texts = stageTextMessages(stage, prev)
  const newTexts = safeOrder
    .filter((k) => k.startsWith('t:'))
    .map((k) => texts[parseInt(k.slice(2), 10)] ?? '')

  const items = [...(prev.imageAutomessage?.items || [])]
  const orderedStageImages = safeOrder
    .filter((k) => k.startsWith('i:'))
    .map((k) => items[parseInt(k.slice(2), 10)])
    .filter((row) => row != null)
  let stageImageIdx = 0
  const newItems = items.map((row) => {
    if ((row?.trigger ?? 'purchase') !== stage) return row
    return orderedStageImages[stageImageIdx++] ?? row
  })

  const imagePatch = { ...(prev.imageAutomessage || {}), items: newItems }

  if (stage === 'purchase') {
    return {
      ...prev,
      automessage: {
        ...(prev.automessage || {}),
        enabled: newTexts.length > 0,
        messages: newTexts,
      },
      imageAutomessage: imagePatch,
    }
  }
  if (stage === 'sent') {
    return {
      ...prev,
      postPurchaseAutomessage: {
        ...(prev.postPurchaseAutomessage || {}),
        enabled: newTexts.length > 0,
        messages: newTexts,
      },
      imageAutomessage: imagePatch,
    }
  }
  return {
    ...prev,
    dealConfirmedAutomessage: {
      ...(prev.dealConfirmedAutomessage || {}),
      enabled: newTexts.length > 0,
      messages: newTexts,
    },
    imageAutomessage: imagePatch,
  }
}

const EMPTY_AUTO_PLACEMENT_ORDER = { purchase: [], sent: [], confirmed: [] }

function normalizeAutoPlacementOrder(loaded) {
  if (!loaded || typeof loaded !== 'object') {
    return { ...EMPTY_AUTO_PLACEMENT_ORDER }
  }
  const out = { ...EMPTY_AUTO_PLACEMENT_ORDER }
  AUTO_MESSAGE_STAGES.forEach(({ trigger }) => {
    const raw = loaded[trigger]
    out[trigger] = Array.isArray(raw) ? raw.filter((k) => typeof k === 'string') : []
  })
  return out
}

function placementKeysSliceChanged(oldOrder, newOrder, prefix) {
  const oldKeys = oldOrder.filter((k) => k.startsWith(prefix))
  const newKeys = newOrder.filter((k) => k.startsWith(prefix))
  return oldKeys.length !== newKeys.length || oldKeys.some((k, i) => newKeys[i] !== k)
}

function patchAutoPlacementOrderForStage(ps, stage) {
  if (!ps) return ps
  const orders = normalizeAutoPlacementOrder(ps.autoPlacementOrder)
  const built = buildPlacementOrder(stage, ps)
  let merged = mergePlacementOrder(orders[stage], built)
  if (stage === 'purchase') merged = normalizePurchasePlacementOrder(merged)
  return {
    ...ps,
    autoPlacementOrder: {
      ...orders,
      [stage]: merged,
    },
  }
}

function getStagePlacementOrderFromSettings(stage, ps) {
  const built = buildPlacementOrder(stage, ps)
  const stored = ps?.autoPlacementOrder?.[stage]
  let order =
    !Array.isArray(stored) || stored.length === 0 ? built : mergePlacementOrder(stored, built)
  if (stage === 'purchase') order = normalizePurchasePlacementOrder(order)
  return order
}

function reorderPlacementInStage(stage, fromPos, toPos, prev, order) {
  const list = [...order]
  if (
    fromPos < 0 ||
    toPos < 0 ||
    fromPos >= list.length ||
    toPos >= list.length ||
    fromPos === toPos
  ) {
    return { ps: prev, order: list }
  }
  const [key] = list.splice(fromPos, 1)
  list.splice(toPos, 0, key)
  let newOrder = dedupePlacementOrder(list)
  if (stage === 'purchase') newOrder = normalizePurchasePlacementOrder(newOrder)
  const orders = normalizeAutoPlacementOrder(prev.autoPlacementOrder)
  let next = {
    ...prev,
    autoPlacementOrder: { ...orders, [stage]: newOrder },
  }
  if (
    placementKeysSliceChanged(order, newOrder, 't:') ||
    placementKeysSliceChanged(order, newOrder, 'i:')
  ) {
    next = applyPlacementOrderToSettings(stage, newOrder, next)
  }
  return { ps: next, order: newOrder }
}

function emptyImageAutomessageRow(trigger = 'purchase') {
  return { trigger, imageId: '', ext: '', filename: '', url: '' }
}

function imageAutomessageEntriesForTrigger(items, trigger) {
  return (Array.isArray(items) ? items : [])
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => (row?.trigger ?? 'purchase') === trigger)
}

function normalizeAutomessageStageMessages(loadedCfg) {
  const raw = loadedCfg?.messages
  if (Array.isArray(raw)) {
    return raw.filter((m) => typeof m === 'string')
  }
  if (typeof loadedCfg?.message === 'string' && loadedCfg.message.trim()) {
    return [loadedCfg.message]
  }
  if (typeof raw === 'string' && raw.trim()) {
    return raw.split('\n').map((s) => s.trim()).filter(Boolean)
  }
  return []
}

function normalizeImageAutomessageFromLoaded(loaded) {
  const raw =
    loaded?.imageAutomessage && typeof loaded.imageAutomessage === 'object'
      ? loaded.imageAutomessage
      : {}
  const enabled = Boolean(raw.enabled)
  let items = []
  if (Array.isArray(raw.items)) {
    items = raw.items
      .filter((row) => row && typeof row === 'object')
      .map((row) => ({
        trigger: IMAGE_AUTO_TRIGGERS.includes(row.trigger) ? row.trigger : 'purchase',
        imageId: typeof row.imageId === 'string' ? row.imageId : '',
        ext: typeof row.ext === 'string' ? row.ext : '',
        filename: typeof row.filename === 'string' ? row.filename : '',
        url: typeof row.url === 'string' ? row.url : '',
      }))
  } else if (typeof raw.imageId === 'string' && raw.imageId && typeof raw.ext === 'string' && raw.ext) {
    items = [
      {
        trigger: IMAGE_AUTO_TRIGGERS.includes(raw.trigger) ? raw.trigger : 'purchase',
        imageId: raw.imageId,
        ext: raw.ext,
        filename: typeof raw.filename === 'string' ? raw.filename : '',
        url: typeof raw.url === 'string' ? raw.url : '',
      },
    ]
  }
  return { enabled, items }
}

export function LotSettingsPage({ lot, token, onBack, loading = false }) {
  const [productSettings, setProductSettings] = useState(null)
  const [settingsTab, setSettingsTab] = useState('general')
  const [loadingSettings, setLoadingSettings] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)
  const [settingsError, setSettingsError] = useState(null)
  const [toast, setToast] = useState(null)
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
  // Список таблиц (вкладка = категория, под-вкладка = название таблицы) для привязки.
  const [tableTabs, setTableTabs] = useState([])
  const [tableTabsLoading, setTableTabsLoading] = useState(false)
  const [tableTabsError, setTableTabsError] = useState(null)
  const [imageUploadingRow, setImageUploadingRow] = useState(null)
  const [imageUploadError, setImageUploadError] = useState(null)
  const [autoDragTile, setAutoDragTile] = useState(null)
  const [autoDropStage, setAutoDropStage] = useState(null)
  const [placedRowDragOver, setPlacedRowDragOver] = useState(null)
  const autoDropHandledRef = useRef(false)
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
  const DEFAULT_SUPERCELL_CODE_REQUEST_MESSAGE =
    'Запросил код на вашу почту для $game_name, скиньте его пожалуйста сюда в чат, как придет'
  const lotGameNorm = (lot?.game || '').trim().toLowerCase()
  const showSupercellEmailValidation = SUPERCELL_EMAIL_GAMES.some((g) => g === lotGameNorm)

  const defaultProductSettings = () => ({
    cost: 0,
    costUsd: 0,
    tableBinding: { subtabId: '', subtabName: '', tabName: '' },
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
      messages: [],
    },
    dealConfirmedAutomessage: {
      enabled: false,
      messages: [],
    },
    purchaseWindowAutomessage: {
      enabled: false,
      message: '',
      start: '12:00',
      end: '13:00',
    },
    imageAutomessage: {
      enabled: false,
      items: [],
    },
    autoPlacementOrder: { ...EMPTY_AUTO_PLACEMENT_ORDER },
    emailValidation: {
      enabled: false,
      invalidEmailMessage: '',
    },
    supercellAutoRequestCode: {
      enabled: false,
      requestCodeMessage: DEFAULT_SUPERCELL_CODE_REQUEST_MESSAGE,
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

  // Загружаем список таблиц (категория + название) для привязки к таблице.
  useEffect(() => {
    let cancelled = false
    setTableTabsLoading(true)
    setTableTabsError(null)
    fetchTableTabs()
      .then((data) => {
        if (cancelled) return
        setTableTabs(Array.isArray(data?.list) ? data.list : [])
      })
      .catch((err) => {
        if (cancelled) return
        setTableTabs([])
        setTableTabsError(err instanceof Error ? err.message : 'Ошибка загрузки таблиц')
      })
      .finally(() => {
        if (cancelled) return
        setTableTabsLoading(false)
      })
    return () => { cancelled = true }
  }, [])

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
        tableBinding: {
          ...base.tableBinding,
          ...(loaded.tableBinding && typeof loaded.tableBinding === 'object' ? loaded.tableBinding : {}),
        },
        groupName: typeof loaded.groupName === 'string' ? loaded.groupName : '',
        autodelivery: {
          ...base.autodelivery,
          ...(loaded.autodelivery || {}),
          autoCompleteDeal: Boolean(
            loaded.autodelivery?.autoCompleteDeal ||
              loaded.autodeliveryApi?.autoCompleteDeal ||
              loaded.autotopupApi?.autoCompleteDeal
          ),
        },
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
        },
        autolist: { ...base.autolist, ...(loaded.autolist || {}) },
        automessage: (() => {
          const loadedAm = loaded.automessage || {}
          const messages = normalizeAutomessageStageMessages(loadedAm)
          return {
            ...base.automessage,
            ...loadedAm,
            messages,
            enabled: Boolean(loadedAm.enabled) || messages.length > 0,
          }
        })(),
        postPurchaseAutomessage: (() => {
          const loadedPp = loaded.postPurchaseAutomessage || {}
          const messages = normalizeAutomessageStageMessages(loadedPp)
          return {
            ...base.postPurchaseAutomessage,
            ...loadedPp,
            messages,
            enabled: Boolean(loadedPp.enabled) || messages.length > 0,
          }
        })(),
        dealConfirmedAutomessage: (() => {
          const loadedDc = loaded.dealConfirmedAutomessage || {}
          const messages = normalizeAutomessageStageMessages(loadedDc)
          return {
            ...base.dealConfirmedAutomessage,
            ...loadedDc,
            messages,
            enabled: Boolean(loadedDc.enabled) || messages.length > 0,
          }
        })(),
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
        imageAutomessage: normalizeImageAutomessageFromLoaded(loaded),
        autoPlacementOrder: (() => {
          const orders = normalizeAutoPlacementOrder(loaded.autoPlacementOrder)
          let purchase = [...(orders.purchase || [])]
          const before = purchase.join('|')
          if (Boolean(loadedEmailValidation.enabled) && !purchase.includes('e')) {
            purchase.push('e')
          }
          const loadedSupercell = loaded.supercellAutoRequestCode || {}
          if (
            Boolean(loadedSupercell.enabled) &&
            !purchase.includes('s')
          ) {
            purchase.push('s')
          }
          const loadedTopup = loaded.autotopupApi || {}
          if (Boolean(loadedTopup.enabled) && !purchase.includes('u')) {
            purchase.push('u')
          }
          const loadedAutoComplete = Boolean(
            loaded.autodelivery?.autoCompleteDeal ||
              loaded.autodeliveryApi?.autoCompleteDeal ||
              loaded.autotopupApi?.autoCompleteDeal
          )
          const canBindComplete =
            Boolean(loaded.autodelivery?.enabled) ||
            purchase.includes('d') ||
            purchase.includes('a') ||
            Boolean(loadedTopup.enabled) ||
            purchase.includes('u')
          if (loadedAutoComplete && !purchase.includes('c') && canBindComplete) {
            purchase.push('c')
          }
          purchase = normalizePurchasePlacementOrder(purchase)
          if (purchase.join('|') !== before) {
            return { ...orders, purchase }
          }
          return orders
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
        supercellAutoRequestCode: {
          ...base.supercellAutoRequestCode,
          ...(loaded.supercellAutoRequestCode || {}),
          enabled:
            loaded.supercellAutoRequestCode != null &&
            typeof loaded.supercellAutoRequestCode === 'object' &&
            Object.prototype.hasOwnProperty.call(loaded.supercellAutoRequestCode, 'enabled')
              ? Boolean(loaded.supercellAutoRequestCode.enabled)
              : true,
          requestCodeMessage:
            typeof loaded.supercellAutoRequestCode?.requestCodeMessage === 'string' &&
            loaded.supercellAutoRequestCode.requestCodeMessage.trim()
              ? loaded.supercellAutoRequestCode.requestCodeMessage
              : DEFAULT_SUPERCELL_CODE_REQUEST_MESSAGE,
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

  const setImageAutomessage = (field, value) => {
    setProductSettings((prev) => ({
      ...prev,
      imageAutomessage: { ...(prev?.imageAutomessage || {}), [field]: value },
    }))
  }

  const setImageAutomessageRow = (index, patch) => {
    setProductSettings((prev) => {
      const items = [...(prev?.imageAutomessage?.items || [])]
      items[index] = { ...(items[index] || emptyImageAutomessageRow()), ...patch }
      return {
        ...prev,
        imageAutomessage: { ...(prev?.imageAutomessage || {}), items },
      }
    })
  }

  const addImageAutomessageRowForTrigger = (trigger) => {
    setProductSettings((prev) => ({
      ...prev,
      imageAutomessage: {
        ...(prev?.imageAutomessage || {}),
        enabled: true,
        items: [
          ...(prev?.imageAutomessage?.items || []),
          emptyImageAutomessageRow(
            IMAGE_AUTO_TRIGGERS.includes(trigger) ? trigger : 'purchase'
          ),
        ],
      },
    }))
  }

  const removeImageAutomessageRow = (index) => {
    setProductSettings((prev) => {
      const items = [...(prev?.imageAutomessage?.items || [])]
      items.splice(index, 1)
      let next = {
        ...prev,
        imageAutomessage: {
          ...(prev.imageAutomessage || {}),
          enabled: items.length > 0 ? Boolean(prev.imageAutomessage?.enabled) : false,
          items,
        },
      }
      AUTO_MESSAGE_STAGES.forEach(({ trigger: stageTrigger }) => {
        next = patchAutoPlacementOrderForStage(next, stageTrigger)
      })
      return next
    })
  }

  const handleImageAutomessageUpload = async (index, file) => {
    if (!file) return
    setImageUploadingRow(index)
    setImageUploadError(null)
    try {
      const image = await uploadAutomessageImage(file)
      setImageAutomessageRow(index, {
        imageId: image.imageId || '',
        ext: image.ext || '',
        filename: image.filename || '',
        url: image.url || '',
      })
    } catch (err) {
      setImageUploadError(err instanceof Error ? err.message : 'Ошибка загрузки картинки')
    } finally {
      setImageUploadingRow(null)
    }
  }

  const setEmailValidation = (field, value) => {
    setProductSettings((prev) => ({
      ...prev,
      emailValidation: { ...(prev?.emailValidation || {}), [field]: value },
    }))
  }

  const removeAutomessageRow = (index) => {
    setProductSettings((prev) => {
      const messages = [...(prev?.automessage?.messages || [])]
      messages.splice(index, 1)
      return patchAutoPlacementOrderForStage(
        {
          ...prev,
          automessage: {
            ...(prev?.automessage || {}),
            enabled: messages.length > 0,
            messages,
          },
        },
        'purchase'
      )
    })
  }

  const updateAutomessageRow = (index, value) => {
    setProductSettings((prev) => {
      const messages = [...(prev?.automessage?.messages || [])]
      if (messages[index] === undefined) return prev
      messages[index] = value
      return {
        ...prev,
        automessage: {
          ...(prev?.automessage || {}),
          enabled: messages.length > 0,
          messages,
        },
      }
    })
  }

  const removePostPurchaseAutomessageRow = (index) => {
    setProductSettings((prev) => {
      const messages = [...(prev?.postPurchaseAutomessage?.messages || [])]
      messages.splice(index, 1)
      return patchAutoPlacementOrderForStage(
        {
          ...prev,
          postPurchaseAutomessage: {
            ...(prev?.postPurchaseAutomessage || {}),
            enabled: messages.length > 0,
            messages,
          },
        },
        'sent'
      )
    })
  }

  const updatePostPurchaseAutomessageRow = (index, value) => {
    setProductSettings((prev) => {
      const messages = [...(prev?.postPurchaseAutomessage?.messages || [])]
      if (messages[index] === undefined) return prev
      messages[index] = value
      return {
        ...prev,
        postPurchaseAutomessage: {
          ...(prev?.postPurchaseAutomessage || {}),
          enabled: messages.length > 0,
          messages,
        },
      }
    })
  }

  const removeDealConfirmedAutomessageRow = (index) => {
    setProductSettings((prev) => {
      const messages = [...(prev?.dealConfirmedAutomessage?.messages || [])]
      messages.splice(index, 1)
      return patchAutoPlacementOrderForStage(
        {
          ...prev,
          dealConfirmedAutomessage: {
            ...(prev?.dealConfirmedAutomessage || {}),
            enabled: messages.length > 0,
            messages,
          },
        },
        'confirmed'
      )
    })
  }

  const updateDealConfirmedAutomessageRow = (index, value) => {
    setProductSettings((prev) => {
      const messages = [...(prev?.dealConfirmedAutomessage?.messages || [])]
      if (messages[index] === undefined) return prev
      messages[index] = value
      return {
        ...prev,
        dealConfirmedAutomessage: { ...(prev?.dealConfirmedAutomessage || {}), messages },
      }
    })
  }

  const handleAutoPaletteDragStart = (e, tileId) => {
    setAutoDragTile(tileId)
    e.dataTransfer.setData(AUTO_TILE_MIME, tileId)
    e.dataTransfer.effectAllowed = 'copy'
  }

  const handleAutoPaletteDragEnd = () => {
    setAutoDragTile(null)
    setAutoDropStage(null)
  }

  const beginAutoDropGuard = () => {
    autoDropHandledRef.current = true
    window.setTimeout(() => {
      autoDropHandledRef.current = false
    }, 0)
  }

  const handlePlacedRowDragStart = (e, stage, pos) => {
    e.stopPropagation()
    setAutoDragTile(null)
    setAutoDropStage(null)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData(PLACEMENT_ROW_MIME, `${stage}:${pos}`)
  }

  const handlePlacedRowDragEnd = () => {
    setPlacedRowDragOver(null)
  }

  const handlePlacedRowDragOver = (e, stage, pos) => {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    setPlacedRowDragOver({ stage, pos })
  }

  const handlePlacedRowDragLeave = (e, stage, pos) => {
    if (placedRowDragOver?.stage !== stage || placedRowDragOver?.pos !== pos) return
    const related = e.relatedTarget
    if (related && e.currentTarget.contains(related)) return
    setPlacedRowDragOver(null)
  }

  const handlePlacedRowDrop = (e, stage, toPos) => {
    e.preventDefault()
    e.stopPropagation()
    if (autoDropHandledRef.current) return
    const raw = e.dataTransfer.getData(PLACEMENT_ROW_MIME)
    if (!raw) return
    const colon = raw.indexOf(':')
    if (colon < 0) return
    const fromStage = raw.slice(0, colon)
    const fromPos = parseInt(raw.slice(colon + 1), 10)
    if (fromStage !== stage || Number.isNaN(fromPos)) return
    beginAutoDropGuard()
    setProductSettings((prev) => {
      if (!prev) return prev
      const order = getStagePlacementOrderFromSettings(stage, prev)
      const { ps } = reorderPlacementInStage(stage, fromPos, toPos, prev, order)
      return ps
    })
    setPlacedRowDragOver(null)
  }

  const handleAutoStageDragOver = (e, stageTrigger) => {
    const tileId = autoDragTile
    if (!tileId || !canDropAutoTile(tileId, stageTrigger, productSettings)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setAutoDropStage(stageTrigger)
  }

  const handleAutoStageDragLeave = (e, stageTrigger) => {
    if (autoDropStage !== stageTrigger) return
    const related = e.relatedTarget
    if (related && e.currentTarget.contains(related)) return
    setAutoDropStage(null)
  }

  const applyAutoTileToStage = (tileId, stageTrigger) => {
    setProductSettings((prev) => {
      if (!prev || !canDropAutoTile(tileId, stageTrigger, prev)) return prev
      if (tileId === 'time' && stageHasTimeBlock(prev)) return prev
      if (tileId === 'autodelivery' && stageHasAutodeliveryBlock(prev)) return prev
      if (tileId === 'autodeliveryApi' && purchasePlacementIncludes(prev, 'a')) return prev
      if (tileId === 'emailValidation' && purchasePlacementIncludes(prev, 'e')) return prev
      if (tileId === 'supercellAutoRequestCode' && purchasePlacementIncludes(prev, 's')) return prev
      if (tileId === 'autotopupApi' && purchasePlacementIncludes(prev, 'u')) return prev
      if (tileId === 'autoComplete') {
        if (!canBindAutoCompleteTile(prev) || stageHasAutoCompleteBlock(prev)) return prev
      }

      let next = prev
      if (tileId === 'text') {
        if (stageTrigger === 'purchase') {
          const messages = [...(prev.automessage?.messages || []), '']
          next = {
            ...prev,
            automessage: { ...(prev.automessage || {}), enabled: true, messages },
          }
        } else if (stageTrigger === 'sent') {
          const messages = [...(prev.postPurchaseAutomessage?.messages || []), '']
          next = {
            ...prev,
            postPurchaseAutomessage: {
              ...(prev.postPurchaseAutomessage || {}),
              enabled: true,
              messages,
            },
          }
        } else {
          const messages = [...(prev.dealConfirmedAutomessage?.messages || []), '']
          next = {
            ...prev,
            dealConfirmedAutomessage: {
              ...(prev.dealConfirmedAutomessage || {}),
              enabled: true,
              messages,
            },
          }
        }
      } else if (tileId === 'time') {
        next = {
          ...prev,
          purchaseWindowAutomessage: {
            ...(prev.purchaseWindowAutomessage || {}),
            enabled: true,
          },
        }
      } else if (tileId === 'image') {
        next = {
          ...prev,
          imageAutomessage: {
            ...(prev.imageAutomessage || {}),
            enabled: true,
            items: [
              ...(prev.imageAutomessage?.items || []),
              emptyImageAutomessageRow(stageTrigger),
            ],
          },
        }
      } else if (tileId === 'autodelivery') {
        next = {
          ...prev,
          autodelivery: { ...(prev.autodelivery || {}), enabled: true },
        }
      } else if (tileId === 'autoComplete') {
        next = {
          ...prev,
          autodelivery: { ...(prev.autodelivery || {}), autoCompleteDeal: true },
        }
      } else if (tileId === 'autodeliveryApi') {
        next = {
          ...prev,
          autodeliveryApi: {
            ...(prev.autodeliveryApi || {}),
            enabled: true,
            deliveryMessage:
              typeof prev.autodeliveryApi?.deliveryMessage === 'string' &&
              prev.autodeliveryApi.deliveryMessage.trim()
                ? prev.autodeliveryApi.deliveryMessage
                : '{delivery}',
          },
        }
        next = appendPurchasePlacementKey(next, 'a')
      } else if (tileId === 'emailValidation') {
        next = {
          ...prev,
          emailValidation: { ...(prev.emailValidation || {}), enabled: true },
        }
        next = appendPurchasePlacementKey(next, 'e')
      } else if (tileId === 'supercellAutoRequestCode') {
        const prevMsg = prev.supercellAutoRequestCode?.requestCodeMessage
        next = {
          ...prev,
          supercellAutoRequestCode: {
            ...(prev.supercellAutoRequestCode || {}),
            enabled: true,
            requestCodeMessage:
              typeof prevMsg === 'string' && prevMsg.trim()
                ? prevMsg
                : DEFAULT_SUPERCELL_CODE_REQUEST_MESSAGE,
          },
        }
        next = appendPurchasePlacementKey(next, 's')
      } else if (tileId === 'autotopupApi') {
        const prevAsk = prev.autotopupApi?.askIdMessage
        next = {
          ...prev,
          autotopupApi: {
            ...(prev.autotopupApi || {}),
            enabled: true,
            askIdMessage:
              typeof prevAsk === 'string' && prevAsk.trim()
                ? prevAsk
                : defaultProductSettings().autotopupApi.askIdMessage,
          },
        }
        next = appendPurchasePlacementKey(next, 'u')
      }
      return patchAutoPlacementOrderForStage(next, stageTrigger)
    })
  }

  const handleAutoStageDrop = (e, stageTrigger) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer.getData(PLACEMENT_ROW_MIME)) return
    if (autoDropHandledRef.current) return
    const tileId = e.dataTransfer.getData(AUTO_TILE_MIME) || autoDragTile
    if (!tileId) return
    beginAutoDropGuard()
    applyAutoTileToStage(tileId, stageTrigger)
    handleAutoPaletteDragEnd()
  }

  const removeAutoBlockFromStage = (stageTrigger, tileId) => {
    setProductSettings((prev) => {
      if (!prev) return prev
      if (tileId === 'time') {
        return patchAutoPlacementOrderForStage(
          {
            ...prev,
            purchaseWindowAutomessage: {
              ...(prev.purchaseWindowAutomessage || {}),
              enabled: false,
            },
          },
          stageTrigger
        )
      }
      if (tileId === 'image') {
        const items = (prev.imageAutomessage?.items || []).filter(
          (row) => (row?.trigger ?? 'purchase') !== stageTrigger
        )
        return patchAutoPlacementOrderForStage(
          {
            ...prev,
            imageAutomessage: {
              ...(prev.imageAutomessage || {}),
              enabled: items.length > 0 ? Boolean(prev.imageAutomessage?.enabled) : false,
              items,
            },
          },
          stageTrigger
        )
      }
      if (tileId === 'autodelivery') {
        return patchAutoPlacementOrderForStage(
          {
            ...prev,
            autodelivery: {
              ...(prev.autodelivery || {}),
              enabled: false,
              autoCompleteDeal: false,
            },
          },
          stageTrigger
        )
      }
      if (tileId === 'autoComplete') {
        return patchAutoPlacementOrderForStage(
          {
            ...prev,
            autodelivery: { ...(prev.autodelivery || {}), autoCompleteDeal: false },
          },
          stageTrigger
        )
      }
      if (tileId === 'autodeliveryApi') {
        let next = {
          ...prev,
          autodeliveryApi: { ...(prev.autodeliveryApi || {}), enabled: false },
        }
        next = removePurchasePlacementKey(next, 'a')
        if (!canBindAutoCompleteTile(next) && stageHasAutoCompleteBlock(next)) {
          next = {
            ...next,
            autodelivery: { ...(next.autodelivery || {}), autoCompleteDeal: false },
          }
          next = removePurchasePlacementKey(next, 'c')
        }
        return patchAutoPlacementOrderForStage(next, stageTrigger)
      }
      if (tileId === 'emailValidation') {
        let next = {
          ...prev,
          emailValidation: {
            ...(prev.emailValidation || {}),
            enabled: false,
            invalidEmailMessage: '',
          },
        }
        next = removePurchasePlacementKey(next, 'e')
        return patchAutoPlacementOrderForStage(next, stageTrigger)
      }
      if (tileId === 'supercellAutoRequestCode') {
        let next = {
          ...prev,
          supercellAutoRequestCode: {
            ...(prev.supercellAutoRequestCode || {}),
            enabled: false,
            requestCodeMessage: DEFAULT_SUPERCELL_CODE_REQUEST_MESSAGE,
          },
        }
        next = removePurchasePlacementKey(next, 's')
        return patchAutoPlacementOrderForStage(next, stageTrigger)
      }
      if (tileId === 'autotopupApi') {
        let next = removePurchasePlacementKey(prev, 'u')
        if (!canBindAutoCompleteTile(next) && stageHasAutoCompleteBlock(next)) {
          next = {
            ...next,
            autodelivery: { ...(next.autodelivery || {}), autoCompleteDeal: false },
          }
          next = removePurchasePlacementKey(next, 'c')
        }
        return patchAutoPlacementOrderForStage(next, stageTrigger)
      }
      return prev
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
                <section className="lot-settings-block lot-settings-block--auto-stages">
                  <div className="lot-settings-auto-layout">
                    <aside className="lot-settings-auto-palette" aria-label="Плитки автосообщений">
                      {AUTO_PALETTE_TILES.filter((tile) => {
                        if (
                          tile.id === 'emailValidation' ||
                          tile.id === 'supercellAutoRequestCode'
                        ) {
                          return showSupercellEmailValidation
                        }
                        return true
                      }).map((tile) => {
                        const paletteLocked =
                          tile.id === 'autoComplete' && !canBindAutoCompleteTile(productSettings)
                        return (
                          <div
                            key={tile.id}
                            className={
                              'lot-settings-auto-palette__tile' +
                              (autoDragTile === tile.id
                                ? ' lot-settings-auto-palette__tile--dragging'
                                : '') +
                              (paletteLocked ? ' lot-settings-auto-palette__tile--locked' : '')
                            }
                            draggable={!paletteLocked}
                            onDragStart={(e) => {
                              if (paletteLocked) return
                              handleAutoPaletteDragStart(e, tile.id)
                            }}
                            onDragEnd={handleAutoPaletteDragEnd}
                          >
                            <span className="lot-settings-auto-palette__tile-icon">
                              <AutoTileIcon kind={tile.id} />
                            </span>
                            <span className="lot-settings-auto-palette__tile-label">
                              {tile.label}
                            </span>
                          </div>
                        )
                      })}
                    </aside>
                    <div className="lot-settings-auto-stages-wrap">
                      <div className="lot-settings-auto-stages">
                        {AUTO_MESSAGE_STAGES.map((stage, stageIdx) => {
                          const dropActive =
                            autoDropStage === stage.trigger &&
                            autoDragTile &&
                            canDropAutoTile(autoDragTile, stage.trigger, productSettings)
                          const stageOrder = getStagePlacementOrderFromSettings(
                            stage.trigger,
                            productSettings
                          )
                          return (
                            <div
                              key={stage.trigger}
                              className={
                                'lot-settings-auto-stage lot-settings-auto-stage--' + stage.trigger
                              }
                            >
                              <h4 className="lot-settings-auto-stage__title">
                                <span className="lot-settings-auto-stage__num">{stageIdx + 1}</span>
                                <span className="lot-settings-auto-stage__label">{stage.label}</span>
                                {stageOrder.length > 0 ? (
                                  <span className="lot-settings-auto-stage__count">
                                    {stageOrder.length}
                                  </span>
                                ) : null}
                              </h4>
                              <div
                                className={
                                  'lot-settings-auto-stage__body lot-settings-auto-stage__drop' +
                                  (dropActive ? ' lot-settings-auto-stage__drop--over' : '') +
                                  (stageOrder.length === 0
                                    ? ' lot-settings-auto-stage__drop--empty'
                                    : '')
                                }
                                onDragOver={(e) => handleAutoStageDragOver(e, stage.trigger)}
                                onDragLeave={(e) => handleAutoStageDragLeave(e, stage.trigger)}
                                onDrop={(e) => handleAutoStageDrop(e, stage.trigger)}
                              >
                                {stageOrder.length === 0 ? (
                                  <div className="lot-settings-auto-stage__placeholder" aria-hidden="true">
                                    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                                      <path d="M12 5v14M5 12h14" />
                                    </svg>
                                    <span>Перетащите плитку слева сюда</span>
                                  </div>
                                ) : null}
                                {stageOrder.map(
                                  (placeKey, pos) => {
                                    const purchaseOrder =
                                      stage.trigger === 'purchase'
                                        ? getStagePlacementOrderFromSettings(
                                            'purchase',
                                            productSettings
                                          )
                                        : []
                                    const rowOver =
                                      placedRowDragOver?.stage === stage.trigger &&
                                      placedRowDragOver?.pos === pos
                                    const rowClass =
                                      'lot-settings-auto-placed lot-settings-auto-placed--row' +
                                      (rowOver ? ' lot-settings-auto-placed--row-over' : '') +
                                      ((placeKey === 'd' ||
                                        placeKey === 'a' ||
                                        placeKey === 'u') &&
                                      purchaseOrder[pos + 1] === 'c'
                                        ? ' lot-settings-auto-placed--bind-next'
                                        : '') +
                                      (placeKey === 'c' &&
                                      (purchaseOrder[pos - 1] === 'd' ||
                                        purchaseOrder[pos - 1] === 'a' ||
                                        purchaseOrder[pos - 1] === 'u')
                                        ? ' lot-settings-auto-placed--after-d'
                                        : '')

                                    const rowDragHandlers = {
                                      onDragOver: (e) => {
                                        if (e.dataTransfer.types.includes(PLACEMENT_ROW_MIME)) {
                                          handlePlacedRowDragOver(e, stage.trigger, pos)
                                          return
                                        }
                                        if (autoDragTile) {
                                          handleAutoStageDragOver(e, stage.trigger)
                                          return
                                        }
                                        handlePlacedRowDragOver(e, stage.trigger, pos)
                                      },
                                      onDragLeave: (e) => {
                                        if (autoDragTile) {
                                          handleAutoStageDragLeave(e, stage.trigger)
                                          return
                                        }
                                        handlePlacedRowDragLeave(e, stage.trigger, pos)
                                      },
                                      onDrop: (e) => {
                                        e.preventDefault()
                                        e.stopPropagation()
                                        if (e.dataTransfer.getData(PLACEMENT_ROW_MIME)) {
                                          handlePlacedRowDrop(e, stage.trigger, pos)
                                          return
                                        }
                                        if (autoDragTile || e.dataTransfer.getData(AUTO_TILE_MIME)) {
                                          handleAutoStageDrop(e, stage.trigger)
                                        }
                                      },
                                    }

                                    const tileEl = (
                                      <div
                                        className="lot-settings-auto-palette__tile lot-settings-auto-placed__tile-draggable"
                                        draggable
                                        onDragStart={(e) =>
                                          handlePlacedRowDragStart(e, stage.trigger, pos)
                                        }
                                        onDragEnd={handlePlacedRowDragEnd}
                                      >
                                        <span className="lot-settings-auto-palette__tile-icon">
                                          <AutoTileIcon kind={placementTileKind(placeKey)} />
                                        </span>
                                        <span className="lot-settings-auto-palette__tile-label">
                                          {placementTileLabel(placeKey)}
                                        </span>
                                      </div>
                                    )

                                    if (placeKey.startsWith('t:')) {
                                      const index = parseInt(placeKey.slice(2), 10)
                                      const text =
                                        stageTextMessages(stage.trigger, productSettings)[index] ??
                                        ''
                                      const removeTextRow =
                                        stage.trigger === 'purchase'
                                          ? removeAutomessageRow
                                          : stage.trigger === 'sent'
                                            ? removePostPurchaseAutomessageRow
                                            : removeDealConfirmedAutomessageRow
                                      const updateTextRow =
                                        stage.trigger === 'purchase'
                                          ? updateAutomessageRow
                                          : stage.trigger === 'sent'
                                            ? updatePostPurchaseAutomessageRow
                                            : updateDealConfirmedAutomessageRow
                                      return (
                                        <div
                                          key={`${stage.trigger}-${placeKey}`}
                                          className={rowClass}
                                          {...rowDragHandlers}
                                        >
                                          {tileEl}
                                          <input
                                            type="text"
                                            className="lot-settings-input lot-settings-auto-placed__field"
                                            value={text}
                                            onChange={(e) =>
                                              updateTextRow(index, e.target.value)
                                            }
                                          />
                                          <button
                                            type="button"
                                            className="lot-settings-btn lot-settings-btn--secondary lot-settings-auto-placed__delete"
                                            onClick={() => removeTextRow(index)}
                                          >
                                            Удалить
                                          </button>
                                        </div>
                                      )
                                    }

                                    if (placeKey === 'w' && stage.trigger === 'purchase') {
                                      return (
                                        <div
                                          key={`${stage.trigger}-time`}
                                          className={rowClass}
                                          {...rowDragHandlers}
                                        >
                                          {tileEl}
                                          <div className="lot-settings-auto-placed__field lot-settings-auto-placed__field--time">
                                            <input
                                              type="text"
                                              className="lot-settings-input lot-settings-auto-placed__time-message"
                                              value={
                                                productSettings?.purchaseWindowAutomessage?.message ??
                                                ''
                                              }
                                              onChange={(e) =>
                                                setPurchaseWindowAutomessage('message', e.target.value)
                                              }
                                            />
                                            <span className="lot-settings-auto-placed__time-label">
                                              С (МСК)
                                            </span>
                                            <input
                                              type="time"
                                              className="lot-settings-input lot-settings-input--time"
                                              value={
                                                productSettings?.purchaseWindowAutomessage?.start ??
                                                '12:00'
                                              }
                                              onChange={(e) =>
                                                setPurchaseWindowAutomessage('start', e.target.value)
                                              }
                                            />
                                            <span className="lot-settings-auto-placed__time-label">
                                              До (МСК)
                                            </span>
                                            <input
                                              type="time"
                                              className="lot-settings-input lot-settings-input--time"
                                              value={
                                                productSettings?.purchaseWindowAutomessage?.end ??
                                                '13:00'
                                              }
                                              onChange={(e) =>
                                                setPurchaseWindowAutomessage('end', e.target.value)
                                              }
                                            />
                                          </div>
                                          <button
                                            type="button"
                                            className="lot-settings-btn lot-settings-btn--secondary lot-settings-auto-placed__delete"
                                            onClick={() =>
                                              removeAutoBlockFromStage(stage.trigger, 'time')
                                            }
                                          >
                                            Удалить
                                          </button>
                                        </div>
                                      )
                                    }

                                    if (placeKey === 'd' && stage.trigger === 'purchase') {
                                      return (
                                        <div
                                          key={`${stage.trigger}-autodelivery`}
                                          className={rowClass}
                                          {...rowDragHandlers}
                                        >
                                          {tileEl}
                                          <div className="lot-settings-auto-placed__field lot-settings-auto-placed__field--bind">
                                            {purchaseOrder[pos + 1] === 'c' ? (
                                              <span
                                                className="lot-settings-auto-placed__bind-label"
                                                aria-hidden="true"
                                              >
                                                ↓
                                              </span>
                                            ) : null}
                                          </div>
                                          <button
                                            type="button"
                                            className="lot-settings-btn lot-settings-btn--secondary lot-settings-auto-placed__delete"
                                            onClick={() =>
                                              removeAutoBlockFromStage(stage.trigger, 'autodelivery')
                                            }
                                          >
                                            Удалить
                                          </button>
                                        </div>
                                      )
                                    }

                                    if (placeKey === 'c' && stage.trigger === 'purchase') {
                                      return (
                                        <div
                                          key={`${stage.trigger}-auto-complete`}
                                          className={rowClass}
                                          {...rowDragHandlers}
                                        >
                                          {tileEl}
                                          <div className="lot-settings-auto-placed__field lot-settings-auto-placed__field--bind">
                                            {purchaseOrder[pos - 1] === 'd' ? (
                                              <span className="lot-settings-auto-placed__bind-label">
                                                После успешной автовыдачи
                                              </span>
                                            ) : null}
                                          </div>
                                          <button
                                            type="button"
                                            className="lot-settings-btn lot-settings-btn--secondary lot-settings-auto-placed__delete"
                                            onClick={() =>
                                              removeAutoBlockFromStage(stage.trigger, 'autoComplete')
                                            }
                                          >
                                            Удалить
                                          </button>
                                        </div>
                                      )
                                    }

                                    if (placeKey === 'a' && stage.trigger === 'purchase') {
                                      return (
                                        <div
                                          key={`${stage.trigger}-autodelivery-api`}
                                          className={rowClass}
                                          {...rowDragHandlers}
                                        >
                                          {tileEl}
                                          <input
                                            type="text"
                                            className="lot-settings-input lot-settings-auto-placed__field"
                                            value={
                                              productSettings?.autodeliveryApi?.deliveryMessage ??
                                              '{delivery}'
                                            }
                                            onChange={(e) =>
                                              setFeature(
                                                'autodeliveryApi',
                                                'deliveryMessage',
                                                e.target.value
                                              )
                                            }
                                          />
                                          <button
                                            type="button"
                                            className="lot-settings-btn lot-settings-btn--secondary lot-settings-auto-placed__delete"
                                            onClick={() =>
                                              removeAutoBlockFromStage(
                                                stage.trigger,
                                                'autodeliveryApi'
                                              )
                                            }
                                          >
                                            Удалить
                                          </button>
                                        </div>
                                      )
                                    }

                                    if (placeKey === 'e' && stage.trigger === 'purchase') {
                                      return (
                                        <div
                                          key={`${stage.trigger}-email-validation`}
                                          className={rowClass}
                                          {...rowDragHandlers}
                                        >
                                          {tileEl}
                                          <input
                                            type="text"
                                            className="lot-settings-input lot-settings-auto-placed__field"
                                            value={
                                              productSettings?.emailValidation
                                                ?.invalidEmailMessage ?? ''
                                            }
                                            onChange={(e) =>
                                              setEmailValidation(
                                                'invalidEmailMessage',
                                                e.target.value
                                              )
                                            }
                                          />
                                          <button
                                            type="button"
                                            className="lot-settings-btn lot-settings-btn--secondary lot-settings-auto-placed__delete"
                                            onClick={() =>
                                              removeAutoBlockFromStage(
                                                stage.trigger,
                                                'emailValidation'
                                              )
                                            }
                                          >
                                            Удалить
                                          </button>
                                        </div>
                                      )
                                    }

                                    if (placeKey === 'u' && stage.trigger === 'purchase') {
                                      return (
                                        <div
                                          key={`${stage.trigger}-autotopup-api`}
                                          className={rowClass}
                                          {...rowDragHandlers}
                                        >
                                          {tileEl}
                                          <input
                                            type="text"
                                            className="lot-settings-input lot-settings-auto-placed__field"
                                            value={
                                              productSettings?.autotopupApi?.askIdMessage ?? ''
                                            }
                                            onChange={(e) =>
                                              setFeature(
                                                'autotopupApi',
                                                'askIdMessage',
                                                e.target.value
                                              )
                                            }
                                          />
                                          <button
                                            type="button"
                                            className="lot-settings-btn lot-settings-btn--secondary lot-settings-auto-placed__delete"
                                            onClick={() =>
                                              removeAutoBlockFromStage(
                                                stage.trigger,
                                                'autotopupApi'
                                              )
                                            }
                                          >
                                            Удалить
                                          </button>
                                        </div>
                                      )
                                    }

                                    if (placeKey === 's' && stage.trigger === 'purchase') {
                                      return (
                                        <div
                                          key={`${stage.trigger}-supercell-auto-request`}
                                          className={rowClass}
                                          {...rowDragHandlers}
                                        >
                                          {tileEl}
                                          <input
                                            type="text"
                                            className="lot-settings-input lot-settings-auto-placed__field"
                                            value={
                                              productSettings?.supercellAutoRequestCode
                                                ?.requestCodeMessage ??
                                              DEFAULT_SUPERCELL_CODE_REQUEST_MESSAGE
                                            }
                                            onChange={(e) =>
                                              setFeature(
                                                'supercellAutoRequestCode',
                                                'requestCodeMessage',
                                                e.target.value
                                              )
                                            }
                                          />
                                          <button
                                            type="button"
                                            className="lot-settings-btn lot-settings-btn--secondary lot-settings-auto-placed__delete"
                                            onClick={() =>
                                              removeAutoBlockFromStage(
                                                stage.trigger,
                                                'supercellAutoRequestCode'
                                              )
                                            }
                                          >
                                            Удалить
                                          </button>
                                        </div>
                                      )
                                    }

                                    if (placeKey.startsWith('i:')) {
                                      const index = parseInt(placeKey.slice(2), 10)
                                      const row =
                                        productSettings?.imageAutomessage?.items?.[index]
                                      if (!row) return null
                                      return (
                                        <div
                                          key={`${stage.trigger}-${placeKey}`}
                                          className={rowClass}
                                          {...rowDragHandlers}
                                        >
                                          {tileEl}
                                          <div className="lot-settings-auto-placed__field lot-settings-auto-placed__field--image">
                                            {row.url ? (
                                              <img
                                                src={automessageImageUrl(row.url)}
                                                alt=""
                                                className="lot-settings-image-auto__preview"
                                              />
                                            ) : null}
                                            <label
                                              className={
                                                'lot-settings-file-picker' +
                                                (imageUploadingRow === index
                                                  ? ' lot-settings-file-picker--loading'
                                                  : '')
                                              }
                                            >
                                              <input
                                                type="file"
                                                accept="image/png,image/jpeg,image/gif,image/webp"
                                                className="lot-settings-file-picker__input"
                                                disabled={imageUploadingRow === index}
                                                onChange={(e) => {
                                                  const file = e.target.files && e.target.files[0]
                                                  if (file) {
                                                    setImageAutomessage('enabled', true)
                                                    void handleImageAutomessageUpload(index, file)
                                                  }
                                                  e.target.value = ''
                                                }}
                                              />
                                              <span className="lot-settings-file-picker__text">
                                                {imageUploadingRow === index
                                                  ? 'Загрузка…'
                                                  : row.url
                                                    ? 'Заменить'
                                                    : 'Выбрать файл'}
                                              </span>
                                            </label>
                                          </div>
                                          <button
                                            type="button"
                                            className="lot-settings-btn lot-settings-btn--secondary lot-settings-auto-placed__delete"
                                            onClick={() => removeImageAutomessageRow(index)}
                                          >
                                            Удалить
                                          </button>
                                        </div>
                                      )
                                    }

                                    return null
                                  }
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  </div>
                  {imageUploadError && (
                    <span className="lot-settings-field__hint">{imageUploadError}</span>
                  )}
                </section>
                <section className="lot-settings-block lot-settings-block--logic-work">
                  <h3 className="lot-settings-block__title">Логика работы</h3>
                <div className="lot-settings-logic-part">
                  <h4 className="lot-settings-block__title lot-settings-block__title--sub">Привязка к таблице</h4>
                  <label className="lot-settings-field">
                    <span className="lot-settings-field__label">Таблица</span>
                    <select
                      className="lot-settings-input"
                      value={productSettings?.tableBinding?.subtabId ?? ''}
                      onChange={(e) => {
                        const subtabId = e.target.value
                        let picked = null
                        let tabName = ''
                        for (const tab of tableTabs) {
                          const sub = (Array.isArray(tab.subtabs) ? tab.subtabs : []).find(
                            (s) => String(s.id) === String(subtabId)
                          )
                          if (sub) {
                            picked = sub
                            tabName = tab.name || ''
                            break
                          }
                        }
                        setProductSettings((p) => ({
                          ...p,
                          tableBinding: {
                            subtabId,
                            subtabName: picked?.name || '',
                            tabName,
                          },
                        }))
                      }}
                    >
                      <option value="">— не привязано —</option>
                      {tableTabs.map((tab) => {
                        const subtabs = Array.isArray(tab.subtabs) ? tab.subtabs : []
                        if (subtabs.length === 0) return null
                        return (
                          <optgroup key={tab.id} label={tab.name}>
                            {subtabs.map((sub) => (
                              <option key={sub.id} value={sub.id}>
                                {tab.name} / {sub.name}
                              </option>
                            ))}
                          </optgroup>
                        )
                      })}
                    </select>
                    {tableTabsLoading && (
                      <span className="lot-settings-field__hint">Загрузка таблиц…</span>
                    )}
                    {tableTabsError && (
                      <span className="lot-settings-field__hint">{tableTabsError}</span>
                    )}
                    {!tableTabsLoading &&
                      !tableTabsError &&
                      productSettings?.tableBinding?.subtabId &&
                      !tableTabs.some((tab) =>
                        (Array.isArray(tab.subtabs) ? tab.subtabs : []).some(
                          (s) => String(s.id) === String(productSettings.tableBinding.subtabId)
                        )
                      ) && (
                        <span className="lot-settings-field__hint">
                          Привязанная таблица не найдена
                          {productSettings.tableBinding.subtabName
                            ? ` (${productSettings.tableBinding.tabName || '—'} / ${productSettings.tableBinding.subtabName})`
                            : ''}
                          — выберите заново.
                        </span>
                      )}
                  </label>
                </div>
                <div className="lot-settings-logic-part">
                  <h4 className="lot-settings-block__title lot-settings-block__title--sub">Автовыдача Api</h4>
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
                    </div>
                  )}
                </div>
                <div className="lot-settings-logic-part">
                  <h4 className="lot-settings-block__title lot-settings-block__title--sub">Автопополнение по API</h4>
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
                      <TopupApiFlowDiagram
                        settings={productSettings?.autotopupApi}
                        onFieldChange={(field, value) => setFeature('autotopupApi', field, value)}
                        autoCompleteDeal={Boolean(productSettings?.autodelivery?.autoCompleteDeal)}
                      />
                    </div>
                  )}
                </div>
                </section>
                </>
                )}
                {settingsTab === 'general' && (
                <>
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
