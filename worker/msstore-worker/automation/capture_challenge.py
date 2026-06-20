#!/usr/bin/env python3
"""
Снять последовательность challenge'ей при браузерном логине Roblox через перехватчик fetch/XHR,
внедрённый ДО скриптов страницы (CDP addScriptToEvaluateOnNewDocument). Браузер сам решает PoW;
мы видим заголовки rblx-challenge-* каждого ответа /v2/login и /challenge/*.

Цель: подтвердить, что на НОВОМ аккаунте после PoW приходит captcha-challenge, и достать его
challengeId / metadata(blob, unifiedCaptchaId) — это вход для кооперативной капчи.

Запуск: ROBLOX_USER=.. ROBLOX_PASS=.. python capture_challenge.py [--timeout 90]
Только читает свой же трафик. Ничего не покупает.
"""
import os, sys, json, time, tempfile, shutil, argparse, base64

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.common.exceptions import WebDriverException

WRAPPER = r"""
(function(){
  if (window.__rbxHook) return; window.__rbxHook = true; window.__rbx = [];
  function rec(url, status, get){
    try {
      var u = (url||'')+'';
      if (u.indexOf('/v2/login')<0 && u.indexOf('/challenge/')<0 && u.indexOf('proof-of-work')<0) return;
      window.__rbx.push({url:u, status:status,
        ctype:get('rblx-challenge-type'), cid:get('rblx-challenge-id'), cmeta:get('rblx-challenge-metadata')});
    } catch(e){}
  }
  var of = window.fetch;
  window.fetch = function(){
    return of.apply(this, arguments).then(function(res){
      try { rec(res.url, res.status, function(h){ return res.headers.get(h); }); } catch(e){}
      return res;
    });
  };
  var oOpen = XMLHttpRequest.prototype.open, oSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(m,u){ this.__u=u; return oOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function(){
    var xhr=this;
    xhr.addEventListener('load', function(){ rec(xhr.__u, xhr.status, function(h){ return xhr.getResponseHeader(h); }); });
    return oSend.apply(this, arguments);
  };
})();
"""

ap = argparse.ArgumentParser()
ap.add_argument("--timeout", type=int, default=90)
a = ap.parse_args()
U = os.environ.get("ROBLOX_USER", ""); P = os.environ.get("ROBLOX_PASS", "")

prof = tempfile.mkdtemp(prefix="chal-")
o = Options()
o.add_argument("--user-data-dir=" + prof)
o.add_argument("--no-first-run"); o.add_argument("--disable-blink-features=AutomationControlled")
o.add_argument("--window-size=1280,1000"); o.add_argument("--lang=en-US")
o.page_load_strategy = "eager"
d = webdriver.Chrome(options=o)


def decode_meta(b64):
    try:
        return json.loads(base64.b64decode(b64 + "==").decode("utf-8", "replace"))
    except Exception:
        return None


try:
    d.set_page_load_timeout(45)
    # внедряем перехватчик ДО любых скриптов страницы
    d.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {"source": WRAPPER})
    try: d.get("https://www.roblox.com/login")
    except Exception: pass
    time.sleep(2)

    def fill(sels, v):
        for by, s in sels:
            try:
                e = d.find_element(by, s)
                if e.is_displayed():
                    e.clear(); e.send_keys(v); return True
            except Exception: pass
        return False
    fill([(By.ID,"login-username"),(By.NAME,"username"),(By.CSS_SELECTOR,"input[type='text']")], U)
    fill([(By.ID,"login-password"),(By.NAME,"password"),(By.CSS_SELECTOR,"input[type='password']")], P)
    for by,s in [(By.ID,"login-button"),(By.CSS_SELECTOR,"button[type='submit']")]:
        try:
            b=d.find_element(by,s)
            if b.is_displayed(): d.execute_script("arguments[0].click();", b); break
        except Exception: pass
    print("[chal] логин отправлен, жду %ss (реши капчу в окне, если попросит)…" % a.timeout, file=sys.stderr)

    d.set_script_timeout(15)
    auth = False
    deadline = time.time() + a.timeout
    seen = []
    while time.time() < deadline:
        try:
            cur = d.execute_script("return window.__rbx || [];")
            if cur and len(cur) != len(seen):
                seen = cur
        except WebDriverException:
            pass
        try:
            r = d.execute_async_script("const done=arguments[arguments.length-1];fetch('https://users.roblox.com/v1/users/authenticated',{credentials:'include'}).then(x=>x.json()).then(j=>done(j&&j.id?1:0)).catch(()=>done(0));")
            if r == 1: auth = True
        except WebDriverException:
            pass
        if auth: break
        time.sleep(2)

    print("AUTHENTICATED:", auth)
    print("=== challenge-последовательность (%d) ===" % len(seen))
    for e in seen:
        meta = decode_meta(e.get("cmeta")) if e.get("cmeta") else None
        compact = None
        if meta:
            compact = {k: meta.get(k) for k in ("sessionId","unifiedCaptchaId","dataExchangeBlob","blob") if k in meta}
            if not compact.get("dataExchangeBlob") and not compact.get("blob"):
                # blob может быть глубже
                compact["_keys"] = list(meta.keys())
        print("  %-6s %s  type=%s cid=%s meta=%s" % (e.get("status"), e.get("url","")[:48], e.get("ctype"), (e.get("cid") or "")[:18], json.dumps(compact, ensure_ascii=False) if compact else None))
finally:
    try: d.quit()
    except Exception: pass
    shutil.rmtree(prof, ignore_errors=True)
