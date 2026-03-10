import React, { useEffect, useMemo, useState } from 'react'
import { fetchInProgressDeals, fetchDealChatMessages, sendDealChatMessage } from '../../services/playerokApi'

// Вкладка "Выполнение" — показывает актуальные сделки со страницы sales
// напрямую с Playerok (без БД) только со статусом PAID.
export function InProgressLotsTab({ token }) {
  const [sales, setSales] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [chatsByDealId, setChatsByDealId] = useState({}) // { [dealId]: { loading, error, messages } }
  const [fullscreenImage, setFullscreenImage] = useState(null)
  const [showFullChatByDealId, setShowFullChatByDealId] = useState({}) // по умолчанию только сообщения по текущей сделке
  const [draftByDealId, setDraftByDealId] = useState({}) // текст нового сообщения по сделке

  const hasToken = Boolean(token)

  useEffect(() => {
    if (!token) {
      setSales([])
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchInProgressDeals(token)
      .then((data) => {
        if (cancelled) return
        const list = Array.isArray(data?.list) ? data.list : []
        setSales(list)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Ошибка загрузки продаж')
        setSales([])
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [token])

  // Отображаем только сделки со статусом PAID.
  const inProgressSales = useMemo(() => {
    return sales.filter(
      (s) => String(s.status || '').toUpperCase() === 'PAID'
    )
  }, [sales])

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

  // При появлении списка сделок загружаем чаты для каждой (без перезаписи уже загруженных)
  useEffect(() => {
    if (!token || inProgressSales.length === 0) return
    let cancelled = false

    const loadChats = async () => {
      for (const deal of inProgressSales) {
        const dealId = deal.id
        if (!dealId || chatsByDealId[dealId]?.loaded) continue
        setChatsByDealId((prev) => {
          if (prev[dealId]?.loaded) return prev
          return { ...prev, [dealId]: { loading: true, error: null, messages: [], loaded: false } }
        })
        try {
          const { list } = await fetchDealChatMessages(token, dealId, deal.chatId)
          if (cancelled) return
          const sorted = [...(list || [])].sort((a, b) => {
            const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0
            const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0
            return ta - tb
          })
          setChatsByDealId((prev) => ({
            ...prev,
            [dealId]: { loading: false, error: null, messages: sorted, loaded: true },
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
  }, [token, inProgressSales])

  // Периодическое обновление чатов, чтобы новые сообщения подтягивались без перезагрузки страницы.
  useEffect(() => {
    if (!token || inProgressSales.length === 0) return
    let cancelled = false

    const refreshChats = async () => {
      for (const deal of inProgressSales) {
        const dealId = deal.id
        if (!dealId) continue
        try {
          const { list } = await fetchDealChatMessages(token, dealId, deal.chatId)
          if (cancelled) return
          const sorted = [...(list || [])].sort((a, b) => {
            const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0
            const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0
            return ta - tb
          })
          setChatsByDealId((prev) => ({
            ...prev,
            [dealId]: {
              ...(prev[dealId] || { loading: false, error: null, loaded: true, messages: [] }),
              loading: false,
              error: null,
              messages: sorted,
              loaded: true,
            },
          }))
        } catch (_err) {
          if (cancelled) return
          // Ошибки периодического обновления игнорируем, чтобы не перезаписывать уже загруженный чат
        }
      }
    }

    const interval = setInterval(refreshChats, 5000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [token, inProgressSales])

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
              <div className="deal-chat-list">
                {salesByCategory.map(({ category, deals }) => (
                  <div key={category} className="deal-chat-list__category">
                    <h3 className="deal-chat-list__category-title">{category}</h3>
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
                      return (
                        <div key={item.id} className="deal-chat-row">
                          <div className="deal-chat-row__info">
                            <div className="deal-chat-row__title">
                              {item.productTitle || 'Товар'}
                            </div>
                            <div className="deal-chat-row__category">
                              {category}
                            </div>
                            <div className="deal-chat-row__meta">
                          <span className="deal-chat-row__buyer">
                            Покупатель: {item.buyerName || '—'}
                          </span>
                          <span className="deal-chat-row__price">
                            {item.price != null && item.price > 0
                              ? `${Number(item.price).toLocaleString('ru-RU')} ₽`
                              : '—'}
                          </span>
                        </div>
                      </div>
                      <div className="deal-chat-row__chat">
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
                                return (
                                  <div
                                    key={m.id}
                                    className="chat-message"
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
                        {!chat.loading && !chat.error && (
                          <form
                            className="deal-chat-row__input"
                            onSubmit={async (e) => {
                              e.preventDefault()
                              const draft = (draftByDealId[item.id] || '').trim()
                              if (!draft) return
                              try {
                                await sendDealChatMessage(token, {
                                  dealId: item.id,
                                  chatId: item.chatId || null,
                                  text: draft,
                                })
                                const newMessage = {
                                  id: `local-${Date.now()}`,
                                  text: draft,
                                  createdAt: new Date().toISOString(),
                                  imageUrl: null,
                                  user: { username: 'Levkaster' },
                                }
                                setChatsByDealId((prev) => ({
                                  ...prev,
                                  [item.id]: {
                                    ...(prev[item.id] || { loading: false, error: null, messages: [], loaded: true }),
                                    messages: [...(prev[item.id]?.messages || []), newMessage],
                                  },
                                }))
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
        </section>
      </div>
    </div>
  )
}


