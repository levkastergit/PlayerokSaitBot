import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { login } from '../../services/authApi'
import './LoginPage.css'

export function LoginPage({ onLoginSuccess }) {
  const navigate = useNavigate()
  const [loginValue, setLoginValue] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    setLoading(true)
    const result = await login(loginValue, password)
    setLoading(false)
    if (result.ok) {
      onLoginSuccess?.()
      navigate('/active', { replace: true })
    } else {
      setError(result.error || 'Неверный логин или пароль')
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1 className="login-title">Playeroksait</h1>
        <p className="login-subtitle">Войдите в панель управления</p>
        <form className="login-form" onSubmit={handleSubmit}>
          <label className="login-label">
            Логин
            <input
              type="text"
              className="login-input"
              value={loginValue}
              onChange={(e) => setLoginValue(e.target.value)}
              autoComplete="username"
              required
              autoFocus
            />
          </label>
          <label className="login-label">
            Пароль
            <input
              type="password"
              className="login-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          {error && <p className="login-error" role="alert">{error}</p>}
          <button type="submit" className="login-submit" disabled={loading}>
            {loading ? 'Вход…' : 'Войти'}
          </button>
        </form>
      </div>
    </div>
  )
}
