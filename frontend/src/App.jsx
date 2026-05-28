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
import { AutoDeliveryApiTab } from './features/auto-delivery-api/AutoDeliveryApiTab.jsx'
import { GroupTab } from './features/group/GroupTab.jsx'
import { ActiveLotsTab } from './features/active/ActiveLotsTab.jsx'
import { CompletedLotsTab } from './features/completed/CompletedLotsTab.jsx'
import { LotSettingsPage } from './features/lot/LotSettingsPage.jsx'
import { CommandsTab } from './features/commands/CommandsTab.jsx'
import { ChatTab } from './features/chat/ChatTab.jsx'
import { PartnersTab } from './features/partners/PartnersTab.jsx'
import { SettingsTab } from './features/settings/SettingsTab.jsx'
import { DdosTab } from './features/ddos/DdosTab.jsx'
import { ChatLoggingTab } from './features/chat-logging/ChatLoggingTab.jsx'
import { ProfitTab } from './features/profit/ProfitTab.jsx'
import { ActionsTab } from './features/actions/ActionsTab.jsx'
import { BalanceTab } from './features/balance/BalanceTab.jsx'
import { TestTab } from './features/test/TestTab.jsx'
const LOTS_TABS = new Set(['active', 'auto-listing', 'auto-delivery', 'auto-delivery-api', 'lot-boost'])

