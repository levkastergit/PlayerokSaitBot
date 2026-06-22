'use strict'
// Хукает crypto.subtle.sign / generateKey / exportKey в странице Roblox (CDP :9224),
// логинится, и печатает ТОЧНЫЕ данные, которые подписываются для secureAuthenticationIntent.
//   node backend/src/debug/robloxCdpSigHook.js <username> <password>
const [, , U, P] = process.argv

const HOOK = `(() => {
  window.__sig = [];
  const S = crypto.subtle;
  const toU8 = (d) => d instanceof ArrayBuffer ? new Uint8Array(d)
      : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength) : new Uint8Array(0);
  const origSign = S.sign.bind(S);
  S.sign = function(alg, key, data){
    try {
      const b = toU8(data);
      let text=''; try{ text=new TextDecoder().decode(b);}catch(_){}
      window.__sig.push({kind:'sign', alg:(alg&&alg.name)||String(alg), len:b.length, text:text,
        hex: Array.from(b.slice(0,200)).map(x=>x.toString(16).padStart(2,'0')).join('')});
    } catch(e){ window.__sig.push({kind:'sign-err', e:String(e)}); }
    return origSign(alg, key, data);
  };
})()`

const FILL = `(() => {
  function setVal(el,val){const d=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');d.set.call(el,val);
    el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}
  const u=document.querySelector('#login-username, input[name="username"], input[autocomplete="username"]');
  const p=document.querySelector('#login-password, input[type="password"]');
  if(!u||!p) return {ok:false,href:location.href};
  setVal(u, ${JSON.stringify(U)}); setVal(p, ${JSON.stringify(P)});
  const btn=document.querySelector('#login-button')||Array.from(document.querySelectorAll('button')).find(b=>/log\\s*in|войти/i.test(b.textContent||''));
  if(btn) btn.click();
  return {ok:true, clicked:!!btn, href:location.href};
})()`

let ws, id = 1
const pend = new Map()
function send(method, params) { const i = id++; ws.send(JSON.stringify({ id: i, method, params: params || {} })); return new Promise((r) => pend.set(i, r)) }

;(async () => {
  const list = await fetch('http://127.0.0.1:9224/json').then((r) => r.json())
  const page = list.find((t) => t.type === 'page')
  console.log('target:', page.url)
  ws = new WebSocket(page.webSocketDebuggerUrl)
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || m.error); pend.delete(m.id) } }
  await new Promise((res) => (ws.onopen = res))
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  await send('Network.clearBrowserCookies').catch(() => {})
  await send('Page.addScriptToEvaluateOnNewDocument', { source: HOOK })
  console.log('hook installed; navigating /Login…')
  await send('Page.navigate', { url: 'https://www.roblox.com/Login' })
  await new Promise((r) => setTimeout(r, 4500))
  const f = await send('Runtime.evaluate', { expression: FILL, returnByValue: true })
  console.log('fill:', JSON.stringify(f && f.result ? f.result.value : f))
  await new Promise((r) => setTimeout(r, 9000))
  const sig = await send('Runtime.evaluate', { expression: 'JSON.stringify(window.__sig||[])', returnByValue: true })
  console.log('\n=== SIGNED DATA ===')
  console.log(sig && sig.result ? sig.result.value : JSON.stringify(sig))
  ws.close()
})().catch((e) => console.log('ERR', e && e.stack ? e.stack : e))
