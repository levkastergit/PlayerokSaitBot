#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
headless_charge.py - ПРОТОТИП headless-charge Robux БЕЗ RobloxPlayerBeta (проверка гипотезы).

Идея: ОДИН управляемый Chromium, который:
  - залогинен кукой ПОКУПАТЕЛЯ (.ROBLOSECURITY на roblox.com) = получатель,
  - гонит MS-charge нашим funded-MSA XSTS (плательщик): createOrder (HTTP) ->
    buynow/Saturn В БРАУЗЕРЕ (там рождается живой антифрод-отпечаток fpt/df + создаётся cartId) ->
    Cart/purchase.
Если Robux упадут ПОКУПАТЕЛЮ -> привязка по устройству/сессии браузера -> нода не нужна.

СТАДИИ (по умолчанию НЕ тратит деньги; --charge = реально дожать оплату ~$0.99/€1.19):
  1) минт XSTS funded-MSA (email/пароль из env MSA_USER/MSA_PASS) + createOrder=200
  2) Chromium + кука покупателя
  3) browser POST -> buynow -> Saturn рендерит корзину (КЛЮЧЕВАЯ проверка: ожила ли корзина в браузере)
  4) (--charge) клик "Купить" в Saturn -> Cart/purchase
  5) сверка баланса покупателя

ЗАПУСК (рядом mint_pay_token.py, cookie.txt с кукой покупателя):
  MSA_USER=.. MSA_PASS=.. python headless_charge.py            # до корзины, без оплаты
  MSA_USER=.. MSA_PASS=.. python headless_charge.py --charge   # дожать оплату
