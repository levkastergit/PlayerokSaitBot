import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { logChatLogging } from '../../debug/chatLoggingLog.js'
import { logChatMessagesGap } from '../../debug/chatMessagesGapLog.js'
import { isPlayerokRateLimitMessage, pollDelayAfterErrors } from './chatRequestUtils.js'
import {
  fetchChatDbList,
  fetchChatDbMessages,
  fetchChatDbMessagesBatch,
  markChatDbRead,
  sendChatDbMessage,
  hideChat,
  unhideChat,
  loadCategoryCommandsList,
  requestSupercellCode,
  cancelDeal,
  confirmDeal,
  rescanApprouteChat,
  recheckChatDbChat,
  loadProductSettingsList,
  testChatPurchase,
  getProductKey,
  getGroupSettingsKey,
  startChatDbFullScan,
  fetchChatDbFullScanStatus,
  pauseChatDbScan,
  stopChatDbScan,
} from '../../services/playerokApi'

// Синтетический чат категории «Тест» (имитация покупок, без сайд-эффектов).
const TEST_CHAT_ID = 'synthetic-test'
const TEST_CHAT = { id: TEST_CHAT_ID, buyerName: 'Тестовый покупатель', category: 'Тест', itemTitle: '' }

function renderReviewBadge(review, { variant = 'list' } = {}) {
  const reviewObj = review && typeof review === 'object' ? review : null
  const left = reviewObj?.left === true
  const ratingNum = Number(reviewObj?.rating)
  const hasRating = Number.isFinite(ratingNum) && ratingNum > 0
  const cls = 'chat-review-badge chat-review-badge--' + variant + (left ? ' chat-review-badge--left' : ' chat-review-badge--none')
  if (!left) {
    return (
      <span className={cls} title="Покупатель не оставил отзыв">
        Без отзыва
      </span>
    )
  }
  return (
    <span className={cls} title={hasRating ? `Отзыв: ${ratingNum} из 5` : 'Отзыв оставлен'}>
      <span aria-hidden="true">★</span>
      {hasRating ? ` ${ratingNum}` : ' Отзыв'}
    </span>
  )
}

/** Денежная сумма в рублях для блока финансов по сделке. */
function formatRub(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return `${n.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`
}

/** Карточка финансов по сделке (цена/себестоимость/поднятия/прибыль). */
function renderDealFinCard(deal, { showTitle = false } = {}) {
  const f = deal && deal.financials
  if (!f) return null
  const profitPositive = Number(f.profit) >= 0
  return (
    <div className="chat-deal-fin">
      {showTitle && (
        <div className="chat-deal-fin__title">
          {deal.itemTitle ||
            deal.itemCategory ||
            `Сделка #${String(deal.dealId || '').slice(0, 8)}`}
        </div>
      )}
      <div className="chat-deal-fin__rows">
        <span className="chat-deal-fin__cell">
          <span className="chat-deal-fin__label">Стоимость</span>
          <span className="chat-deal-fin__value">{formatRub(f.salePrice)}</span>
        </span>
        <span className="chat-deal-fin__cell">
          <span className="chat-deal-fin__label">Себестоимость</span>
          <span className="chat-deal-fin__value">{formatRub(f.cost)}</span>
        </span>
        <span className="chat-deal-fin__cell">
          <span className="chat-deal-fin__label">Поднятия</span>
          <span className="chat-deal-fin__value">{formatRub(f.bumpCost)}</span>
        </span>
        <span className="chat-deal-fin__cell">
          <span className="chat-deal-fin__label">Прибыль</span>
          <span
            className={
              'chat-deal-fin__value ' +
              (profitPositive ? 'chat-deal-fin__value--pos' : 'chat-deal-fin__value--neg')
            }
          >
            {formatRub(f.profit)}
          </span>
        </span>
      </div>
    </div>
  )
}

