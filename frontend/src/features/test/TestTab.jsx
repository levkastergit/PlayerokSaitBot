import { useRef, useState } from 'react'
import { fetchChatsProbeStep } from '../../services/playerokApi'

const MAX_PROBE = 500

function formatCell(value) {
  const s = value != null ? String(value).trim() : ''
  return s || '—'
}

export function TestTab({ token }) {
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(null)
  const [lastLoad, setLastLoad] = useState(null)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const abortRef = useRef(false)

  const handleProbe = async () => {
    abortRef.current = false
    setRunning(true)
    setResult(null)
    setError(null)
    setLastLoad(null)
    setProgress({ current: 0, max: MAX_PROBE, successCount: 0, chatCount: null, loading: false, stepMs: null })

    const startedAt = Date.now()
    let successCount = 0
    let userId = null

    try {
      for (let attempt = 1; attempt <= MAX_PROBE; attempt++) {
        if (abortRef.current) break

        setProgress({
          current: attempt,
          max: MAX_PROBE,
          successCount,
          chatCount: null,
          loading: true,
          stepMs: null,
        })

        const stepStarted = Date.now()
        const data = await fetchChatsProbeStep(token, { userId })
        const stepMs = Date.now() - stepStarted

        if (data.userId) userId = data.userId

        if (data.rateLimited) {
          setResult({
            hit429: true,
            successCount,
            failedAttempt: attempt,
            durationMs: Date.now() - startedAt,
            error: data.error || null,
          })
          return
        }

        if (!data.ok) {
          throw new Error(data.error || 'Ошибка загрузки чатов')
        }

        successCount += 1
        const chats = Array.isArray(data.chats) ? data.chats : []

        setProgress({
          current: attempt,
          max: MAX_PROBE,
          successCount,
          chatCount: chats.length,
          loading: false,
          stepMs,
        })

        setLastLoad({
          attempt,
          chats,
          stepMs,
          pageInfo: data.pageInfo || null,
        })
      }

      if (!abortRef.current) {
        setResult({
          hit429: false,
          successCount,
          stoppedByMax: true,
          durationMs: Date.now() - startedAt,
        })
      }
    } catch (err) {
      setError(err && err.message ? String(err.message) : 'Ошибка проверки')
    } finally {
      setRunning(false)
    }
  }

  const handleStop = () => {
    abortRef.current = true
  }

  const progressPct =
    progress && progress.max > 0
      ? Math.min(100, Math.round((progress.current / progress.max) * 100))
      : 0

  let resultText = null
  if (result) {
    if (result.hit429) {
      resultText = `До 429: ${result.successCount} загрузок userChats (/chats). 429 на попытке №${result.failedAttempt}.`
    } else if (result.stoppedByMax) {
      resultText = `429 не получен за ${result.successCount} загрузок (лимит ${MAX_PROBE}).`
    }
    if (result.durationMs != null) {
      resultText += ` Время: ${(result.durationMs / 1000).toFixed(1)} с.`
    }
  }

  return (
    <div className="tab-page">
      <div className="tab-page-header">
        <h1>Тест</h1>
      </div>
      <div className="tab-grid">
        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <div className="ddos-guard-actions">
            <button
              type="button"
              className="btn-primary"
              disabled={running || !token}
              onClick={handleProbe}
            >
              {running ? 'Проверяем…' : 'Проверить лимит 429 для /chats'}
            </button>
            {running && (
              <button type="button" className="btn-secondary" onClick={handleStop}>
                Остановить
              </button>
            )}
          </div>

          {!token && <p className="card-text card-text--error">Нужен токен Playerok (Настройки).</p>}

          {running && progress && (
            <div className="profit-sync-progress" role="status" aria-live="polite">
              <div className="profit-sync-progress__bar-wrap">
                <div className="profit-sync-progress__bar" style={{ width: `${progressPct}%` }} />
              </div>
              <p className="profit-sync-progress__text">
                {progress.current} из {progress.max}
                {progress.loading ? ' · загрузка чатов…' : ''}
                {!progress.loading && progress.chatCount != null
                  ? ` · чатов: ${progress.chatCount}`
                  : ''}
                {progress.successCount > 0 ? ` · успешных: ${progress.successCount}` : ''}
                {progress.stepMs != null ? ` · ${(progress.stepMs / 1000).toFixed(2)} с` : ''}
              </p>
            </div>
          )}

          {lastLoad && (
            <div className="test-probe-load">
              <p className="card-text test-probe-load__head">
                Попытка {lastLoad.attempt}
                {lastLoad.chats.length > 0 ? ` · ${lastLoad.chats.length} чатов` : ''}
                {lastLoad.stepMs != null ? ` · ${(lastLoad.stepMs / 1000).toFixed(2)} с` : ''}
              </p>
              {lastLoad.chats.length === 0 ? (
                <p className="card-text">Список пуст.</p>
              ) : (
                <div className="history-table-wrap test-probe-load__table-wrap">
                  <table className="history-table test-probe-load__table">
                    <thead>
                      <tr>
                        <th>Покупатель</th>
                        <th>Товар</th>
                        <th>Последнее сообщение</th>
                        <th>Непрочит.</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lastLoad.chats.map((chat) => (
                        <tr key={chat.id || `${lastLoad.attempt}-${chat.buyerName}`}>
                          <td>{formatCell(chat.buyerName)}</td>
                          <td className="history-table__title">{formatCell(chat.itemTitle)}</td>
                          <td>{formatCell(chat.lastMessageText)}</td>
                          <td>{chat.unreadCount != null ? chat.unreadCount : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {error && <p className="card-text card-text--error">{error}</p>}
          {resultText && <p className="card-text">{resultText}</p>}
        </section>
      </div>
    </div>
  )
}
