import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import './index.css'
import { checkAuth } from './services/authApi'
import {
  fetchActiveLots,
  fetchCompletedLots,
  getProductKey,
  loadProductSettingsList,
  fetchBumpHistory,
  recordBump,
  autolistTick,
  loadStoredToken,
  saveStoredToken,
} from './services/playerokApi'
import { LoginPage } from './features/auth/LoginPage.jsx'
import { AutoListingTab } from './features/auto-listing/AutoListingTab.jsx'
import { LotBoostTab } from './features/lot-boost/LotBoostTab.jsx'
import { AutoDeliveryTab } from './features/auto-delivery/AutoDeliveryTab.jsx'
import { ActiveLotsTab } from './features/active/ActiveLotsTab.jsx'
import { CompletedLotsTab } from './features/completed/CompletedLotsTab.jsx'
import { InProgressLotsTab } from './features/completed/InProgressLotsTab.jsx'
import { LotSettingsPage } from './features/lot/LotSettingsPage.jsx'
import { CommandsTab } from './features/commands/CommandsTab.jsx'
import { TokenTab } from './features/token/TokenTab.jsx'
import { ProfitTab } from './features/profit/ProfitTab.jsx'

const LOTS_TABS = new Set(['active', 'auto-listing', 'auto-delivery', 'lot-boost'])

const TABS = [
  { id: 'active', label: 'Активные' },
  { id: 'in-progress', label: 'Выполнение' },
  { id: 'completed', label: 'Завершенные' },
  { id: 'auto-listing', label: 'Автовыставление' },
  { id: 'lot-boost', label: 'Поднятие лотов' },
  { id: 'auto-delivery', label: 'Автовыдача' },
  { id: 'commands', label: 'Команды' },
  { id: 'token', label: 'Токен' },
  { id: 'profit', label: 'Статистика' },
]

const TAB_IDS = new Set(TABS.map((t) => t.id))

