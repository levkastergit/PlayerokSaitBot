import React, { useEffect, useMemo, useRef, useState } from 'react'
import { fetchUserChats, fetchDealChatMessages, sendDealChatMessage, hideChat, unhideChat } from '../../services/playerokApi'

export function ChatTab({ token }) {
  const [chats, setChats] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [pageInfo, setPageInfo] = useState({ hasNextPage: false, endCursor: null })
  const [selectedChatId, setSelectedChatId] = useState(null)
  const [chatStateById, setChatStateById] = useState({})
  const [draftByChatId, setDraftByChatId] = useState({})
  const [chatFilter, setChatFilter] = useState('all') // 'all' | 'hide-completed'
  const listRef = useRef(null)
  const loadingMoreRef = useRef(false)

  const hasToken = Boolean(token)

  const COMPLETED_MARKERS = useMemo(
    () => new Set(['{{DEAL_CONFIRMED}}', '{{DEAL_CONFIRMED_AUTOMATICALLY}}', '{{DEAL_ROLLED_BACK}}']),
    []
  )

  const isChatCompleted = (chat) => {
    if (!chat) return false
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
        const { list, pageInfo: info } = await fetchUserChats(token, { limit: 24 })
        if (cancelled) return
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

  const loadMore = async () => {
    if (!token || !pageInfo.hasNextPage || loadingMoreRef.current) return
    const afterCursor = pageInfo.endCursor
    if (!afterCursor) return
    loadingMoreRef.current = true
    setLoadingMore(true)
    try {
      const { list, pageInfo: info } = await fetchUserChats(token, {
        limit: 24,
        afterCursor,
      })
      setChats((prev) => [...prev, ...list])
      setPageInfo(info || { hasNextPage: false, endCursor: null })
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(err)
    } finally {
      setLoadingMore(false)
      loadingMoreRef.current = false
    }
  }

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    const handleScroll = () => {
      if (!pageInfo.hasNextPage || loadingMoreRef.current) return
      const threshold = 80
      if (el.scrollHeight - el.scrollTop - el.clientHeight < threshold) {
        loadMore()
      }
    }
    el.addEventListener('scroll', handleScroll)
    return () => {
      el.removeEventListener('scroll', handleScroll)
    }
  }, [pageInfo.hasNextPage, pageInfo.endCursor])

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
      const { list, itemTitle, itemImageUrl } = await fetchDealChatMessages(token, chat.dealId || null, chatId)
      const sorted = [...(list || [])].sort((a, b) => {
        const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0
        const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0
        return ta - tb
      })
      setChatStateById((prev) => ({
        ...prev,
        [chatId]: {
          loading: false,
          error: null,
          messages: sorted,
          loaded: true,
          itemTitle: itemTitle || chat.itemTitle || null,
          itemImageUrl: itemImageUrl || null,
        },
      }))
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
  const currentItemImageUrl =
    selectedChat && (selectedChatState?.itemImageUrl || selectedChat.itemImageUrl || null)
  const currentItemTitle =
    selectedChat && (selectedChatState?.itemTitle || selectedChat.itemTitle || '')

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
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(err)
    }
  }

  return (
    <div className="tab-page">
      <div className="tab-page-header">
        <h1>Чаты</h1>
        <p className="tab-page-description">
          Последние чаты с покупателями из профиля Playerok. При прокрутке вниз подгружаются новые чаты.
        </p>
      </div>

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
                >
                  Все чаты
                </button>
                <button
                  type="button"
                  className={
                    chatFilter === 'hide-completed'
                      ? 'chat-filter-toggle__btn chat-filter-toggle__btn--active'
                      : 'chat-filter-toggle__btn'
                  }
                  onClick={() => setChatFilter('hide-completed')}
                >
                  Скрыть выполненные
                </button>
              </div>
              <div
                ref={listRef}
                className="chat-list"
              >
                {visibleChats.map((chat) => {
                  const isActive = chat.id === selectedChatId
                  const unread = typeof chat.unreadCount === 'number' ? chat.unreadCount : null
                  const category = (chat.category || '').trim()
                  const statusLabel = getStatusLabel(chat.status)
                  const metaLine = category ? `${category} · ${statusLabel}` : statusLabel
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
                        {chat.buyerName || 'Покупатель'}
                      </div>
                      <div className="chat-list__meta">
                        <span className="chat-list__buyer">
                          {category || ''}
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
                    {selectedChat.buyerName && (
                      <span className="chat-header-row__buyer">
                        Покупатель: {selectedChat.buyerName}
                      </span>
                    )}
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
                  {selectedChat.buyerName && (
                    <div className="chat-item-card__buyer">
                      Покупатель: {selectedChat.buyerName}
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
                    {selectedChatState.messages.map((m) => {
                      const timeText = formatTime(m.createdAt)
                      return (
                        <div key={m.id} className="chat-message">
                          <div className="chat-message__meta">
                            <span className="chat-message__author">
                              {m.user?.username || selectedChat.buyerName || 'Пользователь'}
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
                              <img
                                src={m.imageUrl}
                                alt="Изображение в чате"
                                className="chat-message__image"
                              />
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
                )}

              {!selectedChatState?.loading && !selectedChatState?.error && (
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
              )}
            </>
          )}
        </section>
      </div>
    </div>
  )
}

