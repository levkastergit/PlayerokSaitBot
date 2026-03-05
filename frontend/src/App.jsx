import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import './index.css'
import { AutoListingTab } from './features/auto-listing/AutoListingTab.jsx'
import { LotBoostTab } from './features/lot-boost/LotBoostTab.jsx'
import { AutoDeliveryTab } from './features/auto-delivery/AutoDeliveryTab.jsx'
import { ActiveLotsTab } from './features/active/ActiveLotsTab.jsx'
import { CompletedLotsTab } from './features/completed/CompletedLotsTab.jsx'
import { TokenTab } from './features/token/TokenTab.jsx'
import { HistoryTab } from './features/history/HistoryTab.jsx'

const TABS = [
  { id: 'active', label: 'Активные' },
  { id: 'completed', label: 'Завершенные' },
  { id: 'auto-listing', label: 'Автовыставление' },
  { id: 'lot-boost', label: 'Поднятие лотов' },
  { id: 'auto-delivery', label: 'Автовыдача' },
  { id: 'token', label: 'Токен' },
  { id: 'history', label: 'История' },
]

const TAB_IDS = new Set(TABS.map((t) => t.id))

function App() {
  const location = useLocation()
  const navigate = useNavigate()
  const pathParts = location.pathname.split('/').filter(Boolean)
  const activeTab = TAB_IDS.has(pathParts[0]) ? pathParts[0] : 'active'
  const activeLotId = activeTab === 'active' ? pathParts[1] || null : null

  useEffect(() => {
    if (location.pathname === '/' || location.pathname === '') {
      navigate('/active', { replace: true })
    }
  }, [location.pathname, navigate])
  const [darkTheme, setDarkTheme] = useState(() => {
    try {
      return window.localStorage.getItem('theme') === 'dark'
    } catch {
      return false
    }
  })
  const [token, setToken] = useState(() => {
    try {
      return window.localStorage.getItem('playerokToken') || ''
    } catch {
      return ''
    }
  })

  useEffect(() => {
    try {
      window.localStorage.setItem('theme', darkTheme ? 'dark' : 'light')
      document.documentElement.setAttribute('data-theme', darkTheme ? 'dark' : 'light')
    } catch {
      // ignore
    }
  }, [darkTheme])

  useEffect(() => {
    try {
      if (token) {
        window.localStorage.setItem('playerokToken', token)
      } else {
        window.localStorage.removeItem('playerokToken')
      }
    } catch {
      // игнорируем ошибки работы с localStorage
    }
  }, [token])

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
          {activeTab === 'auto-listing' && <AutoListingTab token={token} />}
          {activeTab === 'lot-boost' && <LotBoostTab token={token} />}
          {activeTab === 'auto-delivery' && <AutoDeliveryTab token={token} />}
          {activeTab === 'active' && (
            <ActiveLotsTab token={token} lotIdFromUrl={activeLotId} />
          )}
          {activeTab === 'completed' && <CompletedLotsTab token={token} />}
          {activeTab === 'token' && (
            <TokenTab token={token} onTokenChange={setToken} />
          )}
          {activeTab === 'history' && <HistoryTab token={token} />}
        </section>
      </main>
    </div>
  )
}

export default App

