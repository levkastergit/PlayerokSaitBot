'use strict'
// Диагностика: ВЕСЬ HTTP-вход в одном файле с COOKIE-JAR через все шаги и полным логом
// captcha continue/retry. Цель — понять, почему completeBuyerCaptcha даёт
// "Challenge failed to authorize request" (гипотеза: нужна сессионная cookie).
//   node backend/src/debug/robloxFullHttpLogin.js <username> <password> [port]
const https = require('https')
const http = require('http')

const [, , USERNAME, PASSWORD, portArg] = process.argv
const PORT = Number(portArg) || 8802
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'

// ── cookie jar ───────────────────────────────────────────────
const jar = {}
function applySetCookie(setCookie) {
  const arr = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []
  for (const c of arr) {
    const pair = String(c).split(';')[0]
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (!name) continue
    if (value === 'DELETE' || value === '') { delete jar[name]; continue }
    jar[name] = value
  }
}
function cookieHeader() {
  const keys = Object.keys(jar)
  return keys.length ? keys.map((k) => `${k}=${jar[k]}`).join('; ') : null
}

function request({ method = 'GET', url, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const payload = body == null ? null : typeof body === 'string' ? body : JSON.stringify(body)
    const h = { 'User-Agent': UA, Accept: 'application/json', ...headers }
    const ck = cookieHeader()
    if (ck) h.Cookie = ck
    if (payload != null) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(payload) }
    const req = https.request({ method, hostname: u.hostname, path: u.pathname + (u.search || ''), headers: h }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        applySetCookie(res.headers['set-cookie'])
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try { json = text ? JSON.parse(text) : null } catch (_) {}
        resolve({ status: res.statusCode || 0, headers: res.headers || {}, text, json })
      })
    })
    req.on('error', reject)
    req.setTimeout(20000, () => req.destroy(new Error('timeout')))
    if (payload != null) req.write(payload)
    req.end()
  })
}

const b64dec = (s) => { try { return Buffer.from(String(s || ''), 'base64').toString('utf8') } catch (_) { return null } }
const b64enc = (s) => Buffer.from(String(s), 'utf8').toString('base64')
function solvePow(nStr, aStr, t) { const N = BigInt(nStr); let x = BigInt(aStr) % N; for (let i = 0; i < t; i++) x = (x * x) % N; return x.toString() }

let CSRF = null
async function getCsrf() {
  const r = await request({ method: 'POST', url: 'https://auth.roblox.com/v2/login', body: {} })
  return r.headers['x-csrf-token'] || null
}

let captchaState = null

