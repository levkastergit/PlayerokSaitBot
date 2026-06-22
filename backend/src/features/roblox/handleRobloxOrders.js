'use strict'

const roblox = require('../../integrations/roblox/robloxClient')
const loginService = require('../../integrations/roblox/loginServiceClient')

// Токен заказа (twofa_token) ↔ живая сессия браузера в login_service (sid). Только в памяти:
// сессия короткоживущая, login_service сам её закрывает по TTL.
const loginSessions = new Map() // token -> { sid, userId, orderId, type, mediaType, blob, publicKey, createdAt, username, password, attemptAt }
const SESSION_TTL_MS = 15 * 60 * 1000
// Через сколько 2FA-попытку считаем истёкшей: код/пуш Roblox живёт недолго. После этого страница
// показывает «истекло» и кнопку «Запросить повторно» (пере-логин по тем же кредам, пока жива сессия).
const ATTEMPT_TTL_MS = 5 * 60 * 1000
// Креды покупателя в ПАМЯТИ (не в БД): чтобы не переспрашивать пароль при повторном входе по заказу.
// Заводим при создании заказа/входе, чистим после успешного входа и по TTL.
const orderCreds = new Map() // orderId -> { username, password, at }
const ORDER_CREDS_TTL_MS = 30 * 60 * 1000

function pruneSessions() {
  const now = Date.now()
  for (const [k, v] of loginSessions) {
    if (now - Number(v.createdAt || 0) > SESSION_TTL_MS) loginSessions.delete(k)
  }
  for (const [k, v] of orderCreds) {
    if (now - Number(v.at || 0) > ORDER_CREDS_TTL_MS) orderCreds.delete(k)
  }
}

function rememberOrderCreds(orderId, username, password) {
  if (!orderId || !username || !password) return
  orderCreds.set(Number(orderId), { username: String(username), password: String(password), at: Date.now() })
}

function publicBaseUrl(deps) {
  return String((deps && deps.publicBaseUrl) || process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '')
}

// Ссылка для покупателя по текущему статусу заказа (капча/2FA).
function loginLinkFor(order, deps) {
  if (!order || !order.twofaToken) return null
  const base = publicBaseUrl(deps)
  if (order.status === 'awaiting_captcha') return `${base}/roblox/captcha/${order.twofaToken}`
  if (order.status === 'awaiting_2fa') return `${base}/roblox/2fa/${order.twofaToken}`
  return null
}

function withLink(order, deps) {
  if (!order) return order
  // Отдаём сохранённый пароль (из памяти) обратно владельцу заказа — чтобы карточка показала его
  // звёздочками с «глазиком» и не переспрашивала. Только своему авторизованному продавцу.
  const c = orderCreds.get(Number(order.id))
  const out = { ...order, loginLink: loginLinkFor(order, deps), buyerPasswordStored: (c && c.password) || null }
  // Срок действия 2FA-подтверждения — чтобы карточка заказа показала таймер/«истекло».
  if (order.status === 'awaiting_2fa' && order.twofaToken) {
    const sess = loginSessions.get(order.twofaToken)
    if (!sess) {
      out.twofaExpired = true
      out.twofaExpiresInSec = 0
    } else {
      const left = Math.round((Number(sess.attemptAt || sess.createdAt || 0) + ATTEMPT_TTL_MS - Date.now()) / 1000)
      out.twofaExpired = left <= 0
      out.twofaExpiresInSec = Math.max(0, left)
    }
  }
  return out
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
  orderCreds.delete(Number(order.id)) // вход выполнен — пароль больше не нужен
  return saved
}

const loginInFlight = new Set() // orderId с входом «в полёте» — не пускаем параллельный/повторный вход

