'use strict'

const roblox = require('../../integrations/roblox/robloxClient')
const { startBuyerLogin, completeBuyer2fa } = require('../../integrations/roblox/robloxAuthClient')

// Короткоживущее состояние логина покупателя между запросом логина и вводом 2FA-кода на
// hosted-странице. Хранит пароль для повтора логина — поэтому ТОЛЬКО в памяти, не в БД.
const pendingLogins = new Map() // twofaToken -> { state, username, password, orderId, userId, createdAt }
const PENDING_TTL_MS = 15 * 60 * 1000

function prunePending() {
  const now = Date.now()
  for (const [k, v] of pendingLogins) {
    if (now - Number(v.createdAt || 0) > PENDING_TTL_MS) pendingLogins.delete(k)
  }
}

function publicBaseUrl(deps) {
  return String((deps && deps.publicBaseUrl) || process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '')
}

// Сохранить полученную сессию покупателя как roblox_accounts и перевести заказ в ready.
async function finalizeBuyerSession({ userId, order, cookie, fallbackUser, deps }) {
  const { robloxAccountsRepo, robloxOrdersRepo } = deps
  let user = fallbackUser
  let robux = null
  let lastError = null
  try {
    user = await roblox.getAuthenticatedUser(cookie)
  } catch (err) {
    if (!user) throw err
  }
  try {
    robux = await roblox.getRobuxBalance(cookie, user.id)
  } catch (err) {
    lastError = err && err.message ? String(err.message) : null
  }
  const avatarUrl = await roblox.getAvatarHeadshotUrl(user.id)
  const saved = robloxAccountsRepo.upsertAccount(userId, {
    robloxUserId: user.id,
    username: user.name,
    displayName: user.displayName,
    cookie,
    robux,
    isPremium: false,
    avatarUrl,
    status: lastError ? 'error' : 'active',
    lastError,
  })
  robloxOrdersRepo.setBuyerSession(userId, order.id, {
    buyerAccountId: saved.id,
    buyerUsername: user.name,
  })
  robloxOrdersRepo.setState(userId, order.id, {
    status: 'ready',
    phase: 'ready',
    logMessage: `Вход выполнен: @${user.name}. Заказ готов к выдаче.`,
  })
  return saved
}

async function handleOrdersList({ currentUserId, deps }) {
  const { robloxOrdersRepo } = deps
  return { statusCode: 200, data: { ok: true, orders: robloxOrdersRepo.listOrders(currentUserId) } }
}

async function handleOrderCreate({ payload, currentUserId, deps }) {
  const { robloxOrdersRepo } = deps
  const robuxAmount = payload && payload.robuxAmount != null ? Number(payload.robuxAmount) : null
  if (!Number.isFinite(robuxAmount) || robuxAmount <= 0) {
    return { statusCode: 400, data: { ok: false, error: 'Укажите количество Robux' } }
  }
  const order = robloxOrdersRepo.createOrder(currentUserId, {
    robuxAmount: Math.floor(robuxAmount),
    buyerUsername: payload && payload.buyerUsername,
    note: payload && payload.note,
    microsoftAccountId: payload && payload.microsoftAccountId,
  })
  return { statusCode: 200, data: { ok: true, order } }
}

async function handleOrderCancel({ payload, currentUserId, deps }) {
  const { robloxOrdersRepo } = deps
  const id = payload && payload.orderId != null ? Number(payload.orderId) : null
  if (!Number.isFinite(id)) return { statusCode: 400, data: { ok: false, error: 'Не передан orderId' } }
  const order = robloxOrdersRepo.setState(currentUserId, id, {
    status: 'canceled',
    phase: 'canceled',
    logMessage: 'Заказ отменён вручную',
  })
  if (!order) return { statusCode: 404, data: { ok: false, error: 'Заказ не найден' } }
  return { statusCode: 200, data: { ok: true, order } }
}

// Вход в аккаунт покупателя. Если включена 2FA — возвращаем hosted-ссылку для ввода кода.
async function handleOrderLogin({ payload, currentUserId, deps }) {
  const { robloxOrdersRepo } = deps
  prunePending()
  const orderId = payload && payload.orderId != null ? Number(payload.orderId) : null
  const username = payload && payload.username != null ? String(payload.username).trim() : ''
  const password = payload && payload.password != null ? String(payload.password) : ''
  if (!Number.isFinite(orderId)) return { statusCode: 400, data: { ok: false, error: 'Не передан orderId' } }
  if (!username || !password) return { statusCode: 400, data: { ok: false, error: 'Нужны логин и пароль покупателя' } }

  const order = robloxOrdersRepo.getOrder(currentUserId, orderId)
  if (!order) return { statusCode: 404, data: { ok: false, error: 'Заказ не найден' } }

  const captcha = deps && deps.getCaptchaConfig ? deps.getCaptchaConfig(currentUserId) : null
  let result
  try {
    result = await startBuyerLogin({ username, password, captcha })
  } catch (err) {
    return { statusCode: 502, data: { ok: false, error: err && err.message ? String(err.message) : 'Ошибка логина' } }
  }

  if (result.outcome === 'ok') {
    try {
      const saved = await finalizeBuyerSession({ userId: currentUserId, order, cookie: result.cookie, fallbackUser: result.user, deps })
      return { statusCode: 200, data: { ok: true, status: 'ready', account: saved } }
    } catch (err) {
      return { statusCode: 502, data: { ok: false, error: err && err.message ? String(err.message) : 'Сессия получена, но не сохранена' } }
    }
  }

  if (result.outcome === '2fa') {
    const token = robloxOrdersRepo.setTwofaPending(currentUserId, orderId, result.mediaType)
    pendingLogins.set(token, {
      state: { ...result, username, password },
      orderId,
      userId: currentUserId,
      createdAt: Date.now(),
    })
    robloxOrdersRepo.setState(currentUserId, orderId, {
      status: 'awaiting_2fa',
      phase: 'awaiting_2fa',
      logMessage: `Требуется 2FA (${result.mediaType}). Ссылка отправлена покупателю.`,
    })
    const base = publicBaseUrl(deps)
    const twofaUrl = `${base}/roblox/2fa/${token}`
    return { statusCode: 200, data: { ok: true, status: 'awaiting_2fa', needs2fa: true, twofaToken: token, twofaUrl, mediaType: result.mediaType } }
  }

  if (result.outcome === 'captcha') {
    return { statusCode: 422, data: { ok: false, error: result.error || 'Логин требует капчу (солвер не настроен)' } }
  }

  return { statusCode: 422, data: { ok: false, error: result.error || 'Логин не удался' } }
}

