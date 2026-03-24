import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import './index.css'
import { checkAuth, fetchAuthMe, logout } from './services/authApi'
import {
  fetchActiveLots,
  fetchCompletedLots,
  getProductKey,
  loadStoredToken,
  saveStoredToken,
} from './services/playerokApi'
import { LoginPage } from './features/auth/LoginPage.jsx'
import { RegisterPage } from './features/auth/RegisterPage.jsx'
import { AutoListingTab } from './features/auto-listing/AutoListingTab.jsx'
import { LotBoostTab } from './features/lot-boost/LotBoostTab.jsx'
import { AutoDeliveryTab } from './features/auto-delivery/AutoDeliveryTab.jsx'
import { ActiveLotsTab } from './features/active/ActiveLotsTab.jsx'
import { CompletedLotsTab } from './features/completed/CompletedLotsTab.jsx'
import { LotSettingsPage } from './features/lot/LotSettingsPage.jsx'
import { CommandsTab } from './features/commands/CommandsTab.jsx'
import { ChatTab } from './features/chat/ChatTab.jsx'
import { SettingsTab } from './features/settings/SettingsTab.jsx'
import { ProfitTab } from './features/profit/ProfitTab.jsx'
import { ActionsTab } from './features/actions/ActionsTab.jsx'
import { BalanceTab } from './features/balance/BalanceTab.jsx'
const LOTS_TABS = new Set(['active', 'auto-listing', 'auto-delivery', 'lot-boost'])

const TABS = [
  { id: 'active', label: 'Активные' },
  { id: 'completed', label: 'Завершенные' },
  { id: 'auto-listing', label: 'Автовыставление' },
  { id: 'lot-boost', label: 'Поднятие лотов' },
  { id: 'auto-delivery', label: 'Автовыдача' },
  { id: 'chat', label: 'Чаты' },
  { id: 'commands', label: 'Команды' },
  { id: 'settings', label: 'Настройки' },
  { id: 'balance', label: 'Баланс' },
  { id: 'profit', label: 'Статистика' },
  { id: 'actions', label: 'Действия' },
]

const TAB_IDS = new Set(TABS.map((t) => t.id))

function App() {
  const location = useLocation()
  const navigate = useNavigate()
  const pathParts = location.pathname.split('/').filter(Boolean)
  const isLoginPage = pathParts[0] === 'login'
  const isRegisterPage = pathParts[0] === 'register'
  const isLotPage = pathParts[0] === 'lot' && pathParts[1]
  const lotIdFromUrl = isLotPage ? pathParts[1] : null
  const activeTab =
    isLotPage ? 'lot' : (TAB_IDS.has(pathParts[0]) ? pathParts[0] : 'active')

  const [authChecked, setAuthChecked] = useState(false)
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [moduleSupercellEnabled, setModuleSupercellEnabled] = useState(false)

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
    if ((isLoginPage || isRegisterPage) && isAuthenticated) {
      navigate('/active', { replace: true })
      return
    }
    if (!isLoginPage && !isRegisterPage && !isAuthenticated) {
      navigate('/login', { replace: true })
    }
  }, [authChecked, isLoginPage, isRegisterPage, isAuthenticated, navigate])

  useEffect(() => {
    if (!authChecked || !isAuthenticated) {
      setModuleSupercellEnabled(false)
      return
    }
    let cancelled = false
    fetchAuthMe()
      .then((me) => {
        if (cancelled) return
        setModuleSupercellEnabled(Boolean(me?.ok && me?.moduleSupercell))
      })
      .catch(() => {
        if (cancelled) return
        setModuleSupercellEnabled(false)
      })
    return () => { cancelled = true }
  }, [authChecked, isAuthenticated])

  useEffect(() => {
    if (location.pathname === '/' || location.pathname === '') {
      navigate('/active', { replace: true })
    }
  }, [location.pathname, navigate])

  useEffect(() => {
    const first = location.pathname.split('/').filter(Boolean)[0]
    if (first === 'token') {
      navigate('/settings', { replace: true })
    }
  }, [location.pathname, navigate])
  const [darkTheme, setDarkTheme] = useState(false)
  const [token, setToken] = useState('')

  const [lots, setLots] = useState([])
  const [loadingLots, setLoadingLots] = useState(false)
  const [errorLots, setErrorLots] = useState(null)
  const lastFetchedTokenRef = useRef(null)

  const [completedLots, setCompletedLots] = useState([])
  const [loadingCompletedLots, setLoadingCompletedLots] = useState(false)
  const [errorCompletedLots, setErrorCompletedLots] = useState(null)
  const lastFetchedCompletedTokenRef = useRef(null)

  const handleLogout = async () => {
    try {
      await logout()
    } catch {
      // ignore
    }
    setToken('')
    setIsAuthenticated(false)
    navigate('/login', { replace: true })
  }

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

  // Загружаем токен с сервера только после входа — иначе с другого устройства/браузера запрос идёт без сессии и токен не подставляется
  useEffect(() => {
    if (!authChecked || !isAuthenticated) return
    let cancelled = false
      ; (async () => {
        const stored = await loadStoredToken()
        if (!cancelled) setToken(stored || '')
      })()
    return () => { cancelled = true }
  }, [authChecked, isAuthenticated])

  // Автоподнятие лотов выполняется только на бэкенде (фоновой задачей).

  if (!authChecked || (!isAuthenticated && !isLoginPage && !isRegisterPage)) {
    if (isLoginPage) {
      return <LoginPage onLoginSuccess={() => setIsAuthenticated(true)} />
    }
    if (isRegisterPage) {
      return <RegisterPage />
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
  if (isRegisterPage) {
    return <RegisterPage />
  }

  return (
    <div className="app-root">
      <header className="app-header">
        <div className="app-header-left">
          <div className="app-logo">Playeroksait</div>
          <div className="app-subtitle">Панель управления лотами</div>
        </div>
        <div className="app-header-right">
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
          <button
            type="button"
            className="btn-secondary"
            style={{ marginLeft: '1rem' }}
            onClick={handleLogout}
          >
            Выйти
          </button>
        </div>
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
          {activeTab === 'chat' && <ChatTab token={token} moduleSupercellEnabled={moduleSupercellEnabled} />}
          {activeTab === 'commands' && (
            <CommandsTab
              token={token}
              lots={lots}
              loadingLots={loadingLots}
              errorLots={errorLots}
            />
          )}
          {activeTab === 'settings' && (
            <SettingsTab token={token} onTokenChange={handleTokenChange} />
          )}
          {activeTab === 'balance' && <BalanceTab token={token} />}
          {activeTab === 'profit' && <ProfitTab token={token} />}
          {activeTab === 'actions' && <ActionsTab token={token} />}
        </section>
      </main>
    </div>
  )
}

export default App

