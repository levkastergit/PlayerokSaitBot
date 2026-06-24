#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
b2_full_test.py - ПОЛНЫЙ авто-тест B2 (метод swizzyer) на РЕАЛЬНОЙ Windows-машине.

Один запуск делает ВСЁ:
  1) логин ПОКУПАТЕЛЯ в Roblox (buyer_login.py, видимый Chrome; капчу решаешь в окне) -> .ROBLOSECURITY = получатель;
  2) поднимает remote-debugging у WebView2 приложения Roblox; если порт не встаёт -
     САМ находит host-exe (родитель msedgewebview2.exe), добавляет его в реестр и перезапускает приложение;
  3) инжектит куку покупателя в WebView2 приложения через CDP + ведёт на страницу покупки (смена получателя);
  4) проверяет, под кем реально залогинено приложение (users/authenticated);
  5) баланс Robux покупателя ДО;
  6) гонит покупку 80 Robux (buy_robux.py, UIA) - платит MSA, залогиненный в Microsoft Store.
     БЕЗ --buy: доходит до окна оплаты и НЕ подтверждает (денег НЕ тратит).
     С --buy: реально жмёт "Купить" -> спишет $0.99 с баланса MSA;
  7) баланс ПОСЛЕ -> показывает дельту (ждём +80 ПОКУПАТЕЛЮ);
  8) откатывает debug-override реестра.

ТРЕБОВАНИЯ: реальная Windows-машина (НЕ VM - на VM Hyperion роняет приложение).
  Рядом положи buyer_login.py и buy_robux.py. Python 3, Chrome. Приложение Roblox из MS Store установлено.
  В Microsoft Store залогинен ПЛАТЁЛЬЩИК (funded-MSA с балансом) - он платит; получатель задаётся инжектом куки.

ЗАПУСК:
  # репетиция без денег (логин+инжект+проверка+открыть оплату, НЕ платить):
  python b2_full_test.py --buyer-user levkaster --buyer-pass ПАРОЛЬ
  # реальная покупка $0.99 на покупателя:
  python b2_full_test.py --buyer-user levkaster --buyer-pass ПАРОЛЬ --buy
  # если кука уже есть (пропустить логин):
  python b2_full_test.py --cookie-file cookie.txt [--buy]
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

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

PORT = 9222
REG_BASE = r"Software\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments"
DBG_ARG = "--remote-debugging-port=%d --remote-allow-origins=*" % PORT
ROBUX_URL = "https://www.roblox.com/premium/windows/robux"
# базовые догадки host-exe; реальный добавится авто-детектом
GUESS_EXES = ["Windows10Universal.exe", "RobloxPlayerBeta.exe", "RobloxApp.exe",
              "eurotrucks2.exe", "GameLaunchHelper.exe", "RobloxGDK.exe"]


def info(m): print("  [..]   " + m, flush=True)
def ok(m):   print("  [OK]   " + m, flush=True)
def warn(m): print("  [WARN] " + m, flush=True)
def fail(m): print("  [FAIL] " + m, flush=True)
def hdr(m):  print("\n===== %s =====" % m, flush=True)


def ps(cmd, timeout=60):
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", cmd],
                           capture_output=True, text=True, timeout=timeout)
        return (r.stdout or "").strip()
    except Exception as e:
        return "ERR:%s" % e


# ---------- WebView2 debug registry ----------
def set_overrides(exes):
    import winreg
    k = winreg.CreateKey(winreg.HKEY_CURRENT_USER, REG_BASE)
    for e in exes:
        winreg.SetValueEx(k, e, 0, winreg.REG_SZ, DBG_ARG)
    winreg.CloseKey(k)