function App() {
  const location = useLocation()
  const navigate = useNavigate()
  const pathParts = location.pathname.split('/').filter(Boolean)
  const isLoginPage = pathParts[0] === 'login'
  const isLotPage = pathParts[0] === 'lot' && pathParts[1]
  const lotIdFromUrl = isLotPage ? pathParts[1] : null
  const activeTab =
    isLotPage ? 'lot' : (TAB_IDS.has(pathParts[0]) ? pathParts[0] : 'active')

  const [authChecked, setAuthChecked] = useState(false)
  const [isAuthenticated, setIsAuthenticated] = useState(false)

  useEffect(() => {
    let cancelled = false
    checkAuth().then((ok) => {
      if (!cancelled) {
        setAuthChecked(true)
        setIsAuthenticated(ok)
      }
    })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (!authChecked) return
    if (isLoginPage && isAuthenticated) {
      navigate('/active', { replace: true })
      return
    }
    if (!isLoginPage && !isAuthenticated) {
      navigate('/login', { replace: true })
    }
  }, [authChecked, isLoginPage, isAuthenticated, navigate])

  useEffect(() => {
    if (location.pathname === '/' || location.pathname === '') {
      navigate('/active', { replace: true })
    }
  }, [location.pathname, navigate])
  const [darkTheme, setDarkTheme] = useState(false)
  const [token, setToken] = useState('')

  const [lots, setLots] = useState([])
  const [loadingLots, setLoadingLots] = useState(false)
  const [errorLots, setErrorLots] = useState(null)
  const lastFetchedTokenRef = useRef(null)
  const autobumpLastAttemptByKeyRef = useRef({})

  const [completedLots, setCompletedLots] = useState([])
  const [loadingCompletedLots, setLoadingCompletedLots] = useState(false)
  const [errorCompletedLots, setErrorCompletedLots] = useState(null)
  const lastFetchedCompletedTokenRef = useRef(null)

  const handleTokenChange = (nextToken) => {
    setToken(nextToken)
      ; (async () => {
        try {
          await saveStoredToken(nextToken)
        } catch {
          // ignore token persistence errors
        }
      })()
  }

  const selectedLot =
    lotIdFromUrl
      ? (lots.find((l) => String(l.id) === String(lotIdFromUrl)) ||
        completedLots.find((l) => String(l.id) === String(lotIdFromUrl)) ||
        null)
      : null

  useEffect(() => {
    if (!token) {
      setLots([])
      setErrorLots(null)
      lastFetchedTokenRef.current = null
      return
    }
    if (lots.length > 0 && lastFetchedTokenRef.current === token) return

    lastFetchedTokenRef.current = token
    setLoadingLots(true)
    setErrorLots(null)

    fetchActiveLots(token)
      .then((data) => {
        setLots(data)
        setLoadingLots(false)
      })
      .catch((err) => {
        setErrorLots(err instanceof Error ? err.message : 'Неизвестная ошибка')
        setLots([])
        setLoadingLots(false)
      })
  }, [token, activeTab, pathParts[0]])

  useEffect(() => {
    if (!token) {
      setCompletedLots([])
      setErrorCompletedLots(null)
      lastFetchedCompletedTokenRef.current = null
      return
    }
    const needCompleted =
      activeTab === 'completed' ||
      activeTab === 'lot-boost' ||
      activeTab === 'auto-delivery' ||
      activeTab === 'auto-listing' ||
      pathParts[0] === 'lot'
    if (!needCompleted) return
    if (completedLots.length > 0 && lastFetchedCompletedTokenRef.current === token) return

    lastFetchedCompletedTokenRef.current = token
    setLoadingCompletedLots(true)
    setErrorCompletedLots(null)

    fetchCompletedLots(token)
      .then((data) => {
        setCompletedLots(data)
        setLoadingCompletedLots(false)
      })
      .catch((err) => {
        setErrorCompletedLots(err instanceof Error ? err.message : 'Неизвестная ошибка')
        setCompletedLots([])
        setLoadingCompletedLots(false)
      })
  }, [token, activeTab, pathParts[0]])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', darkTheme ? 'dark' : 'light')
  }, [darkTheme])

  useEffect(() => {
    let cancelled = false
      ; (async () => {
        const stored = await loadStoredToken()
        if (cancelled) return
        if (stored) setToken(stored)
      })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!token) return
    const activeLots = [...lots]
    if (activeLots.length === 0) return

    const run = async () => {
      try {
        const [settingsRes, historyRes] = await Promise.all([
          loadProductSettingsList(token),
          fetchBumpHistory(token),
        ])
        const settingsByKey = {}
          ; (settingsRes.list || []).forEach(({ productKey, settings }) => {
            if (productKey && settings) settingsByKey[productKey] = settings
          })
        const lastBumpByKey = {}
          ; (historyRes.list || []).forEach((item) => {
            const k = item.productKey || item.productTitle
            if (!lastBumpByKey[k] || item.bumpedAt > lastBumpByKey[k]) {
              lastBumpByKey[k] = item.bumpedAt
            }
          })

        const now = new Date()
        const nowMins = now.getHours() * 60 + now.getMinutes()
        const nowTs = Math.floor(now.getTime() / 1000)

        const activeLotByKey = {}
        for (const lot of activeLots) {
          const key = getProductKey(lot)
          if (!activeLotByKey[key]) activeLotByKey[key] = lot
        }

        for (const [key, s] of Object.entries(settingsByKey)) {
          if (!s?.autobump?.enabled || !Array.isArray(s.autobump.schedule) || s.autobump.schedule.length === 0) continue
          const lot = activeLotByKey[key]
          if (!lot) continue

          for (const win of s.autobump.schedule) {
            const startParts = (win.start || '00:00').toString().split(':')
            const endParts = (win.end || '23:59').toString().split(':')
            const startMins = parseInt(startParts[0], 10) * 60 + parseInt(startParts[1], 10) || 0
            const endMins = parseInt(endParts[0], 10) * 60 + parseInt(endParts[1], 10) || 0
            const inWindow = startMins <= endMins
              ? (nowMins >= startMins && nowMins < endMins)
              : (nowMins >= startMins || nowMins < endMins)
            if (!inWindow) continue

            const intervalSec = (win.intervalMinutes || 3) * 60
            const last = lastBumpByKey[key] || 0
            if (nowTs - last < intervalSec) continue

            try {
              const lastAttempt = autobumpLastAttemptByKeyRef.current[key] || 0
              if (nowTs - lastAttempt < 60) break
              autobumpLastAttemptByKeyRef.current[key] = nowTs
              console.info('[autobump] attempt', {
                productKey: key,
                itemId: lot.id,
                title: lot.title,
                window: {
                  start: win.start,
                  end: win.end,
                  intervalMinutes: win.intervalMinutes || 3,
                },
                nowTs,
                lastBumpTs: last,
              })
              await recordBump(token, {
                productKey: key,
                productTitle: lot.title,
                itemId: lot.id,
                price: Number(lot.price) || 0,
                priorityStatusId: s?.autobump?.priorityStatusId,
              })
              lastBumpByKey[key] = nowTs
              console.info('[autobump] success', { productKey: key, itemId: lot.id, bumpedAt: nowTs })
            } catch (err) {
              console.warn('[autobump] failed', {
                productKey: key,
                itemId: lot.id,
                error: err instanceof Error ? err.message : String(err),
              })
            }
            break
          }
        }

      } catch (_) {
        // ignore
      }
    }

    run()
    const interval = setInterval(run, 30 * 1000)
    return () => clearInterval(interval)
  }, [token, lots, completedLots])

  // Автовыставление по чату: каждые 5 сек проверяем только последний чат.
  useEffect(() => {
    if (!token) return
    let cancelled = false
    const run = async () => {
      try {
        const res = await autolistTick(token)
        if (cancelled) return
        if (res?.action === 'relisted') {
          fetchActiveLots(token).then(setLots).catch(() => { })
          fetchCompletedLots(token).then(setCompletedLots).catch(() => { })
        }
      } catch (_err) {
        // ignore
      }
    }
    run()
    const interval = setInterval(run, 5000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [token])

  if (!authChecked || (!isAuthenticated && !isLoginPage)) {
    if (isLoginPage) {
      return <LoginPage onLoginSuccess={() => setIsAuthenticated(true)} />
    }
    return (
      <div className="app-root" style={{ alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <p style={{ color: 'var(--text-muted)' }}>Загрузка…</p>
      </div>
    )
  }

  if (isLoginPage) {
    return <LoginPage onLoginSuccess={() => setIsAuthenticated(true)} />
  }

  return (
    <div className="app-root">
      <header className="app-header">
        <div className="app-header-left">
          <div className="app-logo">Playeroksait</div>
          <div className="app-subtitle">Панель управления лотами</div>
        </div>
        <label className="theme-toggle">
          <input
            type="checkbox"
            checked={darkTheme}
            onChange={(e) => setDarkTheme(e.target.checked)}
            aria-label="Тёмная тема"
            className="theme-toggle__input"
          />
          <span className="theme-toggle__switch" aria-hidden="true">
            <span className="theme-toggle__knob" />
          </span>
          <span className="theme-toggle__label">Тёмная тема</span>
        </label>
      </header>

      <main className="app-main">
        <aside className="app-sidebar">
          <nav className="tabs-nav" aria-label="Основные разделы">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={
                  'tab-button' +
                  (activeTab === tab.id ? ' tab-button--active' : '')
                }
                onClick={() => navigate('/' + tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </aside>

        <section className="app-content">
          {activeTab === 'lot' && (
            <LotSettingsPage
              key={lotIdFromUrl || 'lot'}
              lot={selectedLot}
              token={token}
              onBack={() => navigate(-1)}
              loading={
                isLotPage &&
                !selectedLot &&
                (loadingLots || loadingCompletedLots)
              }
            />
          )}
          {activeTab === 'auto-listing' && (
            <AutoListingTab
              token={token}
              lots={lots}
              completedLots={completedLots}
              loadingLots={loadingLots || loadingCompletedLots}
              errorLots={errorLots || errorCompletedLots}
            />
          )}
          {activeTab === 'lot-boost' && (
            <LotBoostTab
              token={token}
              lots={lots}
              completedLots={completedLots}
              loadingLots={loadingLots || loadingCompletedLots}
              errorLots={errorLots || errorCompletedLots}
            />
          )}
          {activeTab === 'auto-delivery' && (
            <AutoDeliveryTab
              token={token}
              lots={lots}
              completedLots={completedLots}
              loadingLots={loadingLots || loadingCompletedLots}
              errorLots={errorLots || errorCompletedLots}
            />
          )}
          {activeTab === 'active' && (
            <ActiveLotsTab
              token={token}
              lots={lots}
              loadingLots={loadingLots}
              errorLots={errorLots}
            />
          )}
          {activeTab === 'completed' && (
            <CompletedLotsTab
              token={token}
              lots={completedLots}
              loadingLots={loadingCompletedLots}
              errorLots={errorCompletedLots}
            />
          )}
          {activeTab === 'in-progress' && <InProgressLotsTab token={token} />}
          {activeTab === 'commands' && (
            <CommandsTab
              token={token}
              lots={lots}
              loadingLots={loadingLots}
              errorLots={errorLots}
            />
          )}
          {activeTab === 'token' && (
            <TokenTab token={token} onTokenChange={handleTokenChange} />
          )}
          {activeTab === 'profit' && <ProfitTab token={token} />}
        </section>
      </main>
    </div>
  )
}

export default App

