'use strict'
// Цепляется ПРЯМО к вкладке roblox.com (CDP :9222), включает Network, затем заполняет логин и жмёт вход.
// Пишет запрос+ответ (headers+body) для /v2/login, challenge/v1/continue, pow-puzzle, 2fa.
//   node backend/src/debug/robloxCdpCapture2.js <username> <password> [outfile]
const fs = require('fs')
const [, , U, P, outArg] = process.argv
const OUT = outArg || 'C:\\playerok\\backend\\src\\debug\\roblox-capture.log'
const MATCH = /\/v2\/login|\/v2\/signup|challenge\/v1\/continue|proof-of-work|pow-puzzle|twostepverification|challenge\/v1\/|secure-authentication-intent|authentication-intent|intent\/v1|server-nonce|nonce/i

fs.writeFileSync(OUT, '# capture2 started\n')
function out(s) { fs.appendFileSync(OUT, s + '\n'); console.log(s) }

const FILL = `(() => {
  function setVal(el, val){
    const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    d.set.call(el, val);
    el.dispatchEvent(new Event('input', {bubbles:true}));
    el.dispatchEvent(new Event('change', {bubbles:true}));
  }
  const u = document.querySelector('#login-username, input[name="username"], input[autocomplete="username"]');
  const p = document.querySelector('#login-password, input[type="password"], input[name="password"]');
  if (!u || !p) return {ok:false, u:!!u, p:!!p, href: location.href};
  setVal(u, ${JSON.stringify(U)}); setVal(p, ${JSON.stringify(P)});
  const btn = document.querySelector('#login-button') ||
              Array.from(document.querySelectorAll('button')).find(b => /log\\s*in|войти|sign\\s*in/i.test(b.textContent||''));
  const form = u.closest('form');
  let how = 'none';
  if (btn) { btn.click(); how = 'btn:' + (btn.id||btn.textContent||'').trim(); }
  else if (form && form.requestSubmit) { form.requestSubmit(); how = 'requestSubmit'; }
  return {ok:true, filledU:u.value.length, filledP:p.value.length, how, href: location.href};
})()`

let ws, id = 1
const pend = new Map()
function send(method, params) {
  const i = id++
  ws.send(JSON.stringify({ id: i, method, params: params || {} }))
  return new Promise((r) => pend.set(i, r))
}
const reqs = new Map()

function pick(h, names) { const o = {}; if (!h) return o; for (const k of Object.keys(h)) { if (names.some((n) => k.toLowerCase().includes(n))) o[k] = h[k] } return o }
function flush(rid, e) {
  reqs.delete(rid)
  out('\n================ ' + e.method + ' ' + e.url + ' -> HTTP ' + (e.status || '?'))
  const rqh = pick(e.reqHeaders, ['x-csrf', 'rblx-challenge'])
  if (Object.keys(rqh).length) out('  REQ headers: ' + JSON.stringify(rqh))
  if (e.postData) out('  REQ body: ' + String(e.postData).slice(0, 1800))
  const rsh = pick(e.respHeaders, ['x-csrf', 'rblx-challenge'])
  if (Object.keys(rsh).length) out('  RESP challenge headers: ' + JSON.stringify(rsh))
  if (e.respBody) out('  RESP body: ' + String(e.respBody).slice(0, 1800))
}

async function handle(m) {
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || m.error || null); pend.delete(m.id); return }
  const p = m.params || {}
  if (m.method === 'Network.requestWillBeSent') {
    if (!MATCH.test(p.request.url)) return
    const e = { url: p.request.url, method: p.request.method, reqHeaders: p.request.headers, postData: p.request.postData || null }
    reqs.set(p.requestId, e)
    if (!e.postData && p.request.hasPostData) { const r = await send('Network.getRequestPostData', { requestId: p.requestId }).catch(() => null); if (r && r.postData) e.postData = r.postData }
  } else if (m.method === 'Network.responseReceived') {
    const e = reqs.get(p.requestId); if (!e) return
    e.status = p.response.status; e.respHeaders = p.response.headers
  } else if (m.method === 'Network.loadingFinished') {
    const e = reqs.get(p.requestId); if (!e) return
    const b = await send('Network.getResponseBody', { requestId: p.requestId }).catch(() => null)
    e.respBody = b ? (b.base64Encoded ? Buffer.from(b.body, 'base64').toString('utf8') : b.body) : null
    flush(p.requestId, e)
  }
}

;(async () => {
  const list = await fetch('http://127.0.0.1:9223/json').then((r) => r.json())
  const page = list.find((t) => t.type === 'page' && /roblox\.com/i.test(t.url)) || list.find((t) => t.type === 'page')
  if (!page) { out('# нет page-таргета'); return }
  out('# target: ' + page.url)
  ws = new WebSocket(page.webSocketDebuggerUrl)
  ws.onmessage = (ev) => handle(JSON.parse(ev.data))
  await new Promise((res) => (ws.onopen = res))
  await send('Network.enable')
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Network.clearBrowserCookies').catch(() => {})
  out('# Network включён, cookie очищены (логаут). Открываю чистую /Login…')
  await send('Page.navigate', { url: 'https://www.roblox.com/Login' })
  await new Promise((r) => setTimeout(r, 4000))
  const r = await send('Runtime.evaluate', { expression: FILL, returnByValue: true })
  out('# fill: ' + JSON.stringify(r && r.result ? r.result.value : r))
  out('# отправлено. Если выскочит интерактивная капча — решите её в окне Chrome, ловлю трафик.')
})().catch((e) => out('# fatal ' + (e && e.stack ? e.stack : e)))
