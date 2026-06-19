#!/usr/bin/env python3
"""
Разовый перехват сети при браузерном входе в Roblox — чтобы понять, какие challenge/PoW-эндпоинты
вызываются (браузер решает proof-of-work сам). Пишет URL'ы вызовов auth/challenge/pow/arkose.

Запуск:  ROBLOX_USER=.. ROBLOX_PASS=.. python capture_login_net.py
Только читает трафик своего же входа. Ничего не покупает.
"""
import os
import sys
import time
import json
import tempfile
import shutil

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By

U = os.environ.get("ROBLOX_USER", "")
P = os.environ.get("ROBLOX_PASS", "")
INTEREST = ("auth.roblox.com", "challenge", "proof-of-work", "pow", "arkoselabs",
            "twostep", "metrics", "account-security", "captcha")

prof = tempfile.mkdtemp(prefix="cap-")
opts = Options()
opts.add_argument("--user-data-dir=" + prof)
opts.add_argument("--no-first-run")
opts.add_argument("--window-size=1200,900")
opts.page_load_strategy = "eager"
opts.set_capability("goog:loggingPrefs", {"performance": "ALL"})

d = webdriver.Chrome(options=opts)
try:
    d.set_page_load_timeout(45)
    try:
        d.get("https://www.roblox.com/login")
    except Exception:
        pass
    time.sleep(2)

    def fill(sel_list, val):
        for by, s in sel_list:
            try:
                el = d.find_element(by, s)
                if el.is_displayed():
                    el.clear(); el.send_keys(val); return True
            except Exception:
                pass
        return False

    fill([(By.ID, "login-username"), (By.NAME, "username"), (By.CSS_SELECTOR, "input[type='text']")], U)
    fill([(By.ID, "login-password"), (By.NAME, "password"), (By.CSS_SELECTOR, "input[type='password']")], P)
    for by, s in [(By.ID, "login-button"), (By.CSS_SELECTOR, "button[type='submit']")]:
        try:
            b = d.find_element(by, s)
            if b.is_displayed():
                d.execute_script("arguments[0].click();", b); break
        except Exception:
            pass
    print("[cap] логин отправлен, жду до 90с (реши капчу/2FA в окне, если будет)…", file=sys.stderr)

    # Ждём авторизацию (или таймаут), параллельно собирая логи сети.
    d.set_script_timeout(15)
    auth = False
    deadline = time.time() + 90
    seen = []
    while time.time() < deadline:
        try:
            for entry in d.get_log("performance"):
                try:
                    msg = json.loads(entry["message"])["message"]
                except Exception:
                    continue
                if msg.get("method") == "Network.requestWillBeSent":
                    url = msg["params"]["request"]["url"]
                    method = msg["params"]["request"].get("method", "")
                    if any(k in url for k in INTEREST):
                        seen.append((method, url))
        except Exception:
            pass
        try:
            r = d.execute_async_script(
                "const done=arguments[arguments.length-1];"
                "fetch('https://users.roblox.com/v1/users/authenticated',{credentials:'include'})"
                ".then(x=>x.json()).then(j=>done(j&&j.id?1:0)).catch(()=>done(0));")
            if r == 1:
                auth = True
        except Exception:
            pass
        if auth:
            break
        time.sleep(3)

    print("AUTHENTICATED:", auth)
    # Уникальные интересные вызовы, по порядку.
    uniq = []
    s = set()
    for m, u in seen:
        key = m + " " + u.split("?")[0]
        if key not in s:
            s.add(key); uniq.append((m, u.split("?")[0]))
    print("=== challenge/PoW/auth сетевые вызовы (%d уник.) ===" % len(uniq))
    for m, u in uniq:
        print(" ", m, u)
finally:
    try:
        d.quit()
    except Exception:
        pass
    shutil.rmtree(prof, ignore_errors=True)
