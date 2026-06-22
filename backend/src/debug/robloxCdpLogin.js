'use strict'
// Заполняет форму логина Roblox в уже открытом Chrome (CDP :9222) и жмёт вход.
//   node backend/src/debug/robloxCdpLogin.js <username> <password>
const [, , U, P] = process.argv

const FILL = `(() => {
  function setVal(el, val){
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value') ||
              Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    d.set.call(el, val);
    el.dispatchEvent(new Event('input', {bubbles:true}));
    el.dispatchEvent(new Event('change', {bubbles:true}));
  }
  const u = document.querySelector('#login-username, input[name="username"], input[autocomplete="username"]');
  const p = document.querySelector('#login-password, input[type="password"], input[name="password"]');
  if (!u || !p) return {ok:false, u:!!u, p:!!p, href: location.href};
  setVal(u, ${JSON.stringify(U)}); setVal(p, ${JSON.stringify(P)});
  const btn = document.querySelector('#login-button, button[type="submit"], button.btn-primary-md, .signup-submit-button');
  let clicked = false;
  if (btn) { btn.click(); clicked = true; }
  return {ok:true, filledU:u.value.length, filledP:p.value.length, clicked, btnText: btn && (btn.textContent||'').trim(), href: location.href};
})()`

let ws, id = 1
const pend = new Map()
function send(method, params, sid) {
  const i = id++
  const m = { id: i, method, params: params || {} }; if (sid) m.sessionId = sid
  ws.send(JSON.stringify(m))
  return new Promise((r) => pend.set(i, r))
}

;(async () => {
  const list = await fetch('http://127.0.0.1:9222/json').then((r) => r.json())
  const page = list.find((t) => t.type === 'page' && /roblox\.com/i.test(t.url)) || list.find((t) => t.type === 'page')
  if (!page) { console.log('нет page-таргета'); return }
  console.log('target:', page.url)
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res) => (ws.onopen = res))
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || m.error); pend.delete(m.id) } }
  await send('Runtime.enable')
  const r = await send('Runtime.evaluate', { expression: FILL, returnByValue: true })
  console.log('fill result:', JSON.stringify(r && r.result ? r.result.value : r))
  ws.close()
})().catch((e) => console.log('ERR', e && e.message))
