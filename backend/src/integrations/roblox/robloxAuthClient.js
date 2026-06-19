'use strict'

// Логин в аккаунт ПОКУПАТЕЛЯ Roblox (swizzyer phase_login + «Auto-Donat» hosted-2FA).
// Кооперативная модель: покупатель сообщает логин/пароль и вводит 6-значный 2FA-код на нашей
// hosted-странице; сервер доводит логин и получает .ROBLOSECURITY, которую дальше использует
// существующий robloxClient.js (баланс/выдача).
//
// Документированная последовательность (Roblox, ~2023+):
//   1) POST auth.roblox.com/v2/login без токена → 403 + заголовок x-csrf-token.
//   2) POST /v2/login c X-CSRF-TOKEN + {ctype:'Username', cvalue, password}.
//        200 → Set-Cookie .ROBLOSECURITY (готово)
//        403 + Rblx-Challenge-* (captcha | twostepverification)
//        либо тело twoStepVerificationData (legacy 2FA)
//   3) 2FA: POST twostepverification.roblox.com/v1/users/{id}/challenges/{mediaType}/verify
//        {challengeId, actionType:'Login', code} → {verificationToken}
//      → POST apis.roblox.com/challenge/v1/continue → повтор /v2/login c Rblx-Challenge-* → cookie.
//
// ВНИМАНИЕ: точное имя challengeType и регистр ключей метаданных 2FA Roblox меняет без анонсов;
// часть помечена TODO «подтвердить живым перехватом». Капча решается через captchaSolver (Фаза 3).

const https = require('https')
const { solveLoginFunCaptcha, ROBLOX_LOGIN_ARKOSE_PUBLIC_KEY } = require('./captchaSolver')

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
const TIMEOUT_MS = 20000

function request({ method = 'GET', url, headers = {}, body, cookie }) {
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(url)
    } catch (_) {
      reject(new Error(`Некорректный URL Roblox: ${url}`))
      return
    }
    const payload = body == null ? null : typeof body === 'string' ? body : JSON.stringify(body)
    const h = { 'User-Agent': DEFAULT_UA, Accept: 'application/json', ...headers }
    if (cookie) h.Cookie = cookie
    if (payload != null) {
      h['Content-Type'] = 'application/json'
      h['Content-Length'] = Buffer.byteLength(payload)
    }
    const req = https.request(
      { method, hostname: u.hostname, path: u.pathname + (u.search || ''), headers: h },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try {
            json = text ? JSON.parse(text) : null
          } catch (_) {
            json = null
          }
          resolve({ status: res.statusCode || 0, headers: res.headers || {}, text, json })
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('Таймаут запроса к Roblox')))
    if (payload != null) req.write(payload)
    req.end()
  })
}

function extractRoblosecurity(setCookie) {
  const arr = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []
  for (const c of arr) {
    const m = String(c).match(/\.ROBLOSECURITY=([^;]+)/)
    if (m && m[1] && m[1] !== 'DELETE') return m[1]
  }
  return null
}

function decodeChallengeMeta(b64) {
  if (!b64) return null
  try {
    return JSON.parse(Buffer.from(String(b64), 'base64').toString('utf8'))
  } catch (_) {
    return null
  }
}

async function getCsrfToken() {
  // /v2/logout без сессии теперь отдаёт 401 без токена. /v2/login без тела → 403 + x-csrf-token
  // (проверка CSRF идёт ДО проверки логина, так что это не попытка входа и не триггерит лимиты).
  const res = await request({ method: 'POST', url: 'https://auth.roblox.com/v2/login', body: {} })
  return res.headers['x-csrf-token'] || res.headers['X-CSRF-TOKEN'] || null
}

