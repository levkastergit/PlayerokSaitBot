import React, { useEffect, useMemo, useState } from 'react'
import {
  checkPlayerokDdosAccess,
  getPlayerokDdosCookieStatus,
  setPlayerokDdosCookie,
} from '../../services/playerokApi'

function extractCookieFromClipboard(rawText) {
  const text = String(rawText || '').trim()
  if (!text) return ''
  const m = text.match(/(?:^|\n)\s*cookie\s*:\s*([^\n\r]+)/i)
  if (m && m[1]) return m[1].trim()
  return text
}

const DROP_COOKIE_PREFIXES = [
  'token=',
  '_ga=',
  '_ga_',
  '_ym_',
  '_gcl_',
  '_ttp=',
  '_tt_enable_cookie=',
  'ttcsid=',
  'ttcsid_',
]

function sanitizeCookieHeader(rawCookie) {
  const value = String(rawCookie || '').trim()
  if (!value) return { cookie: '', removed: [], keptCount: 0 }
  const parts = value
    .split(';')
    .map((x) => x.trim())
    .filter(Boolean)
  const removed = []
  const kept = []
  for (const part of parts) {
    const lower = part.toLowerCase()
    const shouldDrop = DROP_COOKIE_PREFIXES.some((prefix) => lower.startsWith(prefix))
    if (shouldDrop) {
      removed.push(part)
    } else {
      kept.push(part)
    }
  }
  return { cookie: kept.join('; '), removed, keptCount: kept.length }
}

export function DdosTab() {
  const [cookieText, setCookieText] = useState('')
  const [loadingStatus, setLoadingStatus] = useState(true)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState({ configured: false, length: 0 })
  const [sanitizedInfo, setSanitizedInfo] = useState(null)
  const [message, setMessage] = useState(null)
  const [error, setError] = useState(null)
  const [checkLoading, setCheckLoading] = useState(false)
  const [checkResult, setCheckResult] = useState(null)

  const hasCookieText = useMemo(() => cookieText.trim().length > 0, [cookieText])

  const refreshStatus = async () => {
    setLoadingStatus(true)
    try {
      const data = await getPlayerokDdosCookieStatus()
      setStatus({
        configured: Boolean(data && data.configured),
        length: Number(data && data.length) || 0,
      })
    } catch {
      setStatus({ configured: false, length: 0 })
    } finally {
      setLoadingStatus(false)
    }
  }

  useEffect(() => {
    refreshStatus()
  }, [])

  const saveCookie = async (rawCookie) => {
    setMessage(null)
    setError(null)
    const { cookie: value, removed, keptCount } = sanitizeCookieHeader(rawCookie)
    if (!value) {
      setError('Вставьте cookie перед сохранением')
      return
    }
    setSanitizedInfo({ removed, keptCount })
    setCookieText(value)
    setSaving(true)
    try {
      await setPlayerokDdosCookie(value)
      await refreshStatus()
      setMessage('Cookie сохранены в памяти сервера. Можно идти на вкладку "Активные" и обновлять лоты.')
    } catch (err) {
      setError(err && err.message ? String(err.message) : 'Не удалось сохранить cookie')
    } finally {
      setSaving(false)
    }
  }

  const handleImportFromClipboard = async () => {
    setMessage(null)
    setError(null)
    if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
      setError('Буфер обмена недоступен. Скопируйте строку вручную и вставьте в поле.')
      return
    }
    try {
      const clipText = await navigator.clipboard.readText()
      const extracted = extractCookieFromClipboard(clipText)
      if (!extracted) {
        setError('Буфер пуст. Скопируйте header cookie из DevTools.')
        return
      }
      setCookieText(extracted)
      await saveCookie(extracted)
    } catch (err) {
      setError(err && err.message ? String(err.message) : 'Не удалось прочитать буфер обмена')
    }
  }

  const handleClearServerCookie = async () => {
    setMessage(null)
    setError(null)
    setSaving(true)
    try {
      await setPlayerokDdosCookie('')
      setCookieText('')
      setSanitizedInfo(null)
      setCheckResult(null)
      await refreshStatus()
      setMessage('Cookie на сервере очищены.')
    } catch (err) {
      setError(err && err.message ? String(err.message) : 'Не удалось очистить cookie')
    } finally {
      setSaving(false)
    }
  }

  const handleCheckAccess = async () => {
    setCheckLoading(true)
    setCheckResult(null)
    setError(null)
    try {
      const data = await checkPlayerokDdosAccess()
      const viewer = data && data.viewer ? data.viewer : {}
      setCheckResult({
        ok: true,
        text: `Доступ OK: ${viewer.username || 'unknown'} (${viewer.id || 'no-id'})`,
      })
    } catch (err) {
      setCheckResult({
        ok: false,
        text: err && err.message ? String(err.message) : 'Проверка не прошла',
      })
    } finally {
      setCheckLoading(false)
    }
  }

  return (
    <div className="tab-page">
      <div className="tab-page-header">
        <h1>Ddos</h1>
      </div>

      <div className="tab-grid">
        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <h2 className="card-title">Как пройти проверку для сервера</h2>
          <ol className="ddos-instructions">
            <li>Откройте `https://playerok.com` в браузере и пройдите проверку.</li>
            <li>Откройте DevTools → Network → любой запрос к `playerok.com/graphql`.</li>
            <li>Скопируйте заголовок `cookie` целиком (можно строку `cookie: ...`).</li>
            <li>Нажмите кнопку «Импорт cookie из буфера» или вставьте строку в поле ниже и сохраните.</li>
          </ol>
          <p className="card-text">
            Здесь cookie сохраняются прямо в работающий backend, без правки `.env`.
          </p>
        </section>

        <section className="card" style={{ gridColumn: '1 / -1' }}>
          <h2 className="card-title">Cookie DDoS-Guard</h2>
          <p className="card-text">
            Статус: {loadingStatus ? 'проверяем...' : status.configured ? `установлены (${status.length} символов)` : 'не установлены'}
          </p>

          <textarea
            className="input-theme ddos-cookie-textarea"
            placeholder="Вставьте cookie или строку `cookie: ...`"
            value={cookieText}
            onChange={(e) => setCookieText(e.target.value)}
          />

          <div className="ddos-guard-actions">
            <button
              type="button"
              className="btn-primary"
              disabled={saving || !hasCookieText}
              onClick={() => saveCookie(cookieText)}
            >
              {saving ? 'Сохраняем…' : 'Сохранить cookie на сервер'}
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={saving}
              onClick={handleImportFromClipboard}
            >
              Импорт cookie из буфера
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={saving}
              onClick={handleClearServerCookie}
            >
              Очистить cookie на сервере
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={saving || checkLoading}
              onClick={handleCheckAccess}
            >
              {checkLoading ? 'Проверяем…' : 'Проверить доступ к Playerok'}
            </button>
          </div>

          {sanitizedInfo && sanitizedInfo.removed.length > 0 && (
            <p className="card-text">
              Очистка: удалено {sanitizedInfo.removed.length} служебных cookie (token/метрика), оставлено {sanitizedInfo.keptCount}.
            </p>
          )}
          {message && <p className="card-text">{message}</p>}
          {error && <p className="card-text card-text--error">{error}</p>}
          {checkResult && (
            <p className={`card-text ${checkResult.ok ? '' : 'card-text--error'}`}>
              {checkResult.text}
            </p>
          )}
        </section>
      </div>
    </div>
  )
}