// HTML hosted-страницы 2FA (отдаётся покупателю, без сессии сайта).
function renderTwofaPage(token, { error, done } = {}) {
  const safeToken = String(token || '').replace(/[^a-f0-9]/gi, '')
  const msg = done
    ? '<p class="ok">✓ Код принят. Robux будут выданы автоматически. Можете закрыть страницу.</p>'
    : error
      ? `<p class="err">${String(error).replace(/</g, '&lt;')}</p>`
      : ''
  const form = done
    ? ''
    : `<form method="POST" action="/roblox/2fa/${safeToken}">
         <input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6"
                placeholder="6-значный код" pattern="[0-9]*" required autofocus />
         <button type="submit">Подтвердить</button>
       </form>`
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Подтверждение Roblox</title>
    <style>
      body{font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#0f1116;color:#e8eaed;display:flex;
        min-height:100vh;align-items:center;justify-content:center;margin:0}
      .card{background:#1a1d24;padding:28px 26px;border-radius:14px;max-width:340px;width:90%;
        box-shadow:0 10px 40px rgba(0,0,0,.4)}
      h1{font-size:1.15rem;margin:0 0 6px}
      p.lead{color:#9aa0aa;font-size:.9rem;margin:0 0 18px;line-height:1.4}
      input{width:100%;box-sizing:border-box;padding:12px;font-size:1.3rem;letter-spacing:.3em;text-align:center;
        border-radius:10px;border:1px solid #2c313c;background:#0f1116;color:#fff;margin-bottom:12px}
      button{width:100%;padding:12px;border:0;border-radius:10px;background:#3b82f6;color:#fff;font-size:1rem;cursor:pointer}
      .err{color:#f87171;font-size:.9rem}.ok{color:#34d399;font-size:.95rem}
    </style></head><body>
    <div class="card">
      <h1>Подтверждение входа Roblox</h1>
      <p class="lead">Введите 6-значный код двухфакторной аутентификации из приложения-аутентификатора, SMS или e-mail.</p>
      ${msg}${form}
    </div></body></html>`
}

// GET /roblox/2fa/:token — отдать страницу.
async function handleTwofaPage({ token, deps }) {
  const { robloxOrdersRepo } = deps
  const order = robloxOrdersRepo.getOrderByTwofaToken(token)
  if (!order || order.status !== 'awaiting_2fa') {
    return { statusCode: 404, html: renderTwofaPage(token, { error: 'Ссылка недействительна или код уже введён.' }) }
  }
  return { statusCode: 200, html: renderTwofaPage(token) }
}

// POST /roblox/2fa/:token — принять код, довести логин.
async function handleTwofaSubmit({ token, code, deps }) {
  const { robloxOrdersRepo } = deps
  prunePending()
  const pending = pendingLogins.get(token)
  const order = robloxOrdersRepo.getOrderByTwofaToken(token)
  if (!order || !pending) {
    return { statusCode: 404, html: renderTwofaPage(token, { error: 'Ссылка недействительна или истекла. Запросите вход заново.' }) }
  }
  if (!code) {
    return { statusCode: 400, html: renderTwofaPage(token, { error: 'Введите код.' }) }
  }
  let result
  try {
    result = await completeBuyer2fa({ state: pending.state, code: String(code).trim() })
  } catch (err) {
    return { statusCode: 502, html: renderTwofaPage(token, { error: err && err.message ? String(err.message) : 'Ошибка проверки кода.' }) }
  }
  if (result.outcome !== 'ok' || !result.cookie) {
    return { statusCode: 422, html: renderTwofaPage(token, { error: result.error || 'Код не принят, попробуйте ещё раз.' }) }
  }
  try {
    await finalizeBuyerSession({ userId: pending.userId, order, cookie: result.cookie, fallbackUser: result.user, deps })
  } catch (err) {
    return { statusCode: 502, html: renderTwofaPage(token, { error: 'Сессия получена, но не сохранена: ' + (err && err.message ? err.message : '') }) }
  }
  pendingLogins.delete(token)
  return { statusCode: 200, html: renderTwofaPage(token, { done: true }) }
}

module.exports = {
  handleOrdersList,
  handleOrderCreate,
  handleOrderCancel,
  handleOrderLogin,
  handleTwofaPage,
  handleTwofaSubmit,
}
