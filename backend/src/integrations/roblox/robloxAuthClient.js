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
const crypto = require('crypto')
const { solveLoginFunCaptcha, ROBLOX_LOGIN_ARKOSE_PUBLIC_KEY } = require('./captchaSolver')

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
const TIMEOUT_MS = 20000

// Cookie-jar: браузер тащит GuestData/RBXEventTrackerV2 через весь флоу, и Generic Challenge
// привязан к сессионной cookie — без неё финальный /v2/login даёт «Challenge failed to authorize».
// jar — простой объект {name: value}; передаётся в request() и обновляется из Set-Cookie.
function jarToHeader(jar) {
  if (!jar) return null
  const keys = Object.keys(jar)
  return keys.length ? keys.map((k) => `${k}=${jar[k]}`).join('; ') : null
}
function jarUpdate(jar, setCookie) {
  if (!jar || !setCookie) return
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie]
  for (const c of arr) {
    const pair = String(c).split(';')[0]
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (!name) continue
    if (value === 'DELETE' || value === '') delete jar[name]
    else jar[name] = value
  }
}

function request({ method = 'GET', url, headers = {}, body, cookie, jar }) {
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
    const cookieHeader = cookie || jarToHeader(jar)
    if (cookieHeader) h.Cookie = cookieHeader
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
          if (jar) jarUpdate(jar, res.headers && res.headers['set-cookie'])
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

async function getCsrfToken(jar) {
  // /v2/logout без сессии теперь отдаёт 401 без токена. /v2/login без тела → 403 + x-csrf-token
  // (проверка CSRF идёт ДО проверки логина, так что это не попытка входа и не триггерит лимиты).
  const res = await request({ method: 'POST', url: 'https://auth.roblox.com/v2/login', body: {}, jar })
  return res.headers['x-csrf-token'] || res.headers['X-CSRF-TOKEN'] || null
}

// Secure Authentication Intent (HBA / Bound Auth Token). Снято живым перехватом:
//   GET hba-service/v1/getServerNonce -> nonce (JSON-строка)
//   saiSignature = ECDSA-P256( `${clientPublicKey}|${clientEpochTimestamp}|${serverNonce}` ), base64 raw r||s.
// Сейчас enforcement у Roblox выключен (intent опционален), но шлём — браузер всегда шлёт, и это
// страхует от включения проверки. На неудаче возвращаем null и логинимся без intent.
async function getServerNonce(jar) {
  const res = await request({ method: 'GET', url: 'https://apis.roblox.com/hba-service/v1/getServerNonce', jar })
  if (res.status === 200 && typeof res.json === 'string' && res.json) return res.json
  return null
}

async function buildSecureAuthIntent(jar) {
  try {
    const serverNonce = await getServerNonce(jar)
    if (!serverNonce) return null
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const clientPublicKey = publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    const clientEpochTimestamp = Math.floor(Date.now() / 1000)
    const msg = `${clientPublicKey}|${clientEpochTimestamp}|${serverNonce}`
    const saiSignature = crypto
      .sign('SHA256', Buffer.from(msg, 'utf8'), { key: privateKey, dsaEncoding: 'ieee-p1363' })
      .toString('base64')
    return { clientPublicKey, clientEpochTimestamp, serverNonce, saiSignature }
  } catch (_) {
    return null
  }
}

// Тело /v2/login с опциональным secureAuthenticationIntent.
function loginBody({ username, password, sai }) {
  const b = { ctype: 'Username', cvalue: String(username), password: String(password) }
  if (sai) b.secureAuthenticationIntent = sai
  return b
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

const POW_PUZZLE_URL = 'https://apis.roblox.com/proof-of-work-service/v1/pow-puzzle'

// Решить VDF-головоломку Roblox PoW (puzzleType "1"): ответ = A^(2^T) mod N,
// считается T последовательными возведениями в квадрат — это «задержка» (не параллелится).
// Протокол снят живым перехватом: GET ?sessionID -> {artifacts:"{N,A,T}"};
// POST {sessionID,solution} -> {answerCorrect, redemptionToken}.
function solvePowPuzzle(nStr, aStr, t) {
  const N = BigInt(nStr)
  let x = BigInt(aStr) % N
  for (let i = 0; i < t; i++) x = (x * x) % N
  return x.toString()
}

async function fetchAndSolvePow({ csrf, sessionId, jar }) {
  const headers = { 'X-CSRF-TOKEN': csrf }
  const pz = await request({
    method: 'GET',
    url: `${POW_PUZZLE_URL}?sessionID=${encodeURIComponent(sessionId)}`,
    headers,
    jar,
  })
  if (pz.status !== 200 || !pz.json || pz.json.artifacts == null) {
    return { ok: false, error: `PoW: не получил головоломку (HTTP ${pz.status})` }
  }
  if (pz.json.puzzleType != null && String(pz.json.puzzleType) !== '1') {
    return { ok: false, error: `PoW: неизвестный puzzleType ${pz.json.puzzleType}` }
  }
  let art = null
  try {
    art = JSON.parse(pz.json.artifacts)
  } catch (_) {
    art = null
  }
  if (!art || art.N == null || art.A == null || art.T == null) {
    return { ok: false, error: 'PoW: не разобрал artifacts {N,A,T}' }
  }
  let solution
  try {
    solution = solvePowPuzzle(String(art.N), String(art.A), Number(art.T))
  } catch (e) {
    return { ok: false, error: `PoW: ошибка вычисления (${e && e.message ? e.message : e})` }
  }
  const ans = await request({
    method: 'POST',
    url: POW_PUZZLE_URL,
    headers,
    body: { sessionID: sessionId, solution },
    jar,
  })
  if (!ans.json || ans.json.answerCorrect !== true || !ans.json.redemptionToken) {
    const m = (ans.json && ans.json.message) || `HTTP ${ans.status}`
    return { ok: false, error: `PoW: ответ не принят (${m})` }
  }
  return { ok: true, redemptionToken: ans.json.redemptionToken }
}

// Довести proof-of-work: решить PoW, отдать redemptionToken в challenge/continue, шагнуть дальше.
// Generic Challenge цепляет следом captcha (Arkose) или 2FA — тогда возвращаем соответствующий
// outcome, и обычные ветки startBuyerLogin их подхватывают. Иначе — повтор /v2/login до cookie.
async function continueProofOfWork({ csrf, sai, jar, challengeId, metaB64, username, password }) {
  let metaJson = null
  try {
    metaJson = Buffer.from(String(metaB64 || ''), 'base64').toString('utf8')
  } catch (_) {
    metaJson = null
  }
  let meta = null
  try {
    meta = metaJson ? JSON.parse(metaJson) : null
  } catch (_) {
    meta = null
  }
  const sessionId = meta && meta.sessionId
  if (!sessionId) return { outcome: 'error', error: 'PoW: нет sessionId в метаданных' }

  const solved = await fetchAndSolvePow({ csrf, sessionId, jar })
  if (!solved.ok) return { outcome: 'error', error: solved.error }

  // Браузер шлёт в PoW-continue ТОЛЬКО {redemptionToken, sessionId} (снято живьём).
  const powMeta = JSON.stringify({ redemptionToken: solved.redemptionToken, sessionId })
  const cont = await request({
    method: 'POST',
    url: 'https://apis.roblox.com/challenge/v1/continue',
    headers: { 'X-CSRF-TOKEN': csrf },
    body: { challengeId, challengeType: 'proofofwork', challengeMetadata: powMeta },
    jar,
  })

  // Следующий шаг Generic Challenge приходит прямо в ответе continue.
  const nextType = cont.json && cont.json.challengeType
  const nextMetaStr = cont.json && cont.json.challengeMetadata
  const nextChallengeId = (cont.json && cont.json.challengeId) || challengeId
  if (nextType === 'captcha' && nextMetaStr) {
    let cm = {}
    try {
      cm = JSON.parse(nextMetaStr)
    } catch (_) {
      cm = {}
    }
    return {
      outcome: 'captcha',
      challengeId: nextChallengeId,
      meta: cm,
      metaB64: Buffer.from(nextMetaStr, 'utf8').toString('base64'),
      ctx: { csrf, sai, jar },
    }
  }
  if (/twostep/i.test(nextType || '') && nextMetaStr) {
    let cm = {}
    try {
      cm = JSON.parse(nextMetaStr)
    } catch (_) {
      cm = {}
    }
    return {
      outcome: '2fa',
      challengeId: cm.challengeId || nextChallengeId,
      headerChallengeId: nextChallengeId,
      userId: cm.userId || null,
      mediaType: cm.mediaType || 'authenticator',
      metaB64: Buffer.from(nextMetaStr, 'utf8').toString('base64'),
      ctx: { csrf, sai, jar },
    }
  }

  // Иначе — повтор логина с заголовками PoW-челленджа.
  const retry = await request({
    method: 'POST',
    url: 'https://auth.roblox.com/v2/login',
    headers: {
      'X-CSRF-TOKEN': csrf,
      'Rblx-Challenge-Id': challengeId,
      'Rblx-Challenge-Type': 'proofofwork',
      'Rblx-Challenge-Metadata': Buffer.from(powMeta, 'utf8').toString('base64'),
    },
    body: loginBody({ username, password, sai }),
    jar,
  })
  return interpretLoginResponse(retry, { csrf, sai })
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
  // Один cookie-jar на весь флоу (как браузер): GuestData/RBXEventTrackerV2 и т.п. нужны, чтобы
  // Generic Challenge авторизовался на финальном /v2/login.
  const jar = {}
  // Прогрев cookie страницей логина (как браузер делает GET перед входом) — не /v2/login, лимит не трогает.
  await request({ method: 'GET', url: 'https://www.roblox.com/Login', jar }).catch(() => {})
  const csrf = await getCsrfToken(jar)
  if (!csrf) return { outcome: 'error', error: 'Не удалось получить CSRF-токен' }

  // Secure Authentication Intent — браузер всегда шлёт его в теле логина (HBA). Генерим один раз
  // и протаскиваем через весь флоу (challenge/continue + повторы /v2/login).
  const sai = await buildSecureAuthIntent(jar)

  const baseHeaders = { 'X-CSRF-TOKEN': csrf }
  let res = await request({
    method: 'POST',
    url: 'https://auth.roblox.com/v2/login',
    headers: baseHeaders,
    body: loginBody({ username, password, sai }),
    jar,
  })

  let result = interpretLoginResponse(res, { csrf, sai })

  // Generic Challenge начинается с proof-of-work — решаем его сами и шагаем дальше
  // (обычно следом captcha, реже сразу cookie/2FA).
  if (result.outcome === 'proofofwork') {
    result = await continueProofOfWork({
      csrf,
      sai,
      jar,
      challengeId: result.challengeId,
      metaB64: result.metaB64,
      username,
      password,
    })
  }

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
          sai,
          jar,
          challengeId: result.challengeId,
          unifiedCaptchaId,
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
      ctx: { csrf, sai, jar },
      username,
      password,
    }
  }

  return result
}

