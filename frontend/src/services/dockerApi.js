import { trackedFetch } from './requestTracker'

const ENV_ORIGIN = (import.meta.env.VITE_BACKEND_ORIGIN || '').trim()
const RUNTIME_ORIGIN = typeof window !== 'undefined' ? window.location.origin : ''

function inferBackendOrigin() {
  if (ENV_ORIGIN) return ENV_ORIGIN
  if (RUNTIME_ORIGIN && /:(5173|4173)$/i.test(RUNTIME_ORIGIN)) return 'http://localhost:3000'
  return RUNTIME_ORIGIN || 'http://localhost:3000'
}

const BACKEND_ORIGIN = inferBackendOrigin()
const DOCKER_BUILD_PUSH_URL = `${BACKEND_ORIGIN}/api/docker/build-push`
const DOCKER_BUILD_PUSH_STATUS_URL = `${BACKEND_ORIGIN}/api/docker/build-push/status`
const DOCKER_PULL_DEPLOY_URL = `${BACKEND_ORIGIN}/api/docker/pull-deploy`
const RUNTIME_ACTIONS_STATE_URL = `${BACKEND_ORIGIN}/api/runtime/actions-state`
const STOP_RUNTIME_ACTIONS_URL = `${BACKEND_ORIGIN}/api/runtime/actions/stop`
const RESUME_RUNTIME_ACTIONS_URL = `${BACKEND_ORIGIN}/api/runtime/actions/resume`
const RUNTIME_JOBS_URL = `${BACKEND_ORIGIN}/api/runtime/jobs`
const opts = { credentials: 'include' }

/**
 * Снимок фоновых задач сервера для вкладки «Список выполнения».
 * Возвращает реальные данные реестра задач: интервал цикла, момент старта
 * последнего тика, число запусков/ошибок и т.д.
 */
export async function fetchRuntimeJobs() {
  try {
    const res = await trackedFetch(RUNTIME_JOBS_URL, opts)
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data?.ok) {
      return { ok: false, stoppedAll: false, serverNow: Date.now(), jobs: [] }
    }
    return {
      ok: true,
      stoppedAll: Boolean(data.stoppedAll),
      serverNow: Number(data.serverNow) || Date.now(),
      jobs: Array.isArray(data.jobs) ? data.jobs : [],
    }
  } catch {
    return { ok: false, stoppedAll: false, serverNow: Date.now(), jobs: [] }
  }
}

/**
 * Подробные «живые» данные одной задачи (очередь поднятий, сделки/флоу в работе) —
 * грузим только когда плитка развёрнута.
 */
export async function fetchRuntimeJobDetails(id) {
  try {
    const res = await trackedFetch(`${RUNTIME_JOBS_URL}/details?id=${encodeURIComponent(id)}`, opts)
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data?.ok) {
      return { ok: false, id, detailsAt: null, serverNow: Date.now(), details: null }
    }
    return {
      ok: true,
      id: data.id || id,
      detailsAt: Number(data.detailsAt) || null,
      serverNow: Number(data.serverNow) || Date.now(),
      details: data.details && typeof data.details === 'object' ? data.details : null,
    }
  } catch {
    return { ok: false, id, detailsAt: null, serverNow: Date.now(), details: null }
  }
}

export async function fetchDockerBuildPushStatus() {
  try {
    const res = await trackedFetch(DOCKER_BUILD_PUSH_STATUS_URL, opts)
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data?.ok) {
      return { ok: false, running: false, log: '', error: null, image: null, success: false }
    }
    return {
      ok: true,
      running: Boolean(data.running),
      log: String(data.log || ''),
      error: data.error ? String(data.error) : null,
      image: data.image ? String(data.image) : null,
      success: Boolean(data.success),
    }
  } catch {
    return { ok: false, running: false, log: '', error: null, image: null, success: false }
  }
}

export async function dockerBuildAndPush() {
  try {
    const res = await trackedFetch(DOCKER_BUILD_PUSH_URL, {
      ...opts,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })

    const data = await res.json().catch(() => ({}))
    if (res.status === 409) {
      return {
        ok: false,
        running: true,
        error: data?.error || 'Уже выполняется docker build/push',
        log: String(data?.log || ''),
      }
    }
    if (res.status === 202 || data?.started) {
      return { ok: true, started: true, running: true }
    }
    if (!res.ok || !data?.ok) {
      return {
        ok: false,
        error: data?.error || 'Ошибка docker build/push',
        log: String(data?.log || data?.stdout || ''),
      }
    }

    return { ok: true, ...data }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Ошибка сети',
      log: '',
    }
  }
}

export async function dockerPullAndDeploy() {
  try {
    const res = await trackedFetch(DOCKER_PULL_DEPLOY_URL, {
      ...opts,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const data = await res.json().catch(() => ({}))
    if (res.status === 409) {
      return { ok: false, running: true, error: data?.error || 'Обновление уже выполняется' }
    }
    if (res.status === 202 || data?.started) {
      return { ok: true, started: true, message: data?.message || '' }
    }
    if (!res.ok || !data?.ok) {
      return {
        ok: false,
        error: data?.error || 'Ошибка обновления',
        stdout: data?.stdout || '',
        stderr: data?.stderr || '',
      }
    }
    return { ok: true, ...data }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Ошибка сети',
      stdout: '',
      stderr: '',
    }
  }
}

export async function fetchRuntimeActionsState() {
  try {
    const res = await trackedFetch(RUNTIME_ACTIONS_STATE_URL, opts)
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data?.ok) return { ok: false, stopped: false }
    return { ok: true, stopped: Boolean(data.stopped) }
  } catch {
    return { ok: false, stopped: false }
  }
}

export async function stopRuntimeActions() {
  try {
    const res = await trackedFetch(STOP_RUNTIME_ACTIONS_URL, {
      ...opts,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data?.ok) return { ok: false, error: data?.error || 'Ошибка остановки' }
    return { ok: true, stopped: Boolean(data.stopped) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Ошибка сети' }
  }
}

export async function resumeRuntimeActions() {
  try {
    const res = await trackedFetch(RESUME_RUNTIME_ACTIONS_URL, {
      ...opts,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data?.ok) return { ok: false, error: data?.error || 'Ошибка запуска' }
    return { ok: true, stopped: Boolean(data.stopped) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Ошибка сети' }
  }
}