"""
import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import re
import uuid
import urllib.error
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar, Cookie

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import mint_pay_token as M  # noqa: E402

try:
    import websocket  # websocket-client
except Exception:
    print("pip install websocket-client"); sys.exit(2)

PORT = 9400
ROBLOX_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
             "Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0 RobloxNewBrowser Roblox/WinPCGDK ROBLOX PCGDK App")
# buynow/Saturn принимает только WebView/Edge-UA (RobloxApp-UA -> Page not found, снято в buynow_dryrun)
WEBVIEW_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64; WebView/3.0) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/70.0.3538.102 Safari/537.36 Edge/18.26100")
PRODUCT = {"productId": "9NH6SMMZQHM9", "skuId": "0010", "availabilityId": "9VH3WJX9DHDB"}
EDGE = [r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"]
CHROME = [r"C:\Program Files\Google\Chrome\Application\chrome.exe"]


def info(m): print("  [..]   " + m, flush=True)
def ok(m): print("  [OK]   " + m, flush=True)
def warn(m): print("  [WARN] " + m, flush=True)
def fail(m): print("  [FAIL] " + m, flush=True)
def hdr(m): print("\n===== %s =====" % m, flush=True)


def cv():
    return base64.b64encode(os.urandom(12)).decode("ascii") + ".0"


def find_browser():
    for p in EDGE + CHROME:
        if os.path.exists(p):
            return p
    return None


class CDP:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, max_size=None, enable_multithread=True)
        self._id = 0; self._fid = 100000; self._pending = {}; self._alive = True
        self._events = []; self._fulfill = {}  # urlSubstring -> html (отдать вместо ответа сервера)
        self._clean = set()  # urlSubstring -> чистить заголовки запроса (убрать Origin/Referer/sec-*)
        self._dbg = None
        threading.Thread(target=self._reader, daemon=True).start()

    def _send(self, method, params):
        """fire-and-forget (для ответов на Fetch из reader-потока — без ожидания, чтобы не было дедлока)"""
        self._fid += 1
        try:
            self.ws.send(json.dumps({"id": self._fid, "method": method, "params": params or {}}))
        except Exception:
            pass

    def _handle_fetch(self, p):
        rid = p.get("requestId"); req = p.get("request", {}); url = req.get("url", "")
        for sub, html in self._fulfill.items():
            if sub in url:
                b64 = base64.b64encode(html.encode("utf-8")).decode("ascii")
                self._send("Fetch.fulfillRequest", {"requestId": rid, "responseCode": 200,
                           "responseHeaders": [{"name": "Content-Type", "value": "text/html; charset=utf-8"}],
                           "body": b64})
                return
        for sub in self._clean:
            if sub in url:
                if req.get("method") == "POST":
                    # ТОЧНЫЙ набор заголовков как у urllib (которое работает) — полностью заменяем браузерные
                    newh = [{"name": "User-Agent", "value": WEBVIEW_UA},
                            {"name": "Content-Type", "value": "application/x-www-form-urlencoded"},
                            {"name": "Accept", "value": "text/html,application/xhtml+xml"},
                            {"name": "Accept-Language", "value": "ru-RU"},
                            {"name": "Upgrade-Insecure-Requests", "value": "1"},
                            {"name": "Accept-Encoding", "value": "gzip, deflate"}]
                    pd = req.get("postData") or ""
                    self._dbg = {"method": "POST", "forced": [h["name"] for h in newh],
                                 "body_len": len(pd), "body_head": pd[:56]}
                else:
                    strip = ("origin", "referer", "cookie", "sec-ch-ua", "sec-ch-ua-mobile",
                             "sec-ch-ua-platform", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest")
                    newh = [{"name": k, "value": v} for k, v in req.get("headers", {}).items()
                            if k.lower() not in strip]
                self._send("Fetch.continueRequest", {"requestId": rid, "headers": newh})
                return
        self._send("Fetch.continueRequest", {"requestId": rid})

    def _reader(self):
        while self._alive:
            try:
                m = self.ws.recv()
            except Exception:
                self._alive = False; break
            if not m:
                continue
            try:
                o = json.loads(m)
            except Exception:
                continue
            if "id" in o:
                self._pending[o["id"]] = o
            elif o.get("method") == "Fetch.requestPaused":
                self._handle_fetch(o["params"])
            elif "method" in o:
                self._events.append(o)

    def cmd(self, method, params=None, timeout=20):
        self._id += 1; mid = self._id
        try:
            self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        except Exception:
            return None
        t0 = time.time()
        while time.time() - t0 < timeout:
            if mid in self._pending:
                return self._pending.pop(mid)
            if not self._alive:
                return None
            time.sleep(0.01)
        return None

    def ev(self, expr, await_promise=False):
        r = self.cmd("Runtime.evaluate", {"expression": expr, "awaitPromise": await_promise, "returnByValue": True})
        try:
            return r["result"]["result"]["value"]
        except Exception:
            return None

    def net_log(self):
        """собрать интересные сетевые запросы из событий (responseReceived)"""
        out = []
        for e in self._events:
            if e.get("method") == "Network.responseReceived":
                r = e["params"]["response"]
                u = r.get("url", "")
                if any(h in u for h in ("xboxservices", "buynow.production", "paymentinstruments",
                                        "store/purchase", "collections.mp", "fpt.microsoft", "df.cfp")):
                    out.append("%s %s" % (r.get("status"), u.split("?")[0]))
        return out

    def close(self):
        self._alive = False
        try: self.ws.close()
        except Exception: pass


def buynow_html(header):
    """POST buynow по HTTP (urllib, как buynow_dryrun) -> Saturn HTML (283КБ 'Confirm Purchase')."""
    data_obj = {
        "products": [PRODUCT], "scenario": "", "clientType": "SaturnPC", "layout": "Modal",
        "cssOverride": "XboxCom2NewUI", "theme": "dark",
        "flights": ["sc_xboxgamepad", "sc_xboxspinner", "sc_windowexternalnotify",
                    "sc_disabledefaultstyles", "sc_xboxuiexp", "sc_reactredeem", "sc_enablecsvforredeem"],
        "isTelemetryEnabled": True, "data": {"usePurchaseSdk": True},
        "callerApplicationId": "saturnpc", "osVersion": "2814751477604082",
        "clientVersion": "2604.8.1.0", "deviceFamily": "Windows.Desktop",
        "deviceForm": "Unknown", "deviceModel": "B450M DS3H", "pageFormat": "full",
    }
    body = urllib.parse.urlencode({"auth": json.dumps(header), "data": json.dumps(data_obj)}).encode()
    url = "https://www.microsoft.com/store/purchase/buynowui/buynow?market=US&locale=ru&ms-cv=" + urllib.parse.quote(cv())
    req = urllib.request.Request(url, data=body, method="POST", headers={
        "User-Agent": WEBVIEW_UA, "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "text/html,application/xhtml+xml", "Accept-Language": "ru-RU",
        "Upgrade-Insecure-Requests": "1"})
    try:
        r = urllib.request.urlopen(req, timeout=30)
        return r.status, r.read().decode("utf-8", "replace")
    except Exception as e:
        return 0, str(e)


def robux_balance(uid, cookie):
    try:
        req = urllib.request.Request("https://economy.roblox.com/v1/users/%s/currency" % uid,
                                     headers={"Cookie": ".ROBLOSECURITY=%s" % cookie, "User-Agent": "Mozilla/5.0"})
        return json.loads(urllib.request.urlopen(req, timeout=15).read()).get("robux")
    except Exception as e:
        return "ERR:%s" % e


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--charge", action="store_true", help="реально дожать оплату (тратит деньги)")
    ap.add_argument("--cookie-file", default=os.path.join(HERE, "cookie.txt"))
    ap.add_argument("--headless", action="store_true")
    args = ap.parse_args()

    # ---- 1. XSTS + createOrder ----
    hdr("1. Минт XSTS плательщика + createOrder")
    user, pw = M._load_creds()
    tok, d = M.oauth_login(user, pw)
    if not tok:
        fail("login: %s" % d); sys.exit(1)
    header, d = M.xbox_chain(tok)
    if not header:
        fail("xsts/createOrder: %s" % d); sys.exit(1)
    ok("XSTS получен, createOrder принят (%s)" % d)

    # ---- buyer cookie ----
    if not os.path.exists(args.cookie_file):
        fail("нет %s (кука покупателя)" % args.cookie_file); sys.exit(1)
    cookie = "".join(open(args.cookie_file, encoding="utf-8").read().split())
    try:
        req = urllib.request.Request("https://users.roblox.com/v1/users/authenticated",
                                     headers={"Cookie": ".ROBLOSECURITY=%s" % cookie, "User-Agent": "Mozilla/5.0"})
        j = json.loads(urllib.request.urlopen(req, timeout=15).read())
        buyer_id, buyer_name = j.get("id"), j.get("name")
        ok("покупатель @%s (id=%s)" % (buyer_name, buyer_id))
    except Exception as e:
        fail("кука покупателя невалидна: %s" % e); sys.exit(1)
    bal_before = robux_balance(buyer_id, cookie)
    ok("баланс ДО: %s" % bal_before)

    # ---- 2. Chromium ----
    hdr("2. Chromium + кука покупателя + наш XSTS")
    br = find_browser()
    if not br:
        fail("нет Edge/Chrome"); sys.exit(1)
    prof = tempfile.mkdtemp(prefix="hcharge-")
    cmd = [br, "--remote-debugging-port=%d" % PORT, "--remote-allow-origins=*",
           "--user-data-dir=%s" % prof, "--user-agent=%s" % ROBLOX_UA,
           "--no-first-run", "--no-default-browser-check", "about:blank"]
    if args.headless:
        cmd[1:1] = ["--headless=new", "--disable-gpu"]
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ws_url = None
    for _ in range(30):
        time.sleep(0.5)
        try:
            data = json.loads(urllib.request.urlopen("http://127.0.0.1:%d/json" % PORT, timeout=3).read())
            pg = [t for t in data if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]
            if pg:
                ws_url = pg[0]["webSocketDebuggerUrl"]; break
        except Exception:
            pass
    if not ws_url:
        fail("CDP не поднялся"); proc.terminate(); sys.exit(2)
    cdp = CDP(ws_url)
    cdp.cmd("Network.enable"); cdp.cmd("Page.enable"); cdp.cmd("Runtime.enable")
    # кука покупателя на roblox.com
    cdp.cmd("Network.setCookie", {"name": ".ROBLOSECURITY", "value": cookie, "domain": ".roblox.com",
                                  "path": "/", "secure": True, "httpOnly": True})
    ok("CDP подключён, кука покупателя выставлена")

    # регистрируем «намерение» покупателя: грузим страницу покупки под его кукой (как делает приложение)
    cdp.cmd("Page.navigate", {"url": "https://www.roblox.com/premium/windows/robux"})
    time.sleep(6)
    who = cdp.ev("fetch('https://users.roblox.com/v1/users/authenticated',{credentials:'include'}).then(r=>r.json()).then(j=>j.name+':'+j.id).catch(e=>'ERR')", await_promise=True)
    info("страница Robux под сессией: %s" % who)

    # ---- 3. buynow -> Saturn (браузер сам POST'ит, заголовки чистим через Fetch) ----
    hdr("3. buynow -> Saturn (оживает ли корзина в браузере)")
    data_obj = {
        "products": [PRODUCT], "scenario": "", "clientType": "SaturnPC", "layout": "Modal",
        "cssOverride": "XboxCom2NewUI", "theme": "dark",
        "flights": ["sc_xboxgamepad", "sc_xboxspinner", "sc_windowexternalnotify",
                    "sc_disabledefaultstyles", "sc_xboxuiexp", "sc_reactredeem", "sc_enablecsvforredeem"],
        "isTelemetryEnabled": True, "data": {"usePurchaseSdk": True},
        "callerApplicationId": "saturnpc", "osVersion": "2814751477604082",
        "clientVersion": "2604.8.1.0", "deviceFamily": "Windows.Desktop",
        "deviceForm": "Unknown", "deviceModel": "B450M DS3H", "pageFormat": "full",
    }
    # диагностика: urllib-buynow в этот же момент (тем же токеном) — для сравнения
    du_st, du_html = buynow_html(header)
    info("DIAG urllib buynow сейчас: HTTP %s len=%d %s" % (du_st, len(du_html), "OK-Saturn" if "Confirm Purchase" in du_html else "НЕ-Saturn"))
    cdp.cmd("Network.setUserAgentOverride", {"userAgent": WEBVIEW_UA})
    # НЕ чистим заголовки: шлём полный браузерный запрос С КУКАМИ microsoft.com (как WebView приложения,
    # у него в buynow был cookie 1360б). Только UA подменён на WebView/Edge.
    # www.microsoft.com origin (НЕ buynow! чтобы не создать протухшую buynow-сессию до POST)
    cdp.cmd("Page.navigate", {"url": "https://www.microsoft.com/en-us/"})
    for _ in range(25):
        time.sleep(1)
        if cdp.ev("document.readyState") == "complete" and cdp.ev("(location.host||'').indexOf('microsoft.com')>=0") and cdp.ev("!!document.body"):
            break
    buynow_url = "https://www.microsoft.com/store/purchase/buynowui/buynow?market=US&locale=ru&ms-cv=" + cv()
    submit_js = """