// Запустить вход покупателя для заказа через login_service (браузерный движок: логин+PoW+капча/2FA).
// Возвращает {status:'ready'|'awaiting_2fa'|'awaiting_captcha'|'pending'|'failed', token?, error?}.
// Обёртка: пока один вход для заказа идёт, второй (авто+ручной гонка) отклоняем — иначе Roblox
// ловит «An unknown error» на параллельном входе и заказ откатывается с ready.
async function startLoginForOrder(args) {
  const id = args && args.order && args.order.id
  if (id != null && loginInFlight.has(id)) {
    return { status: 'failed', error: 'Вход для этого заказа уже выполняется — подождите немного.' }
  }
  if (id != null) loginInFlight.add(id)
  try {
    return await startLoginForOrderImpl(args)
  } finally {
    if (id != null) loginInFlight.delete(id)
  }
}

async function startLoginForOrderImpl({ username, password, order, currentUserId, deps }) {
  const { robloxOrdersRepo } = deps
  pruneSessions()
  const res = await loginService.start(username, password, 30)

  if (res.status === 'ok' && res.roblosecurity) {
    try {
      await finalizeBuyerSession({ userId: currentUserId, order, cookie: res.roblosecurity, fallbackUser: res.account, deps })
      return { status: 'ready' }
    } catch (err) {
      robloxOrdersRepo.setState(currentUserId, order.id, {
        status: 'failed', phase: 'login',
        logMessage: 'Сессия получена, но не сохранена: ' + (err && err.message ? err.message : ''),
      })
      return { status: 'failed', error: err && err.message ? String(err.message) : 'Не удалось сохранить сессию' }
    }
  }

  if (res.status === '2fa' && res.sid) {
    const token = robloxOrdersRepo.setTwofaPending(currentUserId, order.id, res.mediaType || 'authenticator')
    loginSessions.set(token, { sid: res.sid, userId: currentUserId, orderId: order.id, type: '2fa', mediaType: res.mediaType, username, password, createdAt: Date.now(), attemptAt: Date.now() })
    robloxOrdersRepo.setState(currentUserId, order.id, {
      status: 'awaiting_2fa', phase: 'awaiting_2fa',
      logMessage: `Требуется 2FA (${res.mediaType || 'код'}). Ссылка покупателю сформирована.`,
    })
    return { status: 'awaiting_2fa', token }
  }

  if (res.status === '2fa_push' && res.sid) {
    const token = robloxOrdersRepo.setTwofaPending(currentUserId, order.id, 'push')
    loginSessions.set(token, { sid: res.sid, userId: currentUserId, orderId: order.id, type: 'push', mediaType: 'push', username, password, createdAt: Date.now(), attemptAt: Date.now() })
    robloxOrdersRepo.setState(currentUserId, order.id, {
      status: 'awaiting_2fa', phase: 'awaiting_2fa',
      logMessage: 'Требуется подтверждение входа в приложении Roblox (апрув с телефона).',
    })
    return { status: 'awaiting_2fa', token }
  }

  if (res.status === 'captcha' && res.sid) {
    const token = robloxOrdersRepo.setCaptchaPending(currentUserId, order.id)
    loginSessions.set(token, { sid: res.sid, userId: currentUserId, orderId: order.id, type: 'captcha', blob: res.blob, publicKey: res.publicKey, username, password, createdAt: Date.now(), attemptAt: Date.now() })
    robloxOrdersRepo.setState(currentUserId, order.id, {
      status: 'awaiting_captcha', phase: 'awaiting_captcha',
      logMessage: 'Требуется капча. Ссылка покупателю сформирована.',
    })
    return { status: 'awaiting_captcha', token }
  }

  if (res.status === 'pending' && res.sid) {
    // pending = login_service не определился за wait (затянулось/застряло). Это НЕ 2FA —
    // ссылку покупателю НЕ даём и за 2FA не выдаём. Закрываем зависшую сессию, оставляем
    // заказ в awaiting_login для повторной попытки продавцом.
    try { await loginService.close(res.sid) } catch (_) {}
    robloxOrdersRepo.setState(currentUserId, order.id, {
      status: 'failed', phase: 'login',
      logMessage: 'Вход не завершился вовремя (login_service: pending). Нажмите «Повторить вход».',
    })
    return { status: 'failed', error: 'Вход не завершился вовремя — повторите.' }
  }

  robloxOrdersRepo.setState(currentUserId, order.id, {
    status: 'failed', phase: 'login',
    logMessage: 'Вход не удался: ' + (res.error || res.status || 'ошибка login_service'),
  })
  return { status: 'failed', error: res.error || 'Вход не удался' }
}

