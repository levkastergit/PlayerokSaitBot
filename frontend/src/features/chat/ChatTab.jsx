import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchUserChats,
  fetchDealChatMessages,
  sendDealChatMessage,
  hideChat,
  unhideChat,
  loadCategoryCommandsList,
  requestSupercellCode,
} from '../../services/playerokApi'

export function ChatTab({ token, moduleSupercellEnabled = false }) {
  const [chats, setChats] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [pageInfo, setPageInfo] = useState({ hasNextPage: false, endCursor: null })
  const [selectedChatId, setSelectedChatId] = useState(null)
  const [chatStateById, setChatStateById] = useState({})
  const [draftByChatId, setDraftByChatId] = useState({})
  const [chatFilter, setChatFilter] = useState('all') // 'all' | 'hide-completed'
  const [categoryCommands, setCategoryCommands] = useState([]) // [{ category, commands }]
  const [loadingCommands, setLoadingCommands] = useState(false)
  const [requestCodeModal, setRequestCodeModal] = useState({ open: false, chatId: null })
  const [requestCodeState, setRequestCodeState] = useState({ loading: false, error: null })
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
  const loadingMoreRef = useRef(false)
  const chatStateByIdRef = useRef({})

  const hasToken = Boolean(token)
  const OUR_USERNAME = 'Levkaster'
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

  const isFromBuyer = (message) => {
    const username = (message.user?.username || '').trim()
    return username !== OUR_USERNAME
  }

  const normalizeCategoryName = (name) =>
    String(name || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ')

  const isSupercellCategory = (name) =>
    SUPERCELL_EMAIL_GAMES.includes(normalizeCategoryName(name))

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

  const extractBuyerNameFromMessages = (messages) => {
    if (!Array.isArray(messages) || messages.length === 0) return null
    for (const msg of messages) {
      const msgUser = msg.user
      if (msgUser && msgUser.username && msgUser.username !== OUR_USERNAME) {
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

  const applyLoadedChatData = (chat, list, itemTitle, itemImageUrl, buyerSupercellEmail) => {
    const chatId = chat.id
    const extractedBuyerName = chat.buyerName || extractBuyerNameFromMessages(list)

    if (extractedBuyerName && !chat.buyerName) {
      setChats((prev) =>
        prev.map((c) =>
          c.id === chatId ? { ...c, buyerName: extractedBuyerName } : c
        )
      )
    }

    setChatStateById((prev) => ({
      ...prev,
      [chatId]: {
        ...(prev[chatId] || {}),
        loading: false,
        error: null,
        messages: sortChatMessages(list),
        loaded: true,
        itemTitle: itemTitle || chat.itemTitle || null,
        itemImageUrl: itemImageUrl || null,
        buyerSupercellEmail: buyerSupercellEmail ?? prev[chatId]?.buyerSupercellEmail ?? null,
      },
    }))
  }

  useEffect(() => {
    chatStateByIdRef.current = chatStateById
  }, [chatStateById])

  const preloadChatsData = useCallback(async (targetChats, options = {}) => {
    if (!token || !Array.isArray(targetChats) || targetChats.length === 0) return
    const delayMs = Number(options.delayMs) > 0 ? Number(options.delayMs) : 0
    const shouldCancel = typeof options.shouldCancel === 'function'
      ? options.shouldCancel
      : () => false

    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      if (shouldCancel()) return
    }

    const chatsToPreload = targetChats.filter((chat) => {
      const state = chatStateByIdRef.current[chat.id]
      return !(state && (state.loading || state.loaded))
    })
    if (chatsToPreload.length === 0) return

    const BATCH_SIZE = 4
    const BATCH_DELAY_MS = 400

    for (let i = 0; i < chatsToPreload.length; i += BATCH_SIZE) {
      if (shouldCancel()) return
      const batch = chatsToPreload.slice(i, i + BATCH_SIZE)

      await Promise.all(batch.map(async (chat) => {
        if (shouldCancel()) return
        const chatId = chat.id
        const currentState = chatStateByIdRef.current[chatId]
        if (currentState && (currentState.loading || currentState.loaded)) return

        setChatStateById((prev) => ({
          ...prev,
          [chatId]: {
            ...(prev[chatId] || {}),
            loading: true,
            error: null,
            messages: prev[chatId]?.messages || [],
            loaded: false,
          },
        }))

        try {
          const { list, itemTitle, itemImageUrl, buyerSupercellEmail } = await fetchDealChatMessages(
            token,
            chat.dealId || null,
            chatId
          )
          if (shouldCancel()) return
          applyLoadedChatData(chat, list, itemTitle, itemImageUrl, buyerSupercellEmail)
        } catch {
          if (shouldCancel()) return
          setChatStateById((prev) => ({
            ...prev,
            [chatId]: {
              ...(prev[chatId] || {}),
              loading: false,
              error: null,
              messages: prev[chatId]?.messages || [],
              loaded: false,
            },
          }))
        }
      }))

      if (i + BATCH_SIZE < chatsToPreload.length && !shouldCancel()) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY_MS))
      }
    }
  }, [token])

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

  useEffect(() => {
    if (!token) {
      setChats([])
      setError(null)
      setPageInfo({ hasNextPage: false, endCursor: null })
      setSelectedChatId(null)
      setChatStateById({})
      setDraftByChatId({})
      return
    }
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError(null)
      try {
        // `list` дальше может быть перенормализован, поэтому нужен `let`, а не `const`.
        let { list, pageInfo: info } = await fetchUserChats(token, { limit: 24 })
        if (cancelled) return
        // Проверка чатов без категории или с пустой категорией
        const chatsWithoutCategory = list.filter(chat => {
          const cat = chat.category
          return !cat || (typeof cat === 'string' && !cat.trim())
        })
        if (chatsWithoutCategory.length > 0) {
          // Нормализуем категории для чатов без категории прямо здесь
          const normalizedList = list.map(chat => {
            const cat = chat.category
            if (!cat || (typeof cat === 'string' && !cat.trim())) {
              let fallbackCategory = 'Общий чат'
              if (chat.itemTitle && typeof chat.itemTitle === 'string' && chat.itemTitle.trim()) {
                const title = chat.itemTitle.trim()
                const commonGames = [
                  'Clash of Clans', 'Clash Royale', 'Brawl Stars', 'Hay Day', 'Boom Beach',
                  'PUBG', 'PUBG Mobile', 'Call of Duty', 'Free Fire', 'Fortnite',
                  'CS:GO', 'CS2', 'Counter-Strike', 'Dota 2', 'League of Legends',
                  'Valorant', 'Apex Legends', 'Genshin Impact', 'Honkai', 'Star Rail',
                  'World of Tanks', 'World of Warships', 'War Thunder',
                  'Minecraft', 'Roblox', 'Among Us', 'Fall Guys', 'Mobile Legends',
                  'Wild Rift', 'Arena of Valor', 'Heroes of the Storm', 'Overwatch'
                ]
                for (const game of commonGames) {
                  if (title.toLowerCase().includes(game.toLowerCase())) {
                    fallbackCategory = game
                    break
                  }
                }
                if (!fallbackCategory) {
                  const words = title.split(/\s+/).filter(w => w.length > 0)
                  if (words.length > 0) {
                    let candidate = words.slice(0, 3).join(' ')
                    if (candidate.length > 50) candidate = candidate.substring(0, 50).trim()
                    if (candidate) fallbackCategory = candidate
                  }
                }
              }
              // Если категория всё ещё не найдена, это критическая ошибка
              if (!fallbackCategory || (typeof fallbackCategory === 'string' && !fallbackCategory.trim())) {
                fallbackCategory = 'Категория не определена'
              }
              return { ...chat, category: fallbackCategory }
            }
            return chat
          })

          // Используем нормализованный список
          list = normalizedList
        }

        setChats(list)
        setPageInfo(info || { hasNextPage: false, endCursor: null })
        if (list.length > 0) {
          setSelectedChatId((prev) => {
            if (prev && list.some((c) => c.id === prev)) return prev
            const firstVisible = list.find((c) =>
              chatFilter === 'hide-completed' ? !isChatCompleted(c) : true
            )
            return firstVisible ? firstVisible.id : null
          })
        } else {
          setSelectedChatId(null)
        }
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Ошибка загрузки чатов')
        setChats([])
        setPageInfo({ hasNextPage: false, endCursor: null })
        setSelectedChatId(null)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [token])

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
      const requestParams = { limit: 24 }
      if (afterCursor) {
        requestParams.afterCursor = afterCursor
      }
      let { list, pageInfo: info } = await fetchUserChats(token, requestParams)

      // Проверка чатов без категории в loadMore
      const chatsWithoutCategory = (list || []).filter(chat => {
        const cat = chat.category
        return !cat || (typeof cat === 'string' && !cat.trim())
      })
      if (chatsWithoutCategory.length > 0) {
        // Нормализуем категории для чатов без категории
        // КРИТИЧНО: категория должна быть всегда определена на бэкенде
        const normalizedList = (list || []).map(chat => {
          const cat = chat.category
          if (!cat || (typeof cat === 'string' && !cat.trim())) {
            let fallbackCategory = null
            if (chat.itemTitle && typeof chat.itemTitle === 'string' && chat.itemTitle.trim()) {
              const title = chat.itemTitle.trim()
              const commonGames = [
                'Clash of Clans', 'Clash Royale', 'Brawl Stars', 'Hay Day', 'Boom Beach',
                'PUBG', 'PUBG Mobile', 'Call of Duty', 'Free Fire', 'Fortnite',
                'CS:GO', 'CS2', 'Counter-Strike', 'Dota 2', 'League of Legends',
                'Valorant', 'Apex Legends', 'Genshin Impact', 'Honkai', 'Star Rail',
                'World of Tanks', 'World of Warships', 'War Thunder',
                'Minecraft', 'Roblox', 'Among Us', 'Fall Guys', 'Mobile Legends',
                'Wild Rift', 'Arena of Valor', 'Heroes of the Storm', 'Overwatch'
              ]
              for (const game of commonGames) {
                if (title.toLowerCase().includes(game.toLowerCase())) {
                  fallbackCategory = game
                  break
                }
              }
              if (!fallbackCategory) {
                const words = title.split(/\s+/).filter(w => w.length > 0)
                if (words.length > 0) {
                  let candidate = words.slice(0, 3).join(' ')
                  if (candidate.length > 50) candidate = candidate.substring(0, 50).trim()
                  if (candidate) fallbackCategory = candidate
                }
              }
            }
            // Если категория всё ещё не найдена, это критическая ошибка
            if (!fallbackCategory || (typeof fallbackCategory === 'string' && !fallbackCategory.trim())) {
              fallbackCategory = 'Категория не определена'
            }
            return { ...chat, category: fallbackCategory }
          }
          return chat
        })

        // Используем нормализованный список
        list = normalizedList
      }

      if (!list || list.length === 0) {
        setPageInfo({ hasNextPage: false, endCursor: null })
        return
      }

      setChats((prev) => {
        const updated = [...prev, ...list]
        return updated
      })
      void preloadChatsData(list, { delayMs: 150 })

      const newPageInfo = info || { hasNextPage: false, endCursor: null }
      setPageInfo(newPageInfo)
    } catch (err) {
    } finally {
      setLoadingMore(false)
      loadingMoreRef.current = false
    }
  }, [token, pageInfo.hasNextPage, pageInfo.endCursor, chats.length, preloadChatsData])

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const handleScroll = () => {
      const scrollTop = el.scrollTop
      const scrollHeight = el.scrollHeight
      const clientHeight = el.clientHeight
      const distanceToBottom = scrollHeight - scrollTop - clientHeight
      const threshold = 80

      if (!pageInfo.hasNextPage || loadingMoreRef.current) return
      if (distanceToBottom < threshold) loadMore()
    }
    el.addEventListener('scroll', handleScroll)
    return () => {
      el.removeEventListener('scroll', handleScroll)
    }
  }, [pageInfo.hasNextPage, pageInfo.endCursor, loadMore])

  const visibleChats = useMemo(() => {
    if (chatFilter === 'hide-completed') {
      const base = chats.filter((chat) => !chat.isHidden)
      return base.filter((chat) => !isChatCompleted(chat))
    }
    return chats
  }, [chats, chatFilter, chatStateById])

  useEffect(() => {
    if (!selectedChatId && visibleChats.length > 0) {
      setSelectedChatId(visibleChats[0].id)
      return
    }
    if (selectedChatId && !visibleChats.some((c) => c.id === selectedChatId)) {
      setSelectedChatId(visibleChats.length > 0 ? visibleChats[0].id : null)
    }
  }, [chatFilter, visibleChats, selectedChatId])

  // Фоновая предзагрузка сообщений для списка чатов:
  // нужна, чтобы статус и buyerName определялись ещё до открытия конкретного чата.
  useEffect(() => {
    if (!token || chats.length === 0) return
    let cancelled = false
    void preloadChatsData(chats, {
      delayMs: 500,
      shouldCancel: () => cancelled,
    })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, chats])

  const loadMessagesForChat = async (chat) => {
    if (!token || !chat?.id) return
    const chatId = chat.id
    const state = chatStateById[chatId]
    if (state && state.loaded && !state.error) return
    setChatStateById((prev) => ({
      ...prev,
      [chatId]: {
        ...(prev[chatId] || {}),
        loading: true,
        error: null,
        messages: prev[chatId]?.messages || [],
        loaded: false,
      },
    }))
    try {
      const { list, itemTitle, itemImageUrl, buyerSupercellEmail } = await fetchDealChatMessages(
        token,
        chat.dealId || null,
        chatId
      )

      applyLoadedChatData(chat, list, itemTitle, itemImageUrl, buyerSupercellEmail)
    } catch (err) {
      setChatStateById((prev) => ({
        ...prev,
        [chatId]: {
          loading: false,
          error: err instanceof Error ? err.message : 'Ошибка загрузки чата',
          messages: [],
          loaded: true,
        },
      }))
    }
  }

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

  const selectedChat = chats.find((c) => c.id === selectedChatId) || null
  const selectedChatState = selectedChat ? chatStateById[selectedChat.id] || { loading: false, error: null, messages: [] } : null
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
  const selectedChatIsSupercell = isSupercellCategory(selectedChat?.category || '')
  const selectedChatCanUseSupercell = selectedChatIsSupercell && moduleSupercellEnabled
  const currentItemImageUrl =
    selectedChat && (selectedChatState?.itemImageUrl || selectedChat.itemImageUrl || null)
  const currentItemTitle =
    selectedChat && (selectedChatState?.itemTitle || selectedChat.itemTitle || '')

  useEffect(() => {
    if (!token || !selectedChat?.id) return
    let cancelled = false
    let timerId = null

    const refreshSelectedChat = async () => {
      try {
        const { list, itemTitle, itemImageUrl, buyerSupercellEmail } = await fetchDealChatMessages(
          token,
          selectedChat.dealId || null,
          selectedChat.id
        )
        if (cancelled) return
        applyLoadedChatData(selectedChat, list, itemTitle, itemImageUrl, buyerSupercellEmail)
      } catch (_err) {
        if (cancelled) return
      } finally {
        if (!cancelled) {
          timerId = setTimeout(refreshSelectedChat, 15000)
        }
      }
    }

    timerId = setTimeout(refreshSelectedChat, 15000)
    return () => {
      cancelled = true
      if (timerId) clearTimeout(timerId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, selectedChat?.id, selectedChat?.dealId])

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

  const getStatusLabel = (status) => {
    const s = String(status || '').toUpperCase()
    if (!s) return '—'
    if (s === 'PAID') return 'Выполнение'
    if (s === 'SENT') return 'Отправлено'
    if (s === 'CONFIRMED') return 'Завершено'
    if (s === 'ROLLED_BACK') return 'Возврат'
    if (s === 'PENDING') return 'Ожидание'
    return s
  }

  const handleSendMessage = async (chat) => {
    if (!token || !chat?.id) return
    const chatId = chat.id
    const text = (draftByChatId[chatId] || '').trim()
    if (!text) return
    await sendDealChatMessage(token, {
      dealId: chat.dealId || null,
      chatId,
      text,
    })
    const newMessage = {
      id: `local-${Date.now()}`,
      text,
      createdAt: new Date().toISOString(),
      imageUrl: null,
      user: { username: 'Levkaster' },
    }
    setChatStateById((prev) => ({
      ...prev,
      [chatId]: {
        ...(prev[chatId] || { loading: false, error: null, loaded: true, messages: [] }),
        messages: [...(prev[chatId]?.messages || []), newMessage],
      },
    }))
    setDraftByChatId((prev) => ({ ...prev, [chatId]: '' }))
  }

  const appendLocalMessageForChat = (chat, text) => {
    if (!chat?.id) return
    const trimmed = String(text || '').trim()
    if (!trimmed) return
    const newMessage = {
      id: `local-${Date.now()}`,
      text: trimmed,
      createdAt: new Date().toISOString(),
      imageUrl: null,
      user: { username: OUR_USERNAME },
    }
    setChatStateById((prev) => ({
      ...prev,
      [chat.id]: {
        ...(prev[chat.id] || { loading: false, error: null, loaded: true, messages: [] }),
        messages: [...(prev[chat.id]?.messages || []), newMessage],
      },
    }))
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
    try {
      const data = await requestSupercellCode(token, {
        dealId: selectedChat.dealId || null,
        chatId: selectedChat.id,
        email,
        category: selectedChat.category || '',
      })
      saveManualEmailForChat(selectedChat.id, email)
      if (data?.chatMessage) {
        appendLocalMessageForChat(selectedChat, data.chatMessage)
      }
      closeRequestCodeModal()
    } catch (err) {
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

  const toggleHiddenForChat = async (chat) => {
    if (!token || !chat?.id) return
    const chatId = chat.id
    const currentlyHidden = Boolean(chat.isHidden)
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
    } catch (err) { }
  }

  return (
    <div className="tab-page tab-page--chat">
      <div className="tab-grid">
        <section className="card">
          <h2 className="card-title">Список чатов</h2>

          {!hasToken && (
            <p className="card-text">
              Укажите токен во вкладке «Токен», чтобы увидеть чаты.
            </p>
          )}

          {hasToken && loading && (
            <p className="card-text">Загружаем чаты с Playerok…</p>
          )}

          {hasToken && !loading && error && (
            <p className="card-text card-text--error">{error}</p>
          )}

          {hasToken && !loading && !error && chats.length === 0 && (
            <p className="card-text">
              Чатов пока нет.
            </p>
          )}

          {hasToken && !loading && !error && chats.length > 0 && (
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
                  aria-label="Скрыть выполненные чаты"
                  title="Скрыть выполненные"
                >
                  <span aria-hidden="true">✓</span>
                </button>
              </div>
              <div
                ref={listRef}
                className="chat-list"
              >
                {visibleChats.map((chat) => {
                  const isActive = chat.id === selectedChatId
                  const unread = typeof chat.unreadCount === 'number' ? chat.unreadCount : null

                  // Определение категории с логированием
                  // КРИТИЧНО: категория должна быть всегда определена
                  let category = null
                  let categorySource = null

                  // 1. Пытаемся взять категорию из chat.category
                  if (chat.category && typeof chat.category === 'string') {
                    const trimmed = chat.category.trim()
                    if (trimmed) {
                      category = trimmed
                      categorySource = 'chat.category'
                    }
                  }

                  // 2. Если категории нет, пытаемся извлечь из itemTitle
                  if (!category && chat.itemTitle && typeof chat.itemTitle === 'string') {
                    const title = chat.itemTitle.trim()
                    if (title) {
                      // Список известных игр для поиска в названии
                      const commonGames = [
                        'Clash of Clans', 'Clash Royale', 'Brawl Stars', 'Hay Day', 'Boom Beach',
                        'PUBG', 'PUBG Mobile', 'Call of Duty', 'Free Fire', 'Fortnite',
                        'CS:GO', 'CS2', 'Counter-Strike', 'Dota 2', 'League of Legends',
                        'Valorant', 'Apex Legends', 'Genshin Impact', 'Honkai', 'Star Rail',
                        'World of Tanks', 'World of Warships', 'War Thunder',
                        'Minecraft', 'Roblox', 'Among Us', 'Fall Guys', 'Mobile Legends',
                        'Wild Rift', 'Arena of Valor', 'Heroes of the Storm', 'Overwatch'
                      ]
                      for (const game of commonGames) {
                        if (title.toLowerCase().includes(game.toLowerCase())) {
                          category = game
                          categorySource = 'itemTitle (common games)'
                          break
                        }
                      }

                      // Если не нашли известную игру, используем первые слова названия
                      if (!category) {
                        const words = title.split(/\s+/).filter(w => w.length > 0)
                        if (words.length > 0) {
                          let candidate = words.slice(0, 3).join(' ')
                          if (candidate.length > 50) {
                            candidate = candidate.substring(0, 50).trim()
                          }
                          if (candidate) {
                            category = candidate
                            categorySource = 'itemTitle (first words)'
                          }
                        }
                      }
                    }
                  }

                  // 3. Если категория всё ещё не определена, это критическая ошибка
                  // Категория должна быть всегда определена на бэкенде
                  if (!category || (typeof category === 'string' && !category.trim())) {
                    // Используем категорию из chat.category, даже если она пустая - это ошибка бэкенда
                    category = (chat.category && String(chat.category).trim()) || 'Категория не определена'
                    categorySource = 'error fallback'
                  }

                  const statusLabel = getStatusLabel(getDerivedChatStatus(chat))
                  const metaLine = category ? `${category} · ${statusLabel}` : statusLabel

                  const buyerNameToDisplay = chat.buyerName && chat.buyerName.trim() ? chat.buyerName.trim() : null

                  // Пытаемся извлечь имя из сообщений, если buyerName отсутствует
                  let displayName = buyerNameToDisplay
                  if (!displayName) {
                    const chatState = chatStateById[chat.id]
                    const messages = chatState?.messages || []
                    for (const msg of messages) {
                      const msgUser = msg.user
                      if (msgUser && msgUser.username && msgUser.username !== OUR_USERNAME) {
                        displayName = msgUser.username
                        break
                      }
                    }
                  }

                  return (
                    <button
                      key={chat.id}
                      type="button"
                      className={
                        'chat-list__item' + (isActive ? ' chat-list__item--active' : '')
                      }
                      onClick={() => {
                        setSelectedChatId(chat.id)
                      }}
                    >
                      <div className="chat-list__title">
                        {displayName || 'Покупатель'}
                      </div>
                      <div className="chat-list__meta">
                        <span className="chat-list__buyer">
                          {category}
                        </span>
                        {unread != null && unread > 0 && (
                          <span className="chat-list__badge">
                            {unread}
                          </span>
                        )}
                      </div>
                      <div className="chat-list__preview">
                        {statusLabel}
                      </div>
                      <div className="chat-list__time">
                        {formatTime(chat.lastMessageCreatedAt)}
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
          {hasToken && selectedChat && (
            <>
              <div className="chat-header-row">
                <div className="card-text chat-header-row__info">
                  <div className="chat-header-row__text">
                    <strong>Чат по товару</strong>
                    {(() => {
                      // Пытаемся получить buyerName из разных источников
                      let buyerName = selectedChat.buyerName
                      if (!buyerName) {
                        const chatState = chatStateById[selectedChat.id]
                        const messages = chatState?.messages || []
                        for (const msg of messages) {
                          const msgUser = msg.user
                          if (msgUser && msgUser.username && msgUser.username !== OUR_USERNAME) {
                            buyerName = msgUser.username
                            break
                          }
                        }
                      }
                      return buyerName ? (
                        <span className="chat-header-row__buyer">
                          Покупатель: {buyerName}
                        </span>
                      ) : null
                    })()}
                  </div>
                </div>
                <button
                  type="button"
                  className="chat-header-row__hide-btn"
                  onClick={() => toggleHiddenForChat(selectedChat)}
                >
                  {selectedChat.isHidden ? 'Показать чат' : 'Скрыть чат'}
                </button>
              </div>
              <div className="chat-item-card">
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
                  {(() => {
                    // Пытаемся получить buyerName из разных источников
                    let buyerName = selectedChat.buyerName
                    if (!buyerName) {
                      const chatState = chatStateById[selectedChat.id]
                      const messages = chatState?.messages || []
                      for (const msg of messages) {
                        const msgUser = msg.user
                        if (msgUser && msgUser.username && msgUser.username !== OUR_USERNAME) {
                          buyerName = msgUser.username
                          break
                        }
                      }
                    }
                    return buyerName ? (
                      <div className="chat-item-card__buyer">
                        Покупатель: {buyerName}
                      </div>
                    ) : null
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
              {selectedChatState?.loading && (
                <p className="card-text">Загружаем чат…</p>
              )}
              {!selectedChatState?.loading && selectedChatState?.error && (
                <p className="card-text card-text--error">
                  {selectedChatState.error}
                </p>
              )}
              {!selectedChatState?.loading &&
                !selectedChatState?.error &&
                (selectedChatState?.messages || []).length === 0 && (
                  <p className="card-text">
                    Сообщений в этом чате пока нет.
                  </p>
                )}
              {!selectedChatState?.loading &&
                !selectedChatState?.error &&
                (selectedChatState?.messages || []).length > 0 && (
                  <div className="chat-messages">
                    {(() => {
                      const messagesToRender = selectedChatState.messages || []
                      return messagesToRender.map((m) => {
                        const timeText = formatTime(m.createdAt)
                        const isSystem = m.text ? isSystemMessage(m.text) : false
                        const fromBuyer = isFromBuyer(m)
                        // Для системных сообщений используем только класс system, иначе определяем по автору
                        const messageClass = isSystem
                          ? 'chat-message chat-message--system'
                          : `chat-message ${fromBuyer ? 'chat-message--buyer' : 'chat-message--seller'}`
                        return (
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
                                  <img
                                    src={m.imageUrl}
                                    alt="Изображение в чате"
                                    className="chat-message__image"
                                  />
                                </div>
                              ) : null}
                              {!m.text && !m.imageUrl && (
                                <div className={isSystem ? "chat-message__text chat-message__placeholder" : "chat-message__text-wrapper"}>
                                  {!isSystem ? (
                                    <>
                                      <div className="chat-message__text chat-message__placeholder">
                                        Картинка
                                      </div>
                                      {timeText && (
                                        <div className="chat-message__time">
                                          {timeText}
                                        </div>
                                      )}
                                    </>
                                  ) : (
                                    "Картинка"
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
                      })
                    })()}
                  </div>
                )}

              {!selectedChatState?.loading && !selectedChatState?.error && (
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
                              onClick={async () => {
                                if (!selectedChat || !token) return
                                try {
                                  await sendDealChatMessage(token, {
                                    dealId: selectedChat.dealId || null,
                                    chatId: selectedChat.id,
                                    text: cmd.text,
                                  })
                                  appendLocalMessageForChat(selectedChat, cmd.text)
                                } catch (err) { }
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
    </div>
  )
}

