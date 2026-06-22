'use strict'
// Тест кооперативной капчи на ЧИСТОМ HTTP-движке (robloxAuthClient, без браузера):
//   startBuyerLogin -> PoW решается сам -> captcha -> отдаём hosted-страницу по локальной ссылке
//   -> вы решаете FunCaptcha в браузере -> токен -> completeBuyerCaptcha -> cookie / 2FA.
//   node backend/src/debug/robloxCaptchaLinkTest.js <username> <password> [port]
const http = require('http')
const { startBuyerLogin, completeBuyerCaptcha } = require('../integrations/roblox/robloxAuthClient')

const [, , username, password, portArg] = process.argv
const PORT = Number(portArg) || 8799

// Hosted-страница с виджетом Arkose (упрощённая копия renderCaptchaPage).
function renderCaptchaPage({ publicKey, blob, error } = {}) {
  const style = `body{font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#0f1116;color:#e8eaed;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}.card{background:#1a1d24;padding:28px 26px;border-radius:14px;max-width:420px;width:92%}h1{font-size:1.15rem;margin:0 0 6px}p.lead{color:#9aa0aa;font-size:.9rem;margin:0 0 18px;line-height:1.4}#arkose{min-height:80px;display:flex;justify-content:center}.err{color:#f87171}.ok{color:#34d399}`
  if (error) {
    return `<!doctype html><meta charset="utf-8"><style>${style}</style><div class="card"><h1>Проверка Roblox</h1><p class="err">${String(error).replace(/</g, '&lt;')}</p></div>`
  }
  const pk = String(publicKey || '476068BF-9607-4799-B53D-966BE98E2B81').replace(/[^a-z0-9-]/gi, '')
  const blobJs = JSON.stringify(blob || '')
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>Проверка Roblox</title><style>${style}</style></head><body>
    <div class="card"><h1>Подтверждение входа Roblox</h1>
      <p class="lead">Пройдите проверку безопасности. После прохождения страница сообщит результат.</p>
      <div id="arkose"></div><p id="msg" class="lead"></p></div>
    <script>
      var BLOB = ${blobJs}, PATH = '/captcha', cbFired = false;
      function msg(t,cls){var m=document.getElementById('msg');m.textContent=t;m.className=cls||'lead';}
      window.onerror=function(m){msg('JS error: '+m,'err');};
      msg('Загружаем проверку безопасности…');
      function submitToken(t){ msg('Токен получен, проверяем на сервере…');
        fetch(PATH,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:t})})
          .then(function(r){return r.json();}).then(function(j){
            if(j.ok&&j.status==='ready'){msg('✓ Готово! Вход подтверждён.', 'ok');}
            else if(j.ok&&j.needs2fa){msg('Капча пройдена. Дальше 2FA: '+(j.mediaType||''), 'ok');}
            else{msg(j.error||'Не удалось.', 'err');}
          }).catch(function(){msg('Сеть недоступна.', 'err');});
      }
      function setupEnforcement(enf){ cbFired = true; msg('Виджет загружен, запускаем проверку…');
        try{ enf.setConfig({selector:'#arkose',mode:'inline',
        data: BLOB?{blob:BLOB}:undefined,
        onReady:function(){msg('Готово. Решите задание (если появилось).');},
        onShown:function(){msg('Решите задание выше.');},
        onSuppress:function(){msg('Капча прозрачная (suppressed)…');},
        onCompleted:function(r){submitToken(r.token);},
        onError:function(e){msg('Arkose onError: '+(e&&e.error?JSON.stringify(e.error):JSON.stringify(e)), 'err');},
        onFailed:function(){msg('Проверка не пройдена.', 'err');}});
        if(enf.run)enf.run(); }
        catch(e){msg('setConfig error: '+e, 'err');} }
      setTimeout(function(){ if(!cbFired){ msg('Arkose api.js не вызвал callback за 12с — ключ Roblox, скорее всего, не пускает виджет с localhost. Нужен боевой домен.', 'err'); } }, 12000);
    </script>
    <script src="https://arkoselabs.roblox.com/v2/${pk}/api.js" data-callback="setupEnforcement" async defer
      onerror="document.getElementById('msg').textContent='api.js не загрузился (сеть/блокировка домена arkoselabs).';document.getElementById('msg').className='err';"></script>
    </body></html>`
}

let captchaState = null

;(async () => {
  console.log('[1] startBuyerLogin (PoW решается сам)…')
  const r = await startBuyerLogin({ username, password })
  console.log('[1] outcome:', r.outcome)
  if (r.outcome === 'ok') {
    console.log('Вход без капчи! cookie len:', r.cookie && r.cookie.length, 'user:', r.user && r.user.name)
    return
  }
  if (r.outcome === '2fa') {
    console.log('Сразу 2FA, без капчи. mediaType:', r.mediaType, '— отдельный тест.')
    return
  }
  if (r.outcome !== 'captcha') {
    console.log('Не captcha:', JSON.stringify(r))
    return
  }
  captchaState = r
  console.log('[1] captcha: blob len', String(r.blob || '').length, 'publicKey', r.publicKey)

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/captcha')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(renderCaptchaPage({ publicKey: captchaState.publicKey, blob: captchaState.blob }))
      return
    }
    if (req.method === 'POST' && req.url.startsWith('/captcha')) {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', async () => {
        let token = ''
        try { token = (JSON.parse(body || '{}').token) || '' } catch (_) {}
        console.log('[2] получен токен капчи (len', String(token).length, ') → completeBuyerCaptcha…')
        const out = await completeBuyerCaptcha({ state: captchaState, token })
        console.log('[3] outcome:', out.outcome)
        let data
        if (out.outcome === 'ok') {
          console.log('=== УСПЕХ: .ROBLOSECURITY len', out.cookie && out.cookie.length, 'user:', out.user && out.user.name, '===')
          data = { ok: true, status: 'ready' }
        } else if (out.outcome === '2fa') {
          console.log('=== Капча пройдена, дальше 2FA:', out.mediaType, '===')
          data = { ok: true, needs2fa: true, mediaType: out.mediaType }
        } else {
          console.log('=== Не вышло:', out.error || JSON.stringify(out), '===')
          data = { ok: false, error: out.error || 'Капча не принята' }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(data))
      })
      return
    }
    res.writeHead(404); res.end('not found')
  })
  server.listen(PORT, '127.0.0.1', () => {
    console.log('\n=== ОТКРОЙТЕ В БРАУЗЕРЕ: http://127.0.0.1:' + PORT + '/captcha ===')
    console.log('Решите FunCaptcha — результат появится здесь в консоли.\n')
  })
})().catch((e) => console.error('ERR', e && e.stack ? e.stack : e))