async function run() {
  CSRF = await getCsrf()
  console.log('[csrf]', CSRF ? 'ok' : 'NULL', '| cookies:', Object.keys(jar).join(','))

  let r = await request({ method: 'POST', url: 'https://auth.roblox.com/v2/login',
    headers: { 'X-CSRF-TOKEN': CSRF }, body: { ctype: 'Username', cvalue: USERNAME, password: PASSWORD } })
  if (r.headers['x-csrf-token']) CSRF = r.headers['x-csrf-token']
  console.log('[login] HTTP', r.status, 'challenge:', r.headers['rblx-challenge-type'], '| cookies:', Object.keys(jar).join(','))
  if (r.status !== 403 || !/proofofwork/.test(r.headers['rblx-challenge-type'] || '')) {
    console.log('  body:', r.text.slice(0, 300)); return
  }
  const powChallengeId = r.headers['rblx-challenge-id']
  const powMetaJson = b64dec(r.headers['rblx-challenge-metadata'])
  const powMeta = JSON.parse(powMetaJson)
  const sid = powMeta.sessionId

  // PoW
  const pz = await request({ method: 'GET', url: `https://apis.roblox.com/proof-of-work-service/v1/pow-puzzle?sessionID=${encodeURIComponent(sid)}`, headers: { 'X-CSRF-TOKEN': CSRF } })
  const art = JSON.parse(pz.json.artifacts)
  const solution = solvePow(String(art.N), String(art.A), Number(art.T))
  const ans = await request({ method: 'POST', url: 'https://apis.roblox.com/proof-of-work-service/v1/pow-puzzle', headers: { 'X-CSRF-TOKEN': CSRF }, body: { sessionID: sid, solution } })
  console.log('[pow] answerCorrect:', ans.json && ans.json.answerCorrect, '| cookies:', Object.keys(jar).join(','))
  const redemptionToken = ans.json.redemptionToken
  const powUpdated = powMetaJson.replace('"redemptionToken":""', `"redemptionToken":"${redemptionToken}"`)

  const cont = await request({ method: 'POST', url: 'https://apis.roblox.com/challenge/v1/continue', headers: { 'X-CSRF-TOKEN': CSRF }, body: { challengeId: powChallengeId, challengeType: 'proofofwork', challengeMetadata: powUpdated } })
  if (cont.headers['x-csrf-token']) CSRF = cont.headers['x-csrf-token']
  console.log('[pow-continue] HTTP', cont.status, 'next(body):', cont.json && cont.json.challengeType, '| cookies:', Object.keys(jar).join(','))

  // Per login_service/u6dq/devforum: после PoW РЕ-запрашиваем /v2/login — captcha приходит в ЗАГОЛОВКАХ.
  const afterPow = await request({ method: 'POST', url: 'https://auth.roblox.com/v2/login',
    headers: { 'X-CSRF-TOKEN': CSRF, 'Rblx-Challenge-Id': powChallengeId, 'Rblx-Challenge-Type': 'proofofwork', 'Rblx-Challenge-Metadata': b64enc(powUpdated) },
    body: { ctype: 'Username', cvalue: USERNAME, password: PASSWORD } })
  if (afterPow.headers['x-csrf-token']) CSRF = afterPow.headers['x-csrf-token']
  const capType = afterPow.headers['rblx-challenge-type']
  console.log('[after-pow login] HTTP', afterPow.status, 'challenge-type(header):', capType || '-', 'id:', afterPow.headers['rblx-challenge-id'] || '-')
  if (afterPow.status === 200) {
    const rs = jar['.ROBLOSECURITY']
    console.log('=== ВОШЛИ СРАЗУ после PoW! .ROBLOSECURITY:', rs ? 'len ' + rs.length : 'нет', '===')
    return
  }
  if (!/captcha/.test(capType || '')) {
    console.log('  нет captcha в заголовках. body:', afterPow.text.slice(0, 250))
    return
  }
  const capId = afterPow.headers['rblx-challenge-id']
  const capMetaB64 = afterPow.headers['rblx-challenge-metadata']
  const capMetaStr = b64dec(capMetaB64)
  const capMeta = JSON.parse(capMetaStr)
  captchaState = { challengeId: capId, metaB64: capMetaB64, metaStr: capMetaStr, unifiedCaptchaId: capMeta.unifiedCaptchaId, blob: capMeta.dataExchangeBlob, publicKey: '476068BF-9607-4799-B53D-966BE98E2B81' }
  console.log('[captcha] из ЗАГОЛОВКА: id', capId, '| unifiedCaptchaId', capMeta.unifiedCaptchaId, '| blob len', String(captchaState.blob || '').length)

  // server
  http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/captcha')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page()); return
    }
    if (req.method === 'POST' && req.url.startsWith('/captcha')) {
      let b = ''; req.on('data', (c) => (b += c)); req.on('end', async () => {
        let token = ''; try { token = JSON.parse(b || '{}').token || '' } catch (_) {}
        const out = await completeCaptcha(token)
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(out))
      }); return
    }
    res.writeHead(404); res.end('nf')
  }).listen(PORT, '127.0.0.1', () => {
    console.log(`\n=== ОТКРОЙТЕ: http://127.0.0.1:${PORT}/captcha ===\n`)
  })
}

