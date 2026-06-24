// Публичный раздел «Загрузка» + приёмник капчур-отчётов.
//   GET  /download                     — HTML-страница раздела (без сессии)
//   GET  /download/<file>              — отдача файла из public/downloads (белый список)
//   POST /download/capture             — приём отчёта со скрипта пользователя (X-Capture-Token = upload)
//   GET  /download/captures[/<id>]     — выдача принятых отчётов (X-Capture-Token = read; для Claude)
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const DOWNLOADS_DIR = path.join(__dirname, '..', '..', 'public', 'downloads')
const CAPTURES_DIR = path.join(__dirname, '..', '..', 'data', 'captures')

// upload-токен зашит в публичный скрипт (анти-бот, не секрет). read-токен — только из env (секрет, для Claude).
const UPLOAD_TOKEN = String(process.env.CAPTURE_UPLOAD_TOKEN || 'rbxcap-2f9a4c7e').trim()
const READ_TOKEN = String(process.env.CAPTURE_READ_TOKEN || '').trim()
const MAX_UPLOAD = 5 * 1024 * 1024
const KEEP_CAPTURES = 60

const FILES = {
  'run_msstore_capture.ps1': {
    type: 'text/plain; charset=utf-8',
    title: 'run_msstore_capture.ps1',
    desc: 'ГЛАВНЫЙ. Лаунчер перехвата трафика приложения Roblox (MS Store) при покупке Robux. Запускать от Администратора; рядом положи capture_msstore_app.py. Сам ставит mitmproxy, по выходу всё откатывает и шлёт отчёт.',
  },
  'capture_msstore_app.py': {
    type: 'text/x-python; charset=utf-8',
    title: 'capture_msstore_app.py',
    desc: 'Аддон mitmproxy к лаунчеру выше (положи в ту же папку). Фильтрует/маскирует трафик и отправляет отчёт на сервер.',
  },
  'capture_robux_purchase.py': {
    type: 'text/x-python; charset=utf-8',
    title: 'capture_robux_purchase.py',
    desc: 'ЗАПАСНОЙ: захват покупки через БРАУЗЕР (roblox.com), без прокси. Только если покупаешь не в приложении, а на сайте.',
  },
  'mint_xsts.py': {
    type: 'text/x-python; charset=utf-8',
    title: 'mint_xsts.py',
    desc: 'Прототип B: минт коммерческого токена XSTS (вход в MSA по device-code) + БЕЗОПАСНАЯ проверка на каталоге (без оплаты). Покажет, какой relying-party принимает токен для покупки.',
  },
  'diag_buynow.ps1': {
    type: 'text/plain; charset=utf-8',
    title: 'diag_buynow.ps1',
    desc: 'НОВЫЙ. Диагностика «белого окна» при покупке 80 Robux. Ничего не покупает и не меняет — только читает состояние: ищет перехват TLS (mitmproxy/прокси), проверяет WebView2 Runtime, системный прокси, часы и доступность хостов оплаты. Запуск: powershell -ExecutionPolicy Bypass -File diag_buynow.ps1',
  },
  'test_a_robux.ps1': {
    type: 'text/plain; charset=utf-8',
    title: 'test_a_robux.ps1',
    desc: 'НОВЫЙ — ТЕСТ A. Проверяет, уйдут ли Robux на ПРОИЗВОЛЬНЫЙ userId (не залогиненный в приложении). Обёртка над капчуром: при реальной покупке 80 Robux подменяет получателя на твой userId. Нужны рядом run_msstore_capture.ps1 и capture_msstore_app.py. Инструкция — ниже на этой странице.',
  },
  'inject_cookie.ps1': {
    type: 'text/plain; charset=utf-8',
    title: 'inject_cookie.ps1',
    desc: 'НОВЫЙ — B2. Запускать на РЕАЛЬНОЙ Windows-машине (где приложение Roblox открывается, НЕ на VM). Включает remote-debugging у WebView2 приложения и через CDP вставляет .ROBLOSECURITY покупателя (получатель). Без аргументов — тест debug-порта; -Cookie "<.ROBLOSECURITY>" — инжекция; -Cleanup — откат. Фундамент драйвера авто-покупки.',
  },
  'buyer_login.py': {
    type: 'text/x-python; charset=utf-8',
    title: 'buyer_login.py',
    desc: 'НОВЫЙ — B2. Вход в Roblox-аккаунт покупателя через реальный Chrome (Selenium, HEADED): сам решает PoW и прозрачную Arkose-капчу на чистом IP, отдаёт .ROBLOSECURITY. Капча/2FA — решаются в видимом окне. Нужен Python 3 + Chrome + selenium. Запуск: python buyer_login.py --username U --password P --wait',
  },
  'b2_login_inject.ps1': {
    type: 'text/plain; charset=utf-8',
    title: 'b2_login_inject.ps1',
    desc: 'НОВЫЙ — B2 оркестратор. Логинит покупателя (buyer_login.py) -> получает .ROBLOSECURITY -> инжектит в WebView приложения (inject_cookie.ps1). Положи рядом buyer_login.py и inject_cookie.ps1. Запуск: powershell -ExecutionPolicy Bypass -File b2_login_inject.ps1 -Username U -Password P',
  },
  'headless_probe.py': {
    type: 'text/x-python; charset=utf-8',
    title: 'headless_probe.py',
    desc: 'НОВЫЙ — ФАЗА 1 (де-риск, ДЕНЕГ НЕ ТРАТИТ). Поднимает Edge/Chrome с UA приложения + CDP, ставит куку .ROBLOSECURITY и открывает страницу покупки Robux. Проверяет: полетит ли createOrder на gold.xboxservices в ОБЫЧНОМ браузере (createOrder=401 = отлично). Нужен Python 3 + pip install websocket-client. Запуск: python headless_probe.py --cookie-file cookie.txt, потом в окне нажми пак 80 Robux.',
  },
}

