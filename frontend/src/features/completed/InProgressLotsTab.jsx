import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchInProgressDeals,
  fetchDealChatMessages,
  sendDealChatMessage,
  loadCategoryCommandsList,
  cancelDeal,
  confirmDeal,
} from '../../services/playerokApi'

// Вкладка "Выполнение" — показывает актуальные сделки со страницы sales
// напрямую с Playerok (без БД) только со статусом PAID.
export function InProgressLotsTab({ token }) {
  const [sales, setSales] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [chatsByDealId, setChatsByDealId] = useState({}) // { [dealId]: { loading, error, messages, loaded, buyerSupercellEmail } }
  const [fullscreenImage, setFullscreenImage] = useState(null)
  const [showFullChatByDealId, setShowFullChatByDealId] = useState({}) // по умолчанию только сообщения по текущей сделке
  const [draftByDealId, setDraftByDealId] = useState({}) // текст нового сообщения по сделке
  const [categoryCommandsByName, setCategoryCommandsByName] = useState({}) // { [category]: [{ id, label, text }] }
  const [cancelModal, setCancelModal] = useState({ open: false, deal: null })
  const [cancelState, setCancelState] = useState({ loading: false, error: null })
  const [confirmModal, setConfirmModal] = useState({ open: false, deal: null })
  const [confirmState, setConfirmState] = useState({ loading: false, error: null })
  const READ_IDS_STORAGE_KEY = 'playerok-inprogress-read-message-ids'
  const EMAIL_SENT_STORAGE_KEY = 'playerok-inprogress-email-invalid-sent'
  const [readMessageIds, setReadMessageIds] = useState(() => {
    try {
      const raw = localStorage.getItem(READ_IDS_STORAGE_KEY)
      if (!raw) return {}
      const parsed = JSON.parse(raw)
      return typeof parsed === 'object' && parsed !== null ? parsed : {}
    } catch {
      return {}
    }
  })

  const [emailSentByDealId, setEmailSentByDealId] = useState(() => {
    try {
      const raw = localStorage.getItem(EMAIL_SENT_STORAGE_KEY)
      if (!raw) return {}
      const parsed = JSON.parse(raw)
      return typeof parsed === 'object' && parsed !== null ? parsed : {}
    } catch {
      return {}
    }
  })

  const [productSettingsByKey, setProductSettingsByKey] = useState(() => ({})) // { [productKey]: { loading, error, settings } }

  const hasToken = Boolean(token)
  const initialDealsLoadTokenRef = useRef(null)

  const OUR_USERNAME = 'Levkaster'
  const isFromBuyer = (m) => (m.user?.username || '').trim() !== OUR_USERNAME
  const markMessageAsRead = (messageId) => {
    if (!messageId) return
    setReadMessageIds((prev) => {
      if (prev[messageId]) return prev
      const next = { ...prev, [messageId]: true }
      try {
        localStorage.setItem(READ_IDS_STORAGE_KEY, JSON.stringify(next))
      } catch (_e) { /* quota or disabled */ }
      return next
    })
  }

  const markEmailMessageSent = (dealId) => {
    if (!dealId) return
    setEmailSentByDealId((prev) => {
      if (prev[dealId]) return prev
      const next = { ...prev, [dealId]: true }
      try {
        localStorage.setItem(EMAIL_SENT_STORAGE_KEY, JSON.stringify(next))
      } catch (_e) {
        // quota or disabled
      }
      return next
    })
  }

  const isEmailValid = (email) => {
    if (!email) return false
    const value = String(email).trim()
    if (!value) return false
    // Простая, но более строгая проверка, чем просто includes('@')
    const simpleRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    return simpleRegex.test(value)
  }

  useEffect(() => {
    if (!token) {
      setSales([])
      setError(null)
      initialDealsLoadTokenRef.current = null
      return
    }
    // React StrictMode (dev) может монтировать компонент дважды и вызвать эффект повторно.
    if (initialDealsLoadTokenRef.current === token) return
    initialDealsLoadTokenRef.current = token
    let cancelled = false

    const loadDeals = async () => {
      setLoading(true)
      setError(null)
      try {
        const data = await fetchInProgressDeals(token)
        if (cancelled) return
        const list = Array.isArray(data?.list) ? data.list : []
        setSales(list)
        setLoading(false)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Ошибка загрузки продаж')
        setSales([])
        setLoading(false)
      }
    }

    loadDeals()
    return () => {
      cancelled = true
    }
  }, [token])

  const reloadDeals = async () => {
    if (!token) return
    setLoading(true)
    setError(null)
    try {
      const data = await fetchInProgressDeals(token)
      const list = Array.isArray(data?.list) ? data.list : []
      setSales(list)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки продаж')
      setSales([])
    } finally {
      setLoading(false)
    }
  }

  // Отображаем только сделки со статусом PAID.
  const inProgressSales = useMemo(() => {
    return sales.filter(
      (s) => String(s.status || '').toUpperCase() === 'PAID'
    )
  }, [sales])

  const [selectedCategory, setSelectedCategory] = useState('ALL')

  // Сделки, сгруппированные по категории (категории отсортированы, внутри категории — по названию товара).
  const salesByCategory = useMemo(() => {
    const grouped = new Map()
    for (const item of inProgressSales) {
      const cat = String(item.category ?? '').trim() || 'Без категории'
      if (!grouped.has(cat)) grouped.set(cat, [])
      grouped.get(cat).push(item)
    }
    const categories = [...grouped.keys()].sort((a, b) =>
      a.localeCompare(b, 'ru')
    )
    const result = []
    for (const cat of categories) {
      const list = grouped.get(cat)
      list.sort((a, b) =>
        (a.productTitle || '').localeCompare(b.productTitle || '', 'ru')
      )
      result.push({ category: cat, deals: list })
    }
    return result
  }, [inProgressSales])

  const getCategoryColorKey = (name) => {
    const n = (name || '').trim()
    if (!n) return 'default'
    let hash = 0
    for (let i = 0; i < n.length; i += 1) {
      hash = (hash * 31 + n.charCodeAt(i)) | 0
    }
    const palette = ['blue', 'green', 'orange', 'purple', 'pink']
    const idx = Math.abs(hash) % palette.length
    return palette[idx]
  }

  const visibleSalesByCategory = useMemo(() => {
    if (selectedCategory === 'ALL') return salesByCategory
    return salesByCategory.filter((c) => c.category === selectedCategory)
  }, [salesByCategory, selectedCategory])

  useEffect(() => {
    if (!token || inProgressSales.length === 0) return
    const invalidDeals = inProgressSales.filter((s) => {
      const email = (chatsByDealId?.[s.id]?.buyerSupercellEmail || s.buyerSupercellEmail || '').trim()
      return email && !isEmailValid(email)
    })
    if (invalidDeals.length === 0) return

    let cancelled = false

    const loadMissingSettings = async () => {
      const uniqueKeys = Array.from(
        new Set(
          invalidDeals
            .map((d) => d.productKey)
            .filter((k) => typeof k === 'string' && k.trim() !== '')
        )
      )
      for (const productKey of uniqueKeys) {
        if (!productSettingsByKey[productKey]?.loading && !productSettingsByKey[productKey]?.settings) {
          setProductSettingsByKey((prev) => ({
            ...prev,
            [productKey]: { ...(prev[productKey] || {}), loading: true, error: null },
          }))
          try {
            const { loadProductSettings } = await import('../../services/playerokApi')
            const data = await loadProductSettings(token, productKey)
            if (cancelled) return
            setProductSettingsByKey((prev) => ({
              ...prev,
              [productKey]: {
                loading: false,
                error: null,
                settings:
                  data && typeof data.settings === 'object' && data.settings !== null
                    ? data.settings
                    : {},
              },
            }))
          } catch (err) {
            if (cancelled) return
            setProductSettingsByKey((prev) => ({
              ...prev,
              [productKey]: {
                loading: false,
                error: err instanceof Error ? err.message : 'Ошибка загрузки настроек',
                settings: {},
              },
            }))
          }
        }
      }
    }

    loadMissingSettings()

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, inProgressSales, chatsByDealId])

  useEffect(() => {
    if (!token || inProgressSales.length === 0) return
    const process = async () => {
      for (const deal of inProgressSales) {
        if (emailSentByDealId[deal.id]) continue
        const email = (chatsByDealId?.[deal.id]?.buyerSupercellEmail || deal.buyerSupercellEmail || '').trim()
        if (!email || isEmailValid(email)) continue
        const productKey = typeof deal.productKey === 'string' ? deal.productKey : ''
        if (!productKey) continue
        const entry = productSettingsByKey[productKey]
        if (!entry || entry.loading || entry.error || !entry.settings) continue
        const ev = entry.settings.emailValidation || {}
        const enabled = Boolean(ev.enabled)
        const text =
          typeof ev.invalidEmailMessage === 'string' ? ev.invalidEmailMessage.trim() : ''
        if (!enabled || !text) continue
        try {
          await sendMessageForDeal(deal, text)
          markEmailMessageSent(deal.id)
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error('Failed to send auto email-validation message', err)
        }
      }
    }
    process()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, inProgressSales, productSettingsByKey, emailSentByDealId, chatsByDealId])

  useEffect(() => {
    if (!token) {
      setCategoryCommandsByName({})
      return
    }
    let cancelled = false
    loadCategoryCommandsList(token)
      .then(({ list }) => {
        if (cancelled) return
        const map = {}
        for (const entry of list || []) {
          const cat = (entry && entry.category) || ''
          if (!cat) continue
          map[cat] = Array.isArray(entry.commands) ? entry.commands : []
        }
        setCategoryCommandsByName(map)
      })
      .catch(() => {
        if (cancelled) return
        setCategoryCommandsByName({})
      })
    return () => {
      cancelled = true
    }
  }, [token])

  // Сообщения после последнего {{ITEM_PAID}} (остальное свернуто).
  const getMessagesAfterLastBoundary = (messages) => {
    if (!messages || messages.length === 0) return []
    const sorted = [...messages].sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0
      return ta - tb
    })
    let lastItemPaidIndex = -1
    for (let i = 0; i < sorted.length; i++) {
      if (sorted[i].text && sorted[i].text.trim() === '{{ITEM_PAID}}') {
        lastItemPaidIndex = i
      }
    }
    return lastItemPaidIndex < 0 ? sorted : sorted.slice(lastItemPaidIndex + 1)
  }

  const allDealsForChats = useMemo(() => inProgressSales, [inProgressSales])
  useEffect(() => {
    if (!token || allDealsForChats.length === 0) return
    let cancelled = false

    const loadChats = async () => {
      for (let i = 0; i < allDealsForChats.length; i += 1) {
        const deal = allDealsForChats[i]
        const dealId = deal.id
        if (!dealId || chatsByDealId[dealId]?.loaded) continue
        setChatsByDealId((prev) => {
          if (prev[dealId]?.loaded) return prev
          return { ...prev, [dealId]: { loading: true, error: null, messages: [], loaded: false, buyerSupercellEmail: null } }
        })
        try {
          const { list, buyerSupercellEmail } = await fetchDealChatMessages(token, dealId, deal.chatId)
          if (cancelled) return
          const sorted = [...(list || [])].sort((a, b) => {
            const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0
            const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0
            return ta - tb
          })
          setChatsByDealId((prev) => ({
            ...prev,
            [dealId]: { loading: false, error: null, messages: sorted, loaded: true, buyerSupercellEmail: buyerSupercellEmail ?? null },
          }))
        } catch (err) {
          if (cancelled) return
          setChatsByDealId((prev) => ({
            ...prev,
            [dealId]: {
              loading: false,
              error: err instanceof Error ? err.message : 'Ошибка загрузки чата',
              messages: [],
              loaded: true,
              buyerSupercellEmail: null,
            },
          }))
        }
      }
    }

    loadChats()

    return () => {
      cancelled = true
    }
    // chatsByDealId намеренно не в deps — не перезапускаем при обновлении чатов
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, allDealsForChats])

  // Периодическое обновление чатов, чтобы новые сообщения подтягивались без перезагрузки страницы.
  useEffect(() => {
    if (!token || allDealsForChats.length === 0) return
    let cancelled = false
    let inFlight = false
    let timerId = null

    const refreshChats = async () => {
      if (inFlight) return
      inFlight = true
      for (let i = 0; i < allDealsForChats.length; i += 1) {
        const deal = allDealsForChats[i]
        const dealId = deal.id
        if (!dealId) continue
        try {
          const { list, buyerSupercellEmail } = await fetchDealChatMessages(token, dealId, deal.chatId)
          if (cancelled) return
          const sorted = [...(list || [])].sort((a, b) => {
            const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0
            const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0
            return ta - tb
          })
          setChatsByDealId((prev) => ({
            ...prev,
            [dealId]: {
              ...(prev[dealId] || { loading: false, error: null, loaded: true, messages: [], buyerSupercellEmail: null }),
              loading: false,
              error: null,
              messages: sorted,
              loaded: true,
              buyerSupercellEmail: buyerSupercellEmail ?? prev[dealId]?.buyerSupercellEmail ?? null,
            },
          }))
        } catch (_err) {
          if (cancelled) return
          // Ошибки периодического обновления игнорируем, чтобы не перезаписывать уже загруженный чат
        }
      }
      inFlight = false

      // Планируем следующий проход после паузы (вместо setInterval, чтобы не копить вызовы)
      if (!cancelled) {
        timerId = setTimeout(refreshChats, 15000)
      }
    }

    // Стартуем отложенно, чтобы не мешать первичной загрузке
    timerId = setTimeout(refreshChats, 15000)
    return () => {
      cancelled = true
      if (timerId) clearTimeout(timerId)
    }
  }, [token, allDealsForChats])

  const sendMessageForDeal = async (deal, text) => {
    const trimmed = (text || '').trim()
    if (!trimmed) return
    await sendDealChatMessage(token, {
      dealId: deal.id,
      chatId: deal.chatId || null,
      text: trimmed,
    })
    const newMessage = {
      id: `local-${Date.now()}`,
      text: trimmed,
      createdAt: new Date().toISOString(),
      imageUrl: null,
      user: { username: 'Levkaster' },
    }
    setChatsByDealId((prev) => ({
      ...prev,
      [deal.id]: {
        ...(prev[deal.id] || { loading: false, error: null, messages: [], loaded: true }),
        messages: [...(prev[deal.id]?.messages || []), newMessage],
      },
    }))
  }

  return (
    <div className="tab-page">
      <div className="tab-page-header">
        <h1>Выполнение</h1>
      </div>

      <div className="tab-grid">
        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <h2 className="card-title">Сделки в выполнении</h2>

          {!hasToken && (
            <p className="card-text">
              Укажите токен во вкладке «Токен», чтобы увидеть сделки в выполнении.
            </p>
          )}

          {hasToken && loading && (
            <p className="card-text">Загружаем продажи с Playerok...</p>
          )}

          {hasToken && !loading && error && (
            <p className="card-text card-text--error">
              Ошибка при загрузке продаж: {error}
            </p>
          )}

          {hasToken && !loading && !error && inProgressSales.length === 0 && (
            <p className="card-text">
              Сделок со статусом «Выполнение» не найдено.
            </p>
          )}

          {hasToken && !loading && !error && inProgressSales.length > 0 && (
            <>
              <p className="card-text active-lots-total">
                Всего сделок в выполнении: <strong>{inProgressSales.length}</strong>
              </p>
              <div className="deal-category-filter">
                <button
                  type="button"
                  className={
                    selectedCategory === 'ALL'
                      ? 'deal-category-filter__chip deal-category-filter__chip--active'
                      : 'deal-category-filter__chip'
                  }
                  onClick={() => setSelectedCategory('ALL')}
                >
                  Все категории
                </button>
                {salesByCategory.map(({ category }) => (
                  <button
                    key={category}
                    type="button"
                    className={
                      selectedCategory === category
                        ? 'deal-category-filter__chip deal-category-filter__chip--active'
                        : 'deal-category-filter__chip'
                    }
                    onClick={() => setSelectedCategory(category)}
                  >
                    {category}
                  </button>
                ))}
              </div>
              <div className="deal-chat-list">
                {visibleSalesByCategory.map(({ category, deals }) => (
                  <div key={category} className="deal-chat-list__category">
                    {deals.map((item) => {
                      const chat = chatsByDealId[item.id] || {
                        loading: true,
                        error: null,
                        messages: [],
                      }
                      const showFull = showFullChatByDealId[item.id]
                      const afterLastBoundary = getMessagesAfterLastBoundary(chat.messages)
                      const displayedMessages = showFull ? chat.messages : afterLastBoundary
                      const hiddenCount = Math.max(
                        0,
                        (chat.messages?.length || 0) - (afterLastBoundary.length || 0)
                      )
                      const hasHiddenMessages = hiddenCount > 1
                      const email = (chat?.buyerSupercellEmail || item.buyerSupercellEmail || '').trim()
                      const hasEmail = Boolean(email)
                      const emailIsValid = hasEmail && isEmailValid(email)
                      return (
                        <div key={item.id} className="deal-chat-row">
                          <div className="deal-chat-row__info">
                            <div className="deal-chat-row__title">
                              {item.productTitle || 'Товар'}
                            </div>
                            <div
                              className={`deal-chat-row__category deal-chat-row__category--${getCategoryColorKey(
                                category
                              )}`}
                            >
                              {category}
                            </div>
                            <div className="deal-chat-row__meta">
                              <span className="deal-chat-row__buyer">
                                Покупатель: {item.buyerName || '—'}
                              </span>
                              {hasEmail && (
                                <div
                                  className={
                                    'deal-chat-row__email-box ' +
                                    (emailIsValid
                                      ? 'deal-chat-row__email-box--valid'
                                      : 'deal-chat-row__email-box--invalid')
                                  }
                                >
                                  <span className="deal-chat-row__email-label">
                                    Почта Supercell ID:
                                  </span>
                                  <span className="deal-chat-row__email-value">
                                    {email}
                                  </span>
                                </div>
                              )}
                              <span className="deal-chat-row__price">
                                {item.price != null && item.price > 0
                                  ? `${Number(item.price).toLocaleString('ru-RU')} ₽`
                                  : '—'}
                              </span>
                            </div>
                            <div className="deal-chat-row__global-commands">
                                <button
                                  type="button"
                                  className="deal-chat-row__command-btn deal-chat-row__command-btn--success"
                                  onClick={() => {
                                    setConfirmState({ loading: false, error: null })
                                    setConfirmModal({ open: true, deal: item })
                                  }}
                                >
                                  Завершить сделку
                                </button>
                                <button
                                  type="button"
                                  className="deal-chat-row__command-btn deal-chat-row__command-btn--danger"
                                  onClick={() => {
                                    setCancelState({ loading: false, error: null })
                                    setCancelModal({ open: true, deal: item })
                                  }}
                                >
                                  Отменить сделку
                                </button>
                              </div>
                            {(categoryCommandsByName[category] || []).length > 0 && (
                              <div className="deal-chat-row__commands">
                                {categoryCommandsByName[category].map((cmd) => (
                                  <button
                                    key={cmd.id || cmd.label}
                                    type="button"
                                    className="deal-chat-row__command-btn"
                                    onClick={async () => {
                                      try {
                                        await sendMessageForDeal(item, cmd.text || cmd.label)
                                      } catch (err) {
                                        // eslint-disable-next-line no-console
                                        console.error(err)
                                      }
                                    }}
                                  >
                                    {cmd.label || cmd.text || 'Команда'}
                                  </button>
                                ))}
                              </div>
                            )}
                          </div>
                          <div className="deal-chat-row__chat">
                            <div className="deal-chat-row__chat-body">
                              {chat.loading && (
                                <p className="card-text">Загружаем чат…</p>
                              )}
                              {!chat.loading && chat.error && (
                                <p className="card-text card-text--error">
                                  {chat.error}
                                </p>
                              )}
                              {!chat.loading &&
                                !chat.error &&
                                chat.messages.length === 0 && (
                                  <p className="card-text">
                                    Сообщений в этом чате пока нет.
                                  </p>
                                )}
                              {!chat.loading &&
                                !chat.error &&
                                chat.messages.length > 0 && (
                                  <>
                                    {(hasHiddenMessages || showFull) && (
                                      <div className="deal-chat-row__toggle">
                                      <button
                                        type="button"
                                        className="deal-chat-row__toggle-btn"
                                        onClick={() =>
                                          setShowFullChatByDealId((prev) => ({
                                            ...prev,
                                            [item.id]: !prev[item.id],
                                          }))
                                        }
                                      >
                                        {showFull
                                          ? 'Только этот товар'
                                          : 'Показать весь чат'}
                                      </button>
                                      {!showFull && hasHiddenMessages && (
                                        <span className="deal-chat-row__toggle-hint">
                                          (показано {displayedMessages.length} из {chat.messages.length})
                                        </span>
                                      )}
                                    </div>
                                  )}
                                  <div className="chat-messages">
                                    {displayedMessages.map((m) => {
                                      const ts = m.createdAt
                                        ? new Date(m.createdAt)
                                        : null
                                      const timeText = ts
                                        ? ts.toLocaleString('ru-RU', {
                                          day: '2-digit',
                                          month: '2-digit',
                                          year: 'numeric',
                                          hour: '2-digit',
                                          minute: '2-digit',
                                        })
                                        : ''
                                      const fromBuyer = isFromBuyer(m)
                                      const isNew = fromBuyer && !readMessageIds[m.id]
                                      return (
                                        <div
                                          key={m.id}
                                          className={'chat-message' + (isNew ? ' chat-message--new' : '')}
                                          onMouseEnter={() => markMessageAsRead(m.id)}
                                          role="presentation"
                                        >
                                          <div className="chat-message__meta">
                                            <span className="chat-message__author">
                                              {m.user?.username ||
                                                item.buyerName ||
                                                'Неизвестный пользователь'}
                                            </span>
                                            {timeText && (
                                              <span className="chat-message__time">
                                                {timeText}
                                              </span>
                                            )}
                                          </div>
                                          {m.text ? (
                                            <div className="chat-message__text">
                                              {m.text}
                                            </div>
                                          ) : null}
                                          {m.imageUrl ? (
                                            <div className="chat-message__image-wrap">
                                              <button
                                                type="button"
                                                className="chat-message__image-btn"
                                                onClick={() => setFullscreenImage(m.imageUrl)}
                                                aria-label="Открыть изображение на весь экран"
                                              >
                                                <img
                                                  src={m.imageUrl}
                                                  alt="Изображение в чате"
                                                  className="chat-message__image"
                                                />
                                              </button>
                                            </div>
                                          ) : null}
                                          {!m.text && !m.imageUrl && (
                                            <div className="chat-message__text chat-message__placeholder">
                                              Картинка
                                            </div>
                                          )}
                                        </div>
                                      )
                                    })}
                                  </div>
                                </>
                              )}
                            </div>
                            {!chat.loading && !chat.error && (
                              <form
                                className="deal-chat-row__input"
                                onSubmit={async (e) => {
                                  e.preventDefault()
                                  const draft = (draftByDealId[item.id] || '').trim()
                                  if (!draft) return
                                  try {
                                    await sendMessageForDeal(item, draft)
                                    setDraftByDealId((prev) => ({ ...prev, [item.id]: '' }))
                                  } catch (err) {
                                    // Можно вывести уведомление, пока просто в консоль
                                    // eslint-disable-next-line no-console
                                    console.error(err)
                                  }
                                }}
                              >
                                <input
                                  type="text"
                                  className="deal-chat-row__input-field"
                                  placeholder="Написать сообщение..."
                                  value={draftByDealId[item.id] || ''}
                                  onChange={(e) =>
                                    setDraftByDealId((prev) => ({
                                      ...prev,
                                      [item.id]: e.target.value,
                                    }))
                                  }
                                />
                                <button
                                  type="submit"
                                  className="deal-chat-row__input-btn"
                                  disabled={!token || !(draftByDealId[item.id] || '').trim()}
                                >
                                  Отправить
                                </button>
                              </form>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            </>
          )}

          {fullscreenImage && (
            <div
              className="chat-lightbox"
              onClick={() => setFullscreenImage(null)}
              onKeyDown={(e) => e.key === 'Escape' && setFullscreenImage(null)}
              role="button"
              tabIndex={0}
              aria-label="Закрыть просмотр"
            >
              <button
                type="button"
                className="chat-lightbox__close"
                onClick={() => setFullscreenImage(null)}
                aria-label="Закрыть"
              >
                ×
              </button>
              <img
                src={fullscreenImage}
                alt="Изображение"
                className="chat-lightbox__img"
                onClick={(e) => e.stopPropagation()}
                draggable={false}
              />
            </div>
          )}

          {cancelModal.open && cancelModal.deal && (
            <div
              className="modal-backdrop"
              onClick={() => {
                if (cancelState.loading) return
                setCancelModal({ open: false, deal: null })
                setCancelState({ loading: false, error: null })
              }}
              role="presentation"
            >
              <div
                className="modal"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label="Подтверждение отмены сделки"
              >
                <div className="modal__header">
                  <h3 className="modal__title">Отменить сделку?</h3>
                  <button
                    type="button"
                    className="modal__close"
                    onClick={() => {
                      if (cancelState.loading) return
                      setCancelModal({ open: false, deal: null })
                      setCancelState({ loading: false, error: null })
                    }}
                    aria-label="Закрыть"
                  >
                    ×
                  </button>
                </div>
                <div className="modal__body">
                  <p className="card-text" style={{ marginTop: 0 }}>
                    Точно отменить сделку по товару{' '}
                    <strong>{cancelModal.deal.productTitle || 'Товар'}</strong>?
                  </p>
                  {cancelState.error && (
                    <p className="card-text card-text--error">
                      {cancelState.error}
                    </p>
                  )}
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
                    <button
                      type="button"
                      className="lot-settings-btn lot-settings-btn--secondary"
                      onClick={() => {
                        if (cancelState.loading) return
                        setCancelModal({ open: false, deal: null })
                        setCancelState({ loading: false, error: null })
                      }}
                      disabled={cancelState.loading}
                    >
                      Не отменять
                    </button>
                    <button
                      type="button"
                      className="deal-chat-row__command-btn deal-chat-row__command-btn--danger"
                      onClick={async () => {
                        if (!token) return
                        const dealId = cancelModal.deal?.id
                        if (!dealId) return
                        setCancelState({ loading: true, error: null })
                        try {
                          await cancelDeal(token, dealId)
                          setCancelModal({ open: false, deal: null })
                          setCancelState({ loading: false, error: null })
                          await reloadDeals()
                        } catch (err) {
                          setCancelState({
                            loading: false,
                            error: err instanceof Error ? err.message : 'Не удалось отменить сделку',
                          })
                        }
                      }}
                      disabled={cancelState.loading}
                    >
                      {cancelState.loading ? 'Отменяем…' : 'Да, отменить'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {confirmModal.open && confirmModal.deal && (
            <div
              className="modal-backdrop"
              onClick={() => {
                if (confirmState.loading) return
                setConfirmModal({ open: false, deal: null })
                setConfirmState({ loading: false, error: null })
              }}
              role="presentation"
            >
              <div
                className="modal"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label="Подтверждение завершения сделки"
              >
                <div className="modal__header">
                  <h3 className="modal__title">Завершить сделку?</h3>
                  <button
                    type="button"
                    className="modal__close"
                    onClick={() => {
                      if (confirmState.loading) return
                      setConfirmModal({ open: false, deal: null })
                      setConfirmState({ loading: false, error: null })
                    }}
                    aria-label="Закрыть"
                  >
                    ×
                  </button>
                </div>
                <div className="modal__body">
                  <p className="card-text" style={{ marginTop: 0 }}>
                    Точно подтвердить выполнение сделки по товару{' '}
                    <strong>{confirmModal.deal.productTitle || 'Товар'}</strong>?
                  </p>
                  {confirmState.error && (
                    <p className="card-text card-text--error">
                      {confirmState.error}
                    </p>
                  )}
                  <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
                    <button
                      type="button"
                      className="lot-settings-btn lot-settings-btn--secondary"
                      onClick={() => {
                        if (confirmState.loading) return
                        setConfirmModal({ open: false, deal: null })
                        setConfirmState({ loading: false, error: null })
                      }}
                      disabled={confirmState.loading}
                    >
                      Не завершать
                    </button>
                    <button
                      type="button"
                      className="deal-chat-row__command-btn deal-chat-row__command-btn--success"
                      onClick={async () => {
                        if (!token) return
                        const dealId = confirmModal.deal?.id
                        if (!dealId) return
                        setConfirmState({ loading: true, error: null })
                        try {
                          await confirmDeal(token, dealId)
                          setConfirmModal({ open: false, deal: null })
                          setConfirmState({ loading: false, error: null })
                          await reloadDeals()
                        } catch (err) {
                          setConfirmState({
                            loading: false,
                            error: err instanceof Error ? err.message : 'Не удалось завершить сделку',
                          })
                        }
                      }}
                      disabled={confirmState.loading}
                    >
                      {confirmState.loading ? 'Завершаем…' : 'Да, завершить'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}