async function completeCaptcha(token) {
  console.log('\n[captcha] token len', String(token).length)
  console.log('[captcha] challengeId(header):', captchaState.challengeId, '| unifiedCaptchaId:', captchaState.unifiedCaptchaId)

  // challengeId = из заголовка Rblx-Challenge-Id (devforum fix). Continue: урезанные метаданные.
  const capId = captchaState.challengeId
  const stripped = JSON.stringify({ unifiedCaptchaId: captchaState.unifiedCaptchaId, captchaToken: token, actionType: 'Login' })

  const cont = await request({ method: 'POST', url: 'https://apis.roblox.com/challenge/v1/continue',
    headers: { 'X-CSRF-TOKEN': CSRF }, body: { challengeId: capId, challengeType: 'captcha', challengeMetadata: stripped } })
  if (cont.headers['x-csrf-token']) CSRF = cont.headers['x-csrf-token']
  console.log('[captcha-continue] HTTP', cont.status, 'body:', cont.text.slice(0, 200), '| cookies:', Object.keys(jar).join(','))

  const retry = await request({ method: 'POST', url: 'https://auth.roblox.com/v2/login',
    headers: { 'X-CSRF-TOKEN': CSRF, 'Rblx-Challenge-Id': capId, 'Rblx-Challenge-Type': 'captcha', 'Rblx-Challenge-Metadata': captchaState.metaB64 },
    body: { ctype: 'Username', cvalue: USERNAME, password: PASSWORD } })
  console.log('[retry-login] HTTP', retry.status, 'next-challenge:', retry.headers['rblx-challenge-type'] || '-')
  console.log('  body:', retry.text.slice(0, 300))
  console.log('  cookies now:', Object.keys(jar).join(','))

  if (retry.status === 200) {
    const cookie = (retry.headers['set-cookie'] || []).map(String).find((c) => /\.ROBLOSECURITY=/.test(c))
    const rs = jar['.ROBLOSECURITY']
    if (rs) { console.log('\n=== УСПЕХ: .ROBLOSECURITY len', rs.length, '==='); return { ok: true, status: 'ready' } }
    console.log('200 без cookie:', cookie || '(нет в set-cookie)')
    return { ok: true, status: 'ready' }
  }
  const nt = retry.headers['rblx-challenge-type']
  if (retry.status === 403 && /twostep/.test(nt || '')) return { ok: true, needs2fa: true, mediaType: 'authenticator' }
  const err = (retry.json && retry.json.errors && retry.json.errors[0] && retry.json.errors[0].message) || `HTTP ${retry.status}`
  console.log('=== Не вышло:', err, '===')
  return { ok: false, error: err }
}

function page() {
  const pk = captchaState.publicKey, blobJs = JSON.stringify(captchaState.blob || '')
  return `<!doctype html><meta charset="utf-8"><title>Проверка</title>
  <style>body{font-family:system-ui;background:#0f1116;color:#e8eaed;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}.card{background:#1a1d24;padding:26px;border-radius:14px;max-width:420px;width:92%}#arkose{min-height:80px}</style>
  <div class="card"><h3>Подтверждение входа Roblox</h3><div id="arkose"></div><p id="msg"></p></div>
  <script>
   var BLOB=${blobJs};function msg(t){document.getElementById('msg').textContent=t;}
   window.onerror=function(m){msg('JS error: '+m);};msg('Загружаем проверку…');
   function submitToken(t){msg('Токен получен, проверяем на сервере…');
     fetch('/captcha',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:t})})
       .then(function(r){return r.json();}).then(function(j){msg(j.ok?(j.status==='ready'?'✓ Готово!':(j.needs2fa?'Капча ок → 2FA':'ok')):('Ошибка: '+(j.error||'')));})
       .catch(function(){msg('сеть');});}
   function setupEnforcement(e){msg('Виджет загружен…');try{e.setConfig({selector:'#arkose',mode:'inline',data:BLOB?{blob:BLOB}:undefined,
     onShown:function(){msg('Решите задание.');},onCompleted:function(r){submitToken(r.token);},onError:function(x){msg('Arkose error: '+JSON.stringify(x&&x.error||x));},onFailed:function(){msg('не пройдена');}});if(e.run)e.run();}catch(x){msg('cfg err: '+x);}}
  </script>
  <script src="https://roblox-api.arkoselabs.com/v2/${pk}/api.js" data-callback="setupEnforcement" async defer onerror="document.getElementById('msg').textContent='api.js не загрузился'"></script>`
}

run().catch((e) => console.error('ERR', e && e.stack ? e.stack : e))
