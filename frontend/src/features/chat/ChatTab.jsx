import { useEffect, useState } from 'react'
import { fetchDealChatMessages } from '../../services/playerokApi'

const TEST_CHAT_ID = '1f11c6cf-c041-6e10-c250-abc78f97de9a'

export function ChatTab({ token }) {
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [fullscreenImage, setFullscreenImage] = useState(null)

  const loadMessages = async () => {
    if (!token) {
      setMessages([])
      setError('Сначала введите токен во вкладке «Токен».')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const { list } = await fetchDealChatMessages(token, null, TEST_CHAT_ID)
      const sorted = [...list].sort((a, b) => {
        const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0
        const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0
        return ta - tb
      })
      setMessages(sorted)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось загрузить чат')
      setMessages([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadMessages()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  const formatTime = (iso) => {
    if (!iso) return ''
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return ''
    return d.toLocaleString('ru-RU')
  }

  return (
    <div className="chat-tab">
      <div className="chat-tab__header">
        <div>
          <h2 className="chat-tab__title">Тестовый чат Playerok</h2>
          <p className="chat-tab__subtitle">
            Загружается чат по ссылке{' '}
            <a
              href="https://playerok.com/chats/1f11c6cf-c041-6e10-c250-abc78f97de9a"
              target="_blank"
              rel="noreferrer"
            >
              playerok.com/chats/1f11c6cf-c041-6e10-c250-abc78f97de9a
            </a>
          </p>
        </div>
        <button
          type="button"
          className="btn btn--primary"
          onClick={loadMessages}
          disabled={loading}
        >
          Обновить чат
        </button>
      </div>

      {loading && <div className="chat-tab__status">Загружаем сообщения…</div>}
      {error && !loading && (
        <div className="chat-tab__status chat-tab__status--error">{error}</div>
      )}
      {!loading && !error && messages.length === 0 && (
        <div className="chat-tab__status">Сообщений пока нет.</div>
      )}

      <div className="chat-tab__messages">
        {messages.map((m) => {
          const isMe = m.user?.username === 'Levkaster'
          return (
            <div
              key={m.id}
              className={
                'chat-message' + (isMe ? ' chat-message--me' : ' chat-message--other')
              }
            >
              <div className="chat-message__meta">
                <span className="chat-message__author">
                  {m.user?.username || 'Пользователь'}
                </span>
                <span className="chat-message__time">
                  {formatTime(m.createdAt)}
                </span>
              </div>
              {m.text ? (
                <div className="chat-message__text">{m.text}</div>
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
    </div>
  )
}