const TabIcon = ({ id }) => {
  const common = {
    className: 'tab-button__icon-svg',
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  }

  switch (id) {
    case 'active':
      return (
        <svg {...common}>
          <rect x="4.5" y="4.5" width="15" height="15" rx="4" opacity="0.22" fill="currentColor" stroke="none" />
          <path d="M8.4 12.2l2.2 2.2 5-5" />
        </svg>
      )
    case 'completed':
      return (
        <svg {...common}>
          <rect x="4.5" y="4.5" width="15" height="15" rx="4" opacity="0.18" fill="currentColor" stroke="none" />
          <path d="M8.4 8.8h7.2" />
          <path d="M8.4 12h4.8" />
          <path d="M8.7 15.3l1.6 1.6 3.1-3.2" />
        </svg>
      )
    case 'auto-listing':
      return (
        <svg {...common}>
          <rect x="4.5" y="4.5" width="15" height="15" rx="4" opacity="0.18" fill="currentColor" stroke="none" />
          <path d="M8.4 9.1h7.2" />
          <path d="M8.4 12h7.2" />
          <path d="M8.4 14.9h4.3" />
          <path d="M16.2 15.8h2.8" />
          <path d="M17.6 14.4v2.8" />
        </svg>
      )
    case 'lot-boost':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="7.4" opacity="0.18" fill="currentColor" stroke="none" />
          <path d="M12 16.7V8.8" />
          <path d="M9.2 11.6L12 8.8l2.8 2.8" />
        </svg>
      )
    case 'auto-delivery':
      return (
        <svg {...common}>
          <path d="M12 4.8l6.6 3.3L12 11.4 5.4 8.1 12 4.8z" opacity="0.2" fill="currentColor" stroke="none" />
          <path d="M5.4 8.1V16l6.6 3.2V11.4L5.4 8.1z" opacity="0.14" fill="currentColor" stroke="none" />
          <path d="M18.6 8.1V16L12 19.2v-7.8l6.6-3.3z" />
          <path d="M12 4.8l6.6 3.3L12 11.4 5.4 8.1 12 4.8z" />
          <path d="M14.8 13.2h4.2" />
          <path d="M17.7 11.1l2.1 2.1-2.1 2.1" />
        </svg>
      )
    case 'auto-delivery-api':
      return (
        <svg {...common}>
          <path d="M12 4.8l6.6 3.3L12 11.4 5.4 8.1 12 4.8z" opacity="0.2" fill="currentColor" stroke="none" />
          <path d="M5.4 8.1V16l6.6 3.2V11.4L5.4 8.1z" opacity="0.14" fill="currentColor" stroke="none" />
          <path d="M18.6 8.1V16L12 19.2v-7.8l6.6-3.3z" />
          <path d="M12 4.8l6.6 3.3L12 11.4 5.4 8.1 12 4.8z" />
          <path d="M7.8 13.8h2.4" />
          <path d="M13.8 13.8h2.4" />
          <path d="M19.2 13.8h1" />
        </svg>
      )
    case 'chat':
      return (
        <svg {...common}>
          <path d="M5.2 6.4h13.6v8.2a2 2 0 0 1-2 2h-6.1l-3.9 2v-2H7.2a2 2 0 0 1-2-2V6.4z" opacity="0.18" fill="currentColor" stroke="none" />
          <path d="M8.1 10h7.8" />
          <path d="M8.1 12.9h5.4" />
        </svg>
      )
    case 'group':
      return (
        <svg {...common}>
          <rect x="4.5" y="7.2" width="15" height="12.3" rx="2.8" opacity="0.16" fill="currentColor" stroke="none" />
          <path d="M7.6 10.3h8.8" />
          <path d="M7.6 13h6.2" />
          <path d="M7.6 15.7h4.1" />
          <path d="M11.8 4.8l1.7 1.7h-3.4l1.7-1.7z" />
        </svg>
      )
    case 'partners':
      return (
        <svg {...common}>
          <path
            d="M16.8 21v-2a4.2 4.2 0 0 0-4.2-4.2H7.4A4.2 4.2 0 0 0 3.2 19v2"
          />
          <path d="M10 10.3a3.8 3.8 0 1 0-7.6 0a3.8 3.8 0 0 0 7.6 0z" transform="translate(2.2 0)" />
          <path d="M20.8 21v-2a3.7 3.7 0 0 0-3-3.6" />
          <path d="M16.6 3.8a4 4 0 0 1 0 7.6" />
        </svg>
      )
    case 'commands':
      return (
        <svg {...common}>
          <rect x="4.5" y="5.5" width="15" height="13" rx="3.2" opacity="0.18" fill="currentColor" stroke="none" />
          <path d="M8 10.2l2.4 2.4L8 15" />
          <path d="M12.4 14.9h3.6" />
          <path d="M12.4 10.2h2.2" />
        </svg>
      )
    case 'settings':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="7.2" opacity="0.16" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="2.3" />
          <path d="M12 5.8v1.4" />
          <path d="M12 16.8v1.4" />
          <path d="M18.2 12h-1.4" />
          <path d="M7.2 12H5.8" />
          <path d="M16.4 7.6l-1 1" />
          <path d="M8.6 15.4l-1 1" />
          <path d="M16.4 16.4l-1-1" />
          <path d="M8.6 8.6l-1-1" />
        </svg>
      )
    case 'ddos':
      return (
        <svg {...common}>
          <path d="M12 3.8l7.1 3.2v4.8c0 4.1-2.8 7.4-7.1 8.7-4.3-1.3-7.1-4.6-7.1-8.7V7l7.1-3.2z" opacity="0.18" fill="currentColor" stroke="none" />
          <path d="M12 7.4v5.2" />
          <circle cx="12" cy="15.6" r="0.9" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'chat-logging':
      return (
        <svg {...common}>
          <rect x="5" y="4.5" width="14" height="15" rx="2.5" opacity="0.18" fill="currentColor" stroke="none" />
          <path d="M8.2 9h7.6" />
          <path d="M8.2 12h5.8" />
          <path d="M8.2 15h4.2" />
        </svg>
      )
    case 'balance':
      return (
        <svg {...common}>
          <rect x="4.2" y="6.4" width="15.6" height="11.2" rx="3.2" opacity="0.18" fill="currentColor" stroke="none" />
          <path d="M4.9 9.6h14.2" />
          <circle cx="12" cy="13.3" r="1.8" />
        </svg>
      )
    case 'profit':
      return (
        <svg {...common}>
          <path d="M5.5 18.1h13" />
          <path d="M7.3 14.6l3-3 2.1 2.1 4.3-4.3" />
          <path d="M14.9 9.3h1.8v1.8" />
          <circle cx="7.3" cy="14.6" r="1" opacity="0.25" fill="currentColor" stroke="none" />
          <circle cx="10.3" cy="11.6" r="1" opacity="0.25" fill="currentColor" stroke="none" />
        </svg>
      )
    case 'actions':
      return (
        <svg {...common}>
          <rect x="5.2" y="5.2" width="13.6" height="13.6" rx="3.2" opacity="0.18" fill="currentColor" stroke="none" />
          <path d="M8.9 8.9h6.2v6.2H8.9z" />
          <path d="M3.8 12h1.8" />
          <path d="M18.4 12h1.8" />
          <path d="M12 3.8v1.8" />
          <path d="M12 18.4v1.8" />
        </svg>
      )
    case 'test':
      return (
        <svg {...common}>
          <path d="M8.5 6.2h7v1.8h-7z" opacity="0.2" fill="currentColor" stroke="none" />
          <path d="M7.8 9.4h8.4" />
          <path d="M9.2 12.2h5.6" />
          <path d="M10.6 15h2.8" />
        </svg>
      )
    default:
      return null
  }
}

