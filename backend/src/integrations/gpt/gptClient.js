'use strict'

// ---------------------------------------------------------------------------
// Клиент пользовательского API 987ai (https://api.987ai.vip) — активация
// ChatGPT-подписок по карт-кодам (card_key) из привязанной таблицы.
//
// Особенности этого API (в отличие от Clode/CDK Reseller):
//   • НЕТ глобального ключа авторизации — карт-код передаётся в теле запроса,
//     он же и является «авторизацией». Поэтому ключ нигде не хранится.
//   • Тип продукта (gpt/claude) сервер определяет сам по card_key.
//   • Для GPT покупатель присылает свой Access Token (JWT eyJ... или UUID
//     app_user_id). Токен длинный и не влезает в одно сообщение Playerok,
//     поэтому покупатель присылает ссылку на Google-документ с токеном —
//     мы скачиваем документ (export txt) и достаём токен из текста.
//
// Поток активации: POST /api/tasks { card_key, access_token, idp, force_recharge }
// → возвращает task_id → опрашиваем GET /api/tasks/:taskId до терминального
// статуса (completed/failed/cancelled). При провале карт-код возвращается в пул.
// ---------------------------------------------------------------------------

const DEFAULT_BASE = 'https://api.987ai.vip'
const GPT_POLL_MAX_MS = Math.max(5000, Number(process.env.GPT_TASK_POLL_MAX_MS) || 120000)
const GPT_POLL_INTERVAL_MS = Math.max(500, Number(process.env.GPT_TASK_POLL_INTERVAL_MS) || 3000)

// JWT Access Token: три base64url-сегмента, начинается с eyJ.
const JWT_RE = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/
// UUID (app_user_id) — запасной формат, который API тоже принимает.
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
// ID Google-документа из ссылки вида /document/d/<id>/... или ?id=<id>.
const GDOC_ID_RE = /(?:document\/d\/|\/d\/|[?&]id=)([a-zA-Z0-9_-]{20,})/

function getBaseUrl() {
  const raw = process.env.GPT_API_BASE || DEFAULT_BASE
  return String(raw).trim().replace(/\/+$/, '') || DEFAULT_BASE
}

// --- Google-документ --------------------------------------------------------

/** Достаёт ID Google-документа из произвольного текста покупателя. '' если нет. */
function extractGoogleDocId(text) {
  const m = String(text == null ? '' : text).match(GDOC_ID_RE)
  return m ? m[1] : ''
}

/** Достаёт ChatGPT Access Token (JWT или UUID) из текста документа. '' если нет. */
function extractGptAccessToken(text) {
  const s = String(text == null ? '' : text)
  const jwt = s.match(JWT_RE)
  if (jwt) return jwt[0]
  const uuid = s.match(UUID_RE)
  return uuid ? uuid[0].toLowerCase() : ''
}

/**
 * Скачивает текст Google-документа через публичный export?format=txt.
 * Возвращает:
 *   { ok: true, text }                       — документ доступен
 *   { ok: false, noAccess: true }            — нет доступа (требуется логин/разрешение)
 *   { ok: false, notFound: true }            — документ не найден
 *   { ok: false, error }                     — иная сетевая/серверная ошибка
 */
async function fetchGoogleDocText(docId) {
  const id = String(docId || '').trim()
  if (!id) return { ok: false, notFound: true }
  const url = `https://docs.google.com/document/d/${encodeURIComponent(id)}/export?format=txt`
  let res
  try {
    res = await fetch(url, {
      redirect: 'follow',
      headers: {
        Accept: 'text/plain,*/*',
        'User-Agent': 'Mozilla/5.0 (compatible; PlayerokBot/1.0)',
      },
    })
  } catch (e) {
    return { ok: false, error: e?.message || String(e) }
  }

  const finalUrl = String(res.url || '')
  // Закрытый документ редиректит на страницу логина Google.
  if (/accounts\.google\.com|ServiceLogin|signin/i.test(finalUrl)) {
    return { ok: false, noAccess: true }
  }
  if (res.status === 404) return { ok: false, notFound: true }
  if (res.status === 401 || res.status === 403) return { ok: false, noAccess: true }
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }

  const ct = String(res.headers.get('content-type') || '')
  let body = ''
  try {
    body = await res.text()
  } catch {
    body = ''
  }
  // Вместо текста вернулась HTML-страница (логин/нет доступа).
  if (/text\/html/i.test(ct) || /<html[\s>]/i.test(body.slice(0, 200))) {
    return { ok: false, noAccess: true }
  }
  return { ok: true, text: body }
}

// --- Классификация ошибок API ----------------------------------------------

/** Ошибка из-за токена/аккаунта покупателя — стоит попросить прислать новую ссылку. */
function isGptTokenFaultText(text) {
  const s = String(text || '')
  return (
    /access[_ ]?token/i.test(s) ||
    s.includes('AccessToken') ||
    s.includes('Token无效') ||
    s.includes('Token 无效') ||
    s.includes('无效或已过期') ||
    s.includes('密钥') ||
    s.includes('账户') ||
    s.includes('账号') ||
    s.includes('用户已为') ||
    s.includes('更换')
  )
}

