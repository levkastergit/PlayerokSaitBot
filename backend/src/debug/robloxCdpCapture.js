'use strict'
// Снимает ЖИВОЙ трафик Roblox-логина из Chrome через DevTools Protocol (remote-debugging:9222).
// Пишет запрос+ответ (headers + body) для challenge/v1/continue, /v2/login, pow-puzzle, 2fa.
// Запуск Chrome (отдельно): chrome.exe --remote-debugging-port=9222 --user-data-dir=<tmp> https://www.roblox.com/Login
//   node backend/src/debug/robloxCdpCapture.js [outfile]
const fs = require('fs')

const OUT = process.argv[2] || 'C:\\playerok\\backend\\src\\debug\\roblox-capture.log'
const MATCH = /\/v2\/login|\/v2\/signup|challenge\/v1\/continue|proof-of-work|pow-puzzle|twostepverification|challenge\/v1\//i

fs.writeFileSync(OUT, `# capture started\n`)
function out(s) { fs.appendFileSync(OUT, s + '\n'); console.log(s) }

let ws
let msgId = 1
const pending = new Map() // id -> resolve
function send(method, params, sessionId) {
  const id = msgId++
  const payload = { id, method, params: params || {} }
  if (sessionId) payload.sessionId = sessionId
  ws.send(JSON.stringify(payload))
  return new Promise((res) => pending.set(id, res))
}

const reqs = new Map() // requestId -> entry

async function connect() {
  // get browser-level websocket
  const ver = await fetch('http://127.0.0.1:9222/json/version').then((r) => r.json())
  const url = ver.webSocketDebuggerUrl
  out(`# connecting ${url}`)
  ws = new WebSocket(url)
  ws.onopen = async () => {
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
    out('# auto-attach on. Логиньтесь и решайте капчу в Chrome — ловлю трафик.')
  }
  ws.onmessage = (ev) => handle(JSON.parse(ev.data))
  ws.onclose = () => out('# ws closed')
  ws.onerror = (e) => out('# ws error ' + (e && e.message))
}

async function handle(m) {
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || m.error || null); pending.delete(m.id); return }
  const sid = m.sessionId
  const p = m.params || {}
  switch (m.method) {
    case 'Target.attachedToTarget': {
      const s = p.sessionId
      await send('Network.enable', {}, s)
      await send('Runtime.runIfWaitingForDebugger', {}, s).catch(() => {})
      break
    }
    case 'Network.requestWillBeSent': {
      if (!MATCH.test(p.request.url)) return
      const e = { url: p.request.url, method: p.request.method, reqHeaders: p.request.headers, postData: p.request.postData || null, hasPostData: p.request.hasPostData, sid }
      reqs.set(p.requestId, e)
      if (!e.postData && p.request.hasPostData) {
        const r = await send('Network.getRequestPostData', { requestId: p.requestId }, sid).catch(() => null)
        if (r && r.postData) e.postData = r.postData
      }
      break
    }
    case 'Network.responseReceived': {
      const e = reqs.get(p.requestId)
      if (!e) return
      e.status = p.response.status
      e.respHeaders = p.response.headers
      break
    }
    case 'Network.loadingFinished': {
      const e = reqs.get(p.requestId)
      if (!e) return
      const body = await send('Network.getResponseBody', { requestId: p.requestId }, e.sid).catch(() => null)
      e.respBody = body ? (body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body) : null
      flush(p.requestId, e)
      break
    }
  }
}

function pick(h, names) {
  const o = {}
  if (!h) return o
  for (const k of Object.keys(h)) {
    const lk = k.toLowerCase()
    if (names.some((n) => lk.includes(n))) o[k] = h[k]
  }
  return o
}

function flush(id, e) {
  reqs.delete(id)
  out('\n================ ' + e.method + ' ' + e.url + ' -> HTTP ' + (e.status || '?'))
  const rqh = pick(e.reqHeaders, ['x-csrf', 'rblx-challenge'])
  if (Object.keys(rqh).length) out('  REQ challenge/csrf headers: ' + JSON.stringify(rqh))
  if (e.postData) out('  REQ body: ' + String(e.postData).slice(0, 1500))
  const rsh = pick(e.respHeaders, ['x-csrf', 'rblx-challenge', 'set-cookie'])
  if (Object.keys(rsh).length) out('  RESP challenge headers: ' + JSON.stringify(rsh))
  if (e.respBody) out('  RESP body: ' + String(e.respBody).slice(0, 1500))
}

connect().catch((err) => out('# fatal ' + (err && err.stack ? err.stack : err)))
