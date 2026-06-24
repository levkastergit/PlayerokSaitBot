'use strict'

// ---------------------------------------------------------------------------
// Клиент CDK Reseller API (https://dlsapi.6661231.xyz) — активация Claude-кодов.
// Покупатель присылает свой Claude user ID (UUID), мы берём CDK из таблицы и
// активируем подписку через POST /claude/redeem, затем опрашиваем /claude/task
// до терминального статуса (success/failed). Авторизация — Bearer-токен.
// ---------------------------------------------------------------------------

const DEFAULT_BASE = 'https://dlsapi.6661231.xyz/api/v1'
const CLODE_POLL_MAX_MS = Math.max(5000, Number(process.env.CLODE_TASK_POLL_MAX_MS) || 120000)
const CLODE_POLL_INTERVAL_MS = Math.max(500, Number(process.env.CLODE_TASK_POLL_INTERVAL_MS) || 3000)
// Таймаут одного http-запроса к Clode (в т.ч. внутри poll-цикла), чтобы зависший fetch
// не вешал всю активацию.
const CLODE_FETCH_TIMEOUT_MS = Math.max(3000, Number(process.env.CLODE_FETCH_TIMEOUT_MS) || 25000)

// Коды ошибок, означающие вину покупателя (некорректный ID) — повод переспросить ID.
const CLODE_USER_FAULT_CODES = new Set(['INVALID_USER_ID', 'MISSING_USER_ID'])

const CLODE_PLAN_VALUES = new Set(['pro', 'max_5x', 'max_20x'])

// UUID в любом окружении (кавычки/скобки/мусор от Playerok) — берём первый матч.
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

function getBaseUrl() {
  const raw = process.env.CLODE_API_BASE || DEFAULT_BASE
  return String(raw).trim().replace(/\/+$/, '') || DEFAULT_BASE
}

/** Достаёт Claude user ID (UUID) из произвольного текста покупателя. '' если не найден. */
function extractClaudeUserId(text) {
  const m = String(text == null ? '' : text).match(UUID_RE)
  return m ? m[0].toLowerCase() : ''
}

function normalizeClodePlan(value) {
  const s = String(value == null ? '' : value).trim().toLowerCase()
  return CLODE_PLAN_VALUES.has(s) ? s : null
}

function formatClodeError(body, status) {
  if (body && typeof body === 'object') {
    const code = body.code ? String(body.code) : ''
    const message = body.message ? String(body.message) : ''
    if (code && message) return `${code}: ${message}`
    if (message) return message
    if (code) return code
  }
  return `Clode HTTP ${status}`
}

function buildClodeError(body, status) {
  const err = new Error(formatClodeError(body, status))
  err.clodeBody = body
  err.httpStatus = status
  err.code = body && typeof body === 'object' && body.code ? String(body.code) : ''
  return err
}

/** Ошибка из-за некорректного ID покупателя (стоит переспросить ID), а не сбой стока/сети. */
function isClodeValidationError(err) {
  if (!err) return false
  if (err.code && CLODE_USER_FAULT_CODES.has(String(err.code))) return true
  return false
}

async function clodeFetch(apiKey, method, path, body) {
  const key = String(apiKey || '').trim()
  if (!key) throw new Error('Clode API key is not configured')

  const url = `${getBaseUrl()}/${String(path || '').replace(/^\/+/, '')}`
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
    },
  }
  if (body != null) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }

  let res
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(CLODE_FETCH_TIMEOUT_MS) })
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new Error(`Clode: таймаут запроса ${CLODE_FETCH_TIMEOUT_MS}ms (${method} ${String(path || '')})`)
    }
    throw e
  }
  let json = null
  try {
    json = await res.json()
  } catch {
    json = null
  }

  if (!res.ok) {
    throw buildClodeError(json, res.status)
  }
  return json
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** POST /claude/redeem — асинхронный приём задачи. Возвращает data.taskId (camelCase). */
async function redeemClaude(apiKey, { cdk, claudeUserId, expectedPlan, force } = {}) {
  const reqBody = {
    cdk: String(cdk || '').trim(),
    claude_user_id: String(claudeUserId || '').trim(),
  }
  const plan = normalizeClodePlan(expectedPlan)
  if (plan) reqBody.expected_plan = plan
  if (force) reqBody.force = true

  const body = await clodeFetch(apiKey, 'POST', 'claude/redeem', reqBody)
  const data = body && typeof body === 'object' ? body.data : null
  const taskId = data && (data.taskId || data.task_id) ? String(data.taskId || data.task_id) : ''
  return { taskId, data: data || null, raw: body }
}

/** GET /claude/task?task_id=... — статус задачи (pending | success | failed). */
async function pollClaudeTask(apiKey, taskId) {
  const tid = String(taskId || '').trim()
  if (!tid) throw new Error('Clode task_id is required')
  const body = await clodeFetch(apiKey, 'GET', `claude/task?task_id=${encodeURIComponent(tid)}`)
  const data = body && typeof body === 'object' ? body.data : null
  const status = data && data.status ? String(data.status).trim().toLowerCase() : ''
  const message = data && data.message ? String(data.message) : ''
  return { status, message, data: data || null, raw: body }
}

/**
 * Создаёт задачу активации и дожидается терминального статуса.
 * success → { completed:true }, failed → { failed:true } (CDK откатывается на стороне сервера),
 * таймаут → { inProgress:true }. Синхронные ошибки create (4xx/5xx) пробрасываются вызывающему.
 */
async function redeemClaudeAndConfirm(apiKey, input) {
  const created = await redeemClaude(apiKey, input)
  if (!created.taskId) {
    const err = new Error('Clode redeem did not return a task id')
    err.clodeBody = created.raw
    throw err
  }

  const started = Date.now()
  let last = null
  while (Date.now() - started < CLODE_POLL_MAX_MS) {
    try {
      last = await pollClaudeTask(apiKey, created.taskId)
    } catch (pollErr) {
      // Транзиентный сбой опроса (таймаут/сеть) НЕ должен убивать активацию —
      // ждём интервал и пробуем снова в пределах бюджета.
      await delay(CLODE_POLL_INTERVAL_MS)
      continue
    }
    if (last.status === 'success') {
      return { completed: true, failed: false, taskId: created.taskId, taskBody: last.data, message: last.message }
    }
    if (last.status === 'failed') {
      return { completed: false, failed: true, taskId: created.taskId, taskBody: last.data, message: last.message }
    }
    await delay(CLODE_POLL_INTERVAL_MS)
  }
  return {
    completed: false,
    failed: false,
    inProgress: true,
    taskId: created.taskId,
    taskBody: last ? last.data : null,
    message: last ? last.message : '',
  }
}

module.exports = {
  getBaseUrl,
  extractClaudeUserId,
  normalizeClodePlan,
  isClodeValidationError,
  formatClodeError,
  redeemClaude,
  pollClaudeTask,
  redeemClaudeAndConfirm,
}
