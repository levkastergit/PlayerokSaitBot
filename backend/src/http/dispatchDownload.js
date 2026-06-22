// Публичный раздел «Загрузка»: отдаёт служебные скрипты (напр. капчур покупки Robux).
// Без сессии сайта. Файлы кладутся в образ через Dockerfile (COPY ... ./public/downloads/).
const fs = require('fs')
const path = require('path')

const DOWNLOADS_DIR = path.join(__dirname, '..', '..', 'public', 'downloads')

// Белый список отдаваемых файлов (что не в списке — не отдаётся).
const FILES = {
  'capture_robux_purchase.py': {
    type: 'text/x-python; charset=utf-8',
    title: 'capture_robux_purchase.py',
    desc: 'Пассивный захват сетевого трафика покупки Robux (CDP, без MITM-прокси). Запускается на твоём ПК, после захвата сам загружает замаскированный отчёт и даёт ссылку.',
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
      <h2>Как запустить капчур-скрипт</h2>
      <ol>
        <li>Установи зависимость: <code>pip install websocket-client</code></li>
        <li>Запусти: <code>python capture_robux_purchase.py</code></li>
        <li>В открывшемся браузере войди на <code>roblox.com</code> и купи <b>80 Robux</b> (на оплате выбери Microsoft / Windows-баланс, если предложат).</li>
        <li>Вернись в консоль и нажми <code>Ctrl+C</code>.</li>
        <li>Скрипт загрузит замаскированный отчёт и напечатает <b>ссылку</b> — пришли её в чат.</li>
      </ol>
      <p class="note"><span class="ok">Безопасно:</span> скрипт не трогает процесс Roblox, не ставит прокси/сертификат и не инжектит в страницы — только пассивно слушает сеть своего браузера. Cookies/токены остаются в локальном <code>capture-full.jsonl</code>, наружу уходит лишь замаскированный отчёт.</p>
    </div>
  </div>
</body>
</html>`
}

async function dispatchDownload({ req, res, pathname }) {
  if (req.method !== 'GET') return false

  if (pathname === '/download' || pathname === '/download/') {
    res.statusCode = 200
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(renderPage())
    return true
  }

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
