'use strict'

const path = require('path')
const fs = require('fs')
const { execFile, spawnSync } = require('child_process')

let cachedSupercellPython = null

const BACKEND_DIR = path.join(__dirname, '..', '..')
const SUPERCELL_PLUGIN_DIR = path.join(BACKEND_DIR, 'supercell_auto_otp_plugin')
const SUPERCELL_BRIDGE_SCRIPT = path.join(SUPERCELL_PLUGIN_DIR, 'bridge_request_code.py')
const SUPERCELL_REQUEST_TIMEOUT_MS = Number(process.env.SUPERCELL_REQUEST_TIMEOUT_MS) || 45000

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

function runSupercellRequestCode({ email, gameKey }) {
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

module.exports = { runSupercellRequestCode }