def cleanup_overrides():
    import winreg
    try:
        k = winreg.OpenKey(winreg.HKEY_CURRENT_USER, REG_BASE, 0, winreg.KEY_ALL_ACCESS)
        names = []
        i = 0
        while True:
            try:
                names.append(winreg.EnumValue(k, i)[0]); i += 1
            except OSError:
                break
        for n in names:
            try: winreg.DeleteValue(k, n)
            except OSError: pass
        winreg.CloseKey(k)
        parent = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Policies\Microsoft\Edge\WebView2", 0, winreg.KEY_ALL_ACCESS)
        try: winreg.DeleteKey(parent, "AdditionalBrowserArguments")
        except OSError: pass
        winreg.CloseKey(parent)
    except OSError:
        pass


def find_package():
    out = ps("$p=Get-AppxPackage | Where-Object {$_.Name -match 'Roblox'} | Select-Object -First 1;"
             "if($p){$m=Join-Path $p.InstallLocation 'AppxManifest.xml'; try{[xml]$x=Get-Content $m;"
             "$a=@($x.Package.Applications.Application)[0]; $exe=if($a.Executable){Split-Path $a.Executable -Leaf}else{''};"
             "Write-Output ('{0}|{1}|{2}' -f $p.PackageFamilyName,$a.Id,$exe)}catch{Write-Output ('{0}|App|' -f $p.PackageFamilyName)}}")
    out = (out or "").splitlines()[-1] if out else ""
    if "|" not in out:
        return None
    parts = out.split("|")
    return parts[0], parts[1], (parts[2] if len(parts) > 2 else "")


def kill_app():
    ps("Get-Process msedgewebview2,RobloxPlayerBeta,Windows10Universal,RobloxApp,eurotrucks2,GameLaunchHelper,RobloxGDK "
       "-ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue")
    time.sleep(2)


def launch_app(pfn, appid):
    subprocess.Popen(["explorer.exe", "shell:AppsFolder\\%s!%s" % (pfn, appid)])


def detect_host_exes():
    cmd = ("$wv=Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\";"
           "$h=@(); foreach($p in $wv){$par=Get-CimInstance Win32_Process -Filter (\"ProcessId={0}\" -f $p.ParentProcessId) -ErrorAction SilentlyContinue;"
           "if($par -and $par.Name -ne 'msedgewebview2.exe'){$h+=$par.Name}}; ($h | Sort-Object -Unique) -join ','")
    out = ps(cmd)
    return [x for x in (out or "").split(",") if x and x.endswith(".exe")]


def poll_targets(seconds):
    deadline = time.time() + seconds
    while time.time() < deadline:
        time.sleep(2)
        try:
            data = json.loads(urllib.request.urlopen("http://127.0.0.1:%d/json/list" % PORT, timeout=4).read())
            pages = [t for t in data if t.get("type") == "page" and t.get("webSocketDebuggerUrl")]
            if pages:
                return pages
        except Exception:
            pass
    return None


# ---------- CDP ----------
class CDP:
    def __init__(self, ws_url):
        import websocket
        self.ws = websocket.create_connection(ws_url, max_size=None, enable_multithread=True)
        self._id = 0
        self._pending = {}
        self._alive = True
        threading.Thread(target=self._reader, daemon=True).start()

    def _reader(self):
        import json as _j
        while self._alive:
            try:
                m = self.ws.recv()
            except Exception:
                self._alive = False
                break
            if not m:
                continue
            try:
                o = _j.loads(m)
            except Exception:
                continue
            if "id" in o:
                self._pending[o["id"]] = o

    def cmd(self, method, params=None, timeout=15):
        self._id += 1
        mid = self._id
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

    def evaluate(self, expr, await_promise=False):
        r = self.cmd("Runtime.evaluate", {"expression": expr, "awaitPromise": await_promise, "returnByValue": True})
        try:
            return r["result"]["result"]["value"]
        except Exception:
            return None

    def close(self):
        self._alive = False
        try: self.ws.close()
        except Exception: pass


def robux_balance(uid, cookie):
    try:
        req = urllib.request.Request("https://economy.roblox.com/v1/users/%s/currency" % uid,
                                     headers={"Cookie": ".ROBLOSECURITY=%s" % cookie,
                                              "User-Agent": "Mozilla/5.0"})
        return json.loads(urllib.request.urlopen(req, timeout=15).read()).get("robux")
    except Exception as e:
        return "ERR:%s" % e


