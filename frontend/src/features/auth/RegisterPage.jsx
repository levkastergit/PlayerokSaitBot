import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { register } from '../../services/authApi'
import './LoginPage.css'

export function RegisterPage() {
  const navigate = useNavigate()
  const [loginValue, setLoginValue] = useState('')
  const [password, setPassword] = useState('')
  const [password2, setPassword2] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    if (password !== password2) {
      setError('Пароли не совпадают')
      return
    }
    setLoading(true)
    const result = await register(loginValue, password)
    setLoading(false)
    if (result.ok) {
      navigate('/login', { replace: true })
    } else {
      setError(result.error || 'Ошибка регистрации')
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <h1 className="login-title">Playeroksait</h1>
        <p className="login-subtitle">Создайте новый аккаунт</p>
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
              autoComplete="new-password"
              required
            />
          </label>
          <label className="login-label">
            Повторите пароль
            <input
              type="password"
              className="login-input"
              value={password2}
              onChange={(e) => setPassword2(e.target.value)}
              autoComplete="new-password"
              required
            />
          </label>
          {error && <p className="login-error" role="alert">{error}</p>}
          <button type="submit" className="login-submit" disabled={loading}>
            {loading ? 'Регистрация…' : 'Зарегистрироваться'}
          </button>
          <button
            type="button"
            className="login-submit login-submit--secondary"
            onClick={() => navigate('/login')}
          >
            Назад к входу
          </button>
        </form>
      </div>
    </div>
  )
}

