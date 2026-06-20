#!/usr/bin/env python3
"""Логин Roblox через прокси mitmdump (порт из --proxy), чтобы аддон pow_dump снял тела PoW."""
import os, sys, time, tempfile, shutil, argparse
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By

ap = argparse.ArgumentParser()
ap.add_argument("--proxy", default="127.0.0.1:8081")
ap.add_argument("--timeout", type=int, default=70)
a = ap.parse_args()
U = os.environ.get("ROBLOX_USER", ""); P = os.environ.get("ROBLOX_PASS", "")

prof = tempfile.mkdtemp(prefix="pow-")
o = Options()
o.add_argument("--user-data-dir=" + prof)
o.add_argument("--proxy-server=http://" + a.proxy)
o.add_argument("--ignore-certificate-errors")
o.add_argument("--no-first-run")
o.add_argument("--window-size=1200,900")
o.page_load_strategy = "eager"
d = webdriver.Chrome(options=o)
try:
    d.set_page_load_timeout(45)
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
    print("[powcap] логин отправлен, жду %ss…" % a.timeout, file=sys.stderr)
    d.set_script_timeout(15)
    deadline=time.time()+a.timeout
    while time.time()<deadline:
        try:
            r=d.execute_async_script("const done=arguments[arguments.length-1];fetch('https://users.roblox.com/v1/users/authenticated',{credentials:'include'}).then(x=>x.json()).then(j=>done(j&&j.id?1:0)).catch(()=>done(0));")
            if r==1: print("[powcap] AUTHENTICATED", file=sys.stderr); break
        except Exception: pass
        time.sleep(3)
    time.sleep(2)
finally:
    try: d.quit()
    except Exception: pass
    shutil.rmtree(prof, ignore_errors=True)