(function(){
  var ifr=document.createElement('iframe'); ifr.name='bnf'; ifr.id='bnf';
  ifr.setAttribute('style','position:fixed;left:0;top:0;width:1200px;height:900px;z-index:99999;background:#fff;border:0');
  document.body.appendChild(ifr);
  var f=document.createElement('form'); f.method='POST'; f.action=%s; f.target='bnf'; f.style.display='none';
  function add(n,v){var i=document.createElement('input');i.type='hidden';i.name=n;i.value=v;f.appendChild(i);}
  add('auth', %s); add('data', %s);
  document.body.appendChild(f); f.submit(); return 'submitted-iframe';
})()
""" % (json.dumps(buynow_url), json.dumps(json.dumps(header)), json.dumps(json.dumps(data_obj)))
    r = cdp.ev(submit_js)
    info("browser buynow POST -> iframe: %s" % r)
    time.sleep(16)

    # дамп состояния Saturn ВНУТРИ iframe (same-origin microsoft.com -> доступно)
    dump = cdp.ev("""(function(){
      var ifr=document.getElementById('bnf'); var d=ifr&&ifr.contentDocument; var w=ifr&&ifr.contentWindow;
      var b=d&&d.body; var t=b?b.innerText.replace(/\\s+/g,' ').slice(0,260):'(нет iframe-документа)';
      var btns=d?[].slice.call(d.querySelectorAll('button,[role=button]')).filter(function(e){var r=e.getBoundingClientRect();return r.width>2&&r.height>2;}).map(function(e){return (e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,30);}).filter(Boolean).slice(0,15):[];
      var cs=(w&&w.__STORE_CART_STATE__)||{}; var cid=cs.cartId||(cs.cart&&cs.cart.cartId)||'';
      return JSON.stringify({iframeUrl:d?d.location.href:'(нет)', title:d?d.title:'', textSample:t, buttons:btns, cartId:cid});
    })()""")
    info("Saturn(iframe) state: %s" % dump)
    info("сеть (MS/charge хосты): " + " | ".join(cdp.net_log()[-20:]))

    # === извлечь fingerprint, что зарегистрировал браузер (fpt/df.cfp) — для urllib-корзины ===
    cks = cdp.cmd("Network.getAllCookies")
    ck = (cks or {}).get("result", {}).get("cookies", [])

    def ishex(s):
        return len(s) >= 16 and all(c in "0123456789ABCDEFabcdef" for c in s)
    muid_c = next((c["value"] for c in ck if c["name"] == "MUID"), None)
    hexck = [(c["name"], c["value"], c.get("domain", "")) for c in ck if ishex(c["value"])]
    info("MUID cookie: %s" % muid_c)
    info("hex-куки (vector-id кандидаты): %s" % [(n, v[:40], d) for n, v, d in hexck][:14])
    vec = cdp.ev("(function(){var fr=document.getElementById('bnf');var t=fr&&fr.contentDocument;"
                 "var h=(t?t.documentElement.outerHTML:'')+' '+document.documentElement.outerHTML;"
                 "var m=h.match(/[0-9A-Fa-f]{64}/g);return m?m.slice(0,5).join(','):'';})()")
    info("64-hex в DOM (vector-id кандидаты): %s" % vec)
    info("df.cfp/fpt в сети: " + " | ".join([x for x in cdp.net_log() if "fpt." in x or "df.cfp" in x]))

    # === ПРОБА: urllib-корзина с РОДНЫМ cartMuid + vector-id + браузерными куками ===
    hdr("4. urllib-корзина с браузерным fingerprint (cartMuid)")

    def F(p, s):
        m = re.search(p, s or "")
        return m.group(1) if m else None
    cartmuid = next((c["value"] for c in ck if c["name"] == "cartMuid"), None) or muid_c or uuid.uuid4().hex.upper()
    vecid = (vec.split(",")[0] if vec else (uuid.uuid4().hex + uuid.uuid4().hex).upper())
    info("cartMuid=%s  vector-id=%s..." % (cartmuid, vecid[:20]))
    jar = CookieJar()
    for c in ck:
        try:
            dom = c.get("domain", "")
            jar.set_cookie(Cookie(0, c["name"], c["value"], None, False, dom, True, dom.startswith("."),
                                  c.get("path", "/"), True, c.get("secure", False), None, False, None, None, {}))
        except Exception:
            pass
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

    def ur(method, url, body=None, extra=None):
        h = {"User-Agent": WEBVIEW_UA, "Authorization": header, "Accept": "*/*", "MS-CV": cv()}
        if extra:
            h.update(extra)
        if body is not None:
            h["Content-Type"] = "application/json"
        r = urllib.request.Request(url, data=(body.encode() if isinstance(body, str) else body), headers=h, method=method)
        try:
            x = op.open(r, timeout=30); return x.status, x.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return e.code, e.read().decode("utf-8", "replace")
        except Exception as e:
            return 0, str(e)

    PIFD = "https://paymentinstruments.mp.microsoft.com/v6.0/users/me"
    DYN = "https://buynow.production.store-web.dynamics.com/v1.0"
    _, pi = ur("GET", PIFD + "/paymentInstrumentsEx?status=active&language=en-US&partner=webblends&country=US")
    sv = re.search(r'"paymentMethodType"\s*:\s*"stored_value".*?"id"\s*:\s*"([0-9a-f-]{36})"', pi or "", re.S)
    piid = (sv.group(1) if sv else None) or F(r'"id"\s*:\s*"([0-9a-f-]{36})"', pi)
    aid = F(r'"accountId"\s*:\s*"([0-9a-f-]{36})"', pi)
    _, ad = ur("GET", PIFD + "/addresses?type=billing&language=en-US&partner=webblends&country=US")
    adid = F(r'"id"\s*:\s*"([0-9a-f-]{36})"', ad)
    psdj = json.dumps({"id": None, "amount": 0.99, "currency": "USD", "country": "US", "language": "en-US",
                       "partner": "saturnpc", "piid": piid, "billableAccountId": aid, "hasPreOrder": False,
                       "challengeScenario": "PaymentTransaction", "purchaseOrderId": str(uuid.uuid4()), "emailAddress": user})
    _, r2 = ur("GET", PIFD + "/PaymentSessionDescriptions?paymentSessionData=%s&operation=Add" % urllib.parse.quote(psdj),
               extra={"correlation-context": "v=1,ms.b.tel.scenario=commerce.payments.PaymentSessioncreatePaymentSession"})
    psid = F(r'"id"\s*:\s*"([^"]+)"', r2)
    info("piid=%s aid=%s addr=%s psid=%s" % (piid, aid, adid, (psid or "")[:18]))
    cart_id = str(uuid.uuid4())
    ch = {"x-authorization-muid": cartmuid, "x-ms-vector-id": vecid,
          "x-ms-reference-id": (uuid.uuid4().hex + uuid.uuid4().hex).upper(),
          "x-ms-tracking-id": str(uuid.uuid4()), "x-ms-client-type": "SaturnPC", "x-ms-market": "US",
          "Accept-Language": "ru-RU", "origin": "https://www.microsoft.com",
          "referer": "https://www.microsoft.com/store/purchase/buynowui/buynow?market=US&locale=ru"}
    uc = json.dumps({"locale": "ru", "market": "US", "catalogClientType": "",
                     "clientContext": {"client": "SaturnPC", "deviceFamily": "windows.desktop", "osVersion": "2814751477604082",
                                       "clientVersion": "2604.8.1.0", "deviceForm": "unknown", "deviceModel": "b450m ds3h"},
                     "flights": ["sc_xboxgamepad", "sc_reactredeem", "sc_enablecsvforredeem"]})
    st, resp = ur("PUT", "%s/cart/updateCart?cartId=%s&appId=BuyNow&calculateXboxMastercardPoints=false" % (DYN, cart_id), uc, ch)
    rtp = F(r'"readyToPurchase"\s*:\s*(true|false)', resp)
    info("updateCart HTTP %s  readyToPurchase=%s  %s" % (st, rtp, "" if st == 200 else (resp or "")[:120]))
    if st == 200:
        ok("!!! updateCart=200 — браузерный cartMuid пробил стену 423 !!!")

    if not args.charge:
        warn("РЕПЕТИЦИЯ: без --charge не дожимаю оплату. Если выше видно корзину + кнопку Buy/Confirm — стадия 3 жива.")
        cdp.close(); proc.terminate()
        hdr("ИТОГ")
        print("  XSTS=ok, покупатель=@%s(%s), buynow-форма отправлена. Смотри Saturn state выше." % (buyer_name, buyer_id))
        return

    # ---- 4. дожать оплату ----
    hdr("4. --charge: клик Buy/Confirm в Saturn")
    click = cdp.ev("""(function(){
      var c=[].slice.call(document.querySelectorAll('button,[role=button]')).filter(function(e){var r=e.getBoundingClientRect();return r.width>2&&r.height>2;});
      var b=c.find(function(e){return /buy|confirm|purchase|купить|pay/i.test(e.innerText||'');});
      if(b){b.click(); return 'clicked:'+(b.innerText||'').slice(0,30);} return 'no-buy-button';
    })()""")
    info("Buy click: %s" % click)
    time.sleep(12)
    info("сеть после Buy: " + " | ".join(cdp.net_log()[-12:]))

    # ---- 5. баланс ----
    hdr("5. Баланс покупателя ПОСЛЕ (ждём +80)")
    for _ in range(8):
        time.sleep(4)
        bal = robux_balance(buyer_id, cookie)
        print("    баланс: %s" % bal, flush=True)
        if isinstance(bal_before, int) and isinstance(bal, int) and bal >= bal_before + 80:
            ok("УСПЕХ: Robux упали ПОКУПАТЕЛЮ headless! %s -> %s" % (bal_before, bal)); break
    cdp.close(); proc.terminate()


if __name__ == "__main__":
    main()