// Довести логин после получения captcha-токена: challenge/continue + повтор /v2/login.
// Снято живьём: continue с {unifiedCaptchaId, captchaToken, actionType}; повтор /v2/login несёт
// ТО ЖЕ в Rblx-Challenge-Metadata (base64), а Rblx-Challenge-Type остаётся 'proofofwork'
// (корневой тип Generic Challenge), плюс secureAuthenticationIntent в теле.
async function continueWithCaptchaToken({ csrf, sai, jar, challengeId, unifiedCaptchaId, token, username, password }) {
  const baseHeaders = { 'X-CSRF-TOKEN': csrf }
  const solvedMeta = JSON.stringify({ unifiedCaptchaId, captchaToken: token, actionType: 'Login' })
  await request({
    method: 'POST',
    url: 'https://apis.roblox.com/challenge/v1/continue',
    headers: baseHeaders,
    body: { challengeId, challengeType: 'captcha', challengeMetadata: solvedMeta },
    jar,
  })
  const res = await request({
    method: 'POST',
    url: 'https://auth.roblox.com/v2/login',
    headers: {
      ...baseHeaders,
      'Rblx-Challenge-Id': challengeId,
      'Rblx-Challenge-Type': 'proofofwork',
      'Rblx-Challenge-Metadata': Buffer.from(solvedMeta, 'utf8').toString('base64'),
    },
    body: loginBody({ username, password, sai }),
    jar,
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
  const jar = (state.ctx && state.ctx.jar) || {}
  const csrf = (state.ctx && state.ctx.csrf) || (await getCsrfToken(jar))
  return continueWithCaptchaToken({
    csrf,
    sai: state.ctx && state.ctx.sai,
    jar,
    challengeId: state.challengeId,
    unifiedCaptchaId: state.unifiedCaptchaId,
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
  const jar = (state.ctx && state.ctx.jar) || {}
  const csrf = (state.ctx && state.ctx.csrf) || (await getCsrfToken(jar))
  const sai = state.ctx && state.ctx.sai
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
    jar,
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
        ...loginBody({ username: state.username || '', password: state.password || '', sai }),
        challengeId: state.ticket,
        securityQuestionSessionId: state.ticket,
        twoStepVerificationChallenge: { verificationToken, rememberDevice: true },
      },
      jar,
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
    jar,
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
    body: loginBody({ username: state.username || '', password: state.password || '', sai }),
    jar,
  })
  return interpretLoginResponse(res, { csrf })
}

module.exports = { startBuyerLogin, completeBuyer2fa, completeBuyerCaptcha, getCsrfToken }