def dump_windows(auto):
    """Дамп верхнеуровневых окон + их кнопок (name/autoId/class) — чтобы найти окно оплаты
    и кнопку покупки независимо от языка интерфейса."""
    try:
        root = auto.GetRootControl()
        for w in root.GetChildren():
            try:
                nm = w.Name or ""; cls = w.ClassName or ""
            except Exception:
                continue
            if not (nm or cls):
                continue
            btns = []
            texts = []
            def walk(c, d=0):
                if d > 7:
                    return
                try:
                    kids = c.GetChildren()
                except Exception:
                    kids = []
                for k in kids:
                    try:
                        t = k.ControlTypeName; n = (k.Name or ""); a = (k.AutomationId or "")
                        if t == "ButtonControl" and (n or a):
                            btns.append("btn name=%r autoId=%r" % (n[:40], a[:34]))
                        elif t == "TextControl" and n and any(s in n for s in ("€", "$", "£", "Robux", "Microsoft", "balance", "Balance")):
                            texts.append("txt %r" % n[:50])
                    except Exception:
                        pass
                    walk(k, d + 1)
            walk(w)
            if btns or texts:
                print("  WIN name=%r class=%r" % (nm[:55], cls[:40]))
                for x in texts[:8]:
                    print("      " + x)
                for b in btns[:25]:
                    print("      " + b)
    except Exception as e:
        print("  dump_windows err: %s" % e)


