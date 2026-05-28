import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  clearChatLogging,
  getChatLoggingSnapshot,
  isChatApiRequest,
  subscribeChatLogging,
} from '../../debug/chatLoggingLog.js'
import { requestTracker } from '../../services/requestTracker.js'
import {
  clearChatDbSyncStepLog,
  fetchChatDbSyncStepLog,
} from '../../services/playerokApi.js'

function formatTime(ts) {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function formatPayload(payload) {
  if (payload == null) return ''
  try {
    const text = JSON.stringify(payload, null, 2)
    if (text.length > 4000) return `${text.slice(0, 4000)}\n…`
    return text
  } catch {
    return String(payload)
  }
}

function shortUrl(url) {
  const value = String(url || '')
  const idx = value.indexOf('/api/')
  return idx >= 0 ? value.slice(idx) : value
}

const SYNC_ACTION_LABEL = {
  skip: 'пропуск',
  fetch_messages: 'сообщения',
  meta_refresh: 'мета',
  filtered_age: 'старше месяца',
}

const PHASE_LABEL = {
  playerok_list: 'список Playerok',
  chat_messages: 'сообщения чата',
  complete: 'шаг завершён',
  error: 'ошибка',
}

function ChatSyncDisplayPanel() {
  const [entries, setEntries] = useState([])
  const [loadError, setLoadError] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const listRef = useRef(null)
  const [autoScroll, setAutoScroll] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const data = await fetchChatDbSyncStepLog()
      setEntries(Array.isArray(data?.entries) ? data.entries : [])
      setLoadError(null)
    } catch (err) {
      setLoadError(err && err.message ? String(err.message) : String(err))
    }
  }, [])

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 500)
    return () => clearInterval(timer)
  }, [refresh])

  const sortedEntries = useMemo(
    () => [...entries].sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0)),
    [entries]
  )

  const activeEntry = useMemo(() => {
    if (selectedId) {
      return sortedEntries.find((e) => e.id === selectedId) || sortedEntries[0] || null
    }
    return sortedEntries[0] || null
  }, [sortedEntries, selectedId])

  useEffect(() => {
    if (!autoScroll || !listRef.current) return
    listRef.current.scrollTop = 0
  }, [activeEntry?.id, autoScroll])

  const handleClear = async () => {
    await clearChatDbSyncStepLog()
    setSelectedId(null)
    await refresh()
  }

  const chats = Array.isArray(activeEntry?.chats) ? activeEntry.chats : []

  return (
    <>
      <div className="chat-log-toolbar">
        <label className="chat-log-toolbar__check">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />
          К последнему шагу
        </label>
        <button type="button" className="btn-secondary" onClick={handleClear}>
          Очистить
        </button>
      </div>

      {loadError ? <p className="card-text">{loadError}</p> : null}

      {!loadError && sortedEntries.length === 0 ? (
        <p className="card-text">
          Записей пока нет. Перезапустите backend после обновления. Если чаты грузят сообщения
          долго — шаг «playerok_list» появится сразу после ответа списка чатов.
        </p>
      ) : null}

      {activeEntry ? (
        <div className="chat-sync-display">
          <div className="chat-sync-display__summary">
            <span>{formatTime(activeEntry.ts)}</span>
            <span>
              {PHASE_LABEL[activeEntry.phase] ||
                (activeEntry.ok === false ? 'ошибка' : 'ok')}
            </span>
            {activeEntry.durationMs != null ? <span>{activeEntry.durationMs} ms</span> : null}
            {activeEntry.phase === 'chat_messages' && activeEntry.chatId ? (
              <span>chatId: {activeEntry.chatId}</span>
            ) : null}
            {activeEntry.sync?.queueLeft != null ? (
              <span>в очереди: {activeEntry.sync.queueLeft}</span>
            ) : null}
            {activeEntry.sync?.messagesCount != null ? (
              <span>сообщений: {activeEntry.sync.messagesCount}</span>
            ) : null}
            {activeEntry.phase === 'playerok_list' && activeEntry.sync ? (
              <span>
                Playerok: {activeEntry.sync.playerokEdges ?? '—'} / в синке:{' '}
                {activeEntry.sync.fetchedChats ?? '—'} / изменено:{' '}
                {activeEntry.sync.changedChats ?? '—'} / пропуск:{' '}
                {activeEntry.sync.skippedChats ?? '—'}
              </span>
            ) : null}
            {activeEntry.error ? <span>{activeEntry.error}</span> : null}
          </div>

          {chats.length > 0 ? (
            <div className="chat-sync-display__table-wrap">
              <table className="chat-sync-display__table">
                <thead>
                  <tr>
                    <th>chatId</th>
                    <th>buyer</th>
                    <th>lastMessageId</th>
                    <th>сообщение</th>
                    <th>в БД</th>
                    <th>в БД сообщение</th>
                    <th>причина meta</th>
                    <th>действие</th>
                  </tr>
                </thead>
                <tbody>
                  {chats.map((row) => (
                    <tr key={`${activeEntry.id}-${row.chatId}`}>
                      <td>{row.chatId || '—'}</td>
                      <td>{row.buyerName || '—'}</td>
                      <td>{row.lastMessageId || '—'}</td>
                      <td className="chat-sync-display__message">{row.lastMessageText || '—'}</td>
                      <td>{row.dbLastMessageId || '—'}</td>
                      <td className="chat-sync-display__message">{row.dbLastMessageText || '—'}</td>
                      <td>{row.metaReason || '—'}</td>
                      <td>{SYNC_ACTION_LABEL[row.syncAction] || row.syncAction || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          <pre className="chat-log-entry__body">{formatPayload(activeEntry)}</pre>
        </div>
      ) : null}

      {sortedEntries.length > 1 ? (
        <div ref={listRef} className="chat-sync-display__history">
          {sortedEntries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={
                entry.id === activeEntry?.id
                  ? 'chat-sync-display__history-btn chat-sync-display__history-btn--active'
                  : 'chat-sync-display__history-btn'
              }
              onClick={() => setSelectedId(entry.id)}
            >
              {formatTime(entry.ts)} — {PHASE_LABEL[entry.phase] || (entry.ok === false ? 'ошибка' : 'ok')}
              {entry.phase === 'playerok_list' && entry.sync?.changedChats != null
                ? ` · Δ ${entry.sync.changedChats}`
                : ''}
              {entry.phase === 'chat_messages' && entry.chatId
                ? ` · ${String(entry.chatId).slice(0, 8)}…`
                : ''}
              {entry.sync?.queueLeft != null ? ` · очередь ${entry.sync.queueLeft}` : ''}
            </button>
          ))}
        </div>
      ) : null}
    </>
  )
}

export function ChatLoggingTab() {
  const [pageTab, setPageTab] = useState('events')
  const [chatEvents, setChatEvents] = useState(() => getChatLoggingSnapshot().events)
  const [apiEvents, setApiEvents] = useState(() =>
    (requestTracker.getSnapshot().events || []).filter((e) => isChatApiRequest(e.url))
  )
  const [levelFilter, setLevelFilter] = useState('all')
  const [autoScroll, setAutoScroll] = useState(true)
  const listRef = useRef(null)

  const refreshChatEvents = useCallback(() => {
    setChatEvents(getChatLoggingSnapshot().events)
  }, [])

  const refreshApiEvents = useCallback(() => {
    setApiEvents(
      (requestTracker.getSnapshot().events || []).filter((e) => isChatApiRequest(e.url))
    )
  }, [])

  useEffect(() => subscribeChatLogging(refreshChatEvents), [refreshChatEvents])
  useEffect(() => requestTracker.subscribe(refreshApiEvents), [refreshApiEvents])

  const mergedEntries = useMemo(() => {
    const chatRows = chatEvents.map((entry) => ({
      id: entry.id,
      ts: entry.ts,
      kind: 'chat',
      level: entry.level,
      title: entry.event,
      details: formatPayload(entry.payload),
    }))
    const apiRows = apiEvents.map((entry) => ({
      id: entry.id,
      ts: entry.ts,
      kind: 'api',
      level: entry.ok === false || (entry.status && entry.status >= 400) ? 'error' : 'info',
      title: `${entry.method} ${shortUrl(entry.url)}`,
      details: [
        entry.status != null ? `status: ${entry.status}` : null,
        entry.durationMs != null ? `duration: ${entry.durationMs}ms` : null,
        entry.error ? `error: ${entry.error}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
    }))
    return [...chatRows, ...apiRows].sort((a, b) => a.ts - b.ts)
  }, [chatEvents, apiEvents])

  const visibleEntries = useMemo(() => {
    if (levelFilter === 'all') return mergedEntries
    if (levelFilter === 'error') {
      return mergedEntries.filter((entry) => entry.level === 'error')
    }
    if (levelFilter === 'automation') {
      return mergedEntries.filter(
        (entry) => entry.kind === 'chat' && String(entry.title).startsWith('auto:')
      )
    }
    if (levelFilter === 'action') {
      return mergedEntries.filter((entry) => entry.level === 'action')
    }
    if (levelFilter === 'api') {
      return mergedEntries.filter((entry) => entry.kind === 'api')
    }
    return mergedEntries.filter((entry) => entry.kind === 'chat' && entry.level === 'info')
  }, [mergedEntries, levelFilter])

  useEffect(() => {
    if (!autoScroll) return
    const el = listRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [visibleEntries, autoScroll])

  const handleClear = () => {
    clearChatLogging()
    requestTracker.clear()
    refreshChatEvents()
    refreshApiEvents()
  }

  return (
    <div className="tab-page">
      <div className="tab-page-header">
        <h1>Логирование Чата</h1>
      </div>

      <div className="chat-log-filters" style={{ marginBottom: '0.75rem' }}>
        {[
          { id: 'events', label: 'События' },
          { id: 'display', label: 'Отображение' },
        ].map((item) => (
          <button
            key={item.id}
            type="button"
            className={
              pageTab === item.id
                ? 'chat-log-filters__btn chat-log-filters__btn--active'
                : 'chat-log-filters__btn'
            }
            onClick={() => setPageTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="tab-grid">
        <section className="card" style={{ gridColumn: '1 / -1' }}>
          {pageTab === 'display' ? (
            <>
              <div className="card-title-row">
                <h2 className="card-title" style={{ margin: 0 }}>Отображение</h2>
              </div>
              <ChatSyncDisplayPanel />
            </>
          ) : (
            <>
          <div className="card-title-row">
            <h2 className="card-title" style={{ margin: 0 }}>События</h2>
            <div className="chat-log-toolbar">
              <label className="chat-log-toolbar__check">
                <input
                  type="checkbox"
                  checked={autoScroll}
                  onChange={(e) => setAutoScroll(e.target.checked)}
                />
                Автопрокрутка
              </label>
              <button type="button" className="btn-secondary" onClick={handleClear}>
                Очистить
              </button>
            </div>
          </div>

          <div className="chat-log-filters">
            {[
              { id: 'all', label: 'Все' },
              { id: 'info', label: 'Загрузки' },
              { id: 'action', label: 'Действия' },
              { id: 'api', label: 'API' },
              { id: 'error', label: 'Ошибки' },
              { id: 'automation', label: 'Автоматика' },
            ].map((item) => (
              <button
                key={item.id}
                type="button"
                className={
                  levelFilter === item.id
                    ? 'chat-log-filters__btn chat-log-filters__btn--active'
                    : 'chat-log-filters__btn'
                }
                onClick={() => setLevelFilter(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>

          {visibleEntries.length === 0 ? (
            <p className="card-text">
              Записей пока нет. Откройте вкладку «Чаты» — сюда попадут загрузки, действия и ошибки.
            </p>
          ) : (
            <div ref={listRef} className="chat-log-list">
              {visibleEntries.map((entry) => (
                <article
                  key={`${entry.kind}-${entry.id}`}
                  className={
                    'chat-log-entry' +
                    (entry.level === 'error'
                      ? ' chat-log-entry--error'
                      : entry.level === 'automation'
                        ? ' chat-log-entry--automation'
                        : entry.level === 'action'
                          ? ' chat-log-entry--action'
                          : entry.kind === 'api'
                            ? ' chat-log-entry--api'
                            : '')
                  }
                >
                  <div className="chat-log-entry__head">
                    <span className="chat-log-entry__time">{formatTime(entry.ts)}</span>
                    <span className="chat-log-entry__title">{entry.title}</span>
                  </div>
                  {entry.details ? (
                    <pre className="chat-log-entry__body">{entry.details}</pre>
                  ) : null}
                </article>
              ))}
            </div>
          )}
            </>
          )}
        </section>
      </div>
    </div>
  )
}