function fileSizeKb(name) {
  try {
    return Math.max(1, Math.round(fs.statSync(path.join(DOWNLOADS_DIR, name)).size / 1024))
  } catch (_) {
    return null
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function readRawBody(req, maxBytes) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let aborted = false
    req.on('data', (c) => {
      if (aborted) return
      size += c.length
      if (size > maxBytes) {
        aborted = true
        resolve(null)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!aborted) resolve(Buffer.concat(chunks))
    })
    req.on('error', () => resolve(null))
  })
}

function listCaptures() {
  try {
    return fs
      .readdirSync(CAPTURES_DIR)
      .filter((n) => n.endsWith('.md'))
      .map((n) => {
        const st = fs.statSync(path.join(CAPTURES_DIR, n))
        return { id: n.replace(/\.md$/, ''), size: st.size, mtime: st.mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)
  } catch (_) {
    return []
  }
}

function pruneCaptures(keep) {
  const items = listCaptures()
  for (const it of items.slice(keep)) {
    try {
      fs.unlinkSync(path.join(CAPTURES_DIR, it.id + '.md'))
    } catch (_) {}
  }
}

function sendJsonRaw(res, code, obj) {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(obj))
}

function renderPage() {
  const cards = Object.keys(FILES)
    .map((name) => {
      const f = FILES[name]
      const kb = fileSizeKb(name)
      const present = kb != null
      return `
      <div class="card">
        <div class="card-head">
          <span class="fname">${escapeHtml(f.title)}</span>
          ${present ? `<span class="size">${kb} КБ</span>` : `<span class="missing">недоступен</span>`}
        </div>
        <p class="desc">${escapeHtml(f.desc)}</p>
        ${present
          ? `<a class="btn" href="/download/${encodeURIComponent(name)}" download>Скачать</a>`
          : `<span class="btn btn-disabled">Файл не найден</span>`}
      </div>`
    })
    .join('')

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Загрузка</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; background:#0f1115; color:#e6e8ee; font:15px/1.5 -apple-system,Segoe UI,Roboto,Arial,sans-serif; }
  .wrap { max-width:780px; margin:0 auto; padding:40px 20px 80px; }
  h1 { font-size:26px; margin:0 0 6px; }
  .sub { color:#9aa3b2; margin:0 0 28px; }
  .card { background:#171a21; border:1px solid #232733; border-radius:14px; padding:20px; margin-bottom:18px; }
  .card-head { display:flex; align-items:center; justify-content:space-between; gap:12px; }
  .fname { font-weight:600; font-size:17px; font-family:ui-monospace,Consolas,monospace; }
  .size { color:#7f8aa3; font-size:13px; }
  .missing { color:#e0794b; font-size:13px; }
  .desc { color:#aeb6c5; margin:10px 0 16px; }
  .btn { display:inline-block; background:#3b82f6; color:#fff; text-decoration:none; padding:10px 22px; border-radius:10px; font-weight:600; }
  .btn:hover { background:#2f6fe0; }
  .btn-disabled { background:#2a2f3a; color:#6b7280; cursor:not-allowed; }
  .steps { background:#13161c; border:1px solid #232733; border-radius:14px; padding:20px 22px; margin-top:26px; }
  .steps h2 { font-size:16px; margin:0 0 12px; }
  ol { margin:0; padding-left:20px; }
  li { margin:8px 0; color:#cdd3df; }
  code { background:#0b0d11; border:1px solid #232733; border-radius:6px; padding:2px 7px; font-family:ui-monospace,Consolas,monospace; font-size:13px; color:#e6e8ee; }
  .note { color:#8b94a6; font-size:13px; margin-top:18px; }
  .ok { color:#5bd08a; }
</style>
</head>
<body>
  <div class="wrap">
    <h1>Загрузка</h1>
    <p class="sub">Служебные скрипты. Скачай и запусти у себя на ПК.</p>
    ${cards}
    <div class="steps">
      <h2>Как снять трафик покупки в приложении Roblox (MS Store)</h2>
      <ol>
        <li>Скачай <b>оба</b> файла — <code>run_msstore_capture.ps1</code> и <code>capture_msstore_app.py</code> — в <b>одну папку</b>. Нужен установленный Python 3.</li>
        <li>Запусти лаунчер <b>от Администратора</b>: <code>powershell -ExecutionPolicy Bypass -File run_msstore_capture.ps1</code></li>
        <li>Когда увидишь «ПЕРЕХВАТ ИДЁТ» — открой <b>приложение Roblox</b> (из MS Store) и купи <b>80 Robux</b> (оплата — Microsoft-баланс).</li>
        <li>Если на оплате <b>белый экран</b> — это ожидаемо (хост пиннит сертификат), просто закрой окно.</li>
        <li>Вернись в консоль и нажми <code>Ctrl+C</code> — скрипт <b>сам отправит</b> замаскированный отчёт и всё откатит. Напиши мне «сделал».</li>
      </ol>
      <p class="note"><span class="ok">Безопасно по анткиту:</span> перехватывается только <b>сеть</b> (временный локальный прокси + доверенный CA), процесс Roblox <b>не трогается</b> — Hyperion стережёт память процесса, а не сеть. По выходу лаунчер сам убирает прокси, loopback-exempt и доверие к CA. Cookies/токены остаются в локальном <code>capture-full.jsonl</code> — на сервер уходит только замаскированный отчёт.</p>
    </div>

    <div class="steps">
      <h2>ТЕСТ A — уйдут ли Robux на произвольный userId (<code>test_a_robux.ps1</code>)</h2>
      <p class="desc">Проверяем главный вопрос модели: можно ли лить Robux на <b>любой</b> аккаунт с одного funded-MS-аккаунта. Скрипт при реальной покупке 80 Robux подменяет получателя (<code>publisherUserId</code>) на твой userId.</p>
      <ol>
        <li>Скачай <b>три</b> файла в одну папку: <code>test_a_robux.ps1</code>, <code>run_msstore_capture.ps1</code>, <code>capture_msstore_app.py</code>. Нужен Python 3.</li>
        <li><b>Залогинь приложение Roblox (MS Store) под ДРУГИМ аккаунтом</b> — не тем, что укажешь получателем. Это ключ теста: иначе подмена ничего не докажет.</li>
        <li>Запиши <b>баланс обоих</b> аккаунтов ДО покупки (профиль Roblox или экран Robux).</li>
        <li>Запусти <b>от Администратора</b> (получатель — твой userId, который <b>не</b> залогинен в приложении):<br><code>powershell -ExecutionPolicy Bypass -File test_a_robux.ps1 -RecipientUserId 5304760791</code></li>
        <li>Когда увидишь «ПЕРЕХВАТ ИДЁТ» — в приложении купи <b>80 Robux</b> (оплата Microsoft-балансом). Белый экран на оплате — норм, закрой. Затем <code>Ctrl+C</code> в консоли.</li>
        <li>Подожди ~10–15 c, переоткрой магазин и сверь балансы:
          <br><span class="ok">+80 у получателя</span> (не залогиненного) → <b>ТЕСТ A ПРОЙДЕН</b>: льём на любой userId.
          <br>+80 у залогиненного аккаунта → получатель жёстко привязан к логину в приложении.</li>
      </ol>
      <p class="note">Скрипт сам ничего не покупает — ты делаешь одну реальную покупку $0.99. Отчёт уходит на сервер автоматически по <code>Ctrl+C</code>. Напиши мне результат сверки балансов.</p>
    </div>

    <div class="steps">
      <h2>Белый экран при покупке? — диагностика (<code>diag_buynow.ps1</code>)</h2>
      <p class="desc">Если при «купить 80 Robux» появляется пустое белое окно, прогони диагностику на том же ПК. Она ничего не покупает и не меняет — только ищет причину.</p>
      <ol>
        <li>Скачай <code>diag_buynow.ps1</code> и запусти:<br><code>powershell -ExecutionPolicy Bypass -File diag_buynow.ps1</code></li>
        <li>Смотри секцию <b>2. TLS CERTS</b>: если издатель серта = <code>mitmproxy</code> или нештатный — WebView2 не доверяет ему, отсюда белый экран. Закрой капчур/прокси и повтори покупку.</li>
        <li>Если перехвата нет, а окно белое — <code>wsreset.exe</code> и чистка кэша WebView2. Пришли мне вывод секции 2 и вердикт.</li>
      </ol>
    </div>
  </div>
</body>
</html>`
}

async function dispatchDownload({ req, res, pathname }) {
  // ── Приём отчёта со скрипта пользователя (anti-bot upload-токен) ──
  if (req.method === 'POST' && pathname === '/download/capture') {
    const provided = String(req.headers['x-capture-token'] || '').trim()
    if (!UPLOAD_TOKEN || provided !== UPLOAD_TOKEN) {
      sendJsonRaw(res, 401, { ok: false, error: 'bad token' })
      return true
    }
    const buf = await readRawBody(req, MAX_UPLOAD)
    if (!buf || buf.length === 0) {
      sendJsonRaw(res, 400, { ok: false, error: 'empty or too large' })
      return true
    }
    try {
      fs.mkdirSync(CAPTURES_DIR, { recursive: true })
    } catch (_) {}
    const id = 'cap-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex')
    try {
      fs.writeFileSync(path.join(CAPTURES_DIR, id + '.md'), buf)
    } catch (e) {
      sendJsonRaw(res, 500, { ok: false, error: 'write failed' })
      return true
    }
    pruneCaptures(KEEP_CAPTURES)
    sendJsonRaw(res, 200, { ok: true, id })
    return true
  }

  // ── Выдача принятых отчётов (read-токен из env; для Claude) ──
  if (req.method === 'GET' && (pathname === '/download/captures' || pathname.startsWith('/download/captures/'))) {
    const provided = String(req.headers['x-capture-token'] || '').trim()
    if (!READ_TOKEN || provided !== READ_TOKEN) {
      res.statusCode = 403
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.end('forbidden')
      return true
    }
    if (pathname === '/download/captures') {
      sendJsonRaw(res, 200, { ok: true, items: listCaptures() })
      return true
    }
    const id = pathname.split('/').pop()
    if (!/^[A-Za-z0-9._-]+$/.test(id)) {
      res.statusCode = 400
      res.end('bad id')
      return true
    }
    const fp = path.join(CAPTURES_DIR, id.endsWith('.md') ? id : id + '.md')
    if (!fs.existsSync(fp)) {
      res.statusCode = 404
      res.end('not found')
      return true
    }
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
    res.end(fs.readFileSync(fp))
    return true
  }

  if (req.method !== 'GET') return false

  // ── Страница раздела ──
  if (pathname === '/download' || pathname === '/download/') {
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(renderPage())
    return true
  }

  // ── Отдача файла (белый список) ──
  const m = pathname.match(/^\/download\/([A-Za-z0-9._-]+)$/)
  if (m) {
    const name = m[1]
    const meta = FILES[name]
    if (!meta) {
      res.statusCode = 404
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.end('Not found')
      return true
    }
    const filePath = path.join(DOWNLOADS_DIR, name)
    if (!fs.existsSync(filePath)) {
      res.statusCode = 404
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.end('File missing in build')
      return true
    }
    res.statusCode = 200
    res.setHeader('Content-Type', meta.type)
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`)
    res.setHeader('Cache-Control', 'no-store')
    res.end(fs.readFileSync(filePath))
    return true
  }

  return false
}

module.exports = { dispatchDownload }
