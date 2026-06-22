'use strict'
// Диагностика финального звена: боевой startBuyerLogin доводит до captcha (реальные jar/sai/csrf),
// а continue+retry делаем ИНЛАЙН с полным логом (токен, ответ continue, ответ retry, set-cookie).
//   node backend/src/debug/robloxCaptchaDebug.js <username> <password> [port]
const http = require('http')
const https = require('https')
const { startBuyerLogin } = require('../integrations/roblox/robloxAuthClient')

const [, , U, P, portArg] = process.argv
const PORT = Number(portArg) || 8812
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'

function jarHeader(jar) { const k = Object.keys(jar || {}); return k.length ? k.map((x) => `${x}=${jar[x]}`).join('; ') : null }
function jarUpd(jar, sc) { if (!jar || !sc) return; for (const c of (Array.isArray(sc) ? sc : [sc])) { const p = String(c).split(';')[0]; const i = p.indexOf('='); if (i <= 0) continue; const n = p.slice(0, i).trim(), v = p.slice(i + 1).trim(); if (v === 'DELETE' || v === '') delete jar[n]; else jar[n] = v } }
function req({ method = 'GET', url, headers = {}, body, jar }) {
  return new Promise((res, rej) => {
    const u = new URL(url); const payload = body == null ? null : JSON.stringify(body)
    const h = { 'User-Agent': UA, Accept: 'application/json', ...headers }
    const ck = jarHeader(jar); if (ck) h.Cookie = ck
    if (payload != null) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(payload) }
    const r = https.request({ method, hostname: u.hostname, path: u.pathname + (u.search || ''), headers: h }, (rp) => {
      const ch = []; rp.on('data', (c) => ch.push(c)); rp.on('end', () => { if (jar) jarUpd(jar, rp.headers['set-cookie']); const t = Buffer.concat(ch).toString('utf8'); let j = null; try { j = t ? JSON.parse(t) : null } catch (_) {} res({ status: rp.statusCode, headers: rp.headers, text: t, json: j }) })
    })
    r.on('error', rej); r.setTimeout(20000, () => r.destroy(new Error('timeout'))); if (payload != null) r.write(payload); r.end()
  })
}

let S = null

;(async () => {
  const r = await startBuyerLogin({ username: U, password: P })
  console.log('[start] outcome:', r.outcome)
  if (r.outcome !== 'captcha') { console.log(JSON.stringify(r).slice(0, 300)); return }
  S = r
  console.log('[start] challengeId:', r.challengeId, '| unifiedCaptchaId:', r.unifiedCaptchaId, '| cookies:', Object.keys(r.ctx.jar || {}).join(','), '| sai:', !!r.ctx.sai)

  http.createServer((rq, rs) => {
    if (rq.method === 'GET') { rs.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); rs.end(page()); return }
    let b = ''; rq.on('data', (c) => (b += c)); rq.on('end', async () => {
      let token = ''; try { token = JSON.parse(b || '{}').token || '' } catch (_) {}
      const out = await complete(token)
      rs.writeHead(200, { 'Content-Type': 'application/json' }); rs.end(JSON.stringify(out))
    })
  }).listen(PORT, '127.0.0.1', () => console.log(`\n=== ОТКРОЙТЕ: http://127.0.0.1:${PORT}/ ===\n`))
})().catch((e) => console.error('ERR', e && e.stack ? e.stack : e))

async function complete(token) {
  const { csrf, sai, jar } = S.ctx
  const challengeId = S.challengeId, unifiedCaptchaId = S.unifiedCaptchaId
  console.log('\n[token] len', token.length)
  const surl = (token.match(/surl=([^|]+)/) || [])[1]
  const pk = (token.match(/pk=([^|]+)/) || [])[1]
  const sup = (token.match(/sup=([^|]+)/) || [])[1]
  console.log('[token] pk:', pk, '| sup:', sup, '| surl:', surl ? decodeURIComponent(surl) : '(нет)')
  console.log('[token] full:', token)
  const solvedMeta = JSON.stringify({ unifiedCaptchaId, captchaToken: token, actionType: 'Login' })

  const cont = await req({ method: 'POST', url: 'https://apis.roblox.com/challenge/v1/continue', headers: { 'X-CSRF-TOKEN': csrf }, body: { challengeId, challengeType: 'captcha', challengeMetadata: solvedMeta }, jar })
  console.log('[captcha-continue] HTTP', cont.status, '| body:', cont.text.slice(0, 250))

  const body = { ctype: 'Username', cvalue: U, password: P }
  if (sai) body.secureAuthenticationIntent = sai
  const retry = await req({ method: 'POST', url: 'https://auth.roblox.com/v2/login', headers: { 'X-CSRF-TOKEN': csrf, 'Rblx-Challenge-Id': challengeId, 'Rblx-Challenge-Type': 'proofofwork', 'Rblx-Challenge-Metadata': Buffer.from(solvedMeta, 'utf8').toString('base64') }, body, jar })
  console.log('[retry-login] HTTP', retry.status)
  console.log('  body:', retry.text.slice(0, 300))
  const sc = retry.headers['set-cookie'] || []
  const rs = sc.map(String).find((c) => /\.ROBLOSECURITY=/.test(c))
  console.log('  .ROBLOSECURITY in set-cookie:', rs ? 'YES (len ' + rs.length + ')' : 'no')
  console.log('  cookies now:', Object.keys(jar).join(','))
  if (retry.status === 200 && (rs || jar['.ROBLOSECURITY'])) { console.log('\n=== УСПЕХ ==='); return { ok: true, status: 'ready' } }
  const err = (retry.json && retry.json.errors && retry.json.errors[0] && retry.json.errors[0].message) || ('HTTP ' + retry.status)
  return { ok: false, error: err }
}

function page() {
  const pk = S.publicKey, blobJs = JSON.stringify(S.blob || '')
  return `<!doctype html><meta charset="utf-8"><style>body{font-family:system-ui;background:#0f1116;color:#e8eaed;display:flex;min-height:100vh;align-items:center;justify-content:center}.card{background:#1a1d24;padding:26px;border-radius:14px;max-width:420px;width:92%}#arkose{min-height:80px}</style>
  <div class="card"><h3>Подтверждение входа Roblox</h3><div id="arkose"></div><p id="msg"></p></div>
  <script>var BLOB=${blobJs};function msg(t){document.getElementById('msg').textContent=t}window.onerror=function(m){msg('JS error: '+m)};msg('Загружаем…');
  function sub(t){msg('Токен получен, проверяем…');fetch('/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:t})}).then(r=>r.json()).then(j=>msg(j.ok?'✓ Готово!':('Ошибка: '+(j.error||'')))).catch(()=>msg('сеть'))}
  function setupEnforcement(e){msg('Виджет загружен…');try{e.setConfig({selector:'#arkose',mode:'inline',data:BLOB?{blob:BLOB}:undefined,onShown:function(){msg('Решите задание.')},onCompleted:function(r){sub(r.token)},onError:function(x){msg('Arkose error: '+JSON.stringify(x&&x.error||x))},onFailed:function(){msg('не пройдена')}});if(e.run)e.run()}catch(x){msg('cfg err: '+x)}}
  </script>
  <script src="https://arkoselabs.roblox.com/v2/${pk}/api.js" data-callback="setupEnforcement" async defer onerror="document.getElementById('msg').textContent='api.js не загрузился'"></script>`
}