// Разбор ответа /v2/login в унифицированный результат.
function interpretLoginResponse(res, ctx) {
  if (res.status === 200) {
    const cookie = extractRoblosecurity(res.headers['set-cookie'])
    if (cookie) {
      return {
        outcome: 'ok',
        cookie,
        user: res.json && res.json.user
          ? { id: Number(res.json.user.id), name: res.json.user.name, displayName: res.json.user.displayName }
          : null,
      }
    }
    return { outcome: 'error', error: 'Логин 200, но cookie .ROBLOSECURITY не получена' }
  }

  const challType = res.headers['rblx-challenge-type'] || null
  const challId = res.headers['rblx-challenge-id'] || null
  const challMetaB64 = res.headers['rblx-challenge-metadata'] || null

  if (res.status === 403 && challType) {
    const meta = decodeChallengeMeta(challMetaB64) || {}
    if (/captcha/i.test(challType)) {
      return { outcome: 'captcha', challengeId: challId, meta, metaB64: challMetaB64, ctx }
    }
    if (/twostep/i.test(challType)) {
      return {
        outcome: '2fa',
        challengeId: meta.challengeId || challId,
        userId: meta.userId || (res.json && res.json.userId) || null,
        mediaType: meta.mediaType || 'authenticator',
        headerChallengeId: challId,
        metaB64: challMetaB64,
        ctx,
      }
    }
    if (/proofofwork|pow/i.test(challType)) {
      return { outcome: 'proofofwork', challengeType: challType, challengeId: challId, meta, metaB64: challMetaB64, ctx }
    }
    return { outcome: 'error', error: `Неизвестный challenge: ${challType}`, challengeType: challType, meta, metaB64: challMetaB64 }
  }

  // Legacy: 2FA в теле ответа.
  const tsv = res.json && res.json.twoStepVerificationData
  if (tsv && (tsv.ticket || tsv.mediaType)) {
    return {
      outcome: '2fa',
      legacy: true,
      ticket: tsv.ticket || null,
      mediaType: tsv.mediaType || 'authenticator',
      userId: (res.json && res.json.user && res.json.user.id) || null,
      ctx,
    }
  }

  const errMsg =
    (res.json && res.json.errors && res.json.errors[0] && res.json.errors[0].message) ||
    `Логин не удался (HTTP ${res.status})`
  return { outcome: 'error', error: errMsg }
}

/**
 * Начать логин покупателя. Возвращает один из исходов:
 *   {outcome:'ok', cookie, user}
 *   {outcome:'2fa', ...state}      — нужен код с hosted-страницы
 *   {outcome:'captcha', ...}       — нужен решатель капчи (Фаза 3)
 *   {outcome:'error', error}
 */
async function startBuyerLogin({ username, password, captcha } = {}) {
  if (!username || !password) return { outcome: 'error', error: 'Нужны логин и пароль покупателя' }
  const csrf = await getCsrfToken()
  if (!csrf) return { outcome: 'error', error: 'Не удалось получить CSRF-токен' }

  const baseHeaders = { 'X-CSRF-TOKEN': csrf }
  let res = await request({
    method: 'POST',
    url: 'https://auth.roblox.com/v2/login',
    headers: baseHeaders,
    body: { ctype: 'Username', cvalue: String(username), password: String(password) },
  })

  let result = interpretLoginResponse(res, { csrf })

  if (result.outcome === 'captcha') {
    const blob =
      result.meta && (result.meta.dataExchangeBlob || result.meta.blob || result.meta.data_exchange_blob)
    const unifiedCaptchaId = result.meta && result.meta.unifiedCaptchaId

    // 1) Быстрый путь: платный солвер, если настроен.
    if (captcha && captcha.provider && captcha.apiKey) {
      const solved = await solveLoginFunCaptcha({
        provider: captcha.provider,
        apiKey: captcha.apiKey,
        blob,
        proxy: captcha.proxy,
      })
      if (solved.ok) {
        return continueWithCaptchaToken({
          csrf,
          challengeId: result.challengeId,
          unifiedCaptchaId,
          metaB64: result.metaB64,
          token: solved.token,
          username,
          password,
        })
      }
      // солвер не справился — падаем в кооперативный путь ниже
    }

    // 2) Кооперативный путь (как у swizzyer): данные для hosted-страницы, токен решит покупатель.
    return {
      outcome: 'captcha',
      cooperative: true,
      publicKey: ROBLOX_LOGIN_ARKOSE_PUBLIC_KEY,
      blob: blob || null,
      challengeId: result.challengeId,
      unifiedCaptchaId: unifiedCaptchaId || null,
      metaB64: result.metaB64,
      ctx: { csrf },
      username,
      password,
    }
  }

  return result
}

// Довести логин после получения captcha-токена: challenge/continue + повтор /v2/login.
// Результат — тот же унифицированный исход (может быть 'ok' / '2fa' / 'error').
async function continueWithCaptchaToken({ csrf, challengeId, unifiedCaptchaId, metaB64, token, username, password }) {
  const baseHeaders = { 'X-CSRF-TOKEN': csrf }
  await request({
    method: 'POST',
    url: 'https://apis.roblox.com/challenge/v1/continue',
    headers: baseHeaders,
    body: {
      challengeId,
      challengeType: 'captcha',
      challengeMetadata: JSON.stringify({ unifiedCaptchaId, captchaToken: token, actionType: 'Login' }),
    },
  })
  const res = await request({
    method: 'POST',
    url: 'https://auth.roblox.com/v2/login',
    headers: {
      ...baseHeaders,
      'Rblx-Challenge-Id': challengeId,
      'Rblx-Challenge-Type': 'captcha',
      'Rblx-Challenge-Metadata': metaB64,
    },
    body: { ctype: 'Username', cvalue: String(username), password: String(password) },
  })
  return interpretLoginResponse(res, { csrf })
}

