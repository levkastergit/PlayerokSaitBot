'use strict'

const path = require('path')
const fs = require('fs')
const { execFile, spawnSync } = require('child_process')

let cachedSupercellPython = null

const BACKEND_DIR = path.join(__dirname, '..', '..')
const SUPERCELL_PLUGIN_DIR = path.join(BACKEND_DIR, 'supercell_auto_otp_plugin')
const SUPERCELL_BRIDGE_SCRIPT = path.join(SUPERCELL_PLUGIN_DIR, 'bridge_request_code.py')
const SUPERCELL_REQUEST_TIMEOUT_MS = Number(process.env.SUPERCELL_REQUEST_TIMEOUT_MS) || 45000
const SUPERCELL_REQUEST_RETRIES = Math.max(0, Number(process.env.SUPERCELL_REQUEST_RETRIES) || 2)
const SUPERCELL_REQUEST_RETRY_DELAY_MS = Math.max(
  100,
  Number(process.env.SUPERCELL_REQUEST_RETRY_DELAY_MS) || 1200
)

function resolveSupercellPython() {
  if (cachedSupercellPython) return cachedSupercellPython

  const candidates = []
  const envPython = (process.env.SUPERCELL_PYTHON_BIN || '').trim()
  if (envPython) candidates.push({ command: envPython, args: [] })
  candidates.push(
    { command: 'py', args: ['-3'] },
    { command: 'python', args: [] },
    { command: 'python3', args: [] }
  )

  for (const candidate of candidates) {
    const check = spawnSync(candidate.command, [...candidate.args, '--version'], {
      cwd: SUPERCELL_PLUGIN_DIR,
      windowsHide: true,
      encoding: 'utf8',
    })
    if (check.status === 0) {
      cachedSupercellPython = candidate
      return candidate
    }
  }

  throw new Error(
    'Не найден Python 3 для supercell bridge. Установите Python 3 или задайте SUPERCELL_PYTHON_BIN.'
  )
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function isRetryableSupercellError(message) {
  const text = String(message || '').toLowerCase()
  if (!text) return false
  return (
    text.includes('recaptcha') ||
    text.includes('таймаут') ||
    text.includes('timeout') ||
    text.includes('нет ответа') ||
    text.includes('http 5')
  )
}

function runSupercellRequestCodeOnce({ email, gameKey }) {
  if (!fs.existsSync(SUPERCELL_BRIDGE_SCRIPT)) {
    return Promise.reject(new Error('Файл bridge_request_code.py не найден'))
  }

  const python = resolveSupercellPython()
  const args = [...python.args, SUPERCELL_BRIDGE_SCRIPT, '--email', email, '--game', gameKey]

  return new Promise((resolve, reject) => {
    execFile(
      python.command,
      args,
      {
        cwd: SUPERCELL_PLUGIN_DIR,
        timeout: SUPERCELL_REQUEST_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        let payload = null
        const rawStdout = String(stdout || '').trim()
        if (rawStdout) {
          try {
            payload = JSON.parse(rawStdout)
          } catch (_) {
            payload = null
          }
        }

        if (error) {
          if (error.killed) {
            return reject(new Error('Истек таймаут запроса кода Supercell'))
          }
          if (payload && payload.error) {
            return reject(new Error(String(payload.error)))
          }
          const stderrText = String(stderr || '').trim()
          return reject(new Error(stderrText || error.message || 'Не удалось запустить supercell bridge'))
        }

        if (!payload || typeof payload !== 'object') {
          return reject(new Error('Supercell bridge вернул некорректный ответ'))
        }
        if (!payload.ok) {
          return reject(new Error(payload.error || 'Supercell bridge не смог запросить код'))
        }
        return resolve(payload)
      }
    )
  })
}

async function runSupercellRequestCode({ email, gameKey }) {
  let lastError = null
  for (let attempt = 0; attempt <= SUPERCELL_REQUEST_RETRIES; attempt += 1) {
    try {
      return await runSupercellRequestCodeOnce({ email, gameKey })
    } catch (err) {
      lastError = err
      const msg = err?.message || String(err)
      const shouldRetry = attempt < SUPERCELL_REQUEST_RETRIES && isRetryableSupercellError(msg)
      console.warn('[supercellBridge] ошибка запроса кода', {
        reason: shouldRetry ? 'bridge_retryable_error' : 'bridge_fatal_error',
        attempt: attempt + 1,
        maxAttempts: SUPERCELL_REQUEST_RETRIES + 1,
        gameKey: String(gameKey || ''),
        email: String(email || ''),
        error: msg,
      })
      if (!shouldRetry) break
      await sleep(SUPERCELL_REQUEST_RETRY_DELAY_MS * (attempt + 1))
    }
  }
  throw lastError || new Error('Не удалось запросить код Supercell')
}

module.exports = { runSupercellRequestCode }