const TABS = [
  { id: 'active', label: 'Активные' },
  { id: 'completed', label: 'Завершенные' },
  { id: 'auto-listing', label: 'Автовыставление' },
  { id: 'lot-boost', label: 'Поднятие лотов' },
  { id: 'auto-delivery', label: 'Автовыдача' },
  { id: 'auto-delivery-api', label: 'Автовыдача Api' },
  { id: 'group', label: 'Группа' },
  { id: 'chat', label: 'Чаты' },
  { id: 'partners', label: 'Напарники' },
  { id: 'commands', label: 'Команды' },
  { id: 'settings', label: 'Настройки' },
  { id: 'ddos', label: 'Ddos' },
  { id: 'chat-logging', label: 'Логирование Чата' },
  { id: 'balance', label: 'Баланс' },
  { id: 'profit', label: 'Статистика' },
  { id: 'actions', label: 'Действия' },
  { id: 'test', label: 'Тест' },
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
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
  /** На странице чатов по умолчанию боковое меню скрыто, чтобы область чата была шире; ⋯ в шапке переключает меню */
  const [sidebarNavCompact, setSidebarNavCompact] = useState(false)
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
    const needActiveLots =
      activeTab === 'active' ||
      LOTS_TABS.has(activeTab) ||
      pathParts[0] === 'lot'
    if (!needActiveLots) return
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
      activeTab === 'auto-delivery-api' ||
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
    setIsMobileMenuOpen(false)
  }, [location.pathname])

  useEffect(() => {
    if (activeTab === 'chat') {
      setSidebarNavCompact(true)
    } else {
      setSidebarNavCompact(false)
    }
  }, [activeTab])

  useEffect(() => {
    if (!isMobileMenuOpen) return undefined
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        setIsMobileMenuOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isMobileMenuOpen])

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
    <div className={`app-root${isMobileMenuOpen ? ' app-root--menu-open' : ''}`}>
      <header className="app-header">
        <div className="app-header-left">
          <button
            type="button"
            className="mobile-menu-toggle"
            onClick={() => setIsMobileMenuOpen((prev) => !prev)}
            aria-label={isMobileMenuOpen ? 'Закрыть меню' : 'Открыть меню'}
            aria-expanded={isMobileMenuOpen}
            aria-controls="main-sidebar"
          >
            <span className="mobile-menu-toggle__line" />
            <span className="mobile-menu-toggle__line" />
            <span className="mobile-menu-toggle__line" />
          </button>
          {activeTab === 'chat' ? (
            <button
              type="button"
              className="header-sidebar-compact-toggle"
              onClick={() => setSidebarNavCompact((prev) => !prev)}
              title={sidebarNavCompact ? 'Показать боковое меню' : 'Скрыть боковое меню'}
              aria-label={sidebarNavCompact ? 'Показать боковое меню' : 'Скрыть боковое меню'}
            >
              <span aria-hidden="true">⋯</span>
            </button>
          ) : null}
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
            <span className={`theme-toggle__icon ${darkTheme ? 'theme-toggle__icon--moon' : 'theme-toggle__icon--sun'}`} aria-hidden="true">{darkTheme ? '🌙' : '☀'}</span>
            <span className="theme-toggle__label">{darkTheme ? 'Тёмная тема' : 'Светлая тема'}</span>
          </label>
        </div>
      </header>

      <main
        className={
          'app-main' +
          (sidebarNavCompact && activeTab === 'chat' ? ' app-main--nav-compact' : '')
        }
      >
        <aside className={`app-sidebar${isMobileMenuOpen ? ' app-sidebar--open' : ''}`} id="main-sidebar">
          <div className="app-sidebar__mobile-head">
            <button
              type="button"
              className="mobile-menu-close"
              onClick={() => setIsMobileMenuOpen(false)}
              aria-label="Закрыть меню"
            >
              ✕
            </button>
          </div>
          <nav className="tabs-nav" aria-label="Основные разделы">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={
                  'tab-button' +
                  (activeTab === tab.id ? ' tab-button--active' : '')
                }
                title={tab.label}
                onClick={() => {
                  navigate('/' + tab.id)
                  setIsMobileMenuOpen(false)
                }}
              >
                <span className={`tab-button__icon tab-button__icon--${tab.id}`}><TabIcon id={tab.id} /></span>
                <span className="tab-button__text">{tab.label}</span>
              </button>
            ))}
          </nav>
        </aside>

        <section className={`app-content${activeTab === 'chat' ? ' app-content--chat' : ''}`}>
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
          {activeTab === 'auto-delivery-api' && (
            <AutoDeliveryApiTab
              token={token}
              lots={lots}
              completedLots={completedLots}
              loadingLots={loadingLots || loadingCompletedLots}
              errorLots={errorLots || errorCompletedLots}
            />
          )}
          {activeTab === 'group' && (
            <GroupTab
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
          <div className="app-content-panel" hidden={activeTab !== 'chat'}>
            <ChatTab
              token={token}
              moduleSupercellEnabled={moduleSupercellEnabled}
              isPageActive={activeTab === 'chat'}
            />
          </div>
          {activeTab === 'partners' && <PartnersTab token={token} />}
          {activeTab === 'commands' && (
            <CommandsTab
              token={token}
              lots={lots}
              loadingLots={loadingLots}
              errorLots={errorLots}
            />
          )}
          {activeTab === 'settings' && (
            <SettingsTab token={token} onTokenChange={handleTokenChange} onLogout={handleLogout} />
          )}
          {activeTab === 'ddos' && <DdosTab />}
          {activeTab === 'chat-logging' && <ChatLoggingTab />}
          {activeTab === 'balance' && <BalanceTab token={token} />}
          {activeTab === 'profit' && <ProfitTab token={token} />}
          {activeTab === 'actions' && <ActionsTab token={token} />}
          {activeTab === 'test' && <TestTab token={token} />}
        </section>
      </main>
    </div>
  )
}

export default App