/** Ошибка из-за отсутствия складского остатка на стороне API (не вина покупателя). */
function isGptStockText(text) {
  const s = String(text || '')
  return s.includes('无可用库存') || s.includes('无库存') || s.includes('库存')
}

function gptErrorText(err) {
  if (!err) return ''
  return String(err.gptError || err.message || '')
}

function isGptTokenFaultError(err) {
  return isGptTokenFaultText(gptErrorText(err))
}

function isGptStockError(err) {
  return isGptStockText(gptErrorText(err))
}

function buildGptError(json, status) {
  const apiErr = json && typeof json === 'object' && json.error ? String(json.error) : ''
  const err = new Error(apiErr || `GPT HTTP ${status}`)
  err.gptError = apiErr
  err.httpStatus = status
  err.gptBody = json
  return err
}

// --- HTTP -------------------------------------------------------------------

async function gptFetch(method, path, body) {
  const url = `${getBaseUrl()}/${String(path || '').replace(/^\/+/, '')}`
  const init = { method, headers: { Accept: 'application/json' } }
  if (body != null) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const res = await fetch(url, init)
  let json = null
  try {
    json = await res.json()
  } catch {
    json = null
  }
  return { json, status: res.status, ok: res.ok }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// --- Задачи активации -------------------------------------------------------

/**
 * POST /api/tasks — создаёт задачу активации GPT. Возвращает { taskId }.
 * При 409 (на карт-код уже есть задача) — достаёт её task_id из текста ошибки
 * и продолжает работу с ним. Прочие ошибки пробрасываются вызывающему.
 */
async function createGptTask({ cardKey, accessToken, idp = '', forceRecharge = false } = {}) {
  const reqBody = {
    card_key: String(cardKey || '').trim(),
    access_token: String(accessToken || '').trim(),
    idp: String(idp || ''),
    force_recharge: Boolean(forceRecharge),
  }
  const { json, status } = await gptFetch('POST', '/api/tasks', reqBody)
  const taskId = json && (json.task_id || json.taskId) ? String(json.task_id || json.taskId) : ''
  if (json && json.success && taskId) {
    return { taskId, raw: json }
  }
  // 409: задача уже выполняется — id можно достать из текста ошибки и опрашивать.
  if (status === 409) {
    const m = String(json?.error || '').match(UUID_RE)
    if (m) return { taskId: m[0], raw: json, conflict: true }
  }
  throw buildGptError(json, status)
}

/** GET /api/tasks/:taskId — статус задачи (pending|processing|completed|failed|cancelled|unknown). */
async function pollGptTask(taskId) {
  const tid = String(taskId || '').trim()
  if (!tid) throw new Error('GPT task id is required')
  const { json } = await gptFetch('GET', `/api/tasks/${encodeURIComponent(tid)}`)
  return {
    status: String(json?.status || '').trim().toLowerCase(),
    result: String(json?.result || ''),
    error: String(json?.error || ''),
    queuePosition: json?.queue_position,
    raw: json,
  }
}

/**
 * Создаёт задачу активации и дожидается терминального статуса.
 * completed → { completed:true }, failed/cancelled → { failed:true, tokenFault },
 * таймаут → { inProgress:true }. Синхронные ошибки create пробрасываются.
 */
async function redeemGptAndConfirm({ cardKey, accessToken } = {}) {
  const created = await createGptTask({ cardKey, accessToken })
  if (!created.taskId) {
    const err = new Error('GPT create-task did not return a task id')
    err.gptBody = created.raw
    throw err
  }

  const started = Date.now()
  let last = null
  while (Date.now() - started < GPT_POLL_MAX_MS) {
    last = await pollGptTask(created.taskId)
    if (last.status === 'completed') {
      return { completed: true, failed: false, taskId: created.taskId, message: last.result || last.error }
    }
    if (last.status === 'failed' || last.status === 'cancelled') {
      const msg = last.error || last.result || ''
      return {
        completed: false,
        failed: true,
        taskId: created.taskId,
        message: msg,
        tokenFault: isGptTokenFaultText(msg),
        stockFault: isGptStockText(msg),
      }
    }
    // pending | processing | unknown — продолжаем опрос.
    await delay(GPT_POLL_INTERVAL_MS)
  }
  return {
    completed: false,
    failed: false,
    inProgress: true,
    taskId: created.taskId,
    message: last ? last.error || last.result : '',
  }
}

module.exports = {
  getBaseUrl,
  extractGoogleDocId,
  extractGptAccessToken,
  fetchGoogleDocText,
  isGptTokenFaultError,
  isGptStockError,
  createGptTask,
  pollGptTask,
  redeemGptAndConfirm,
}
