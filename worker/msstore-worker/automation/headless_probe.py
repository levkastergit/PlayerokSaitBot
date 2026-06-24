#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
headless_probe.py - ФАЗА 1 (де-риск, ДЕНЕГ НЕ ТРАТИТ).

Вопрос: запускается ли веб-чекаут MS-Store (createOrder -> buynow -> cart) на странице
roblox.com/premium/windows/robux в ОБЫЧНОМ Chromium (не в WebView приложения), или странице
нужен мост приложения window.chrome.webview?

Что делает: поднимает Edge/Chrome с UA приложения Roblox + remote-debugging (CDP), опционально
ставит куку .ROBLOSECURITY (логин = получатель), открывает страницу покупки Robux и СЛУШАЕТ сеть.
Когда ты в окне нажмёшь "купить 80 Robux", скрипт покажет, ПОЛЕТЕЛ ЛИ createOrder на
gold.xboxservices. Платёжный токен мы тут НЕ подсовываем, поэтому createOrder, если и полетит,
вернёт 401 - и это ОТЛИЧНЫЙ результат: значит флоу заводится вне приложения, и в Фазе 2 надо лишь
впрыснуть наш XSTS. Если createOrder вообще не появляется - странице нужен мост (ветка --emulate-bridge).

ДЕНЕГ НЕ ТРАТИТ: без нашего XSTS оплата не пройдёт; до Cart/purchase=Purchased не дойдёт.

ЗАПУСК:
  # смоук на VM без логина (просто проверить, что всё поднимается):
  python headless_probe.py --headless
  # реальный де-риск (твоя машина), залогинено кукой покупателя, окно видимое:
  python headless_probe.py --cookie-file cookie.txt
  потом в окне нажми пак "80 Robux" и смотри лог. Ctrl+C -> вердикт.

Опции: --browser edge|chrome  --cookie / --cookie-file  --headless  --emulate-bridge  --port 9335
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

try:
    import websocket  # websocket-client
except Exception:
    print("Нет websocket-client. Установи: pip install websocket-client")
    sys.exit(2)

# UA приложения Roblox (снят из живого капчура 2026-06-24) - чтобы страница думала, что это app.
ROBLOX_APP_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                 "Chrome/149.0.0.0 Safari/537.36 Edg/149.0.0.0 RobloxNewBrowser Roblox/WinPCGDK "
                 "ROBLOX PCGDK App 1.0.0RobloxApp/2.726.0.1138 (GlobalDist; RobloxDirectDownload) GAMEPADNAVIGATION")

ROBUX_URL = "https://www.roblox.com/premium/windows/robux"

# хосты денежной/привязочной цепочки - на них смотрим
WATCH = [
    ("createOrder", "gold.xboxservices.com/PurchaseExperienceFD/createOrder"),
    ("Product", "gold.xboxservices.com/PurchaseExperienceFD/Product"),
    ("buynow", "www.microsoft.com/store/purchase"),
    ("updateCart", "buynow.production.store-web.dynamics.com/v1.0/cart/updateCart"),
    ("PaymentSession", "paymentinstruments.mp.microsoft.com/v6.0/users/me/PaymentSessionDescriptions"),
    ("Cart/purchase", "buynow.production.store-web.dynamics.com/v1.0/Cart/purchase"),
    ("keys", "collections.mp.microsoft.com/v7.0/beneficiaries/me/keys"),
    ("RST2(WLID)", "login.live.com/RST2.srf"),
    ("storeedgefd", "storeedgefd.dsx.mp.microsoft.com"),
    ("roblox-pay-gw", "apis.roblox.com/payments-gateway"),
]

EDGE_PATHS = [r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
              r"C:\Program Files\Microsoft\Edge\Application\msedge.exe"]