# ---------- main flow ----------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--buyer-user", default="")
    ap.add_argument("--buyer-pass", default="")
    ap.add_argument("--cookie-file", default="", help="готовая .ROBLOSECURITY (пропустить логин)")
    ap.add_argument("--buy", action="store_true", help="РЕАЛЬНО оплатить $0.99 (без флага - стоп на окне оплаты)")
    ap.add_argument("--login-timeout", type=int, default=240)
    args = ap.parse_args()

    # deps
    hdr("0. Зависимости")
    for mod, pipname in (("selenium", "selenium"), ("uiautomation", "uiautomation"), ("websocket", "websocket-client")):
        try:
            __import__(mod)
        except Exception:
            info("ставлю %s..." % pipname)
            subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", pipname])
    for f in ("buyer_login.py", "buy_robux.py"):
        if not os.path.exists(os.path.join(HERE, f)):
            fail("рядом нет %s - скачай его в эту же папку" % f); sys.exit(1)
    ok("зависимости и файлы на месте")

    # 1. cookie покупателя
    hdr("1. Кука покупателя (.ROBLOSECURITY = получатель)")
    cookie = ""
    buyer_id = None
    buyer_name = None
    if args.cookie_file and os.path.exists(args.cookie_file):
        cookie = "".join(open(args.cookie_file, encoding="utf-8").read().split())
        ok("кука из файла (len=%d)" % len(cookie))
    else:
        if not (args.buyer_user and args.buyer_pass):
            fail("нужны --buyer-user/--buyer-pass или --cookie-file"); sys.exit(1)
        import buyer_login
        info("логиню @%s (откроется Chrome; реши капчу в окне, если появится)..." % args.buyer_user)
        res = buyer_login.run(args.buyer_user, args.buyer_pass, headless=False, timeout=args.login_timeout, wait=True)
        if not res.get("ok") or not res.get("roblosecurity"):
            fail("логин не удался: %s" % json.dumps(res, ensure_ascii=False)); sys.exit(2)
        cookie = res["roblosecurity"]
        buyer_id = res.get("account", {}).get("id")
        buyer_name = res.get("account", {}).get("name")
        ok("вошёл @%s (id=%s), кука получена" % (buyer_name, buyer_id))

    # узнаём buyer_id из куки, если ещё нет
    if not buyer_id:
        try:
            req = urllib.request.Request("https://users.roblox.com/v1/users/authenticated",
                                         headers={"Cookie": ".ROBLOSECURITY=%s" % cookie, "User-Agent": "Mozilla/5.0"})
            d = json.loads(urllib.request.urlopen(req, timeout=15).read())
            buyer_id, buyer_name = d.get("id"), d.get("name")
            ok("кука принадлежит @%s (id=%s)" % (buyer_name, buyer_id))
        except Exception as e:
            warn("не удалось определить владельца куки: %s" % e)

    # 2. WebView2 debug-порт (с авто-детектом host-exe)
    hdr("2. Поднять remote-debugging WebView2 приложения")
    pkg = find_package()
    if not pkg:
        fail("приложение Roblox из MS Store не найдено (Get-AppxPackage *Roblox*)"); sys.exit(1)
    pfn, appid, exe = pkg
    ok("пакет PFN=%s AppId=%s exe=%s" % (pfn, appid, exe))
    # RobloxPlayerBeta.exe — ПОДТВЕРЖДЁННЫЙ host WebView2 приложения (проверено живьём)
    exes = list(dict.fromkeys(["RobloxPlayerBeta.exe"] + ([exe] if exe else []) + GUESS_EXES))
    set_overrides(exes)
    info("реестр: debug-флаг для %d exe (host = RobloxPlayerBeta.exe)" % len(exes))
    kill_app()
    launch_app(pfn, appid)
    info("приложение запущено; жду debug-порт автоматически (до 160с, приложение грузит дом — НИЧЕГО НЕ НАЖИМАЙ)...")
    pages = poll_targets(160)
    if not pages:
        print("\n  >>> Порт не встал сам. ЕСЛИ приложение открылось — открой в нём меню 'Купить Robux' и нажми ENTER (запасной путь). <<<", flush=True)
        try:
            input()
        except Exception:
            pass
        pages = poll_targets(40)
    if not pages:
        # доп.попытка: вдруг host-exe другой; добавляем ТОЛЬКО Roblox-связанные и перезапускаем
        hosts = [h for h in detect_host_exes()
                 if any(x in h.lower() for x in ("roblox", "gdk", "eurotrucks", "windows10universal"))]
        if hosts:
            info("доп. host-exe: %s — добавляю и перезапускаю" % ", ".join(hosts))
            set_overrides(list(dict.fromkeys(exes + hosts)))
            kill_app(); launch_app(pfn, appid)
            pages = poll_targets(90)
    if not pages:
        fail("debug-порт %d не поднялся. Проверь вручную (открой приложение, зайди на 'Купить Robux'):" % PORT)
        print("    Invoke-RestMethod http://127.0.0.1:9222/json/list")
        cleanup_overrides(); sys.exit(3)
    ok("debug-порт живой, таргетов: %d" % len(pages))

    # 3. инжект куки
    hdr("3. Инжект куки покупателя в WebView2 (смена получателя)")
    page = next((p for p in pages if "roblox.com" in (p.get("url") or "")), pages[0])
    cdp = CDP(page["webSocketDebuggerUrl"])
    cdp.cmd("Network.enable"); cdp.cmd("Page.enable"); cdp.cmd("Runtime.enable")
    for dom in (".roblox.com", "www.roblox.com"):
        cdp.cmd("Network.setCookie", {"name": ".ROBLOSECURITY", "value": cookie,
                                      "domain": dom, "path": "/", "secure": True, "httpOnly": True})
    ok("кука выставлена, веду на страницу покупки")
    cdp.cmd("Page.navigate", {"url": ROBUX_URL})
    time.sleep(5)
    # навигация могла переподцепить таргет -> переподключаемся к актуальной roblox-вкладке
    try:
        data = json.loads(urllib.request.urlopen("http://127.0.0.1:%d/json/list" % PORT, timeout=4).read())
        rp = [t for t in data if t.get("type") == "page" and "roblox.com" in (t.get("url") or "") and t.get("webSocketDebuggerUrl")]
        if rp and rp[0]["webSocketDebuggerUrl"] != page["webSocketDebuggerUrl"]:
            cdp.close(); cdp = CDP(rp[0]["webSocketDebuggerUrl"])
            cdp.cmd("Runtime.enable"); cdp.cmd("Page.enable")
            info("переподключился к актуальной вкладке Robux")
    except Exception:
        pass

    # 4. проверка получателя (поллинг, не виснет)
    hdr("4. Проверка: под кем залогинено приложение")
    app_uid = None; app_name = None; who = None
    for _ in range(12):
        who = cdp.evaluate("fetch('https://users.roblox.com/v1/users/authenticated',{credentials:'include'})"
                           ".then(r=>r.json()).then(j=>JSON.stringify(j)).catch(e=>'ERR:'+e)", await_promise=True)
        try:
            j = json.loads(who)
            if j.get("id"):
                app_uid = j.get("id"); app_name = j.get("name"); break
        except Exception:
            pass
        time.sleep(2)
    if app_uid and str(app_uid) == str(buyer_id):
        ok("приложение залогинено под ПОКУПАТЕЛЕМ @%s (id=%s) - получатель сменён верно" % (app_name, app_uid))
    elif app_uid:
        warn("приложение под id=%s (@%s), а покупатель id=%s. Инжект не переключил сессию (Model B?)."
             % (app_uid, app_name, buyer_id))
    else:
        warn("authenticated не вернул id (последний ответ: %s)" % str(who)[:120])

    # 5. баланс ДО
    hdr("5. Баланс Robux покупателя ДО")
    bal_before = robux_balance(buyer_id, cookie) if buyer_id else "нет buyer_id"
    ok("баланс ДО (id=%s): %s" % (buyer_id, bal_before))

    # 6. покупка
    hdr("6. Покупка 80 Robux - клик пака (CDP) + подтверждение (UIA)")
    if not args.buy:
        warn("РЕПЕТИЦИЯ (без --buy): дойду до окна оплаты и НЕ подтвержу (денег не трачу).")
    import buy_robux
    buy_robux.auto.SetGlobalSearchTimeout(2)
    # клик пака 80 через CDP в WebView приложения (надёжнее UIA для веб-контента)
    pack_js = r"""(function(a){
 function v(e){var r=e.getBoundingClientRect();return r.width>2&&r.height>2;}
 var c=[].slice.call(document.querySelectorAll('button,[role=button],a,div,span,li')).filter(v);
 var best=null;
 for(var i=0;i<c.length;i++){var e=c[i];var t=(e.innerText||'').replace(/ /g,' ');
   if(/(^|\D)80(\D|$)/.test(t)&&/\d[.,]\d{2}\s*[€$£₽]|[€$£₽]\s*\d/.test(t)&&t.length<100){if(!best||t.length<(best.innerText||'').length)best=e;}}
 if(!best){for(var j=0;j<c.length;j++){var e2=c[j];var t2=(e2.innerText||'').replace(/ /g,' ');if(/(^|\D)80(\D|$)/.test(t2)&&/[€$£₽]/.test(t2)&&t2.length<140){best=e2;break;}}}
 var dump=c.filter(function(e){return /\$|0[.,]99/.test(e.innerText||'')&&(e.innerText||'').length<70;}).slice(0,22).map(function(e){return e.tagName+':'+(e.innerText||'').replace(/\s+/g,' ').trim().slice(0,40);});
 var rect=null; if(best){best.scrollIntoView({block:'center'}); var rr=best.getBoundingClientRect(); rect={x:Math.round(rr.left+rr.width/2),y:Math.round(rr.top+rr.height/2)}; best.click();}
 return JSON.stringify({clicked:!!best,target:best?(best.innerText||'').replace(/\s+/g,' ').trim().slice(0,60):null,rect:rect,dump:dump});
})(80)"""
    diag_js = r"""(function(){
 var b=document.body;
 return JSON.stringify({href:location.href,title:document.title,ready:document.readyState,
   bodyLen:(b?b.innerText.length:0),
   bodySample:(b?b.innerText.replace(/\s+/g,' ').slice(0,280):''),
   btn:document.querySelectorAll('button').length,
   iframes:[].slice.call(document.querySelectorAll('iframe')).map(function(f){return (f.src||f.id||'(noref)').slice(0,80);}),
   priced:[].slice.call(document.querySelectorAll('button,[role=button],a,div,span,li')).filter(function(e){var r=e.getBoundingClientRect();return r.width>2&&r.height>2&&/[€$£₽]|Robux/.test(e.innerText||'')&&(e.innerText||'').length<70;}).slice(0,25).map(function(e){return e.tagName+':'+(e.innerText||'').replace(/\s+/g,' ').trim().slice(0,42);})});
})()"""
    clicked = False
    last = {}
    for _attempt in range(15):
        try:
            last = json.loads(cdp.evaluate(diag_js) or "{}")
        except Exception:
            last = {}
        if last.get("priced"):
            try:
                pj = json.loads(cdp.evaluate(pack_js) or "{}")
            except Exception:
                pj = {}
            if pj.get("clicked"):
                clicked = True
                info("CDP-клик пака: target=%r" % pj.get("target"))
                rect = pj.get("rect")
                if rect:
                    x, y = rect["x"], rect["y"]
                    cdp.cmd("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y})
                    cdp.cmd("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1})
                    cdp.cmd("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1})
                    info("доверенный мышиный клик по паку (%d,%d)" % (x, y))
                break
        time.sleep(2)
    info("CDP-таргет: " + json.dumps({k: last.get(k) for k in ("href", "title", "ready", "bodyLen", "btn", "iframes")}, ensure_ascii=False))
    if last.get("bodySample"):
        info("текст страницы (фрагмент): " + str(last.get("bodySample")))
    info("кликабельные с ценой/Robux: %s" % last.get("priced"))
    if clicked:
        info("жду нативное окно оплаты (8с) + ДАМП окон (нужно под твою локаль)...")
        time.sleep(8)
        print("  --- нативные окна и кнопки (для подбора под локаль) ---")
        dump_windows(buy_robux.auto)
        print("  --- конец дампа ---")
        buy_robux.confirm_purchase(do_click=args.buy)
    else:
        warn("пак не найден/не кликнут -> запасной полный UIA-путь buy_robux...")
        rc = buy_robux.run("buy" if args.buy else "select", 80)
        info("buy_robux код возврата: %s" % rc)

    # 7. баланс ПОСЛЕ
    hdr("7. Баланс ПОСЛЕ (зачисление асинхронное ~10-15с)")
    bal_after = None
    if buyer_id and args.buy:
        for _ in range(8):
            time.sleep(4)
            bal_after = robux_balance(buyer_id, cookie)
            print("    баланс: %s" % bal_after, flush=True)
            try:
                if isinstance(bal_before, int) and isinstance(bal_after, int) and bal_after >= bal_before + 80:
                    break
            except Exception:
                pass
        ok("ДО=%s -> ПОСЛЕ=%s (ждём +80 ПОКУПАТЕЛЮ id=%s)" % (bal_before, bal_after, buyer_id))
    else:
        info("покупка не подтверждалась (--buy не задан) - баланс не проверяю.")

    # 8. cleanup
    hdr("8. Откат debug-override")
    cdp.close()
    cleanup_overrides()
    ok("реестр-оверрайд снят")

    hdr("ИТОГ")
    print("  получатель (кука): @%s id=%s" % (buyer_name, buyer_id))
    print("  приложение залогинено под id=%s" % app_uid)
    print("  баланс ДО=%s  ПОСЛЕ=%s" % (bal_before, bal_after))
    if args.buy and isinstance(bal_before, int) and isinstance(bal_after, int):
        d = bal_after - bal_before
        print("  ДЕЛЬТА=+%s -> %s" % (d, "УСПЕХ: Robux пришли покупателю!" if d >= 80 else "проверь вручную"))
    else:
        print("  (репетиция без оплаты; для реальной покупки добавь --buy)")


if __name__ == "__main__":
    main()