async function handleOrdersList({ currentUserId, deps }) {
  const { robloxOrdersRepo } = deps
  const orders = robloxOrdersRepo.listOrders(currentUserId).map((o) => withLink(o, deps))
  return { statusCode: 200, data: { ok: true, orders } }
}

// Создать заказ. Если переданы логин (buyerUsername) и пароль — сразу запускаем вход.
async function handleOrderCreate({ payload, currentUserId, deps }) {
  const { robloxOrdersRepo } = deps
  const robuxAmount = payload && payload.robuxAmount != null ? Number(payload.robuxAmount) : null
  if (!Number.isFinite(robuxAmount) || robuxAmount <= 0) {
    return { statusCode: 400, data: { ok: false, error: 'Укажите количество Robux' } }
  }
  const username = payload && payload.buyerUsername != null ? String(payload.buyerUsername).trim() : ''
  const password = payload && payload.password != null ? String(payload.password) : ''

  const order = robloxOrdersRepo.createOrder(currentUserId, {
    robuxAmount: Math.floor(robuxAmount),
    buyerUsername: username || undefined,
    note: payload && payload.note,
    microsoftAccountId: payload && payload.microsoftAccountId,
  })

  let login = null
  if (username && password) {
    rememberOrderCreds(order.id, username, password)
    try {
      login = await startLoginForOrder({ username, password, order, currentUserId, deps })
    } catch (err) {
      login = { status: 'failed', error: err && err.message ? String(err.message) : 'Ошибка входа' }
    }
  }

  const fresh = robloxOrdersRepo.getOrder(currentUserId, order.id)
  return { statusCode: 200, data: { ok: true, order: withLink(fresh, deps), login } }
}

async function handleOrderCancel({ payload, currentUserId, deps }) {
  const { robloxOrdersRepo } = deps
  const id = payload && payload.orderId != null ? Number(payload.orderId) : null
  if (!Number.isFinite(id)) return { statusCode: 400, data: { ok: false, error: 'Не передан orderId' } }
  const order = robloxOrdersRepo.setState(currentUserId, id, {
    status: 'canceled', phase: 'canceled', logMessage: 'Заказ отменён вручную',
  })
  if (!order) return { statusCode: 404, data: { ok: false, error: 'Заказ не найден' } }
  return { statusCode: 200, data: { ok: true, order: withLink(order, deps) } }
}

// Повторный/ручной запуск входа для существующего заказа. Пароль можно НЕ передавать — возьмём
// сохранённый при создании заказа (в памяти). Передан непустой — перезапишем (возможность исправить).
async function handleOrderLogin({ payload, currentUserId, deps }) {
  const { robloxOrdersRepo } = deps
  pruneSessions()
  const orderId = payload && payload.orderId != null ? Number(payload.orderId) : null
  if (!Number.isFinite(orderId)) return { statusCode: 400, data: { ok: false, error: 'Не передан orderId' } }

  const order = robloxOrdersRepo.getOrder(currentUserId, orderId)
  if (!order) return { statusCode: 404, data: { ok: false, error: 'Заказ не найден' } }
  // Уже вошли — повторный вход не нужен и опасен (Roblox даёт «unknown error» на повторном входе,
  // и заказ откатывается). Просто возвращаем текущее состояние.
  if (order.status === 'ready') {
    return { statusCode: 200, data: { ok: true, status: 'ready', loginStatus: 'ready', order: withLink(order, deps) } }
  }

  const stored = orderCreds.get(orderId) || {}
  const username =
    (payload && payload.username != null && String(payload.username).trim()) || stored.username || order.buyerUsername || ''
  const password = (payload && payload.password != null && String(payload.password)) || stored.password || ''
  if (!username || !password) {
    return { statusCode: 400, data: { ok: false, error: 'Введите пароль покупателя' } }
  }
  rememberOrderCreds(orderId, username, password)

  const r = await startLoginForOrder({ username, password, order, currentUserId, deps })
  const fresh = withLink(robloxOrdersRepo.getOrder(currentUserId, orderId), deps)
  return {
    statusCode: r.status === 'failed' ? 422 : 200,
    data: {
      ok: r.status !== 'failed',
      status: fresh.status,
      loginStatus: r.status,
      needsLink: r.status === 'awaiting_2fa' || r.status === 'awaiting_captcha',
      loginLink: fresh.loginLink,
      order: fresh,
      error: r.error || null,
    },
  }
}