/**
 * Завершить капчу кооперативно: покупатель решил FunCaptcha на hosted-странице, прислал токен.
 * @param {object} state  то, что вернул startBuyerLogin при outcome:'captcha' cooperative
 * @param {string} token  Arkose-токен из виджета
 */
async function completeBuyerCaptcha({ state, token }) {
  if (!state) return { outcome: 'error', error: 'Нет состояния капчи' }
  if (!token) return { outcome: 'error', error: 'Нет токена капчи' }
  const csrf = (state.ctx && state.ctx.csrf) || (await getCsrfToken())
  return continueWithCaptchaToken({
    csrf,
    challengeId: state.challengeId,
    unifiedCaptchaId: state.unifiedCaptchaId,
    metaB64: state.metaB64,
    token,
    username: state.username,
    password: state.password,
  })
}

/**
 * Завершить 2FA: проверить код и довести логин до cookie.
 * @param {object} state  то, что вернул startBuyerLogin при outcome:'2fa' (+ username/password/csrf)
 * @param {string} code   6-значный код от покупателя
 */
async function completeBuyer2fa({ state, code }) {
  if (!state) return { outcome: 'error', error: 'Нет состояния 2FA' }
  if (!code) return { outcome: 'error', error: 'Нет кода 2FA' }
  const csrf = (state.ctx && state.ctx.csrf) || (await getCsrfToken())
  const userId = state.userId
  const mediaType = state.mediaType || 'authenticator'
  if (!userId) return { outcome: 'error', error: 'Неизвестен userId для 2FA' }

  const headers = { 'X-CSRF-TOKEN': csrf }

  // Проверка кода.
  const verifyRes = await request({
    method: 'POST',
    url: `https://twostepverification.roblox.com/v1/users/${Number(userId)}/challenges/${mediaType}/verify`,
    headers,
    body: { challengeId: state.challengeId || state.ticket, actionType: 'Login', code: String(code) },
  })
  const verificationToken =
    verifyRes.json && (verifyRes.json.verificationToken || verifyRes.json.token)
  if (verifyRes.status !== 200 || !verificationToken) {
    const msg =
      (verifyRes.json && verifyRes.json.errors && verifyRes.json.errors[0] && verifyRes.json.errors[0].message) ||
      `Код 2FA не принят (HTTP ${verifyRes.status})`
    return { outcome: 'error', error: msg }
  }

  // Legacy-путь: повтор логина с verificationToken в теле.
  if (state.legacy) {
    const res = await request({
      method: 'POST',
      url: 'https://auth.roblox.com/v2/login',
      headers,
      body: {
        ctype: 'Username',
        cvalue: String(state.username || ''),
        password: String(state.password || ''),
        challengeId: state.ticket,
        securityQuestionSessionId: state.ticket,
        twoStepVerificationChallenge: { verificationToken, rememberDevice: true },
      },
    })
    return interpretLoginResponse(res, { csrf })
  }

  // Современный путь: challenge/v1/continue + повтор логина с Rblx-Challenge-* заголовками.
  await request({
    method: 'POST',
    url: 'https://apis.roblox.com/challenge/v1/continue',
    headers,
    body: {
      challengeId: state.challengeId,
      challengeType: 'twostepverification',
      challengeMetadata: JSON.stringify({
        verificationToken,
        rememberDevice: true,
        actionType: 'Login',
        challengeId: state.challengeId,
      }),
    },
  })
  const res = await request({
    method: 'POST',
    url: 'https://auth.roblox.com/v2/login',
    headers: {
      ...headers,
      'Rblx-Challenge-Id': state.headerChallengeId || state.challengeId,
      'Rblx-Challenge-Type': 'twostepverification',
      'Rblx-Challenge-Metadata': state.metaB64 || '',
    },
    body: { ctype: 'Username', cvalue: String(state.username || ''), password: String(state.password || '') },
  })
  return interpretLoginResponse(res, { csrf })
}

module.exports = { startBuyerLogin, completeBuyer2fa, completeBuyerCaptcha, getCsrfToken }
