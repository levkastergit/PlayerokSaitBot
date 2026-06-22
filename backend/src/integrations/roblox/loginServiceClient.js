'use strict'

// Клиент к login_service.py (движок входа в браузере на воркер-машине/хосте с браузером).
// Бэкенд в Docker не может сам поднять браузер, поэтому вход (логин+PoW+капча/2FA) выполняет
// отдельный сервис. Адрес — env LOGIN_SERVICE_URL (при host-network Docker и сервисе на хосте это
// http://127.0.0.1:8765). Сервис держит живую сессию браузера, ключ — sid.
//
// Контракт login_service:
//   POST /start   {username,password,wait}     -> {status:'ok',account,roblosecurity}
//                                                | {status:'2fa',sid,mediaType}
//                                                | {status:'captcha',sid,publicKey,blob}
//                                                | {status:'2fa_push',sid} | {status:'pending',sid}
//                                                | {status:'error',error}
//   POST /2fa     {sid,code}    -> {status:'ok',...} | {status:'pending'|'error',...}
//   POST /captcha {sid,token}   -> {status:'ok',...} | {status:'pending'|'error',...}
//   POST /poll    {sid}         -> {status:'ok',...} | {status:'pending'}
//   POST /close   {sid}

const http = require('http')
const https = require('https')
const { URL } = require('url')

function baseUrl() {
  return String(process.env.LOGIN_SERVICE_URL || 'http://127.0.0.1:8765').replace(/\/+$/, '')
}

function call(path, method, body, timeoutMs = 70000) {
  return new Promise((resolve, reject) => {
    let u
    try {
      u = new URL(baseUrl() + path)
    } catch (e) {
      reject(e)
      return
    }
    const mod = u.protocol === 'https:' ? https : http
    const payload = body == null ? null : JSON.stringify(body)
    const headers = {}
    // Shared-secret для login_service, когда он слушает по сети (на отдельной машине).
    const lsToken = String(process.env.LOGIN_SERVICE_TOKEN || '').trim()
    if (lsToken) headers['X-Login-Token'] = lsToken
    if (payload != null) {
      headers['Content-Type'] = 'application/json'
      headers['Content-Length'] = Buffer.byteLength(payload)
    }
    const req = mod.request(
      { hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname + (u.search || ''), method, headers },
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
          resolve({ status: res.statusCode || 0, json, text })
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error('login_service: таймаут')))
    if (payload != null) req.write(payload)
    req.end()
  })
}

async function safe(path, body, timeoutMs) {
  try {
    const r = await call(path, 'POST', body, timeoutMs)
    if (r.json) return r.json
    return { status: 'error', error: `login_service HTTP ${r.status}` }
  } catch (err) {
    return { status: 'error', error: `login_service недоступен: ${err && err.message ? err.message : err}` }
  }
}

async function start(username, password, wait = 30) {
  return safe('/start', { username, password, wait }, 90000)
}
async function submit2fa(sid, code) {
  return safe('/2fa', { sid, code }, 70000)
}
async function submitCaptcha(sid, token) {
  return safe('/captcha', { sid, token }, 70000)
}
async function poll(sid) {
  return safe('/poll', { sid }, 30000)
}
async function close(sid) {
  return safe('/close', { sid }, 10000)
}

module.exports = { start, submit2fa, submitCaptcha, poll, close, baseUrl }