export function ChatTab({ token, moduleSupercellEnabled = false, isPageActive = true }) {
  const summarizeChatForLog = useCallback((chat) => ({
    id: chat?.id ?? null,
    dealId: chat?.dealId ?? null,
    itemId: chat?.itemId ?? null,
    buyerName: String(chat?.buyerName || '').trim() || null,
    category: String(chat?.category || '').trim() || null,
    itemTitle: String(chat?.itemTitle || '').trim() || null,
    status: String(chat?.status || '').trim() || null,
    unreadCount: typeof chat?.unreadCount === 'number' ? chat.unreadCount : null,
    isHidden: Boolean(chat?.isHidden),
  }), [])

  const [chats, setChats] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [pageInfo, setPageInfo] = useState({ hasNextPage: false, endCursor: null })
  const [selectedChatId, setSelectedChatId] = useState(null)
  const [chatStateById, setChatStateById] = useState({})
  const [draftByChatId, setDraftByChatId] = useState({})
  const [chatFilter, setChatFilter] = useState('all') // 'all' | 'hide-completed' | 'only-fulfillment' | 'test'
  const [testProductKey, setTestProductKey] = useState('')
  const [testMessages, setTestMessages] = useState([])
  const [testRunning, setTestRunning] = useState(false)
  const [testError, setTestError] = useState(null)
  const [categoryCommands, setCategoryCommands] = useState([]) // [{ category, commands }]
  const [loadingCommands, setLoadingCommands] = useState(false)
  const [requestCodeModal, setRequestCodeModal] = useState({ open: false, chatId: null })
  const [requestCodeState, setRequestCodeState] = useState({ loading: false, error: null })
  const [dealActionModal, setDealActionModal] = useState({ open: false, kind: null, chatId: null })
  const [dealActionState, setDealActionState] = useState({
    loading: false,
    error: null,
    candidates: [],
    selectedDealId: null,
  })
  const [approuteRescanState, setApprouteRescanState] = useState({
    loading: false,
    error: null,
    notice: null,
  })
  const [recheckState, setRecheckState] = useState({
    loading: false,
    error: null,
    notice: null,
  })
  const [productSettingsList, setProductSettingsList] = useState([])
  const [fullScanState, setFullScanState] = useState({ loading: false, status: null, error: null })
  const [fullScanTick, setFullScanTick] = useState(0)
  const [showChatExtraInfo, setShowChatExtraInfo] = useState(false)
  const [isMobileChatLayout, setIsMobileChatLayout] = useState(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia('(max-width: 900px)').matches
  })
  const [mobileChatView, setMobileChatView] = useState('list')
  // На мобильном детали карточки товара (финансы/почта) свёрнуты по умолчанию,
  // чтобы лента сообщений была крупнее и читаемее.
  const [mobileCardExpanded, setMobileCardExpanded] = useState(false)
  const CHAT_EMAIL_OVERRIDE_STORAGE_KEY = 'playerok-chat-supercell-email-overrides'
  const [manualEmailByChatId, setManualEmailByChatId] = useState(() => {
    try {
      const raw = localStorage.getItem(CHAT_EMAIL_OVERRIDE_STORAGE_KEY)
      if (!raw) return {}
      const parsed = JSON.parse(raw)
      return typeof parsed === 'object' && parsed !== null ? parsed : {}
    } catch {
      return {}
    }
  })
  const [emailDraftByChatId, setEmailDraftByChatId] = useState({})
  const listRef = useRef(null)
  const messagesRef = useRef(null)
  const stickToBottomRef = useRef(true)
  const loadingMoreRef = useRef(false)
  const chatStateByIdRef = useRef({})
  const selectedChatIdRef = useRef(null)
  const preloadQueueRef = useRef([])
  const preloadQueueRunningRef = useRef(false)
  const batchLoadInFlightRef = useRef(new Set())
  const chatListScrollAnchorRef = useRef(null)
  const initialLoadDoneRef = useRef(false)
  const visibleChatsRef = useRef([])
  const chatsRef = useRef([])
  // Последний message_id, по которому мы уже отметили чат прочитанным на бэкенде.
  const lastMarkedReadByChatRef = useRef({})

  const hasToken = Boolean(token)
  const normalizeBuyerName = (value) => String(value || '').trim()
  const isGenericBuyerName = (value) => {
    const normalized = normalizeBuyerName(value).toLowerCase()
    if (!normalized) return true
    return ['покупатель', 'buyer', 'customer', 'заказчик', 'user'].includes(normalized)
  }

  useEffect(() => {
    if (!token) {
      setProductSettingsList([])
      return
    }
    let cancelled = false
    loadProductSettingsList(token)
      .then((data) => {
        if (!cancelled) setProductSettingsList(data.list || [])
      })
      .catch(() => {
        if (!cancelled) setProductSettingsList([])
      })
    return () => {
      cancelled = true
    }
  }, [token])

  useEffect(() => {
    if (!token) {
      setFullScanState({ loading: false, status: null, error: null })
      return
    }
    let cancelled = false
    let timerId = null
    const poll = async () => {
      try {
        const data = await fetchChatDbFullScanStatus()
        if (cancelled) return
        setFullScanState((prev) => ({
          ...prev,
          status: data?.unavailable ? prev.status : data?.state || null,
          error: null,
        }))
      } catch (err) {
        if (cancelled) return
        setFullScanState((prev) => ({
          ...prev,
          error: err instanceof Error ? err.message : String(err),
        }))
      } finally {
        if (!cancelled) timerId = setTimeout(poll, 1000)
      }
    }
    poll()
    return () => {
      cancelled = true
      if (timerId) clearTimeout(timerId)
    }
  }, [token])

  const fullScanInProgress = Number(fullScanState.status?.scan_in_progress || 0) === 1
  const fullScanDone = Number(fullScanState.status?.scan_progress_done || 0)
  const fullScanTotal = Number(fullScanState.status?.scan_progress_total || 0)
  const fullScanProgressPercent =
    fullScanTotal > 0 ? Math.max(0, Math.min(100, Math.round((fullScanDone / fullScanTotal) * 100))) : 0
  const fullScanStartedAt = Number(fullScanState.status?.full_scan_requested_at || 0)
  const fullScanUpdatedAt = Number(fullScanState.status?.updated_at || 0)
  const fullScanElapsedSec =
    fullScanInProgress && fullScanStartedAt > 0
      ? Math.max(0, Math.floor((Date.now() - fullScanStartedAt) / 1000))
      : 0
  const fullScanUpdateLagSec =
    fullScanInProgress && fullScanUpdatedAt > 0
      ? Math.max(0, Math.floor((Date.now() - fullScanUpdatedAt) / 1000))
      : 0
  const fullScanCurrentLabel = String(fullScanState.status?.scan_current_label || '').trim()
  const fullScanCurrentStep = String(fullScanState.status?.scan_step || '').trim()
  const fullScanLastError = String(fullScanState.status?.last_error || '').trim()
  const fullScanPhase = String(fullScanState.status?.scan_phase || '').trim()
  const fullScanPaused = Number(fullScanState.status?.scan_paused || 0) === 1
  const fullScanPhaseLabel =
    fullScanPhase === 'list'
      ? 'Сбор списка чатов'
      : fullScanPhase === 'history'
        ? 'Добор истории сообщений'
        : ''

  useEffect(() => {
    if (!fullScanInProgress) return
    const timer = setInterval(() => {
      setFullScanTick((v) => v + 1)
    }, 1000)
    return () => clearInterval(timer)
  }, [fullScanInProgress])

  const settingsByKey = useMemo(() => {
    const map = {}
    productSettingsList.forEach(({ productKey, settings }) => {
      if (productKey && settings) map[productKey] = settings
    })
    return map
  }, [productSettingsList])

  // Товары для тест-покупки: только те, у кого включён какой-либо режим выдачи.
  const testProductOptions = useMemo(() => {
    const opts = []
    for (const entry of productSettingsList) {
      const productKey = entry && entry.productKey
      const s = entry && entry.settings
      if (!productKey || !s || typeof s !== 'object') continue
      const enabled =
        (s.automessage && s.automessage.enabled) ||
        (s.autodelivery && s.autodelivery.enabled) ||
        (s.autodeliveryApi && s.autodeliveryApi.enabled) ||
        (s.autotopupApi && s.autotopupApi.enabled) ||
        (s.emailValidation && s.emailValidation.enabled)
      if (!enabled) continue
      const key = String(productKey)
      const sep = key.indexOf('::')
      const label = sep > 0 ? `${key.slice(0, sep).trim()} — ${key.slice(sep + 2).trim()}` : key
      opts.push({ value: key, label })
    }
    opts.sort((a, b) => a.label.localeCompare(b.label))
    return opts
  }, [productSettingsList])

  const runTestPurchase = useCallback(async () => {
    if (!token || !testProductKey || testRunning) return
    setTestRunning(true)
    setTestError(null)
    try {
      const data = await testChatPurchase(token, { productKey: testProductKey })
      const transcript = Array.isArray(data?.transcript) ? data.transcript : []
      setTestMessages(
        transcript.map((m, i) => ({
          id: `test-${i}`,
          role: m && m.role === 'buyer' ? 'buyer' : m && m.role === 'system' ? 'system' : 'bot',
          text: m && m.text != null ? String(m.text) : '',
        }))
      )
    } catch (err) {
      setTestError(err && err.message ? err.message : 'Ошибка тест-покупки')
      setTestMessages([])
    } finally {
      setTestRunning(false)
    }
  }, [token, testProductKey, testRunning])

  const resolveSettingsForChat = useCallback(
    (chat, itemTitle) => {
      const title = String(itemTitle || chat?.itemTitle || '').trim()
      const game = String(chat?.category || '').trim()
      const key = getProductKey({ game, title })
      let s = settingsByKey[key]
      const label = s && typeof s.settingsLabel === 'string' ? s.settingsLabel.trim() : ''
      if (label) {
        const gk = getGroupSettingsKey(label)
        if (settingsByKey[gk]) s = settingsByKey[gk]
      }
      return s
    },
    [settingsByKey]
  )

  const DEFAULT_OUR_USERNAME = 'Levkaster'
  // Ник владельца токена приходит с бэкенда (getViewer); 'Levkaster' — запасной вариант.
  const [, setViewerUsername] = useState(null)
  const viewerUsernameRef = useRef(null)
  const getOurUsername = () => viewerUsernameRef.current || DEFAULT_OUR_USERNAME
  const noteViewerUsername = useCallback((value) => {
    const next = String(value || '').trim()
    if (!next || viewerUsernameRef.current === next) return
    viewerUsernameRef.current = next
    setViewerUsername(next)
  }, [])
  const isOwnUsername = (value) => {
    const v = String(value || '').trim().toLowerCase()
    if (!v) return false
    return v === getOurUsername().toLowerCase()
  }
  const SUPERCELL_EMAIL_GAMES = [
    'brawl stars',
    'clash royale',
    'clash of clans',
    'бравл старс',
    'бравл старк',
    'клеш рояль',
    'клеш оф кланс',
    'клеш оф кленс',
  ]
  const CHAT_CATEGORY_HINTS = [
    'YouTube',
    'Claude',
    'ChatGPT',
    'ЧатГПТ',
    'Brawl Stars',
    'Clash Royale',
    'Clash of Clans',
    'PUBG',
    'Call of Duty',
    'Discord',
    'Telegram',
  ]

  const SYSTEM_STATUS_BY_MARKER = useMemo(
    () => ({
      '{{ITEM_PAID}}': 'PAID',
      '{{ITEM_SENT}}': 'SENT',
      '{{DEAL_CONFIRMED}}': 'CONFIRMED',
      '{{DEAL_CONFIRMED_AUTOMATICALLY}}': 'CONFIRMED',
      '{{DEAL_ROLLED_BACK}}': 'ROLLED_BACK',
    }),
    []
  )
  const COMPLETED_MARKERS = useMemo(
    () => new Set(['{{DEAL_CONFIRMED}}', '{{DEAL_CONFIRMED_AUTOMATICALLY}}', '{{DEAL_ROLLED_BACK}}']),
    []
  )

  // Функция для преобразования hex цвета в RGB
  const hexToRgb = (hex) => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex)
    return result
      ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
      : null
  }

  // Функция для определения яркости цвета (0-255)
  const getLuminance = (r, g, b) => {
    // Формула относительной яркости
    return 0.299 * r + 0.587 * g + 0.114 * b
  }

  // Функция для определения цвета текста на основе яркости фона
  const getTextColor = (backgroundColor) => {
    const rgb = hexToRgb(backgroundColor)
    if (!rgb) return '#fff'
    const luminance = getLuminance(rgb.r, rgb.g, rgb.b)
    // Если фон светлый (яркость > 128), используем темный текст, иначе светлый
    return luminance > 128 ? '#000' : '#fff'
  }

  const parseTimestamp = (value) => {
    const ts = Date.parse(value || '')
    return Number.isFinite(ts) ? ts : 0
  }

  const isFromBuyer = (message) => {
    if (typeof message?.fromBuyer === 'boolean') {
      return message.fromBuyer
    }
    if (message?._optimisticOutgoing === true) {
      return false
    }
    const username = (message?.user?.username || '').trim()
    if (!username) return true
    return !isOwnUsername(username)
  }

  const normalizeCategoryName = (name) =>
    String(name || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .replace(/ё/g, 'е')

  const isSuperSellMarketplaceLabel = (name) => {
    const n = normalizeCategoryName(name)
    if (!n) return false
    const markers = [
      'super sell',
      'supersell',
      'super-sell',
      'суперселл',
      'супер селл',
      'супер-селл',
    ]
    return markers.some((m) => n === m || n.includes(m))
  }

  const SUPERCELL_TITLE_PATTERNS = [
    { re: /brawl\s*stars|brawlstars|бравл\s*стар/i, label: 'Brawl Stars' },
    { re: /clash\s*royale|clashroyale|клеш\s*роял|клеш\s*рояль/i, label: 'Clash Royale' },
    {
      re: /clash\s*of\s*clans|clashofclans|\bcoc\b|клеш\s*оф\s*клан|клеш\s*кланс|клеш\s*кленс/i,
      label: 'Clash of Clans',
    },
  ]

  const matchSupercellFromText = (text) => {
    const raw = String(text || '')
    if (!raw.trim()) return null
    for (const pattern of SUPERCELL_TITLE_PATTERNS) {
      if (pattern.re.test(raw)) return pattern.label
    }
    return null
  }

  const isSupercellCategory = (name) => {
    const n = normalizeCategoryName(name)
    if (!n) return false
    if (SUPERCELL_EMAIL_GAMES.includes(n)) return true
    if (SUPERCELL_EMAIL_GAMES.some((g) => n.includes(g))) return true
    if (isSuperSellMarketplaceLabel(name)) return true
    if (matchSupercellFromText(name)) return true
    return false
  }

  const chatSupportsSupercell = (chat, { itemTitle = '', deals = [] } = {}) => {
    if (!chat) return false
    const candidates = [
      chat.category,
      itemTitle,
      chat.itemTitle,
      ...(Array.isArray(deals) ? deals.map((d) => d.itemCategory) : []),
    ].filter((c) => c != null && String(c).trim())

    for (const c of candidates) {
      if (isSupercellCategory(c) && !isSuperSellMarketplaceLabel(c)) return true
    }
    for (const c of candidates) {
      if (isSuperSellMarketplaceLabel(c)) return true
    }
    for (const c of candidates) {
      const derived = deriveCategoryFromText(c)
      if (derived && isSupercellCategory(derived)) return true
    }
    if (matchSupercellFromText(itemTitle) || matchSupercellFromText(chat.itemTitle)) return true
    return false
  }

  const resolveSupercellCategoryForRequest = (chat, { itemTitle = '', deals = [] } = {}) => {
    if (!chat) return ''
    const candidates = [
      chat.category,
      itemTitle,
      chat.itemTitle,
      ...(Array.isArray(deals) ? deals.map((d) => d.itemCategory) : []),
    ].filter((c) => c != null && String(c).trim())

    for (const c of candidates) {
      if (isSupercellCategory(c) && !isSuperSellMarketplaceLabel(c)) return String(c).trim()
    }
    for (const c of candidates) {
      const derived = deriveCategoryFromText(c)
      if (derived && isSupercellCategory(derived) && !isSuperSellMarketplaceLabel(derived)) {
        return derived
      }
    }
    const fromTitle = matchSupercellFromText(itemTitle) || matchSupercellFromText(chat.itemTitle)
    if (fromTitle) return fromTitle
    for (const c of candidates) {
      if (isSupercellCategory(c)) return String(c).trim()
    }
    return ''
  }

  const deriveCategoryFromText = useCallback((value) => {
    const text = String(value || '').trim()
    if (!text) return null
    const lower = text.toLowerCase()
    for (const hint of CHAT_CATEGORY_HINTS) {
      if (lower.includes(hint.toLowerCase())) return hint
    }
    const words = text.split(/\s+/).filter(Boolean)
    if (words.length === 0) return null
    return words.slice(0, 2).join(' ')
  }, [])

  const isEmailValid = (email) => {
    const value = String(email || '').trim()
    if (!value) return false
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  }

  const saveManualEmailsToStorage = (next) => {
    try {
      localStorage.setItem(CHAT_EMAIL_OVERRIDE_STORAGE_KEY, JSON.stringify(next))
    } catch (_e) {
      // quota or disabled
    }
  }

  const isSystemMessage = (text) => {
    if (!text || typeof text !== 'string') return false
    // Проверяем, содержит ли текст плейсхолдеры в формате {{...}}
    return /\{\{[A-Z_]+\}\}/.test(text)
  }

  const formatMessageText = (text) => {
    if (!text || typeof text !== 'string') return text

    // Словарь замены плейсхолдеров на понятные тексты
    const replacements = {
      '{{ITEM_PAID}}': 'Оплата покупки',
      '{{ITEM_SENT}}': 'Товар отправлен',
      '{{DEAL_CONFIRMED}}': 'Сделка подтверждена',
      '{{DEAL_CONFIRMED_AUTOMATICALLY}}': 'Сделка подтверждена автоматически',
      '{{DEAL_ROLLED_BACK}}': 'Сделка отменена',
    }

    let result = text

    // Заменяем известные плейсхолдеры
    for (const [placeholder, replacement] of Object.entries(replacements)) {
      result = result.replace(new RegExp(placeholder.replace(/[{}]/g, '\\$&'), 'g'), replacement)
    }

    // Универсальная замена для любых других плейсхолдеров в формате {{...}}
    result = result.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
      // Если уже обработано выше, пропускаем
      if (replacements[match]) return replacements[match]

      // Преобразуем ключ в понятный текст
      const readable = key
        .replace(/_/g, ' ')
        .toLowerCase()
        .replace(/\b\w/g, (l) => l.toUpperCase())
      return readable
    })

    return result
  }

  const previewFromListRow = (chat) => {
    const fallbackText = String(chat.lastMessageText || '').trim()
    if (!fallbackText) return null
    const fromBuyer =
      typeof chat?.lastMessageFromBuyer === 'boolean'
        ? chat.lastMessageFromBuyer
        : !isSystemMessage(fallbackText)
    return {
      text: formatMessageText(fallbackText),
      fromBuyer,
    }
  }

  /** Последнее НЕ системное сообщение в чате + кто отправил. */
  const getLastChatMessagePreviewInfo = (chat) => {
    if (!chat?.id) return null
    const state = chatStateById[chat.id]
    const messages = Array.isArray(state?.messages) ? state.messages : []
    const listLastId = chat.lastMessageId != null ? String(chat.lastMessageId) : null

    let lastFromState = null
    let lastFromStateId = null
    let lastFromStateTs = 0

    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const m = messages[i]
      if (!m) continue

      // В превью списка не показываем системные сообщения.
      if (isSystemMessage(m.text)) continue

      if (m.imageUrl && !String(m.text || '').trim()) {
        lastFromStateId = m.id != null ? String(m.id) : null
        lastFromState = {
          text: 'Картинка',
          fromBuyer: isFromBuyer(m),
        }
        lastFromStateTs = parseTimestamp(m.createdAt)
        break
      }
      const t = String(m.text || '').trim()
      if (!t) continue
      lastFromStateId = m.id != null ? String(m.id) : null
      lastFromState = {
        text: formatMessageText(t),
        fromBuyer: isFromBuyer(m),
      }
      lastFromStateTs = parseTimestamp(m.createdAt)
      break
    }

    const listAheadOfLocal =
      Boolean(listLastId) &&
      (!lastFromStateId || listLastId !== lastFromStateId)

    const listTs = parseTimestamp(chat.lastMessageCreatedAt)
    const shouldUseListPreview =
      listAheadOfLocal &&
      (!lastFromState ||
        (listTs > 0 && lastFromStateTs > 0 ? listTs > lastFromStateTs : lastFromState.fromBuyer))

    if (shouldUseListPreview) {
      const fromList = previewFromListRow(chat)
      if (fromList) return fromList
    }

    if (lastFromState) return lastFromState
    return previewFromListRow(chat)
  }

  const getDerivedChatStatus = (chat) => {
    if (!chat) return ''
    const state = chatStateById[chat.id]
    const messages = Array.isArray(state?.messages) ? state.messages : []
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const marker = String(messages[i]?.text || '').trim()
      const derivedStatus = SYSTEM_STATUS_BY_MARKER[marker]
      if (derivedStatus) return derivedStatus
    }
    const lastMarker = String(chat.lastMessageText || '').trim()
    if (SYSTEM_STATUS_BY_MARKER[lastMarker]) {
      return SYSTEM_STATUS_BY_MARKER[lastMarker]
    }
    return String(chat.status || '').toUpperCase()
  }

  // Статус только из стабильных полей строки списка (без загруженных сообщений),
  // чтобы членство в фильтрах не «прыгало», пока чаты подгружаются.
  const getStableChatStatus = (chat) => {
    if (!chat) return ''
    const lastMarker = String(chat.lastMessageText || '').trim()
    if (SYSTEM_STATUS_BY_MARKER[lastMarker]) {
      return SYSTEM_STATUS_BY_MARKER[lastMarker]
    }
    return String(chat.status || '').toUpperCase()
  }

  const extractBuyerNameFromMessages = (messages) => {
    if (!Array.isArray(messages) || messages.length === 0) return null
    for (const msg of messages) {
      const msgUser = msg.user
      if (msgUser && msgUser.username && !isOwnUsername(msgUser.username)) {
        return msgUser.username
      }
    }
    return null
  }

  const sortChatMessages = (messages) => {
    return [...(messages || [])].sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0
      return ta - tb
    })
  }

  /** Если thread/список опережает загруженные messages — показываем lastMessage из списка. */
  const mergeListAheadMessage = (chat, messages) => {
    if (!chat?.id) return Array.isArray(messages) ? messages : []
    const list = Array.isArray(messages) ? [...messages] : []
    const listLastId = chat.lastMessageId != null ? String(chat.lastMessageId) : null
    if (!listLastId || list.some((m) => m?.id != null && String(m.id) === listLastId)) {
      return list
    }
    const latestLoaded = list.length > 0 ? list[list.length - 1] : null
    if (latestLoaded) {
      const listTs = parseTimestamp(chat.lastMessageCreatedAt)
      const latestLoadedTs = parseTimestamp(latestLoaded.createdAt)
      if (listTs > 0 && latestLoadedTs > 0 && latestLoadedTs >= listTs) {
        return list
      }
      if (listTs <= 0 && !isFromBuyer(latestLoaded)) {
        return list
      }
    }
    const text = String(chat.lastMessageText || '').trim()
    if (!text) return list
    const fromBuyer =
      typeof chat?.lastMessageFromBuyer === 'boolean'
        ? chat.lastMessageFromBuyer
        : !isSystemMessage(text)
    logChatMessagesGap('ui:merge-list-ahead', {
      chatId: chat.id,
      listLastId,
      textPreview: text.slice(0, 120),
      loadedCount: list.length,
    })
    list.push({
      id: listLastId,
      text,
      createdAt: chat.lastMessageCreatedAt || null,
      imageUrl: null,
      user: {
        username: fromBuyer
          ? String(chat.buyerName || '').trim() || null
          : getOurUsername(),
      },
      _fromListPreview: true,
    })
    return sortChatMessages(list)
  }

  const isMessagesNearBottom = (el, threshold = 80) => {
    if (!el) return true
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    return distance < threshold
  }

  const scrollMessagesToBottom = useCallback(() => {
    const el = messagesRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [])

  const applyLoadedChatData = (
    chat,
    list,
    itemTitle,
    itemImageUrl,
    buyerSupercellEmail,
    itemCategory = null,
    dealSummaries = null,
    review = null
  ) => {
    const chatId = chat.id
    const prevMessagesSnapshot = Array.isArray(chatStateByIdRef.current[chatId]?.messages)
      ? chatStateByIdRef.current[chatId].messages
      : []
    const knownUsernameByMessageId = new Map(
      prevMessagesSnapshot
        .map((m) => [m?.id != null ? String(m.id) : '', String(m?.user?.username || '').trim()])
        .filter(([id, username]) => Boolean(id) && Boolean(username))
    )
    const sortedMessages = sortChatMessages(list).map((message) => {
      const username = String(message?.user?.username || '').trim()
      if (username || message?.id == null) return message
      const knownUsername = knownUsernameByMessageId.get(String(message.id))
      if (!knownUsername) return message
      return {
        ...message,
        user: { ...(message.user || {}), username: knownUsername },
      }
    })
    const latestMessage =
      Array.isArray(sortedMessages) && sortedMessages.length > 0
        ? sortedMessages[sortedMessages.length - 1]
        : null
    const latestMessageId = latestMessage?.id != null ? String(latestMessage.id) : null
    const latestMessageText =
      latestMessage?.text != null ? String(latestMessage.text) : null
    const latestMessageCreatedAt = latestMessage?.createdAt || null
    const latestMessageFromBuyer =
      latestMessage && !isSystemMessage(latestMessageText) ? isFromBuyer(latestMessage) : null
    const extractedBuyerName = extractBuyerNameFromMessages(list)
    const shouldPatchBuyerName =
      !isGenericBuyerName(extractedBuyerName) &&
      isGenericBuyerName(chat.buyerName)
    const currentCategory = String(chat.category || '').trim()
    const shouldRecoverCategory =
      !currentCategory ||
      currentCategory === 'Категория не определена' ||
      isSuperSellMarketplaceLabel(currentCategory)
    const serverCategory =
      itemCategory && String(itemCategory).trim() ? String(itemCategory).trim() : null
    const recoveredCategory = shouldRecoverCategory
      ? deriveCategoryFromText(itemTitle || chat.itemTitle || '')
      : null
    const resolvedCategory = shouldRecoverCategory
      ? serverCategory || recoveredCategory || null
      : null

    if (shouldPatchBuyerName) {
      setChats((prev) =>
        prev.map((c) =>
          c.id === chatId ? { ...c, buyerName: extractedBuyerName } : c
        )
      )
    }
    if (resolvedCategory) {
      setChats((prev) =>
        prev.map((c) =>
          c.id === chatId
            ? {
                ...c,
                category: resolvedCategory,
                itemTitle: itemTitle || c.itemTitle || null,
              }
            : c
        )
      )
      logChatLogging(
        serverCategory ? 'category_from_deal_messages' : 'category_recovered_from_itemTitle',
        {
          chat: summarizeChatForLog(chat),
          resolvedCategory,
          itemTitle: itemTitle || chat.itemTitle || null,
        }
      )
    }

    // Обновляем превью чата слева только если локально пришли действительно
    // более свежие данные, чтобы не откатывать новый lastMessage из списка чатов.
    if (latestMessageId || latestMessageText || latestMessageCreatedAt) {
      setChats((prev) =>
        prev.map((c) => {
          if (c.id !== chatId) return c
          const currentTs = c.lastMessageCreatedAt ? Date.parse(c.lastMessageCreatedAt) : 0
          const loadedTs = latestMessageCreatedAt ? Date.parse(latestMessageCreatedAt) : 0
          const hasCurrentTs = Number.isFinite(currentTs) && currentTs > 0
          const hasLoadedTs = Number.isFinite(loadedTs) && loadedTs > 0
          const loadedIsNewer = hasLoadedTs && (!hasCurrentTs || loadedTs > currentTs)
          const canFillGaps =
            !hasCurrentTs &&
            (!c.lastMessageId || !String(c.lastMessageText || '').trim())

          if (!loadedIsNewer && !canFillGaps) return c

          const nextLastMessageId = latestMessageId || c.lastMessageId || null
          const nextLastMessageText = latestMessageText || c.lastMessageText || null
          const nextLastMessageCreatedAt = latestMessageCreatedAt || c.lastMessageCreatedAt || null
          const nextDealId =
            latestMessage?.dealId != null
              ? String(latestMessage.dealId)
              : c.dealId || null
          const nextLastMessageFromBuyer =
            typeof latestMessageFromBuyer === 'boolean'
              ? latestMessageFromBuyer
              : String(nextLastMessageId || '') === String(c.lastMessageId || '')
                ? (typeof c.lastMessageFromBuyer === 'boolean' ? c.lastMessageFromBuyer : null)
                : null

          if (
            String(nextLastMessageId || '') === String(c.lastMessageId || '') &&
            String(nextLastMessageText || '') === String(c.lastMessageText || '') &&
            String(nextLastMessageCreatedAt || '') === String(c.lastMessageCreatedAt || '') &&
            String(nextDealId || '') === String(c.dealId || '') &&
            (typeof nextLastMessageFromBuyer === 'boolean'
              ? nextLastMessageFromBuyer
              : null) ===
              (typeof c.lastMessageFromBuyer === 'boolean' ? c.lastMessageFromBuyer : null)
          ) {
            return c
          }

          return {
            ...c,
            lastMessageId: nextLastMessageId,
            lastMessageText: nextLastMessageText,
            lastMessageCreatedAt: nextLastMessageCreatedAt,
            dealId: nextDealId,
            lastMessageFromBuyer: nextLastMessageFromBuyer,
          }
        })
      )
    }

    setChatStateById((prev) => {
      const prevState = prev[chatId] || {}
      const prevMessages = Array.isArray(prevState.messages) ? prevState.messages : []
      // Не даём пустому/устаревшему ответу "снести" уже загруженную историю чата.
      let nextMessages =
        sortedMessages.length === 0 && prevMessages.length > 0
          ? prevMessages
          : sortedMessages
      const pendingLocalMessages = prevMessages.filter((m) => m?._optimisticOutgoing === true)
      if (pendingLocalMessages.length > 0) {
        const knownMessageIds = new Set(
          nextMessages
            .filter((m) => m?.id != null)
            .map((m) => String(m.id))
        )
        let hasAddedPending = false
        for (const pending of pendingLocalMessages) {
          const pendingId = pending?.id != null ? String(pending.id) : ''
          if (!pendingId || knownMessageIds.has(pendingId)) continue
          knownMessageIds.add(pendingId)
          nextMessages.push(pending)
          hasAddedPending = true
        }
        if (hasAddedPending) {
          nextMessages = sortChatMessages(nextMessages)
        }
      }
      const listLastId = chat.lastMessageId != null ? String(chat.lastMessageId) : null
      const apiHasListLast =
        Boolean(listLastId) &&
        nextMessages.some((m) => m?.id != null && String(m.id) === listLastId)
      if (listLastId && !apiHasListLast) {
        logChatMessagesGap('applyLoadedChatData:list-ahead-of-api', {
          chatId: chat.id,
          listLastId,
          apiCount: nextMessages.length,
          latestMessageId,
        })
      }
      nextMessages = mergeListAheadMessage(chat, nextMessages)
      const hasListLastInMessages =
        !listLastId || nextMessages.some((m) => m?.id != null && String(m.id) === listLastId)
      const expectsMessages = Boolean(
        chat.lastMessageId ||
        String(chat.lastMessageText || '').trim() ||
        latestMessageId
      )
      const loaded = !expectsMessages || hasListLastInMessages
      return {
        ...prev,
        [chatId]: {
          ...prevState,
          loading: false,
          error: null,
          messages: nextMessages,
          loaded,
          backgroundLoading: false,
          itemTitle: itemTitle || chat.itemTitle || prevState.itemTitle || null,
          itemImageUrl: prevState.itemImageUrl || chat.itemImageUrl || itemImageUrl || null,
          deals: Array.isArray(dealSummaries) ? dealSummaries : prevState.deals || [],
          buyerSupercellEmail: buyerSupercellEmail ?? prevState.buyerSupercellEmail ?? null,
          review: review != null ? review : (prevState.review != null ? prevState.review : null),
        },
      }
    })
    if (review != null) {
      setChats((prev) =>
        prev.map((c) => (c.id === chatId ? { ...c, review } : c))
      )
    }
    logChatLogging('applyLoadedChatData', {
      chat: summarizeChatForLog(chat),
      messagesCount: Array.isArray(list) ? list.length : 0,
      loadedItemTitle: itemTitle || null,
      loadedItemImageUrl: itemImageUrl || null,
      buyerSupercellEmail: buyerSupercellEmail || null,
      itemCategory: serverCategory || null,
    })
  }

  useEffect(() => {
    chatStateByIdRef.current = chatStateById
  }, [chatStateById])

  useEffect(() => {
    chatsRef.current = chats
  }, [chats])

  useEffect(() => {
    selectedChatIdRef.current = selectedChatId
  }, [selectedChatId])

  const pullMessagesForChat = useCallback(
    async (chat, { silent = false } = {}) => {
      if (!token || !chat?.id) return
      if (chat.id === TEST_CHAT_ID) return // тест-чат синтетический, истории на бэке нет
      const chatId = chat.id
      const isSelected = selectedChatIdRef.current === chatId
      const hasCachedMessages = Boolean(chatStateByIdRef.current[chatId]?.messages?.length)
      if (isSelected && !silent && !hasCachedMessages) {
        setChatStateById((prev) => ({
          ...prev,
          [chatId]: {
            ...(prev[chatId] || {}),
            loading: true,
            error: null,
            messages: prev[chatId]?.messages || [],
            loaded: false,
            backgroundLoading: false,
          },
        }))
      }
      try {
        const { list, buyerSupercellEmail, itemTitle, itemImageUrl, itemCategory, deals, viewerUsername, review } =
          await fetchChatDbMessages(token, {
            dealId: chat.dealId || null,
            chatId,
          })
        noteViewerUsername(viewerUsername)
        applyLoadedChatData(
          chat,
          list,
          itemTitle,
          itemImageUrl,
          buyerSupercellEmail || null,
          itemCategory,
          deals,
          review || null
        )
      } catch (_err) {
        if (isSelected && !silent && !hasCachedMessages) {
          const errMsg = _err instanceof Error ? _err.message : 'Ошибка загрузки чата'
          const rateLimited = isPlayerokRateLimitMessage(errMsg)
          setChatStateById((prev) => ({
            ...prev,
            [chatId]: {
              ...(prev[chatId] || {}),
              loading: false,
              error: errMsg,
              loaded: !rateLimited,
              backgroundLoading: false,
            },
          }))
        }
      }
    },
    [token]
  )

  const normalizeUnreadCount = (value) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
    return Math.trunc(value)
  }

  const resolveUnreadCount = (prevChat, incomingChat, selectedChatIdForCalc) => {
    if (incomingChat?.id === selectedChatIdForCalc) {
      return 0
    }

    const incomingUnread = normalizeUnreadCount(incomingChat?.unreadCount)
    const incomingLastMessageFromBuyer =
      typeof incomingChat?.lastMessageFromBuyer === 'boolean'
        ? incomingChat.lastMessageFromBuyer
        : null
    if (incomingLastMessageFromBuyer === false) {
      return 0
    }
    const prevUnreadRaw = normalizeUnreadCount(prevChat?.unreadCount)
    const prevUnread = prevUnreadRaw != null ? prevUnreadRaw : 0
    const hasNewLastMessage =
      Boolean(prevChat && incomingChat) &&
      Boolean(incomingChat?.lastMessageId) &&
      String(prevChat?.lastMessageId || '') !== String(incomingChat.lastMessageId || '')

    if (incomingUnread != null) {
      return incomingUnread
    }

    if (hasNewLastMessage) {
      return prevUnread + 1
    }

    if (prevChat) {
      return prevUnread
    }

    return incomingUnread != null ? incomingUnread : 0
  }

  const saveChatListScrollAnchor = useCallback((mode = 'prepend') => {
    const el = listRef.current
    if (!el) return
    chatListScrollAnchorRef.current = {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      mode,
    }
  }, [])

  const mergeChatEntry = useCallback((prevChat, incomingChat) => {
    const isPoorCategory = (value) => {
      const s = String(value || '').trim()
      return !s || s === 'Категория не определена'
    }
    if (!prevChat) {
      const incomingBuyer = normalizeBuyerName(incomingChat.buyerName)
      const incomingLastMessageFromBuyer =
        typeof incomingChat?.lastMessageFromBuyer === 'boolean'
          ? incomingChat.lastMessageFromBuyer
          : null
      return {
        ...incomingChat,
        buyerName: isGenericBuyerName(incomingBuyer) ? null : incomingBuyer,
        lastMessageFromBuyer: incomingLastMessageFromBuyer,
        review: incomingChat?.review != null ? incomingChat.review : null,
        hasOpenProblem: incomingChat?.hasOpenProblem === true,
        unreadCount: resolveUnreadCount(null, incomingChat, selectedChatIdRef.current),
      }
    }
    const incCat = String(incomingChat.category || '').trim()
    const prevCat = String(prevChat.category || '').trim()
    const incPoor = isPoorCategory(incCat)
    const prevPoor = isPoorCategory(prevCat)
    const mergedCategory = incPoor ? (prevPoor ? incCat : prevCat) : incCat
    const incomingBuyer = normalizeBuyerName(incomingChat.buyerName)
    const previousBuyer = normalizeBuyerName(prevChat.buyerName)
    const mergedBuyerName = isGenericBuyerName(incomingBuyer)
      ? (isGenericBuyerName(previousBuyer) ? incomingBuyer : previousBuyer)
      : incomingBuyer
    const incomingLastMessageFromBuyer =
      typeof incomingChat?.lastMessageFromBuyer === 'boolean'
        ? incomingChat.lastMessageFromBuyer
        : null
    const mergedLastMessageFromBuyer =
      incomingLastMessageFromBuyer != null
        ? incomingLastMessageFromBuyer
        : String(prevChat?.lastMessageId || '') === String(incomingChat?.lastMessageId || '')
          ? (typeof prevChat?.lastMessageFromBuyer === 'boolean' ? prevChat.lastMessageFromBuyer : null)
          : null
    return {
      ...prevChat,
      ...incomingChat,
      buyerName: mergedBuyerName || null,
      category: mergedCategory,
      itemImageUrl: prevChat.itemImageUrl || incomingChat.itemImageUrl || null,
      itemTitle: incomingChat.itemTitle || prevChat.itemTitle || null,
      lastMessageFromBuyer: mergedLastMessageFromBuyer,
      review: incomingChat?.review != null ? incomingChat.review : (prevChat?.review != null ? prevChat.review : null),
      hasOpenProblem:
        typeof incomingChat?.hasOpenProblem === 'boolean'
          ? incomingChat.hasOpenProblem
          : prevChat?.hasOpenProblem === true,
      unreadCount: resolveUnreadCount(prevChat, incomingChat, selectedChatIdRef.current),
    }
  }, [])

  const mergeChatsWithRefresh = useCallback((prevChats, incomingChats) => {
    const chatSortValue = (chat) => {
      const ts = chat?.lastMessageCreatedAt ? Date.parse(chat.lastMessageCreatedAt) : NaN
      return Number.isFinite(ts) ? ts : 0
    }
    const sortByLastMessageDesc = (list) =>
      [...(list || [])].sort((a, b) => {
        const aTs = chatSortValue(a)
        const bTs = chatSortValue(b)
        if (bTs !== aTs) return bTs - aTs
        return String(b?.id || '').localeCompare(String(a?.id || ''))
      })

    const prevById = new Map((prevChats || []).map((chat) => [chat.id, chat]))
    const incomingIds = new Set((incomingChats || []).map((chat) => chat.id))
    const refreshedHead = (incomingChats || []).map((incoming) =>
      mergeChatEntry(prevById.get(incoming.id) || null, incoming)
    )
    const tail = (prevChats || []).filter((chat) => !incomingIds.has(chat.id))
    return sortByLastMessageDesc([...refreshedHead, ...tail])
  }, [mergeChatEntry])

  const CHAT_MESSAGES_BATCH_SIZE = 6
  const CHAT_LIST_POLL_MS = 1200
  const CHAT_MESSAGES_POLL_MS = 1200
  const PRELOAD_INITIAL_COUNT = 8
  const PRELOAD_VIEWPORT_PRIORITY = 4

  const chatNeedsMessagesLoad = useCallback((chatId) => {
    if (!chatId || chatId === TEST_CHAT_ID) return false
    const chatKey = String(chatId)
    if (batchLoadInFlightRef.current.has(chatKey)) return false
    const state = chatStateByIdRef.current[chatId]
    if (state?.loaded && !state?.error) {
      if (!Array.isArray(state.messages) || state.messages.length === 0) {
        const chat = chatsRef.current.find((c) => String(c.id) === chatKey)
        if (chat?.lastMessageId || String(chat?.lastMessageText || '').trim()) {
          return true
        }
      }
      return false
    }
    return true
  }, [])

  const loadChatsMessagesBatch = useCallback(async (targetChats, options = {}) => {
    if (!token || !Array.isArray(targetChats) || targetChats.length === 0) return
    const shouldCancel = typeof options.shouldCancel === 'function'
      ? options.shouldCancel
      : () => false
    const selectedId = selectedChatIdRef.current

    const chatsToLoad = targetChats.filter((chat) => chat?.id && chatNeedsMessagesLoad(chat.id))
    if (chatsToLoad.length === 0) return

    for (const chat of chatsToLoad) {
      batchLoadInFlightRef.current.add(String(chat.id))
    }

    const chatById = new Map(chatsToLoad.map((chat) => [String(chat.id), chat]))
    logChatLogging('loadChatsMessagesBatch:start', {
      targetChats: targetChats.length,
      chatsToLoad: chatsToLoad.length,
      chatIds: chatsToLoad.map((chat) => chat.id),
    })

    setChatStateById((prev) => {
      const next = { ...prev }
      for (const chat of chatsToLoad) {
        const chatId = chat.id
        const isSelected = chatId === selectedId
        const hasCachedMessages = Boolean(prev[chatId]?.messages?.length)
        next[chatId] = {
          ...(prev[chatId] || {}),
          loading: isSelected && !hasCachedMessages,
          error: null,
          messages: prev[chatId]?.messages || [],
          loaded: hasCachedMessages ? Boolean(prev[chatId]?.loaded) : false,
          backgroundLoading: !isSelected,
        }
      }
      return next
    })

    try {
      const entries = chatsToLoad.map((chat) => ({
        chatId: chat.id,
        dealId: chat.dealId || undefined,
        buyerName: chat.buyerName || undefined,
        category: chat.category || undefined,
      }))

      logChatLogging('loadChatsMessagesBatch:request', {
        count: entries.length,
        chatIds: entries.map((entry) => entry.chatId),
      })

      const { results } = await fetchChatDbMessagesBatch(token, entries)
      if (shouldCancel()) return

      for (const result of results) {
        const chatId = result?.chatId
        if (!chatId) continue
        const chat = chatById.get(String(chatId))
        if (!chat) continue

        if (!result.ok) {
          const errMsg = result.error || 'Ошибка загрузки чата'
          const rateLimited = isPlayerokRateLimitMessage(errMsg)
          logChatLogging('loadChatsMessagesBatch:item:error', {
            chat: summarizeChatForLog(chat),
            message: errMsg,
            rateLimited,
          })
          setChatStateById((prev) => ({
            ...prev,
            [chatId]: {
              ...(prev[chatId] || {}),
              loading: false,
              error: errMsg,
              messages: prev[chatId]?.messages || [],
              loaded: !rateLimited,
              backgroundLoading: false,
            },
          }))
          continue
        }

        noteViewerUsername(result.viewerUsername)
        applyLoadedChatData(
          chat,
          result.list,
          result.itemTitle,
          result.itemImageUrl,
          result.buyerSupercellEmail,
          result.itemCategory,
          result.deals,
          result.review || null
        )
      }

      logChatLogging('loadChatsMessagesBatch:chunk:done', {
        count: results.length,
        okCount: results.filter((item) => item.ok).length,
        errorCount: results.filter((item) => !item.ok).length,
      })
    } catch (err) {
      logChatLogging('loadChatsMessagesBatch:error', {
        message: err instanceof Error ? err.message : String(err),
        chatIds: chatsToLoad.map((chat) => chat.id),
      })
      if (shouldCancel()) return
      const errMsg = err instanceof Error ? err.message : 'Ошибка загрузки чата'
      const rateLimited = isPlayerokRateLimitMessage(errMsg)
      setChatStateById((prev) => {
        const next = { ...prev }
        for (const chat of chatsToLoad) {
          const chatId = chat.id
          next[chatId] = {
            ...(prev[chatId] || {}),
            loading: false,
            error: errMsg,
            messages: prev[chatId]?.messages || [],
            loaded: !rateLimited,
            backgroundLoading: false,
          }
        }
        return next
      })
    } finally {
      for (const chat of chatsToLoad) {
        batchLoadInFlightRef.current.delete(String(chat.id))
      }
      if (shouldCancel()) {
        setChatStateById((prev) => {
          const next = { ...prev }
          for (const chat of chatsToLoad) {
            const chatId = chat.id
            const prevState = prev[chatId]
            if (!prevState || prevState.loaded) continue
            next[chatId] = {
              ...prevState,
              loading: false,
              backgroundLoading: false,
            }
          }
          return next
        })
      }
    }
  }, [token, summarizeChatForLog, chatNeedsMessagesLoad])

  const drainPreloadQueue = useCallback(async () => {
    if (preloadQueueRunningRef.current) return
    preloadQueueRunningRef.current = true
    try {
      while (preloadQueueRef.current.length > 0) {
        if (!token) break
        const batch = preloadQueueRef.current.splice(0, CHAT_MESSAGES_BATCH_SIZE)
        const pending = batch.filter((chat) => chat?.id && chatNeedsMessagesLoad(chat.id))
        if (pending.length === 0) continue
        await loadChatsMessagesBatch(pending, { messagesOnly: true })
      }
    } finally {
      preloadQueueRunningRef.current = false
      if (preloadQueueRef.current.length > 0) {
        void drainPreloadQueue()
      }
    }
  }, [token, loadChatsMessagesBatch, chatNeedsMessagesLoad])

  const enqueueChatsForPreload = useCallback(
    (targetChats, options = {}) => {
      if (!token || !Array.isArray(targetChats) || targetChats.length === 0) return
      const priority = options.priority === true
      const knownIds = new Set(preloadQueueRef.current.map((c) => c.id))
      const toAdd = []
      for (const chat of targetChats) {
        if (!chat?.id || knownIds.has(chat.id)) continue
        if (!chatNeedsMessagesLoad(chat.id)) continue
        knownIds.add(chat.id)
        toAdd.push(chat)
      }
      if (toAdd.length === 0) return
      if (priority) {
        preloadQueueRef.current.unshift(...toAdd)
      } else {
        preloadQueueRef.current.push(...toAdd)
      }
      void drainPreloadQueue()
    },
    [token, chatNeedsMessagesLoad, drainPreloadQueue]
  )

  const isChatCompleted = (chat) => {
    if (!chat) return false
    const status = getDerivedChatStatus(chat)
    if (status === 'CONFIRMED' || status === 'ROLLED_BACK') {
      return true
    }
    const state = chatStateById[chat.id]
    let lastText = null
    if (state && Array.isArray(state.messages) && state.messages.length > 0) {
      const last = state.messages[state.messages.length - 1]
      lastText = (last && last.text) || ''
    } else {
      lastText = chat.lastMessageText || ''
    }
    const trimmed = String(lastText || '').trim()
    return COMPLETED_MARKERS.has(trimmed)
  }

  // «Только выполнение»: статус PAID (Выполните заказ) либо есть открытая проблема по сделке.
  const isFulfillmentChat = (chat) => {
    if (!chat) return false
    if (getStableChatStatus(chat) === 'PAID') return true
    return chat.hasOpenProblem === true
  }

  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const media = window.matchMedia('(max-width: 900px)')
    const onChange = (event) => {
      setIsMobileChatLayout(event.matches)
      if (!event.matches) {
        setMobileChatView('chat')
      }
    }
    setIsMobileChatLayout(media.matches)
    if (!media.matches) {
      setMobileChatView('chat')
    }
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [])

  useEffect(() => {
    if (!isMobileChatLayout) return
    if (!selectedChatId) {
      setMobileChatView('list')
    }
  }, [isMobileChatLayout, selectedChatId])

  useEffect(() => {
    if (!token) {
      setChats([])
      setError(null)
      setPageInfo({ hasNextPage: false, endCursor: null })
      setSelectedChatId(null)
      setChatStateById({})
      setDraftByChatId({})
      initialLoadDoneRef.current = false
      return
    }
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        logChatLogging('fetchUserChats:start', { limit: 24 })
        const { list, pageInfo: info } = await fetchChatDbList(token, { limit: 24, offset: 0 })
        if (cancelled) return

        logChatLogging('fetchUserChats:success', {
          count: list.length,
          pageInfo: info || { hasNextPage: false, endCursor: null },
          undefinedCategoryCount: list.filter((c) => {
            const category = String(c?.category || '').trim()
            return !category || category === 'Категория не определена'
          }).length,
          sample: list.slice(0, 10).map(summarizeChatForLog),
        })
        setChats((prev) => {
          const prevById = new Map((prev || []).map((chat) => [chat.id, chat]))
          return (list || []).map((incomingChat) => {
            const prevChat = prevById.get(incomingChat.id) || null
            return mergeChatEntry(prevChat, incomingChat)
          }).sort((a, b) => {
            const aTs = a?.lastMessageCreatedAt ? Date.parse(a.lastMessageCreatedAt) : 0
            const bTs = b?.lastMessageCreatedAt ? Date.parse(b.lastMessageCreatedAt) : 0
            if (bTs !== aTs) return bTs - aTs
            return String(b?.id || '').localeCompare(String(a?.id || ''))
          })
        })
        setPageInfo(info || { hasNextPage: false, endCursor: null })
        initialLoadDoneRef.current = true
        if (list.length > 0) {
          const prevSelected = selectedChatIdRef.current
          let nextSelectedId =
            prevSelected && list.some((c) => c.id === prevSelected) ? prevSelected : null
          if (!nextSelectedId) {
            const firstVisible = list.find((c) =>
              chatFilter === 'hide-completed'
                ? !isChatCompleted(c)
                : chatFilter === 'only-fulfillment'
                  ? isFulfillmentChat(c)
                  : true
            )
            nextSelectedId = firstVisible ? firstVisible.id : null
          }
          selectedChatIdRef.current = nextSelectedId
          setSelectedChatId(nextSelectedId)
          void loadChatsMessagesBatch(list.slice(0, PRELOAD_INITIAL_COUNT))
        } else {
          selectedChatIdRef.current = null
          setSelectedChatId(null)
        }
      } catch (err) {
        if (cancelled) return
        logChatLogging('fetchUserChats:error', {
          message: err instanceof Error ? err.message : String(err),
        })
        setError(err instanceof Error ? err.message : 'Ошибка загрузки чатов')
        setChats([])
        setPageInfo({ hasNextPage: false, endCursor: null })
        setSelectedChatId(null)
        initialLoadDoneRef.current = false
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
      preloadQueueRef.current = []
      initialLoadDoneRef.current = false
    }
  }, [token, loadChatsMessagesBatch, mergeChatEntry, enqueueChatsForPreload])

  // Загрузка команд по категориям
  useEffect(() => {
    if (!token) {
      setCategoryCommands([])
      return
    }
    let cancelled = false
    setLoadingCommands(true)
    loadCategoryCommandsList(token)
      .then(({ list }) => {
        if (cancelled) return
        setCategoryCommands(list || [])
        setLoadingCommands(false)
      })
      .catch((err) => {
        if (cancelled) return
        setCategoryCommands([])
        setLoadingCommands(false)
      })
    return () => {
      cancelled = true
    }
  }, [token])

  const loadMore = useCallback(async () => {
    if (!token) {
      return
    }
    if (!pageInfo.hasNextPage) {
      return
    }
    if (loadingMoreRef.current) {
      return
    }

    // Используем endCursor, даже если он null или пустая строка
    // API должен обработать это корректно
    const afterCursor = pageInfo.endCursor || null
    loadingMoreRef.current = true
    setLoadingMore(true)
    try {
      logChatLogging('loadMore:start', {
        requestParams: {
          limit: 24,
          afterCursor: pageInfo.endCursor || null,
        },
      })
      const requestParams = { limit: 24 }
      if (afterCursor) {
        requestParams.afterCursor = afterCursor
      }
      const { list, pageInfo: info } = await fetchChatDbList(token, {
        limit: requestParams.limit,
        offset: chatsRef.current.length,
      })

      if (!list || list.length === 0) {
        logChatLogging('loadMore:emptyPage', null)
        setPageInfo({ hasNextPage: false, endCursor: null })
        return
      }
      logChatLogging('loadMore:success', {
        count: list.length,
        pageInfo: info || { hasNextPage: false, endCursor: null },
        undefinedCategoryCount: list.filter((c) => {
          const category = String(c?.category || '').trim()
          return !category || category === 'Категория не определена'
        }).length,
        sample: list.slice(0, 10).map(summarizeChatForLog),
      })

      setChats((prev) => {
        const prevById = new Map(prev.map((chat) => [chat.id, chat]))
        const mergedNew = list.map((incoming) => mergeChatEntry(prevById.get(incoming.id) || null, incoming))
        return [...prev, ...mergedNew.filter((chat) => !prevById.has(chat.id))].sort((a, b) => {
          const aTs = a?.lastMessageCreatedAt ? Date.parse(a.lastMessageCreatedAt) : 0
          const bTs = b?.lastMessageCreatedAt ? Date.parse(b.lastMessageCreatedAt) : 0
          if (bTs !== aTs) return bTs - aTs
          return String(b?.id || '').localeCompare(String(a?.id || ''))
        })
      })

      const newPageInfo = info || { hasNextPage: false, endCursor: null }
      setPageInfo(newPageInfo)
      enqueueChatsForPreload(list)
    } catch (err) {
      logChatLogging('loadMore:error', {
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setLoadingMore(false)
      loadingMoreRef.current = false
    }
  }, [token, pageInfo.hasNextPage, pageInfo.endCursor, mergeChatEntry, enqueueChatsForPreload])

  const visibleChats = useMemo(() => {
    if (chatFilter === 'test') {
      return [TEST_CHAT]
    }
    if (chatFilter === 'hide-completed') {
      const base = chats.filter((chat) => !chat.isHidden)
      return base.filter((chat) => !isChatCompleted(chat))
    }
    if (chatFilter === 'only-fulfillment') {
      const base = chats.filter((chat) => !chat.isHidden)
      return base.filter((chat) => isFulfillmentChat(chat))
    }
    return chats
  }, [chats, chatFilter, chatStateById])

  useEffect(() => {
    visibleChatsRef.current = visibleChats
  }, [visibleChats])

  const preloadChatsNearViewport = useCallback(() => {
    const el = listRef.current
    const chatList = visibleChatsRef.current
    if (!el || chatList.length === 0) return

    const elRect = el.getBoundingClientRect()
    const prefetchMargin = 200
    const nodes = el.querySelectorAll('.chat-list__item')
    const nearViewport = []

    nodes.forEach((node, index) => {
      if (index >= chatList.length) return
      const rect = node.getBoundingClientRect()
      if (
        rect.bottom >= elRect.top - prefetchMargin &&
        rect.top <= elRect.bottom + prefetchMargin
      ) {
        nearViewport.push(chatList[index])
      }
    })

    const slice = nearViewport.slice(0, PRELOAD_VIEWPORT_PRIORITY)
    if (slice.length > 0) {
      enqueueChatsForPreload(slice, { priority: true })
    }
  }, [enqueueChatsForPreload])

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const handleScroll = () => {
      const scrollTop = el.scrollTop
      const scrollHeight = el.scrollHeight
      const clientHeight = el.clientHeight
      const distanceToBottom = scrollHeight - scrollTop - clientHeight
      const threshold = 80

      if (pageInfo.hasNextPage && !loadingMoreRef.current && distanceToBottom < threshold) {
        loadMore()
      }
      preloadChatsNearViewport()
    }
    el.addEventListener('scroll', handleScroll)
    return () => {
      el.removeEventListener('scroll', handleScroll)
    }
  }, [pageInfo.hasNextPage, pageInfo.endCursor, loadMore, preloadChatsNearViewport])

  useLayoutEffect(() => {
    const saved = chatListScrollAnchorRef.current
    chatListScrollAnchorRef.current = null
    if (!saved) return
    const el = listRef.current
    if (!el) return
    if (saved.mode === 'prepend') {
      const heightDelta = el.scrollHeight - saved.scrollHeight
      if (heightDelta > 0) {
        el.scrollTop = saved.scrollTop + heightDelta
      }
    } else {
      el.scrollTop = saved.scrollTop
    }
  }, [chats, visibleChats])

  useEffect(() => {
    if (!token || !initialLoadDoneRef.current || loading || loadingMore) return
    enqueueChatsForPreload(visibleChats.slice(0, PRELOAD_INITIAL_COUNT))
    preloadChatsNearViewport()
  }, [
    token,
    loading,
    loadingMore,
    visibleChats,
    enqueueChatsForPreload,
    preloadChatsNearViewport,
    PRELOAD_INITIAL_COUNT,
  ])

  useEffect(() => {
    if (!selectedChatId && visibleChats.length > 0) {
      setSelectedChatId(visibleChats[0].id)
      return
    }
    if (selectedChatId && !visibleChats.some((c) => c.id === selectedChatId)) {
      setSelectedChatId(visibleChats.length > 0 ? visibleChats[0].id : null)
    }
  }, [chatFilter, visibleChats, selectedChatId])

  const isListAheadOfLoadedMessages = (chat) => {
    if (!chat?.id) return false
    const listLastId = chat.lastMessageId != null ? String(chat.lastMessageId) : null
    if (!listLastId) return false
    const messages = chatStateById[chat.id]?.messages
    if (!Array.isArray(messages) || messages.length === 0) return true
    return !messages.some((m) => m?.id != null && String(m.id) === listLastId)
  }

  const loadMessagesForChat = async (chat, { force = false } = {}) => {
    if (!token || !chat?.id) return
    if (chat.id === TEST_CHAT_ID) return // тест-чат синтетический, истории на бэке нет
    const state = chatStateByIdRef.current[chat.id]
    const hasCachedMessages = Boolean(state?.messages?.length)
    const listAhead = isListAheadOfLoadedMessages(chat)
    if (!force && state?.loaded && !state?.error && !listAhead) return
    if (!force && state?.error && !isPlayerokRateLimitMessage(state.error) && !listAhead) {
      return
    }
    await pullMessagesForChat(chat, { silent: hasCachedMessages && !listAhead })
  }

  const markChatAsRead = useCallback((chatId) => {
    if (!chatId || chatId === TEST_CHAT_ID) return
    // Оптимистично гасим бейдж локально...
    setChats((prev) =>
      prev.map((chat) =>
        chat.id === chatId && Number(chat.unreadCount || 0) > 0
          ? { ...chat, unreadCount: 0 }
          : chat
      )
    )
    // ...и сохраняем метку прочтения на бэкенде, чтобы непрочитанность не вернулась
    // после перезагрузки/следующего опроса (читаем мы только на своём сайте).
    if (token) {
      void markChatDbRead(token, chatId).catch(() => {})
    }
  }, [token])

  useEffect(() => {
    if (!selectedChatId) return
    setChatStateById((prev) => {
      const cur = prev[selectedChatId]
      if (cur?.messages?.length > 0) return prev
      if (cur?.loading) return prev
      return {
        ...prev,
        [selectedChatId]: {
          ...(cur || {}),
          loading: true,
          error: null,
          messages: cur?.messages || [],
          loaded: false,
          backgroundLoading: false,
        },
      }
    })
  }, [selectedChatId])

  useEffect(() => {
    if (!token || !selectedChatId) return
    const chat = chats.find((c) => c.id === selectedChatId)
    if (!chat) return
    loadMessagesForChat(chat)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, selectedChatId])

  const formatTime = (iso) => {
    if (!iso) return ''
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    return d.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const isTestChat = selectedChatId === TEST_CHAT_ID
  const selectedChat = isTestChat ? TEST_CHAT : chats.find((c) => c.id === selectedChatId) || null
  const selectedChatState = selectedChat
    ? chatStateById[selectedChat.id] || {
        loading: Boolean(selectedChat.lastMessageId || String(selectedChat.lastMessageText || '').trim()),
        error: null,
        messages: [],
        loaded: false,
      }
    : null
  const selectedChatHasPreviewMessage = Boolean(
    selectedChat?.lastMessageId || String(selectedChat?.lastMessageText || '').trim()
  )
  const selectedChatMessagesPending =
    (selectedChatState?.messages || []).length === 0 &&
    (Boolean(selectedChatState?.loading || selectedChatState?.backgroundLoading) ||
      (!selectedChatState?.loaded &&
        selectedChatHasPreviewMessage))
  const selectedChatDeals = Array.isArray(selectedChatState?.deals) ? selectedChatState.deals : []
  // Текущая (последняя по ленте) сделка — её финансы показываем в шапке,
  // финансы предыдущих сделок показываем инлайн в ленте у начала каждой сделки.
  const selectedChatPrimaryDealId = (() => {
    const msgs = selectedChatState?.messages || []
    let last = null
    for (const m of msgs) {
      if (m && m.dealId) last = String(m.dealId)
    }
    if (last) return last
    if (selectedChat?.dealId) return String(selectedChat.dealId)
    return selectedChatDeals[0]?.dealId ? String(selectedChatDeals[0].dealId) : null
  })()
  const selectedChatDetectedEmail = String(selectedChatState?.buyerSupercellEmail || '').trim()
  const selectedChatManualEmail = selectedChat
    ? String(manualEmailByChatId[selectedChat.id] || '').trim()
    : ''
  const selectedChatEmail = selectedChatManualEmail || selectedChatDetectedEmail
  const selectedChatEmailDraft = selectedChat
    ? Object.prototype.hasOwnProperty.call(emailDraftByChatId, selectedChat.id)
      ? emailDraftByChatId[selectedChat.id]
      : selectedChatEmail
    : ''
  const selectedChatEmailIsValid = isEmailValid(selectedChatEmail)
  const selectedChatEmailDraftIsValid = isEmailValid(selectedChatEmailDraft)
  const currentItemImageUrl =
    selectedChat && (selectedChatState?.itemImageUrl || selectedChat.itemImageUrl || null)
  const currentItemTitle =
    selectedChat && (selectedChatState?.itemTitle || selectedChat.itemTitle || '')
  const selectedChatIsSupercell = chatSupportsSupercell(selectedChat, {
    itemTitle: currentItemTitle,
    deals: selectedChatDeals,
  })
  const selectedChatCanUseSupercell = selectedChatIsSupercell && moduleSupercellEnabled
  const selectedChatSupercellCategory = resolveSupercellCategoryForRequest(selectedChat, {
    itemTitle: currentItemTitle,
    deals: selectedChatDeals,
  })

  const selectedChatApprouteEnabled = useMemo(() => {
    if (!selectedChat) return false
    const s = resolveSettingsForChat(selectedChat, currentItemTitle)
    return Boolean(s?.autodeliveryApi?.enabled)
  }, [selectedChat, currentItemTitle, resolveSettingsForChat])

  useEffect(() => {
    setApprouteRescanState({ loading: false, error: null, notice: null })
    setRecheckState({ loading: false, error: null, notice: null })
    setShowChatExtraInfo(false)
  }, [selectedChatId])

  useLayoutEffect(() => {
    stickToBottomRef.current = true
    scrollMessagesToBottom()
  }, [selectedChatId, scrollMessagesToBottom])

  useEffect(() => {
    const el = messagesRef.current
    if (!el) return undefined
    const onScroll = () => {
      stickToBottomRef.current = isMessagesNearBottom(el)
    }
    el.addEventListener('scroll', onScroll)
    return () => el.removeEventListener('scroll', onScroll)
  }, [selectedChatId, selectedChatState?.messages?.length])

  useLayoutEffect(() => {
    if (!selectedChatId) return
    const state = chatStateById[selectedChatId]
    if (!state || state.loading) return
    if (!(state.messages?.length > 0)) return
    if (!stickToBottomRef.current) return
    scrollMessagesToBottom()
  }, [
    selectedChatId,
    selectedChatState?.loading,
    selectedChatState?.messages,
    scrollMessagesToBottom,
  ])

  useEffect(() => {
    if (!token || !selectedChat?.id || !isPageActive) return
    let cancelled = false
    let timerId = null
    let errorStreak = 0

    const scheduleNext = (delayMs) => {
      if (cancelled) return
      if (timerId) clearTimeout(timerId)
      timerId = setTimeout(() => {
        void refreshSelectedChat()
      }, delayMs)
    }

    const refreshSelectedChat = async () => {
      if (cancelled) return
      const chatId = selectedChatIdRef.current
      const chat = chatId ? chatsRef.current.find((c) => c.id === chatId) : null
      if (!chat) {
        scheduleNext(pollDelayAfterErrors(CHAT_MESSAGES_POLL_MS, errorStreak))
        return
      }
      if (typeof document !== 'undefined' && document.hidden) {
        scheduleNext(pollDelayAfterErrors(CHAT_MESSAGES_POLL_MS, errorStreak))
        return
      }
      try {
        const { list, buyerSupercellEmail, itemTitle, itemImageUrl, itemCategory, deals, viewerUsername, review } =
          await fetchChatDbMessages(token, {
            dealId: chat.dealId || null,
            chatId: chat.id,
          })
        if (cancelled) return
        errorStreak = 0
        noteViewerUsername(viewerUsername)
        applyLoadedChatData(
          chat,
          list,
          itemTitle,
          itemImageUrl,
          buyerSupercellEmail || null,
          itemCategory,
          deals,
          review || null
        )
        // Чат открыт у нас на экране — двигаем метку прочтения на бэкенде, чтобы
        // сообщения, пришедшие во время просмотра, не вернулись «новыми» после выхода.
        const latestId =
          Array.isArray(list) && list.length > 0 && list[list.length - 1]?.id != null
            ? String(list[list.length - 1].id)
            : ''
        if (latestId && lastMarkedReadByChatRef.current[chat.id] !== latestId) {
          lastMarkedReadByChatRef.current[chat.id] = latestId
          if (token) void markChatDbRead(token, chat.id).catch(() => {})
        }
      } catch (err) {
        if (cancelled) return
        if (isPlayerokRateLimitMessage(err instanceof Error ? err.message : String(err))) {
          errorStreak += 1
        }
      } finally {
        if (!cancelled) {
          scheduleNext(pollDelayAfterErrors(CHAT_MESSAGES_POLL_MS, errorStreak))
        }
      }
    }

    scheduleNext(CHAT_MESSAGES_POLL_MS)
    return () => {
      cancelled = true
      if (timerId) clearTimeout(timerId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, isPageActive, selectedChat?.id, selectedChat?.dealId])

  useEffect(() => {
    if (!token || !isPageActive) return
    let cancelled = false
    let timerId = null
    let errorStreak = 0

    const scheduleNext = (delayMs) => {
      if (cancelled) return
      if (timerId) clearTimeout(timerId)
      timerId = setTimeout(() => {
        void refreshChatsList()
      }, delayMs)
    }

    const refreshChatsList = async () => {
      if (cancelled) return
      if (typeof document !== 'undefined' && document.hidden) {
        scheduleNext(pollDelayAfterErrors(CHAT_LIST_POLL_MS, errorStreak))
        return
      }
      try {
        const selectedId = selectedChatIdRef.current
        const prevSelected = selectedId
          ? chatsRef.current.find((c) => c.id === selectedId)
          : null

        const { list } = await fetchChatDbList(token, { limit: 24, offset: 0 })
        if (cancelled) return

        const nextSelected = selectedId ? list.find((c) => c.id === selectedId) : null
        const selectedHasNewListMessage =
          Boolean(nextSelected?.lastMessageId) &&
          String(prevSelected?.lastMessageId || '') !== String(nextSelected.lastMessageId)

        saveChatListScrollAnchor('prepend')
        setChats((prev) => mergeChatsWithRefresh(prev, list))
        errorStreak = 0
        enqueueChatsForPreload(list)
        requestAnimationFrame(() => preloadChatsNearViewport())

        if (selectedHasNewListMessage && nextSelected) {
          void pullMessagesForChat(nextSelected)
        }
      } catch (err) {
        if (cancelled) return
        if (isPlayerokRateLimitMessage(err instanceof Error ? err.message : String(err))) {
          errorStreak += 1
        }
      } finally {
        if (!cancelled) {
          scheduleNext(pollDelayAfterErrors(CHAT_LIST_POLL_MS, errorStreak))
        }
      }
    }

    scheduleNext(CHAT_LIST_POLL_MS)
    return () => {
      cancelled = true
      if (timerId) clearTimeout(timerId)
    }
  }, [
    token,
    isPageActive,
    mergeChatsWithRefresh,
    saveChatListScrollAnchor,
    enqueueChatsForPreload,
    preloadChatsNearViewport,
    pullMessagesForChat,
  ])

  // Получаем команды для категории выбранного чата
  const currentCategoryCommands = useMemo(() => {
    if (!selectedChat) return []
    const category = (selectedChat.category || '').trim()
    if (!category) return []
    const categoryData = categoryCommands.find((c) => c.category === category)
    if (!categoryData || !Array.isArray(categoryData.commands)) return []
    return categoryData.commands
      .filter((cmd) => cmd.label && cmd.text)
      .map((cmd) => ({
        ...cmd,
        color: cmd.color || '#6c757d', // цвет по умолчанию, если не указан
      }))
  }, [selectedChat, categoryCommands])

  useEffect(() => {
    logChatLogging('chat-state-snapshot', {
      chatsCount: chats.length,
      visibleChatsCount: visibleChats.length,
      selectedChatId,
      selectedChat: selectedChat ? summarizeChatForLog(selectedChat) : null,
      emptyOrUndefinedCategories: chats
        .filter((chat) => {
          const category = String(chat?.category || '').trim()
          return !category || category === 'Категория не определена'
        })
        .map(summarizeChatForLog)
        .slice(0, 30),
    })
  }, [chats, visibleChats, selectedChatId, selectedChat, summarizeChatForLog])

  useEffect(() => {
    if (!selectedChat || !moduleSupercellEnabled) return
    const category = String(selectedChat.category || '').trim()
    logChatLogging('supercell:selectedChat', {
      chat: summarizeChatForLog(selectedChat),
      isSupercellCategory: isSupercellCategory(category),
      isSuperSellWrapper: isSuperSellMarketplaceLabel(category),
      detectedEmail: selectedChatDetectedEmail || null,
      manualEmail: selectedChatManualEmail || null,
      itemTitle: currentItemTitle || null,
      resolvedCategory: selectedChatSupercellCategory || null,
      canUseSupercell: selectedChatCanUseSupercell,
      moduleSupercellEnabled,
    })
  }, [
    selectedChat,
    moduleSupercellEnabled,
    selectedChatDetectedEmail,
    selectedChatManualEmail,
    currentItemTitle,
    selectedChatCanUseSupercell,
    summarizeChatForLog,
  ])

  const getOrderStatusLabel = (status) => {
    const s = String(status || '').toUpperCase()
    if (!s) return ''
    if (s === 'PAID') return 'Выполните заказ'
    if (s === 'SENT') return 'Ожидает подтверждения'
    if (s === 'CONFIRMED') return 'Подтверждено'
    if (s === 'ROLLED_BACK') return 'Возврат'
    if (s === 'PENDING') return 'Ожидание'
    return s.replace(/_/g, ' ')
  }

  const getStatusIcon = (status) => {
    const s = String(status || '').toUpperCase()
    if (!s) return { icon: '—', label: '—', tone: 'muted' }
    if (s === 'PAID') return { icon: '🛠️', label: 'Выполните заказ', tone: 'work' }
    if (s === 'SENT') return { icon: '⏳', label: 'Ожидает подтверждения', tone: 'sent' }
    if (s === 'CONFIRMED') return { icon: '✓', label: 'Подтверждено', tone: 'success' }
    if (s === 'ROLLED_BACK') return { icon: '↩', label: 'Возврат', tone: 'rollback' }
    if (s === 'PENDING') return { icon: '⏳', label: 'Ожидание', tone: 'sent' }
    return { icon: '•', label: s, tone: 'muted' }
  }

  const sortChatsByLastMessageDesc = (list) =>
    [...(list || [])].sort((a, b) => {
      const aTs = parseTimestamp(a?.lastMessageCreatedAt)
      const bTs = parseTimestamp(b?.lastMessageCreatedAt)
      if (bTs !== aTs) return bTs - aTs
      return String(b?.id || '').localeCompare(String(a?.id || ''))
    })

  const appendLocalMessageForChat = (chat, text, options = {}) => {
    if (!chat?.id) return
    const trimmed = String(text || '').trim()
    if (!trimmed) return null
    const createdAt = options.createdAt || new Date().toISOString()
    const messageId =
      options.messageId || `local-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
    const fromBuyer = options.fromBuyer === true
    const newMessage = {
      id: messageId,
      text: trimmed,
      createdAt,
      imageUrl: null,
      user: {
        username: fromBuyer ? String(chat.buyerName || '').trim() || null : getOurUsername(),
      },
      ...(options.optimistic ? { _optimisticOutgoing: true } : {}),
    }
    setChatStateById((prev) => ({
      ...prev,
      [chat.id]: {
        ...(prev[chat.id] || { loading: false, error: null, loaded: true, messages: [] }),
        messages: [...(prev[chat.id]?.messages || []), newMessage],
      },
    }))
    setChats((prev) =>
      sortChatsByLastMessageDesc(
        prev.map((c) =>
          c.id === chat.id
            ? {
                ...c,
                lastMessageId: messageId,
                lastMessageText: trimmed,
                lastMessageCreatedAt: createdAt,
                dealId: c.dealId || chat.dealId || null,
                unreadCount: fromBuyer ? Number(c.unreadCount || 0) : 0,
                lastMessageFromBuyer: fromBuyer,
              }
            : c
        )
      )
    )
    return {
      id: messageId,
      createdAt,
      text: trimmed,
    }
  }

  // Единая отправка с оптимистичным сообщением и откатом при ошибке.
  // Используется и для обычного ввода, и для кнопок быстрых команд.
  const deliverChatMessage = async (chat, rawText, { onError } = {}) => {
    if (!token || !chat?.id) return false
    const chatId = chat.id
    const text = String(rawText || '').trim()
    if (!text) return false
    const previousChatPreview = {
      lastMessageId: chat.lastMessageId || null,
      lastMessageText: chat.lastMessageText || null,
      lastMessageCreatedAt: chat.lastMessageCreatedAt || null,
      unreadCount: Number(chat.unreadCount || 0),
      lastMessageFromBuyer:
        typeof chat.lastMessageFromBuyer === 'boolean' ? chat.lastMessageFromBuyer : null,
    }
    const optimisticMessage = appendLocalMessageForChat(chat, text, { optimistic: true })
    if (!optimisticMessage) return false
    logChatLogging('action:sendMessage', { chat: summarizeChatForLog(chat), textLength: text.length }, 'action')
    try {
      const sendResult = await sendChatDbMessage(token, {
        dealId: chat.dealId || null,
        chatId,
        text,
        clientMessageId: String(optimisticMessage.id),
        clientCreatedAt: optimisticMessage.createdAt,
      })
      const serverMessage =
        sendResult && typeof sendResult.message === 'object' && sendResult.message !== null
          ? sendResult.message
          : null
      const resolvedId =
        serverMessage?.id != null ? String(serverMessage.id) : String(optimisticMessage.id)
      const resolvedText =
        serverMessage?.text != null ? String(serverMessage.text).trim() : optimisticMessage.text
      const resolvedCreatedAt = serverMessage?.createdAt || optimisticMessage.createdAt

      setChatStateById((prev) => {
        const current = prev[chatId] || {}
        const currentMessages = Array.isArray(current.messages) ? current.messages : []
        const nextMessages = currentMessages.map((m) =>
          String(m?.id || '') === String(optimisticMessage.id)
            ? {
                ...m,
                id: resolvedId,
                text: resolvedText,
                createdAt: resolvedCreatedAt,
                user: { ...(m.user || {}), username: getOurUsername() },
                _optimisticOutgoing: false,
              }
            : m
        )
        return {
          ...prev,
          [chatId]: {
            ...current,
            messages: nextMessages,
          },
        }
      })
      setChats((prev) =>
        sortChatsByLastMessageDesc(
          prev.map((c) =>
            c.id === chatId && String(c.lastMessageId || '') === String(optimisticMessage.id)
              ? {
                  ...c,
                  lastMessageId: resolvedId,
                  lastMessageText: resolvedText,
                  lastMessageCreatedAt: resolvedCreatedAt,
                  unreadCount: 0,
                  lastMessageFromBuyer: false,
                }
              : c
          )
        )
      )
      logChatLogging('action:sendMessage:success', { chatId }, 'action')
      return true
    } catch (err) {
      setChatStateById((prev) => {
        const current = prev[chatId] || {}
        const currentMessages = Array.isArray(current.messages) ? current.messages : []
        return {
          ...prev,
          [chatId]: {
            ...current,
            messages: currentMessages.filter(
              (m) => String(m?.id || '') !== String(optimisticMessage.id)
            ),
          },
        }
      })
      setChats((prev) =>
        sortChatsByLastMessageDesc(
          prev.map((c) =>
            c.id === chatId && String(c.lastMessageId || '') === String(optimisticMessage.id)
              ? {
                  ...c,
                  lastMessageId: previousChatPreview.lastMessageId,
                  lastMessageText: previousChatPreview.lastMessageText,
                  lastMessageCreatedAt: previousChatPreview.lastMessageCreatedAt,
                  unreadCount: previousChatPreview.unreadCount,
                  lastMessageFromBuyer: previousChatPreview.lastMessageFromBuyer,
                }
              : c
          )
        )
      )
      logChatLogging(
        'action:sendMessage:error',
        { chatId, message: err instanceof Error ? err.message : String(err) },
        'error'
      )
      if (typeof onError === 'function') onError(err, text)
      return false
    }
  }

  const handleSendMessage = async (chat) => {
    if (!token || !chat?.id) return
    const chatId = chat.id
    const text = (draftByChatId[chatId] || '').trim()
    if (!text) return
    setDraftByChatId((prev) => ({ ...prev, [chatId]: '' }))
    await deliverChatMessage(chat, text, {
      onError: (_err, failedText) => {
        // Возвращаем неотправленный текст обратно в поле ввода.
        setDraftByChatId((prev) => ({ ...prev, [chatId]: failedText }))
      },
    })
  }

  const openRequestCodeModal = (chat) => {
    if (!chat?.id || !moduleSupercellEnabled) return
    setRequestCodeState({ loading: false, error: null })
    setEmailDraftByChatId((prev) => ({
      ...prev,
      [chat.id]: Object.prototype.hasOwnProperty.call(prev, chat.id)
        ? prev[chat.id]
        : (manualEmailByChatId[chat.id] || chatStateById[chat.id]?.buyerSupercellEmail || ''),
    }))
    setRequestCodeModal({ open: true, chatId: chat.id })
  }

  const closeRequestCodeModal = () => {
    setRequestCodeModal({ open: false, chatId: null })
    setRequestCodeState({ loading: false, error: null })
  }

  const saveManualEmailForChat = (chatId, emailValue) => {
    const trimmed = String(emailValue || '').trim()
    if (!chatId) return
    setManualEmailByChatId((prev) => {
      const next = trimmed ? { ...prev, [chatId]: trimmed } : { ...prev }
      if (!trimmed) delete next[chatId]
      saveManualEmailsToStorage(next)
      return next
    })
  }

  const resetManualEmailForChat = (chatId) => {
    if (!chatId) return
    setManualEmailByChatId((prev) => {
      if (!Object.prototype.hasOwnProperty.call(prev, chatId)) return prev
      const next = { ...prev }
      delete next[chatId]
      saveManualEmailsToStorage(next)
      return next
    })
    setEmailDraftByChatId((prev) => {
      const next = { ...prev }
      delete next[chatId]
      return next
    })
  }

  const handleRequestCodeForSelectedChat = async () => {
    if (!selectedChat || !token || !moduleSupercellEnabled) return
    const email = String(emailDraftByChatId[selectedChat.id] || '').trim()
    if (!isEmailValid(email)) {
      setRequestCodeState({ loading: false, error: 'Введите корректную почту Supercell ID' })
      return
    }
    setRequestCodeState({ loading: true, error: null })
    logChatLogging('action:requestSupercellCode', { chat: summarizeChatForLog(selectedChat), email }, 'action')
    try {
      const data = await requestSupercellCode(token, {
        dealId: selectedChat.dealId || null,
        chatId: selectedChat.id,
        email,
        category: selectedChatSupercellCategory || selectedChat.category || '',
      })
      saveManualEmailForChat(selectedChat.id, email)
      if (data?.chatMessage) {
        appendLocalMessageForChat(selectedChat, data.chatMessage)
      }
      closeRequestCodeModal()
      logChatLogging('action:requestSupercellCode:success', { chatId: selectedChat.id }, 'action')
    } catch (err) {
      logChatLogging(
        'action:requestSupercellCode:error',
        { chatId: selectedChat.id, message: err instanceof Error ? err.message : String(err) },
        'error'
      )
      setRequestCodeState({
        loading: false,
        error: err instanceof Error ? err.message : 'Не удалось запросить код',
      })
    }
  }

  const handleSaveEmailForSelectedChat = () => {
    if (!selectedChat) return
    const email = String(emailDraftByChatId[selectedChat.id] || '').trim()
    if (!isEmailValid(email)) {
      setRequestCodeState({ loading: false, error: 'Введите корректную почту Supercell ID' })
      return
    }
    saveManualEmailForChat(selectedChat.id, email)
    closeRequestCodeModal()
  }

  const pickDealIdFromMessages = (messages) => {
    const list = Array.isArray(messages) ? messages : []
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const m = list[i]
      const id = m?.dealId != null ? String(m.dealId).trim() : m?.deal?.id != null ? String(m.deal.id).trim() : ''
      if (id) return id
    }
    return null
  }

  const handleApprouteRescan = async () => {
    if (!token || !selectedChat?.id) return
    setApprouteRescanState({ loading: true, error: null, notice: 'Отправляем запрос Api…' })
    const messages = selectedChatState?.messages || []
    const dealIdForRescan =
      selectedChat.dealId || pickDealIdFromMessages(messages) || undefined
    try {
      await rescanApprouteChat(token, {
        chatId: selectedChat.id,
        dealId: dealIdForRescan,
        dealItemId: selectedChat.itemId || undefined,
      })
      try {
        const { list, itemTitle, itemImageUrl, itemCategory, deals, viewerUsername, review } =
          await fetchChatDbMessages(token, {
            dealId: selectedChat.dealId || null,
            chatId: selectedChat.id,
          })
        noteViewerUsername(viewerUsername)
        applyLoadedChatData(
          selectedChat,
          list,
          itemTitle,
          itemImageUrl,
          null,
          itemCategory,
          deals,
          review || null
        )
      } catch (refreshErr) {
        const refreshMessage =
          refreshErr instanceof Error ? refreshErr.message : 'не удалось обновить чат'
        setApprouteRescanState({
          loading: false,
          error: null,
          notice: `Запрос Api отправлен, но чат не обновился: ${refreshMessage}`,
        })
        return
      }
      setApprouteRescanState({
        loading: false,
        error: null,
        notice: 'Готово: запрос Api отправлен.',
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Не удалось выполнить рескан'
      if (err && err.pending) {
        setApprouteRescanState({ loading: false, error: null, notice: message })
      } else {
        setApprouteRescanState({ loading: false, error: message, notice: null })
      }
    }
  }

  const handleRecheckChat = async () => {
    if (!token || !selectedChat?.id) return
    setRecheckState({ loading: true, error: null, notice: 'Загружаем чат с Playerok…' })
    try {
      const result = await recheckChatDbChat(token, {
        chatId: selectedChat.id,
        dealId: selectedChat.dealId || undefined,
      })
      try {
        const { list, itemTitle, itemImageUrl, itemCategory, deals, viewerUsername, review } =
          await fetchChatDbMessages(token, {
            dealId: selectedChat.dealId || null,
            chatId: selectedChat.id,
          })
        noteViewerUsername(viewerUsername)
        applyLoadedChatData(
          selectedChat,
          list,
          itemTitle,
          itemImageUrl,
          null,
          itemCategory,
          deals,
          review || null
        )
      } catch (_refreshErr) {
        // данные перепроверены в БД, но обновить чат на экране не удалось — не критично
      }
      const added = Number(result?.added || 0)
      setRecheckState({
        loading: false,
        error: null,
        notice: added > 0 ? `Готово: добавлено новых сообщений — ${added}.` : 'Готово: новых сообщений не найдено.',
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Не удалось выполнить перепроверку'
      setRecheckState({ loading: false, error: message, notice: null })
    }
  }

  const toggleHiddenForChat = async (chat) => {
    if (!token || !chat?.id) return
    const chatId = chat.id
    const currentlyHidden = Boolean(chat.isHidden)
    logChatLogging(
      'action:toggleHidden',
      { chat: summarizeChatForLog(chat), nextHidden: !currentlyHidden },
      'action'
    )
    try {
      if (!currentlyHidden) {
        await hideChat(token, chatId)
      } else {
        await unhideChat(token, chatId)
      }
      setChats((prev) =>
        prev.map((c) =>
          c.id === chatId
            ? { ...c, isHidden: !currentlyHidden }
            : c
        )
      )
      logChatLogging('action:toggleHidden:success', { chatId, hidden: !currentlyHidden }, 'action')
    } catch (err) {
      logChatLogging(
        'action:toggleHidden:error',
        { chatId, message: err instanceof Error ? err.message : String(err) },
        'error'
      )
    }
  }

  const closeDealActionModal = () => {
    setDealActionModal({ open: false, kind: null, chatId: null })
    setDealActionState({ loading: false, error: null, candidates: [], selectedDealId: null })
  }

  const openDealActionModal = (kind) => {
    if (!token || !selectedChat) return
    const allDeals = Array.isArray(selectedChatDeals) ? selectedChatDeals : []
    const seen = new Set()
    const activeDeals = []
    for (const d of allDeals) {
      const id = d?.dealId != null ? String(d.dealId).trim() : ''
      if (!id || seen.has(id)) continue
      const st = String(d?.status || '').toUpperCase()
      if (st === 'CONFIRMED' || st === 'ROLLED_BACK') continue
      seen.add(id)
      activeDeals.push(d)
    }
    const multiple = activeDeals.length > 1
    const defaultDealId = multiple
      ? null
      : activeDeals[0]?.dealId || selectedChat.dealId || null
    logChatLogging(
      'action:openDealModal',
      { kind, multiple, activeCount: activeDeals.length, chat: summarizeChatForLog(selectedChat) },
      'action'
    )
    setDealActionState({
      loading: false,
      error: null,
      candidates: multiple ? activeDeals : [],
      selectedDealId: defaultDealId,
    })
    setDealActionModal({ open: true, kind, chatId: selectedChat.id })
  }

  const handleDealActionConfirm = async () => {
    const { kind, chatId } = dealActionModal
    const chat = chats.find((c) => c.id === chatId)
    if (!token || !kind) return
    const needsPick = dealActionState.candidates.length > 1
    if (needsPick && !dealActionState.selectedDealId) {
      setDealActionState((prev) => ({
        ...prev,
        error: 'Выберите сделку, с которой выполнить действие.',
      }))
      return
    }
    const effectiveDealId =
      (dealActionState.selectedDealId != null ? String(dealActionState.selectedDealId).trim() : '') ||
      (chat?.dealId != null ? String(chat.dealId).trim() : '')
    if (!effectiveDealId) {
      setDealActionState((prev) => ({
        ...prev,
        loading: false,
        error: 'У этого чата нет ID сделки — запрос на Playerok отправить нельзя.',
      }))
      return
    }
    setDealActionState((prev) => ({ ...prev, loading: true, error: null }))
    logChatLogging('action:dealAction', { kind, dealId: effectiveDealId, chat: summarizeChatForLog(chat) }, 'action')
    try {
      if (kind === 'refund') {
        await cancelDeal(token, effectiveDealId)
      } else {
        await confirmDeal(token, effectiveDealId)
      }
      closeDealActionModal()
      logChatLogging('action:dealAction:success', { kind, chatId, dealId: effectiveDealId }, 'action')
      if (selectedChatId === chatId) {
        void loadMessagesForChat(chat)
      }
      try {
        const { list, pageInfo: info } = await fetchChatDbList(token, {
          limit: 24,
          offset: 0,
        })
        saveChatListScrollAnchor('prepend')
        setChats((prev) => mergeChatsWithRefresh(prev, list || []))
        setPageInfo(info || { hasNextPage: false, endCursor: null })
      } catch (_e) {
        // список обновится по таймеру
      }
    } catch (err) {
      logChatLogging(
        'action:dealAction:error',
        { kind, chatId, message: err instanceof Error ? err.message : String(err) },
        'error'
      )
      setDealActionState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : 'Не удалось выполнить действие',
      }))
    }
  }

  const handleStartFullScan = async () => {
    if (!token) return
    setFullScanState((prev) => ({ ...prev, loading: true, error: null }))
    try {
      await startChatDbFullScan(token)
      setFullScanState((prev) => ({ ...prev, loading: false }))
    } catch (err) {
      setFullScanState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }))
    }
  }

  const handlePauseFullScan = async () => {
    setFullScanState((prev) => ({ ...prev, loading: true, error: null }))
    try {
      await pauseChatDbScan()
      setFullScanState((prev) => ({ ...prev, loading: false }))
    } catch (err) {
      setFullScanState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }))
    }
  }

  const handleStopFullScan = async () => {
    setFullScanState((prev) => ({ ...prev, loading: true, error: null }))
    try {
      await stopChatDbScan()
      setFullScanState((prev) => ({ ...prev, loading: false }))
    } catch (err) {
      setFullScanState((prev) => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      }))
    }
  }

  const selectedChatDerivedStatus = selectedChat ? getDerivedChatStatus(selectedChat) : ''
  const selectedChatOrderStatusLabel = selectedChat
    ? getOrderStatusLabel(selectedChatDerivedStatus)
    : ''

  return (
    <div className="tab-page tab-page--chat">
      <div className={`tab-grid ${isMobileChatLayout ? `tab-grid--chat-mobile-${mobileChatView}` : ''}`}>
        <section className="card">
          <h2 className="card-title">Список чатов</h2>
          {hasToken && (
            <div className="ddos-guard-actions" style={{ marginBottom: '0.6rem' }}>
              <button
                type="button"
                className="btn-secondary"
                onClick={handleStartFullScan}
                disabled={fullScanState.loading || fullScanInProgress}
              >
                {fullScanInProgress
                  ? 'Прогружаем чаты...'
                  : fullScanPaused
                    ? 'Продолжить прогрузку'
                    : 'Прогрузить чаты'}
              </button>
            </div>
          )}
          {hasToken && fullScanState.status && (
            <>
              {fullScanInProgress ? (
                <div className="profit-sync-progress" role="status" aria-live="polite" data-scan-tick={fullScanTick}>
                  <div className="profit-sync-progress__bar-wrap">
                    <div
                      className="profit-sync-progress__bar"
                      style={{ width: `${fullScanProgressPercent || 8}%` }}
                    />
                  </div>
                  <p className="profit-sync-progress__text">
                    {fullScanPhaseLabel ? `${fullScanPhaseLabel}: ` : 'Прогрузка: '}
                    {fullScanPhase === 'list'
                      ? `найдено ${fullScanDone}`
                      : `${fullScanDone} из ${fullScanTotal || '...'} (${fullScanProgressPercent}%)`}
                    {' · '}
                    Время: {Math.floor(fullScanElapsedSec / 60)}м {String(fullScanElapsedSec % 60).padStart(2, '0')}с
                    {fullScanCurrentLabel ? (
                      <>
                        {' · '}
                        {fullScanCurrentLabel}
                      </>
                    ) : null}
                  </p>
                  {fullScanLastError && fullScanCurrentStep === 'skip' && (
                    <p className="card-text card-text--error" style={{ marginTop: '0.35rem' }}>
                      {fullScanLastError}
                    </p>
                  )}
                  {fullScanUpdateLagSec >= 75 && fullScanCurrentStep === 'messages' && (
                    <p className="card-text" style={{ marginTop: '0.35rem' }}>
                      Долгая загрузка истории — через ~{Math.max(0, 90 - fullScanUpdateLagSec)}с чат будет пропущен.
                    </p>
                  )}
                  <div className="ddos-guard-actions" style={{ marginTop: '0.4rem' }}>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={handlePauseFullScan}
                      disabled={fullScanState.loading}
                    >
                      Пауза
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={handleStopFullScan}
                      disabled={fullScanState.loading}
                    >
                      Стоп
                    </button>
                  </div>
                </div>
              ) : fullScanPaused ? (
                <p className="card-text" style={{ marginTop: 0 }}>
                  Прогрузка на паузе
                  {fullScanPhaseLabel ? ` (${fullScanPhaseLabel.toLowerCase()})` : ''}
                  {fullScanDone > 0 ? ` · обработано ${fullScanDone}` : ''}. Нажмите «Продолжить прогрузку».
                </p>
              ) : (
                <p className="card-text" style={{ marginTop: 0 }}>
                  {Number(fullScanState.status.full_scan_completed_at || 0) > 0
                    ? 'Полная прогрузка чатов уже выполнена.'
                    : 'Полная прогрузка ещё не запускалась.'}
                </p>
              )}
            </>
          )}
          {hasToken && fullScanState.error && (
            <p className="card-text card-text--error">{fullScanState.error}</p>
          )}

          {!hasToken && (
            <p className="card-text">
              Укажите токен во вкладке «Токен», чтобы увидеть чаты.
            </p>
          )}

          {hasToken && loading && chats.length === 0 && (
            <p className="card-text">Загружаем чаты с Playerok…</p>
          )}

          {hasToken && error && (
            <p className="card-text card-text--error">{error}</p>
          )}

          {hasToken && !loading && !error && chats.length === 0 && (
            <p className="card-text">
              Чатов пока нет.
            </p>
          )}

          {hasToken && !error && chats.length > 0 && (
            <>
              <div className="chat-filter-toggle">
                <button
                  type="button"
                  className={
                    chatFilter === 'all'
                      ? 'chat-filter-toggle__btn chat-filter-toggle__btn--active'
                      : 'chat-filter-toggle__btn'
                  }
                  onClick={() => setChatFilter('all')}
                  aria-label="Показать все чаты"
                  title="Все чаты"
                >
                  <span aria-hidden="true">💬</span>
                </button>
                <button
                  type="button"
                  className={
                    chatFilter === 'hide-completed'
                      ? 'chat-filter-toggle__btn chat-filter-toggle__btn--active'
                      : 'chat-filter-toggle__btn'
                  }
                  onClick={() => setChatFilter('hide-completed')}
                  aria-label="Только чаты в работе (без завершённых)"
                  title="Только в работе"
                >
                  <span aria-hidden="true">🛠️</span>
                </button>
                <button
                  type="button"
                  className={
                    chatFilter === 'only-fulfillment'
                      ? 'chat-filter-toggle__btn chat-filter-toggle__btn--active'
                      : 'chat-filter-toggle__btn'
                  }
                  onClick={() => setChatFilter('only-fulfillment')}
                  aria-label="Только выполнение заказов и чаты с проблемой"
                  title="Только выполнение"
                >
                  <span aria-hidden="true">📦</span>
                </button>
                <button
                  type="button"
                  className={
                    chatFilter === 'test'
                      ? 'chat-filter-toggle__btn chat-filter-toggle__btn--active'
                      : 'chat-filter-toggle__btn'
                  }
                  onClick={() => setChatFilter('test')}
                  aria-label="Тест: имитация покупок"
                  title="Тест"
                >
                  <span aria-hidden="true">🧪</span>
                </button>
              </div>
              <div
                ref={listRef}
                className="chat-list"
              >
                {visibleChats.map((chat) => {
                  const isActive = chat.id === selectedChatId
                  const unread = typeof chat.unreadCount === 'number' ? chat.unreadCount : null
                  const category = String(chat.category || '').trim() || 'Категория не определена'

                  const derivedStatus = getDerivedChatStatus(chat)
                  const statusIcon = getStatusIcon(derivedStatus)
                  const statusColor =
                    statusIcon.tone === 'success'
                      ? '#16a34a'
                      : statusIcon.tone === 'rollback'
                        ? '#ef4444'
                        : statusIcon.tone === 'work'
                          ? '#0ea5e9'
                          : statusIcon.tone === 'sent'
                            ? '#f59e0b'
                            : 'var(--text-muted)'

                  const displayName = String(chat.buyerName || '').trim() || 'Имя покупателя'
                  const lastMessagePreview = getLastChatMessagePreviewInfo(chat)
                  const hasUnread =
                    unread != null &&
                    unread > 0 &&
                    (lastMessagePreview ? lastMessagePreview.fromBuyer : true)

                  return (
                    <button
                      key={chat.id}
                      type="button"
                      className={
                        'chat-list__item' +
                        (isActive ? ' chat-list__item--active' : '') +
                        (hasUnread ? ' chat-list__item--unread' : '')
                      }
                      onClick={() => {
                        logChatLogging('action:selectChat', { chat: summarizeChatForLog(chat) }, 'action')
                        setSelectedChatId(chat.id)
                        void loadMessagesForChat(chat, { force: true })
                        markChatAsRead(chat.id)
                        if (isMobileChatLayout) {
                          setMobileChatView('chat')
                        }
                      }}
                    >
                      <div
                        className="chat-list__status-slot chat-list__preview--status-icon"
                        title={statusIcon.label}
                        aria-label={statusIcon.label}
                        style={{ color: statusColor }}
                      >
                        <span aria-hidden="true" className="chat-list__status-glyph">
                          {statusIcon.icon}
                        </span>
                      </div>
                      <div className="chat-list__main">
                        <div className="chat-list__title">
                          {displayName}
                        </div>
                        <div className="chat-list__meta">
                          <span className="chat-list__buyer">
                            {category}
                          </span>
                          {derivedStatus === 'CONFIRMED' ? renderReviewBadge(chat.review, { variant: 'list' }) : null}
                        </div>
                        {lastMessagePreview ? (
                          <div className="chat-list__buyer-last-msg">
                            <span
                              className={
                                'chat-list__buyer-last-msg-author ' +
                                (lastMessagePreview.fromBuyer
                                  ? 'chat-list__buyer-last-msg-author--buyer'
                                  : 'chat-list__buyer-last-msg-author--seller')
                              }
                            >
                              {lastMessagePreview.fromBuyer ? 'Заказчик:' : 'Вы:'}
                            </span>{' '}
                            <span className="chat-list__buyer-last-msg-text">{lastMessagePreview.text}</span>
                            {hasUnread && (
                              <span className="chat-list__unread-pill">
                                Новых: {unread}
                              </span>
                            )}
                          </div>
                        ) : null}
                        <div className="chat-list__item-footer">
                          <div className="chat-list__time">
                            {formatTime(chat.lastMessageCreatedAt)}
                          </div>
                        </div>
                      </div>
                    </button>
                  )
                })}
                {loadingMore && (
                  <p className="card-text" style={{ marginTop: '0.5rem' }}>
                    Загружаем ещё чаты…
                  </p>
                )}
              </div>
            </>
          )}
        </section>

        <section className="card">
          <button
            type="button"
            className="chat-mobile-back-btn"
            onClick={() => setMobileChatView('list')}
          >
            ← Чаты
          </button>
          <h2 className="card-title">Сообщения</h2>
          {!hasToken && (
            <p className="card-text">
              Сообщения чатов недоступны без токена.
            </p>
          )}
          {hasToken && !selectedChat && (
            <p className="card-text">
              Выберите чат слева, чтобы увидеть сообщения.
            </p>
          )}
          {hasToken && selectedChat && isTestChat && (
            <>
              <div className="chat-header-row">
                <div className="card-text chat-header-row__info">
                  <div className="chat-header-row__text">
                    <strong>Тест покупки</strong>
                    <span className="chat-header-row__buyer">
                      Покупатель: {TEST_CHAT.buyerName}
                    </span>
                  </div>
                </div>
              </div>
              <div className="chat-messages">
                {testMessages.length === 0 ? (
                  <p className="card-text">
                    Выберите товар и нажмите «Тест покупки».
                  </p>
                ) : (
                  testMessages.map((m) => {
                    const cls =
                      m.role === 'system'
                        ? 'chat-message chat-message--system'
                        : m.role === 'buyer'
                          ? 'chat-message chat-message--buyer'
                          : 'chat-message chat-message--seller'
                    return (
                      <div key={m.id} className={cls}>
                        <div className="chat-message__bubble">
                          <div className="chat-message__text-wrapper">
                            <div className="chat-message__text">
                              {formatMessageText(m.text)}
                            </div>
                          </div>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
              {testError && (
                <p className="card-text card-text--error" role="status" aria-live="polite">
                  {testError}
                </p>
              )}
              <form
                className="deal-chat-row__input"
                onSubmit={(e) => {
                  e.preventDefault()
                  void runTestPurchase()
                }}
              >
                <select
                  className="deal-chat-row__input-field"
                  value={testProductKey}
                  onChange={(e) => setTestProductKey(e.target.value)}
                  aria-label="Товар для тест-покупки"
                >
                  <option value="">Выберите товар…</option>
                  {testProductOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <button
                  type="submit"
                  className="deal-chat-row__input-btn"
                  disabled={!token || !testProductKey || testRunning}
                >
                  {testRunning ? 'Тестируем…' : 'Тест покупки'}
                </button>
              </form>
            </>
          )}
          {hasToken && selectedChat && !isTestChat && (
            <>
              <div className="chat-header-row">
                <div className="card-text chat-header-row__info">
                  <div className="chat-header-row__text">
                    <strong>Чат по товару</strong>
                    {selectedChat.buyerName ? (
                      <span className="chat-header-row__buyer">
                        Покупатель: {selectedChat.buyerName}
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="chat-header-row__center">
                  {selectedChatDerivedStatus !== 'CONFIRMED' ? (
                    <div className="chat-header-row__deal-btns" aria-label="Быстрые действия со сделкой">
                      <button
                        type="button"
                        className="chat-header-row__deal-btn chat-header-row__deal-btn--refund"
                        disabled={!token}
                        title="Оформить возврат на Playerok"
                        onClick={() => openDealActionModal('refund')}
                      >
                        Возврат
                      </button>
                      <button
                        type="button"
                        className="chat-header-row__deal-btn chat-header-row__deal-btn--confirm"
                        disabled={!token}
                        title="Подтвердить сделку на Playerok"
                        onClick={() => openDealActionModal('confirm')}
                      >
                        Подтвердить сделку
                      </button>
                    </div>
                  ) : null}
                  {selectedChatOrderStatusLabel ? (
                    <span className="chat-header-row__order-status">Статус: {selectedChatOrderStatusLabel}</span>
                  ) : null}
                </div>
                <div className="chat-header-row__actions">
                  <button
                    type="button"
                    className="chat-header-row__hide-btn"
                    disabled={!token || recheckState.loading}
                    title="Загрузить чат с Playerok и добавить недостающие сообщения в БД"
                    onClick={() => void handleRecheckChat()}
                  >
                    {recheckState.loading ? 'Перепроверяем…' : 'Перепроверка'}
                  </button>
                  {selectedChatApprouteEnabled && (
                    <button
                      type="button"
                      className="chat-header-row__hide-btn"
                      disabled={!token || approuteRescanState.loading}
                      onClick={() => void handleApprouteRescan()}
                    >
                      {approuteRescanState.loading ? 'Проверяем Api…' : 'Повтор Api'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="chat-header-row__hide-btn"
                    onClick={() => toggleHiddenForChat(selectedChat)}
                  >
                    {selectedChat.isHidden ? 'Показать чат' : 'Скрыть чат'}
                  </button>
                  <button
                    type="button"
                    className="chat-header-row__hide-btn"
                    onClick={() => setShowChatExtraInfo((v) => !v)}
                  >
                    {showChatExtraInfo ? 'Скрыть доп инфо' : 'Доп инфо'}
                  </button>
                </div>
              </div>
              {selectedChatApprouteEnabled && approuteRescanState.error && (
                <p className="card-text card-text--error" role="status" aria-live="polite">
                  {approuteRescanState.error}
                </p>
              )}
              {selectedChatApprouteEnabled && approuteRescanState.notice && (
                <p className="card-text" role="status" aria-live="polite">
                  {approuteRescanState.notice}
                </p>
              )}
              {recheckState.error && (
                <p className="card-text card-text--error" role="status" aria-live="polite">
                  {recheckState.error}
                </p>
              )}
              {recheckState.notice && (
                <p className="card-text" role="status" aria-live="polite">
                  {recheckState.notice}
                </p>
              )}
              <div className={'chat-item-card' + (mobileCardExpanded ? ' chat-item-card--mexpanded' : '')}>
                <div className="chat-item-card__image-wrap">
                  {currentItemImageUrl ? (
                    <img
                      src={currentItemImageUrl}
                      alt={currentItemTitle || ''}
                      className="chat-item-card__image"
                    />
                  ) : (
                    <div className="chat-item-card__placeholder">
                      Нет фото
                    </div>
                  )}
                </div>
                <div className="chat-item-card__body">
                  {currentItemTitle && (
                    <div className="chat-item-card__title">
                      {currentItemTitle}
                    </div>
                  )}
                  <button
                    type="button"
                    className="chat-item-card__mtoggle"
                    onClick={() => setMobileCardExpanded((v) => !v)}
                  >
                    {mobileCardExpanded ? 'Скрыть детали ▴' : 'Показать детали (финансы, почта) ▾'}
                  </button>
                  {selectedChat.buyerName ? (
                    <div className="chat-item-card__buyer">
                      Покупатель: {selectedChat.buyerName}
                    </div>
                  ) : null}
                  {selectedChatDerivedStatus === 'CONFIRMED' && (() => {
                    const headerReview = selectedChatState?.review || selectedChat?.review || null
                    return (
                      <div className="chat-item-card__review">
                        Отзыв покупателя: {renderReviewBadge(headerReview, { variant: 'header' })}
                      </div>
                    )
                  })()}
                  {selectedChatDeals.length > 0 && (
                    <div className="chat-item-card__buyer">
                      Покупки в чате: {selectedChatDeals.map((d) => d.itemCategory || 'Без категории').join(' · ')}
                    </div>
                  )}
                  {(() => {
                    // В шапке — только текущая (последняя) сделка. Предыдущие сделки
                    // показываются инлайн в ленте сообщений по мере прокрутки к ним.
                    const primaryDeal = selectedChatDeals.find(
                      (d) =>
                        d &&
                        d.financials &&
                        selectedChatPrimaryDealId &&
                        String(d.dealId) === String(selectedChatPrimaryDealId)
                    )
                    const headerDeal =
                      primaryDeal ||
                      (selectedChatDeals.length === 1
                        ? selectedChatDeals.find((d) => d && d.financials)
                        : null)
                    if (!headerDeal) return null
                    return (
                      <div className="chat-item-card__financials">
                        {renderDealFinCard(headerDeal, { showTitle: false })}
                      </div>
                    )
                  })()}
                  {selectedChatCanUseSupercell && (
                    <div
                      className={
                        'chat-item-card__email-box ' +
                        (selectedChatEmail
                          ? selectedChatEmailIsValid
                            ? 'deal-chat-row__email-box--valid'
                            : 'deal-chat-row__email-box--invalid'
                          : '')
                      }
                    >
                      <span className="deal-chat-row__email-label">Почта Supercell ID:</span>
                      <span className="deal-chat-row__email-value">
                        {selectedChatEmail || 'Не указана'}
                      </span>
                      <button
                        type="button"
                        className="lot-settings-btn lot-settings-btn--secondary"
                        onClick={() => openRequestCodeModal(selectedChat)}
                      >
                        Изменить
                      </button>
                    </div>
                  )}
                </div>
              </div>
              {showChatExtraInfo && (
                <div className="card-text" style={{ marginTop: '0.6rem' }}>
                  <div>Chat ID: {selectedChat.id || '—'}</div>
                  <div>Deal ID: {selectedChat.dealId || '—'}</div>
                  <div>Item ID: {selectedChat.itemId || '—'}</div>
                  <div>Buyer: {selectedChat.buyerName || '—'}</div>
                  <div>Category: {selectedChat.category || '—'}</div>
                  <div>Last message ID: {selectedChat.lastMessageId || '—'}</div>
                  {selectedChatDeals.length > 0 && (
                    <div>
                      Deals in chat: {selectedChatDeals.map((d) => d.dealId || '—').join(', ')}
                    </div>
                  )}
                </div>
              )}
              {(() => {
                const baseMessages = mergeListAheadMessage(
                  selectedChat,
                  selectedChatState?.messages || []
                )
                const feedReview = selectedChatState?.review || selectedChat?.review || null
                let messagesToRender = baseMessages
                if (feedReview && feedReview.left === true) {
                  const reviewMsg = {
                    id: '__review__',
                    createdAt: feedReview.createdAt || null,
                    _reviewBadge: feedReview,
                  }
                  const reviewTs = feedReview.createdAt ? Date.parse(feedReview.createdAt) : NaN
                  if (Number.isFinite(reviewTs)) {
                    const next = [...baseMessages]
                    let insertAt = next.findIndex((m) => {
                      const ts = m?.createdAt ? Date.parse(m.createdAt) : NaN
                      return Number.isFinite(ts) && ts > reviewTs
                    })
                    if (insertAt < 0) insertAt = next.length
                    next.splice(insertAt, 0, reviewMsg)
                    messagesToRender = next
                  } else {
                    messagesToRender = [...baseMessages, reviewMsg]
                  }
                }
                if (messagesToRender.length === 0) {
                  if (selectedChatMessagesPending) {
                    return <p className="card-text">Загружаем чат…</p>
                  }
                  if (selectedChatState?.error) {
                    return (
                      <p className="card-text card-text--error">
                        {selectedChatState.error}
                      </p>
                    )
                  }
                  return (
                    <p className="card-text">Сообщений в этом чате пока нет.</p>
                  )
                }
                // Финансы предыдущих сделок — инлайн в ленте у начала каждой сделки
                // (первое сообщение с её deal_id). Текущую сделку показываем в шапке.
                const financialsByDeal = new Map()
                for (const d of selectedChatDeals) {
                  if (d && d.dealId && d.financials) financialsByDeal.set(String(d.dealId), d)
                }
                const cardBeforeMessageId = new Map()
                const seenFinDeals = new Set()
                for (const m of messagesToRender) {
                  const did = m && m.dealId ? String(m.dealId) : null
                  if (!did || seenFinDeals.has(did)) continue
                  seenFinDeals.add(did)
                  if (selectedChatPrimaryDealId && did === String(selectedChatPrimaryDealId)) continue
                  const deal = financialsByDeal.get(did)
                  if (deal && m.id != null) cardBeforeMessageId.set(String(m.id), deal)
                }
                return (
                  <div ref={messagesRef} className="chat-messages">
                    {selectedChatMessagesPending && (
                      <p className="card-text chat-messages__loading-hint">
                        Загружаем историю…
                      </p>
                    )}
                    {messagesToRender.map((m) => {
                        if (m._reviewBadge) {
                          const rv = m._reviewBadge
                          const ratingNum = Number(rv.rating)
                          const hasRating = Number.isFinite(ratingNum) && ratingNum > 0
                          const stars = hasRating
                            ? '★'.repeat(ratingNum) + '☆'.repeat(Math.max(0, 5 - ratingNum))
                            : ''
                          const reviewTimeText = formatTime(m.createdAt)
                          return (
                            <div key={m.id} className="chat-message chat-message--system">
                              <div className="chat-message__bubble">
                                <div className="chat-message__system-header">
                                  <span className="chat-message__system-icon" title="Системное сообщение">
                                    ⚙️
                                  </span>
                                  <span className="chat-message__system-label">Системное сообщение</span>
                                </div>
                                <div className="chat-message__text">
                                  {hasRating
                                    ? `Покупатель оставил отзыв: ${stars} (${ratingNum} из 5)`
                                    : 'Покупатель оставил отзыв'}
                                </div>
                                {reviewTimeText && (
                                  <div className="chat-message__time">{reviewTimeText}</div>
                                )}
                              </div>
                            </div>
                          )
                        }
                        const timeText = formatTime(m.createdAt)
                        const isSystem = m.text ? isSystemMessage(m.text) : false
                        const fromBuyer = isFromBuyer(m)
                        // Для системных сообщений используем только класс system, иначе определяем по автору
                        const messageClass = isSystem
                          ? 'chat-message chat-message--system'
                          : `chat-message ${fromBuyer ? 'chat-message--buyer' : 'chat-message--seller'}`
                        const inlineFinDeal = cardBeforeMessageId.get(String(m.id))
                        const messageNode = (
                          <div key={m.id} className={messageClass}>
                            <div className="chat-message__bubble">
                              {isSystem && (
                                <div className="chat-message__system-header">
                                  <span className="chat-message__system-icon" title="Системное сообщение">
                                    ⚙️
                                  </span>
                                  <span className="chat-message__system-label">Системное сообщение</span>
                                </div>
                              )}
                              {!isSystem && m.text ? (
                                <div className="chat-message__text-wrapper">
                                  <div className="chat-message__text">
                                    {formatMessageText(m.text)}
                                  </div>
                                  {timeText && (
                                    <div className="chat-message__time">
                                      {timeText}
                                    </div>
                                  )}
                                </div>
                              ) : isSystem && m.text ? (
                                <div className="chat-message__text">
                                  {formatMessageText(m.text)}
                                </div>
                              ) : null}
                              {m.imageUrl ? (
                                <div className="chat-message__image-wrap">
                                  <a
                                    href={m.imageUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="chat-message__image-btn"
                                    title="Открыть изображение"
                                  >
                                    <img
                                      src={m.imageUrl}
                                      alt="Изображение в чате"
                                      className="chat-message__image"
                                    />
                                  </a>
                                </div>
                              ) : null}
                              {m.imageUrl && !m.text && timeText ? (
                                <div className="chat-message__time">
                                  {timeText}
                                </div>
                              ) : null}
                              {!m.text && !m.imageUrl && (
                                <div className={isSystem ? "chat-message__text chat-message__placeholder" : "chat-message__text-wrapper"}>
                                  {!isSystem ? (
                                    <>
                                      <div className="chat-message__text chat-message__placeholder">
                                        Сообщение без текста
                                      </div>
                                      {timeText && (
                                        <div className="chat-message__time">
                                          {timeText}
                                        </div>
                                      )}
                                    </>
                                  ) : (
                                    "Сообщение без текста"
                                  )}
                                </div>
                              )}
                              {isSystem && timeText && (
                                <div className="chat-message__time">
                                  {timeText}
                                </div>
                              )}
                            </div>
                          </div>
                        )
                        if (inlineFinDeal) {
                          return [
                            <div className="chat-deal-fin-inline" key={`fin-${m.id}`}>
                              {renderDealFinCard(inlineFinDeal, { showTitle: true })}
                            </div>,
                            messageNode,
                          ]
                        }
                        return messageNode
                      })}
                    </div>
                  )
                })()}

              {!selectedChatState?.error && (
                <>
                  {(currentCategoryCommands.length > 0 || selectedChatCanUseSupercell) && (
                    <div className="chat-commands-buttons" style={{ marginBottom: '1rem' }}>
                      <div className="chat-commands-buttons__label" style={{
                        fontSize: '0.875rem',
                        color: 'var(--text-secondary, #666)',
                        marginBottom: '0.5rem'
                      }}>
                        Быстрые команды:
                      </div>
                      <div className="chat-commands-buttons__list" style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: '0.5rem'
                      }}>
                        {currentCategoryCommands.map((cmd, index) => {
                          const buttonColor = cmd.color || '#6c757d'
                          const textColor = getTextColor(buttonColor)
                          return (
                            <button
                              key={cmd.id || index}
                              type="button"
                              className="btn-secondary"
                              style={{
                                fontSize: '0.875rem',
                                padding: '0.5rem 1rem',
                                backgroundColor: buttonColor,
                                borderColor: buttonColor,
                                color: textColor,
                                transition: 'background-color 0.2s ease, border-color 0.2s ease',
                              }}
                              onMouseEnter={(e) => {
                                // Немного затемняем при наведении
                                const rgb = hexToRgb(buttonColor)
                                if (rgb) {
                                  const darkerR = Math.max(0, rgb.r - 20)
                                  const darkerG = Math.max(0, rgb.g - 20)
                                  const darkerB = Math.max(0, rgb.b - 20)
                                  const darkerColor = `rgb(${darkerR}, ${darkerG}, ${darkerB})`
                                  e.target.style.backgroundColor = darkerColor
                                  e.target.style.borderColor = darkerColor
                                  // Обновляем цвет текста для затемненного фона
                                  const darkerLuminance = getLuminance(darkerR, darkerG, darkerB)
                                  e.target.style.color = darkerLuminance > 128 ? '#000' : '#fff'
                                }
                              }}
                              onMouseLeave={(e) => {
                                e.target.style.backgroundColor = buttonColor
                                e.target.style.borderColor = buttonColor
                                e.target.style.color = textColor
                              }}
                              onClick={() => {
                                if (!selectedChat || !token) return
                                void deliverChatMessage(selectedChat, cmd.text)
                              }}
                            >
                              {cmd.label}
                            </button>
                          )
                        })}
                        {selectedChatCanUseSupercell && (
                          <button
                            type="button"
                            className="deal-chat-row__command-btn"
                            onClick={() => openRequestCodeModal(selectedChat)}
                          >
                            Запросить код
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                  <form
                    className="deal-chat-row__input"
                    onSubmit={(e) => {
                      e.preventDefault()
                      if (!selectedChat) return
                      handleSendMessage(selectedChat)
                    }}
                  >
                    <input
                      type="text"
                      className="deal-chat-row__input-field"
                      placeholder="Написать сообщение…"
                      value={draftByChatId[selectedChat.id] || ''}
                      onChange={(e) =>
                        setDraftByChatId((prev) => ({
                          ...prev,
                          [selectedChat.id]: e.target.value,
                        }))
                      }
                    />
                    <button
                      type="submit"
                      className="deal-chat-row__input-btn"
                      disabled={
                        !token || !(draftByChatId[selectedChat.id] || '').trim()
                      }
                    >
                      Отправить
                    </button>
                  </form>
                </>
              )}
            </>
          )}
        </section>
      </div>
      {requestCodeModal.open && selectedChat && requestCodeModal.chatId === selectedChat.id && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!requestCodeState.loading) closeRequestCodeModal()
          }}
          role="presentation"
        >
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Запросить код Supercell"
          >
            <div className="modal__header">
              <h3 className="modal__title">Запросить код</h3>
              <button
                type="button"
                className="modal__close"
                onClick={closeRequestCodeModal}
                disabled={requestCodeState.loading}
                aria-label="Закрыть"
              >
                x
              </button>
            </div>
            <div className="modal__body">
              <p className="card-text" style={{ marginTop: 0 }}>
                Категория: <strong>{selectedChat.category || '—'}</strong>
              </p>
              <label className="field">
                <span className="field-label">Почта Supercell ID</span>
                <input
                  type="email"
                  className={
                    'deal-chat-row__email-input ' +
                    (selectedChatEmailDraft
                      ? selectedChatEmailDraftIsValid
                        ? 'deal-chat-row__email-input--valid'
                        : 'deal-chat-row__email-input--invalid'
                      : '')
                  }
                  value={selectedChatEmailDraft}
                  onChange={(e) =>
                    setEmailDraftByChatId((prev) => ({
                      ...prev,
                      [selectedChat.id]: e.target.value,
                    }))
                  }
                  placeholder="Введите почту"
                />
              </label>
              {selectedChatEmailDraft && (
                <p
                  className={
                    'card-text ' +
                    (selectedChatEmailDraftIsValid
                      ? 'chat-request-code__email-status chat-request-code__email-status--valid'
                      : 'card-text--error chat-request-code__email-status')
                  }
                >
                  {selectedChatEmailDraftIsValid
                    ? 'Почта валидная'
                    : 'Почта невалидная'}
                </p>
              )}
              {selectedChatDetectedEmail && selectedChatDetectedEmail !== selectedChatEmailDraft && (
                <p className="deal-chat-row__email-hint">
                  Автоопределена: {selectedChatDetectedEmail}
                </p>
              )}
              {requestCodeState.error && (
                <p className="card-text card-text--error">
                  {requestCodeState.error}
                </p>
              )}
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16, flexWrap: 'wrap' }}>
                {selectedChatManualEmail && (
                  <button
                    type="button"
                    className="lot-settings-btn lot-settings-btn--secondary"
                    onClick={() => resetManualEmailForChat(selectedChat.id)}
                    disabled={requestCodeState.loading}
                  >
                    Вернуть авто
                  </button>
                )}
                <button
                  type="button"
                  className="lot-settings-btn lot-settings-btn--secondary"
                  onClick={closeRequestCodeModal}
                  disabled={requestCodeState.loading}
                >
                  Отмена
                </button>
                <button
                  type="button"
                  className="lot-settings-btn lot-settings-btn--secondary"
                  onClick={handleSaveEmailForSelectedChat}
                  disabled={requestCodeState.loading || !selectedChatEmailDraftIsValid}
                >
                  Сохранить почту
                </button>
                <button
                  type="button"
                  className="deal-chat-row__command-btn"
                  onClick={handleRequestCodeForSelectedChat}
                  disabled={requestCodeState.loading || !selectedChatEmailDraftIsValid}
                >
                  {requestCodeState.loading ? 'Запрашиваем код...' : 'Запросить код'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {dealActionModal.open && dealActionModal.kind && dealActionModal.chatId && (
        <div
          className="modal-backdrop"
          onClick={() => {
            if (!dealActionState.loading) closeDealActionModal()
          }}
          role="presentation"
        >
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label={
              dealActionModal.kind === 'refund'
                ? 'Подтверждение возврата'
                : 'Подтверждение сделки'
            }
          >
            <div className="modal__header">
              <h3 className="modal__title">
                {dealActionModal.kind === 'refund'
                  ? 'Оформить возврат?'
                  : 'Подтвердить сделку?'}
              </h3>
              <button
                type="button"
                className="modal__close"
                onClick={closeDealActionModal}
                disabled={dealActionState.loading}
                aria-label="Закрыть"
              >
                x
              </button>
            </div>
            <div className="modal__body">
              <p className="card-text" style={{ marginTop: 0 }}>
                {dealActionModal.kind === 'refund'
                  ? 'Вы уверены, что хотите оформить возврат товара? Сделка на Playerok будет отменена.'
                  : 'Вы уверены, что хотите подтвердить сделку? На Playerok будет зафиксировано, что товар отправлен покупателю.'}
              </p>
              {dealActionState.candidates.length > 1 && (
                <div className="deal-action-picker">
                  <p className="card-text deal-action-picker__hint" style={{ marginTop: 0, marginBottom: 8 }}>
                    У покупателя несколько активных сделок. Выберите, с какой выполнить действие:
                  </p>
                  <div className="deal-action-picker__list">
                    {dealActionState.candidates.map((d) => {
                      const id = String(d.dealId)
                      const checked = String(dealActionState.selectedDealId || '') === id
                      return (
                        <label
                          key={id}
                          className={
                            'deal-action-picker__item' + (checked ? ' deal-action-picker__item--active' : '')
                          }
                        >
                          <input
                            type="radio"
                            name="deal-action-pick"
                            value={id}
                            checked={checked}
                            disabled={dealActionState.loading}
                            onChange={() =>
                              setDealActionState((prev) => ({ ...prev, selectedDealId: id, error: null }))
                            }
                          />
                          <span className="deal-action-picker__item-text">
                            <span className="deal-action-picker__item-title">
                              {d.itemTitle || 'Без названия'}
                            </span>
                            <span className="deal-action-picker__item-meta">
                              {getOrderStatusLabel(d.status) || 'Статус неизвестен'} · #{id.slice(0, 8)}
                            </span>
                          </span>
                        </label>
                      )
                    })}
                  </div>
                </div>
              )}
              {dealActionState.error && (
                <p className="card-text card-text--error">{dealActionState.error}</p>
              )}
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  justifyContent: 'flex-end',
                  marginTop: 16,
                  flexWrap: 'wrap',
                }}
              >
                <button
                  type="button"
                  className="lot-settings-btn lot-settings-btn--secondary"
                  onClick={closeDealActionModal}
                  disabled={dealActionState.loading}
                >
                  Отмена
                </button>
                <button
                  type="button"
                  className={
                    dealActionModal.kind === 'refund'
                      ? 'lot-settings-btn'
                      : 'deal-chat-row__command-btn'
                  }
                  style={
                    dealActionModal.kind === 'refund'
                      ? { backgroundColor: '#dc2626', borderColor: '#dc2626', color: '#fff' }
                      : undefined
                  }
                  onClick={handleDealActionConfirm}
                  disabled={
                    dealActionState.loading ||
                    (dealActionState.candidates.length > 1 && !dealActionState.selectedDealId)
                  }
                >
                  {dealActionState.loading
                    ? 'Выполняем…'
                    : dealActionModal.kind === 'refund'
                      ? 'Да, оформить возврат'
                      : 'Да, подтвердить'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