// ── Hosted-страница 2FA (отдаётся покупателю, без сессии сайта) ───────────────
function renderTwofaPage(token, { error, done, expired, canResend, expiresInSec, mediaType } = {}) {
  const safeToken = String(token || '').replace(/[^a-f0-9]/gi, '')
  const isPush = mediaType === 'push'
  const codeSrc = { authenticator: 'приложения-аутентификатора', email: 'письма на e-mail аккаунта', sms: 'SMS' }[mediaType]
    || 'приложения-аутентификатора / SMS / e-mail'
  const resendForm = `<form method="POST" action="/roblox/2fa/${safeToken}" style="margin-top:8px"><input type="hidden" name="resend" value="1" /><button type="submit">Запросить заново</button></form>`
  const expiredBlock = `<p class="err">⏳ Срок действия подтверждения истёк.${canResend ? ' Запросите заново.' : ' Попросите у продавца новую ссылку.'}</p>${canResend ? resendForm : ''}`
  const errLine = error ? `<p class="err">${String(error).replace(/</g, '&lt;')}</p>` : ''

  let lead = ''
  let inner = ''
  if (done) {
    inner = '<p class="ok">✓ Вход выполнен. Можете закрыть страницу.</p>'
  } else if (expired) {
    inner = expiredBlock
  } else {
    const ttl = Number(expiresInSec) > 0 ? Math.floor(Number(expiresInSec)) : 0
    const timer = ttl > 0 ? `<p class="lead" id="cdline">Действует ещё <b id="cd">--:--</b></p>` : ''
    let formBlock
    if (isPush) {
      lead = `<p class="lead">В приложении <b>Roblox</b> на телефоне придёт запрос «Это вы пытаетесь войти?» — нажмите <b>Yes / Это я</b>, затем кнопку ниже.</p>`
      formBlock = `<form method="POST" action="/roblox/2fa/${safeToken}"><button type="submit">Я подтвердил в приложении</button></form>`
    } else {
      lead = `<p class="lead">Введите 6-значный код из ${codeSrc}.</p>`
      formBlock = `<form method="POST" action="/roblox/2fa/${safeToken}"><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6-значный код" pattern="[0-9]*" autofocus /><button type="submit">Подтвердить</button></form>`
    }
    const cdScript = ttl > 0
      ? `<script>(function(){var left=${ttl},cd=document.getElementById('cd');(function t(){var m=Math.floor(left/60),s=left%60;if(cd)cd.textContent=m+':'+(s<10?'0':'')+s;if(left<=0){['liveForm','cdline'].forEach(function(i){var x=document.getElementById(i);if(x)x.style.display='none';});var e=document.getElementById('expiredBlock');if(e)e.style.display='block';return;}left--;setTimeout(t,1000);})();})();</script>`
      : ''
    inner = `${timer}<div id="liveForm">${errLine}${formBlock}</div><div id="expiredBlock" style="display:none">${expiredBlock}</div>${cdScript}`
  }

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
      button.sec{background:#2c313c}
      .err{color:#f87171;font-size:.9rem}.ok{color:#34d399;font-size:.95rem}
    </style></head><body>
    <div class="card">
      <h1>Подтверждение входа Roblox</h1>
      ${lead}${inner}
    </div></body></html>`
}

// GET /roblox/2fa/:token — отдать страницу.
async function handleTwofaPage({ token, deps }) {
  const { robloxOrdersRepo } = deps
  pruneSessions()
  const order = robloxOrdersRepo.getOrderByTwofaToken(token)
  if (!order || order.status !== 'awaiting_2fa') {
    return { statusCode: 404, html: renderTwofaPage(token, { error: 'Ссылка недействительна или вход уже выполнен.' }) }
  }
  const sess = loginSessions.get(token)
  const media = (sess && sess.mediaType) || order.twofaMediaType || 'authenticator'
  if (!sess) {
    // Сессия браузера выметена по TTL — пере-логин кредами уже невозможен, нужна новая ссылка.
    return { statusCode: 200, html: renderTwofaPage(token, { expired: true, canResend: false, mediaType: media }) }
  }
  const elapsed = Date.now() - Number(sess.attemptAt || sess.createdAt || 0)
  if (elapsed > ATTEMPT_TTL_MS) {
    return { statusCode: 200, html: renderTwofaPage(token, { expired: true, canResend: !!sess.password, mediaType: media }) }
  }
  const expiresInSec = Math.max(10, Math.round((ATTEMPT_TTL_MS - elapsed) / 1000))
  return { statusCode: 200, html: renderTwofaPage(token, { expiresInSec, canResend: !!sess.password, mediaType: media }) }
}

// Пере-логин теми же кредами, переиспользуя тот же token (ссылка покупателю не меняется).
async function reloginForToken({ token, order, sess, deps }) {
  try { if (sess.sid) await loginService.close(sess.sid) } catch (_) {}
  const r = await loginService.start(sess.username, sess.password, 30)
  if (r.status === 'ok' && r.roblosecurity) {
    try {
      await finalizeBuyerSession({ userId: sess.userId, order, cookie: r.roblosecurity, fallbackUser: r.account, deps })
    } catch (err) {
      return { statusCode: 502, html: renderTwofaPage(token, { error: 'Сессия получена, но не сохранена: ' + (err && err.message ? err.message : '') }) }
    }
    loginSessions.delete(token)
    return { statusCode: 200, html: renderTwofaPage(token, { done: true }) }
  }
  if ((r.status === '2fa' || r.status === '2fa_push' || r.status === 'pending') && r.sid) {
    const mediaType = r.mediaType || (r.status === '2fa_push' ? 'push' : sess.mediaType) || 'authenticator'
    loginSessions.set(token, {
      sid: r.sid, userId: sess.userId, orderId: order.id, type: r.status, mediaType,
      username: sess.username, password: sess.password, createdAt: Date.now(), attemptAt: Date.now(),
    })
    deps.robloxOrdersRepo.setState(sess.userId, order.id, {
      status: 'awaiting_2fa', phase: 'awaiting_2fa', logMessage: 'Покупатель запросил код повторно.',
    })
    return { statusCode: 200, html: renderTwofaPage(token, { expiresInSec: Math.round(ATTEMPT_TTL_MS / 1000), canResend: true }) }
  }
  return { statusCode: 200, html: renderTwofaPage(token, { error: (r && r.error) || 'Не удалось перезапросить код. Попросите у продавца новую ссылку.' }) }
}

// POST /roblox/2fa/:token — код / пустой (опрос push) / resend=1 (запросить повторно).
async function handleTwofaSubmit({ token, code, resend, deps }) {
  const { robloxOrdersRepo } = deps
  pruneSessions()
  const order = robloxOrdersRepo.getOrderByTwofaToken(token)
  const sess = loginSessions.get(token)
  if (!order || !sess) {
    return { statusCode: 200, html: renderTwofaPage(token, { expired: true, canResend: false }) }
  }
  if (resend) {
    if (!sess.password) return { statusCode: 200, html: renderTwofaPage(token, { expired: true, canResend: false }) }
    return reloginForToken({ token, order, sess, deps })
  }
  const res = code
    ? await loginService.submit2fa(sess.sid, String(code).trim())
    : await loginService.poll(sess.sid)

  if (res.status === 'ok' && res.roblosecurity) {
    try {
      await finalizeBuyerSession({ userId: sess.userId, order, cookie: res.roblosecurity, fallbackUser: res.account, deps })
    } catch (err) {
      return { statusCode: 502, html: renderTwofaPage(token, { error: 'Сессия получена, но не сохранена: ' + (err && err.message ? err.message : '') }) }
    }
    loginSessions.delete(token)
    return { statusCode: 200, html: renderTwofaPage(token, { done: true }) }
  }
  if (res.status === 'pending') {
    return { statusCode: 200, html: renderTwofaPage(token, { error: 'Ещё проверяем… если подтверждали в приложении — подождите и нажмите ещё раз.' }) }
  }
  return { statusCode: 422, html: renderTwofaPage(token, { error: res.error || 'Код не принят, попробуйте ещё раз.' }) }
}

// ── Кооперативная капча (hosted-страница с виджетом FunCaptcha/Arkose) ─────────
function renderCaptchaPage(token, { publicKey, blob, error } = {}) {
  const safeToken = String(token || '').replace(/[^a-f0-9]/gi, '')
  const style = `body{font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#0f1116;color:#e8eaed;display:flex;
      min-height:100vh;align-items:center;justify-content:center;margin:0}
    .card{background:#1a1d24;padding:28px 26px;border-radius:14px;max-width:420px;width:92%;
      box-shadow:0 10px 40px rgba(0,0,0,.4)}
    h1{font-size:1.15rem;margin:0 0 6px}
    p.lead{color:#9aa0aa;font-size:.9rem;margin:0 0 18px;line-height:1.4}
    #arkose{min-height:80px;display:flex;justify-content:center}
    .err{color:#f87171;font-size:.9rem}.ok{color:#34d399;font-size:.95rem}`
  if (error) {
    return `<!doctype html><html lang="ru"><head><meta charset="utf-8"/>
      <meta name="viewport" content="width=device-width, initial-scale=1"/><title>Проверка Roblox</title>
      <style>${style}</style></head><body><div class="card"><h1>Подтверждение входа Roblox</h1>
      <p class="err">${String(error).replace(/</g, '&lt;')}</p></div></body></html>`
  }
  const pk = String(publicKey || '476068BF-9607-4799-B53D-966BE98E2B81').replace(/[^a-z0-9-]/gi, '')
  const blobJs = JSON.stringify(blob || '')
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/><title>Проверка Roblox</title>
    <style>${style}</style></head><body>
    <div class="card">
      <h1>Подтверждение входа Roblox</h1>
      <p class="lead">Пройдите проверку безопасности, чтобы подтвердить вход в аккаунт. После прохождения страница сообщит результат.</p>
      <div id="arkose"></div>
      <p id="msg" class="lead"></p>
    </div>
    <script>
      var BLOB = ${blobJs};
      var PATH = location.pathname;
      function msg(t, cls){ var m=document.getElementById('msg'); m.textContent=t; m.className = cls||'lead'; }
      function submitToken(t){
        msg('Проверяем…');
        fetch(PATH, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({token:t})})
          .then(function(r){return r.json();})
          .then(function(j){
            if (j.ok && j.status==='ready') { msg('✓ Готово! Вход подтверждён, можете закрыть страницу.', 'ok'); }
            else if (j.ok && j.needs2fa && j.twofaUrl) { msg('Капча пройдена. Переходим к вводу кода 2FA…', 'ok'); setTimeout(function(){location.href=j.twofaUrl;}, 900); }
            else { msg(j.error || 'Не удалось. Обновите страницу и попробуйте снова.', 'err'); }
          })
          .catch(function(){ msg('Сеть недоступна. Попробуйте ещё раз.', 'err'); });
      }
      function setupEnforcement(enf){
        try {
          enf.setConfig({
            selector:'#arkose', mode:'inline',
            data: BLOB ? { blob: BLOB } : undefined,
            onCompleted: function(r){ submitToken(r.token); },
            onError: function(){ msg('Ошибка проверки. Обновите страницу.', 'err'); },
            onFailed: function(){ msg('Проверка не пройдена. Попробуйте снова.', 'err'); }
          });
          enf.run();
        } catch (e) { msg('Не удалось загрузить проверку: ' + e, 'err'); }
      }
    </script>
    <script src="https://arkoselabs.roblox.com/v2/${pk}/api.js" data-callback="setupEnforcement" async defer></script>
    </body></html>`
}

// GET /roblox/captcha/:token — отдать страницу с виджетом.
async function handleCaptchaPage({ token, deps }) {
  const { robloxOrdersRepo } = deps
  pruneSessions()
  const order = robloxOrdersRepo.getOrderByTwofaToken(token)
  const sess = loginSessions.get(token)
  if (!order || order.status !== 'awaiting_captcha' || !sess) {
    return { statusCode: 404, html: renderCaptchaPage(token, { error: 'Ссылка недействительна или капча уже решена.' }) }
  }
  return { statusCode: 200, html: renderCaptchaPage(token, { publicKey: sess.publicKey, blob: sess.blob }) }
}

// POST /roblox/captcha/:token — токен капчи → довести вход через login_service (может потребоваться 2FA).
async function handleCaptchaSubmit({ token, captchaToken, deps }) {
  const { robloxOrdersRepo } = deps
  pruneSessions()
  const order = robloxOrdersRepo.getOrderByTwofaToken(token)
  const sess = loginSessions.get(token)
  if (!order || !sess) {
    return { statusCode: 404, data: { ok: false, error: 'Ссылка недействительна или истекла. Запросите вход заново.' } }
  }
  if (!captchaToken) {
    return { statusCode: 400, data: { ok: false, error: 'Нет токена капчи.' } }
  }

  const res = await loginService.submitCaptcha(sess.sid, String(captchaToken))

  if (res.status === 'ok' && res.roblosecurity) {
    try {
      await finalizeBuyerSession({ userId: sess.userId, order, cookie: res.roblosecurity, fallbackUser: res.account, deps })
    } catch (err) {
      return { statusCode: 502, data: { ok: false, error: 'Сессия получена, но не сохранена: ' + (err && err.message ? err.message : '') } }
    }
    loginSessions.delete(token)
    return { statusCode: 200, data: { ok: true, status: 'ready' } }
  }

  // Капча пройдена, но дальше включена 2FA — переводим заказ на 2FA и отдаём новую ссылку.
  if (res.status === '2fa' && res.sid) {
    loginSessions.delete(token)
    const twofaToken = robloxOrdersRepo.setTwofaPending(sess.userId, order.id, res.mediaType || 'authenticator')
    loginSessions.set(twofaToken, { sid: res.sid, userId: sess.userId, orderId: order.id, type: '2fa', mediaType: res.mediaType, createdAt: Date.now() })
    robloxOrdersRepo.setState(sess.userId, order.id, {
      status: 'awaiting_2fa', phase: 'awaiting_2fa',
      logMessage: `Капча пройдена, требуется 2FA (${res.mediaType || 'код'}).`,
    })
    const base = publicBaseUrl(deps)
    return { statusCode: 200, data: { ok: true, status: 'awaiting_2fa', needs2fa: true, twofaUrl: `${base}/roblox/2fa/${twofaToken}`, mediaType: res.mediaType } }
  }

  return { statusCode: 422, data: { ok: false, error: res.error || 'Капча не принята, попробуйте ещё раз.' } }
}

module.exports = {
  handleOrdersList,
  handleOrderCreate,
  handleOrderCancel,
  handleOrderLogin,
  handleTwofaPage,
  handleTwofaSubmit,
  handleCaptchaPage,
  handleCaptchaSubmit,
}