CHROME_PATHS = [r"C:\Program Files\Google\Chrome\Application\chrome.exe",
                r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"]


def find_browser(which):
    paths = EDGE_PATHS if which == "edge" else CHROME_PATHS
    for p in paths:
        if os.path.exists(p):
            return p
    # запасной: попробовать другой браузер
    for p in (CHROME_PATHS if which == "edge" else EDGE_PATHS):
        if os.path.exists(p):
            print("  [..] %s не найден, беру %s" % (which, p))
            return p
    return None


class CDP:
    """Минимальный CDP-клиент поверх одного page-таргета (websocket-client)."""

    def __init__(self, ws_url, on_event):
        self.ws = websocket.create_connection(ws_url, max_size=None, enable_multithread=True)
        self._id = 0
        self._pending = {}
        self._on_event = on_event
        self._alive = True
        self._t = threading.Thread(target=self._reader, daemon=True)
        self._t.start()

    def _reader(self):
        while self._alive:
            try:
                msg = self.ws.recv()
            except Exception:
                break
            if not msg:
                continue
            try:
                obj = json.loads(msg)
            except Exception:
                continue
            if "id" in obj:
                self._pending[obj["id"]] = obj
            elif "method" in obj:
                try:
                    self._on_event(obj["method"], obj.get("params", {}))
                except Exception:
                    pass

    def cmd(self, method, params=None, timeout=15):
        self._id += 1
        mid = self._id
        self.ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
        t0 = time.time()
        while time.time() - t0 < timeout:
            if mid in self._pending:
                return self._pending.pop(mid)
            time.sleep(0.01)
        return None

    def close(self):
        self._alive = False
        try:
            self.ws.close()
        except Exception:
            pass


# общий счётчик "что полетело"
seen = {label: {"req": 0, "statuses": []} for label, _ in WATCH}
_url_by_reqid = {}


def classify(url):
    for label, frag in WATCH:
        if frag in url:
            return label
    return None


def make_handler():
    def on_event(method, params):
        if method == "Network.requestWillBeSent":
            url = params.get("request", {}).get("url", "")
            m = params.get("request", {}).get("method", "")
            label = classify(url)
            if label:
                seen[label]["req"] += 1
                _url_by_reqid[params.get("requestId")] = label
                short = url.split("?")[0]
                print("  [NET>] %-14s %s %s" % (label, m, short))
        elif method == "Network.responseReceived":
            rid = params.get("requestId")
            label = _url_by_reqid.get(rid)
            if label:
                st = params.get("response", {}).get("status")
                seen[label]["statuses"].append(st)
                print("  [NET<] %-14s status %s" % (label, st))
        elif method == "Runtime.consoleAPICalled":
            typ = params.get("type")
            args = params.get("args", [])
            txt = " ".join(str(a.get("value", a.get("description", ""))) for a in args)[:300]
            if txt.startswith("[BRIDGE]"):
                print("  " + txt)
            elif typ in ("error", "warning") and txt.strip():
                print("  [JS-%s] %s" % (typ, txt[:200]))
        elif method == "Runtime.exceptionThrown":
            d = params.get("exceptionDetails", {})
            txt = d.get("exception", {}).get("description") or d.get("text") or ""
            if txt:
                print("  [JS-exc] %s" % str(txt)[:200])
        elif method == "Log.entryAdded":
            e = params.get("entry", {})
            if e.get("level") in ("error", "warning"):
                print("  [LOG-%s] %s" % (e.get("level"), str(e.get("text", ""))[:200]))
    return on_event


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--browser", choices=["edge", "chrome"], default="edge")
    ap.add_argument("--cookie", default="")
    ap.add_argument("--cookie-file", default="")
    ap.add_argument("--headless", action="store_true", help="без окна (смоук на сервере)")
    ap.add_argument("--emulate-bridge", action="store_true",
                    help="впрыснуть заглушку window.chrome.webview ДО загрузки (если без неё флоу не стартует)")
    ap.add_argument("--port", type=int, default=9335)
    ap.add_argument("--seconds", type=int, default=0, help="авто-выход через N сек (0 = до Ctrl+C)")
    ap.add_argument("--auto-buy", type=int, default=0, metavar="N",
                    help="после загрузки САМ кликнуть пак на N Robux через CDP (не нужен человек)")
    args = ap.parse_args()

    cookie = args.cookie
    if args.cookie_file:
        if not os.path.exists(args.cookie_file):
            print("  [FAIL] cookie-file не найден: %s" % args.cookie_file)
            sys.exit(1)
        with open(args.cookie_file, encoding="utf-8") as f:
            cookie = "".join(f.read().split())
    if cookie and "ROBLOSECURITY" not in cookie and "_|WARNING" not in cookie and len(cookie) < 200:
        print("  [FAIL] cookie не похож на настоящий .ROBLOSECURITY (короткий/плейсхолдер).")
        sys.exit(1)

    browser = find_browser(args.browser)
    if not browser:
        print("  [FAIL] не нашёл Edge/Chrome.")
        sys.exit(1)
    print("  [..] браузер: %s" % browser)

    profile = tempfile.mkdtemp(prefix="rbxprobe-")
    cmd = [browser, "--remote-debugging-port=%d" % args.port, "--remote-allow-origins=*",
           "--user-data-dir=%s" % profile,
           "--user-agent=%s" % ROBLOX_APP_UA, "--no-first-run", "--no-default-browser-check",
           "--disable-sync", "--disable-features=Translate", "about:blank"]
    if args.headless:
        cmd.insert(1, "--headless=new")
        cmd.insert(2, "--disable-gpu")
    print("  [..] запускаю браузер (headless=%s)..." % args.headless)
    proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    # ждём CDP-эндпойнт и page-таргет
    ws_url = None
    for _ in range(40):
        time.sleep(0.5)
        try:
            data = json.loads(urllib.request.urlopen("http://127.0.0.1:%d/json" % args.port, timeout=3).read())
            pages = [t for t in data if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]
            if pages:
                ws_url = pages[0]["webSocketDebuggerUrl"]
                break
        except Exception:
            pass
    if not ws_url:
        print("  [FAIL] CDP не поднялся на :%d" % args.port)
        proc.terminate()
        sys.exit(2)
    print("  [OK] CDP подключён")

    cdp = CDP(ws_url, make_handler())
    cdp.cmd("Network.enable")
    cdp.cmd("Page.enable")
    cdp.cmd("Runtime.enable")
    cdp.cmd("Log.enable")

    if args.emulate_bridge:
        stub = r"""
(function(){
  window.__bridgeLog = [];
  window.__bridgeCb = {};
  function log(e){ try{ window.__bridgeLog.push(e); console.log("[BRIDGE] "+JSON.stringify(e)); }catch(_){} }
  var base = {
    addEventListener: function(t, cb){ window.__bridgeCb[String(t)]=cb; log({k:"addEventListener", event:String(t)}); },
    removeEventListener: function(t){ log({k:"removeEventListener", event:String(t)}); },
    postMessage: function(m){ var v; try{v=JSON.parse(JSON.stringify(m));}catch(e){v=String(m);} log({k:"postMessage", msg:v}); },
    postMessageWithAdditionalObjects: function(m){ var v; try{v=JSON.parse(JSON.stringify(m));}catch(e){v=String(m);} log({k:"postMessageWAO", msg:v}); },
    hostObjects: new Proxy({sync:{}}, { get:function(t,p){ log({k:"hostObjects.get", prop:String(p)}); return (p==="sync")?t.sync:undefined; } })
  };
  window.chrome = window.chrome || {};
  try {
    window.chrome.webview = new Proxy(base, { get:function(t,p){ if(p in t) return t[p]; log({k:"webview.get", prop:String(p)}); return undefined; } });
  } catch(e){ window.chrome.webview = base; }
})();
"""
        cdp.cmd("Page.addScriptToEvaluateOnNewDocument", {"source": stub})
        print("  [..] впрыснут ШПИОНСКИЙ window.chrome.webview (логирует postMessage/обращения)")

    if cookie:
        r = cdp.cmd("Network.setCookie", {"name": ".ROBLOSECURITY", "value": cookie,
                                          "domain": ".roblox.com", "path": "/", "secure": True, "httpOnly": True})
        ok = bool(r and r.get("result", {}).get("success", True))
        print("  [%s] кука .ROBLOSECURITY поставлена (len=%d)" % ("OK" if ok else "??", len(cookie)))
    else:
        print("  [..] без куки -> страница уйдёт на логин (это смоук-режим)")

    print("\n  -> навигация на %s\n" % ROBUX_URL)
    cdp.cmd("Page.navigate", {"url": ROBUX_URL})
    time.sleep(8)

    ev = cdp.cmd("Runtime.evaluate", {
        "expression": ("JSON.stringify({href:location.href, title:document.title,"
                       "hasChrome:(typeof window.chrome), hasWebview:!!(window.chrome&&window.chrome.webview),"
                       "loggedIn: !!document.querySelector('[data-userid],#nav-robux-amount,.rbx-upgrade-now')})"),
        "returnByValue": True})
    info = {}
    try:
        info = json.loads(ev["result"]["result"]["value"])
    except Exception:
        pass
    print("  [PAGE] %s" % json.dumps(info, ensure_ascii=False))
    if info.get("hasWebview"):
        print("  [i] window.chrome.webview ПРИСУТСТВУЕТ (или эмулирован).")
    else:
        print("  [i] window.chrome.webview ОТСУТСТВУЕТ - если флоу не стартует, пробуй --emulate-bridge.")

    if args.auto_buy:
        amt = args.auto_buy
        js = r"""
(function(amount){
  function vis(e){var r=e.getBoundingClientRect();return r.width>2&&r.height>2;}
  var cand=[].slice.call(document.querySelectorAll('button,[role="button"],a,div,span')).filter(vis);
  var priced=cand.filter(function(e){var t=(e.innerText||'');return /\$|Robux/.test(t)&&t.length<60;})
    .slice(0,30).map(function(e){return {tag:e.tagName,cls:String(e.className||'').slice(0,28),txt:(e.innerText||'').replace(/\s+/g,' ').trim().slice(0,48)};});
  // 1) ищем кликабельный с суммой amount И ценой ($) в тексте
  var target=null, why='';
  var amtStr=String(amount), amtSp=amount.toLocaleString('ru-RU');
  for(var i=0;i<cand.length;i++){var e=cand[i];var t=(e.innerText||'').replace(/ /g,' ');
    if((t.indexOf(amtStr)>=0||t.indexOf(amtSp)>=0)&&/[€$£₽]/.test(t)&&t.length<60){target=e;why='amount+price';break;}}
  // 2) запас: кнопка с ценой 0,99 (для 80) — только button/role
  if(!target){for(var j=0;j<cand.length;j++){var e2=cand[j];var t2=(e2.innerText||'');
    if((t2.indexOf('0,99')>=0||t2.indexOf('0.99')>=0)&&(e2.tagName==='BUTTON'||e2.getAttribute('role')==='button')){target=e2;why='price0.99';break;}}}
  var clicked=false, rect=null;
  if(target){var r=target.getBoundingClientRect();rect={x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
    try{target.click();clicked=true;}catch(e){}}
  return JSON.stringify({clicked:clicked,why:why,target:target?(target.innerText||'').replace(/\s+/g,' ').trim().slice(0,60):null,rect:rect,priced:priced});
})(__AMT__)
""".replace("__AMT__", str(amt))
        ev2 = cdp.cmd("Runtime.evaluate", {"expression": js, "returnByValue": True})
        try:
            res = json.loads(ev2["result"]["result"]["value"])
        except Exception:
            res = {"err": str(ev2)[:300]}
        print("\n=== АВТО-КЛИК пак %d ===" % amt)
        print("  найденные кликабельные (цена/Robux):")
        for p in res.get("priced", [])[:30]:
            print("    [%s.%s] %s" % (p.get("tag"), p.get("cls"), p.get("txt")))
        print("  -> clicked=%s why=%s target=%r" % (res.get("clicked"), res.get("why"), res.get("target")))
        # если JS click не сработал, добиваем реальным мышиным кликом по координатам
        rect = res.get("rect")
        if res.get("clicked") and rect:
            cdp.cmd("Input.dispatchMouseEvent", {"type": "mousePressed", "x": rect["x"], "y": rect["y"], "button": "left", "clickCount": 1})
            cdp.cmd("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": rect["x"], "y": rect["y"], "button": "left", "clickCount": 1})
            print("  + продублировал мышиным кликом по (%d,%d)" % (rect["x"], rect["y"]))

    print("\n=== СЛУШАЮ СЕТЬ ===")
    print("  Если не было --auto-buy: в окне нажми пак '80 Robux' (0,99 $).")
    print("  (createOrder=401 = ОТЛИЧНО: флоу стартует вне app, в Фазе 2 впрыснем XSTS.)")
    print("  Ctrl+C -> вердикт.\n")

    t0 = time.time()
    try:
        while True:
            time.sleep(1)
            if args.seconds and (time.time() - t0) > args.seconds:
                break
    except KeyboardInterrupt:
        pass

    if args.emulate_bridge:
        ev3 = cdp.cmd("Runtime.evaluate", {"expression": "JSON.stringify(window.__bridgeLog||[])", "returnByValue": True})
        blog = []
        try:
            blog = json.loads(ev3["result"]["result"]["value"])
        except Exception:
            pass
        print("\n=== BRIDGE LOG (что страница слала в window.chrome.webview) ===")
        if not blog:
            print("  (пусто — страница не обращалась к мосту)")
        for e in blog:
            print("  " + json.dumps(e, ensure_ascii=False)[:400])

    print("\n================ ВЕРДИКТ ================")
    for label, _ in WATCH:
        s = seen[label]
        if s["req"]:
            print("  %-14s: запросов=%d статусы=%s" % (label, s["req"], s["statuses"]))
    co = seen["createOrder"]["req"]
    if co:
        print("\n  >>> createOrder ПОЛЕТЕЛ (%d) - веб-флоу стартует вне приложения." % co)
        print("      Фаза 2: впрыснуть наш XSTS на gold/buynow/paymentinstruments через CDP Fetch.")
    else:
        print("\n  >>> createOrder НЕ полетел.")
        print("      Вероятно нужен мост приложения - перезапусти с --emulate-bridge,")
        print("      либо страница не дошла до покупки (проверь, залогинен ли, виден ли пак).")
    print("========================================")

    cdp.close()
    try:
        proc.terminate()
    except Exception:
        pass


if __name__ == "__main__":
    main()
