#!/usr/bin/env python3
"""Подключается к уже запущенному Edge (remote-debugging 9333), читает состояние
страницы store.xbox.com и делает скриншот. НИЧЕГО не покупает — только наблюдает.

usage: python xbox_probe.py <shot_name> [url_to_navigate]
"""
import sys, time
from selenium import webdriver
from selenium.webdriver.edge.options import Options

shot = sys.argv[1] if len(sys.argv) > 1 else "xbox-shot"
nav = sys.argv[2] if len(sys.argv) > 2 else None

opts = Options()
opts.add_experimental_option("debuggerAddress", "127.0.0.1:9333")
d = webdriver.Edge(options=opts)

if nav:
    d.get(nav)
    time.sleep(6)

time.sleep(1)
print("URL  :", d.current_url)
print("TITLE:", d.title)
try:
    body = d.find_element("tag name", "body").text
except Exception as e:
    body = ""
    print("body read err:", e)

hints = ["Sign in", "Sign out", "Sign-in", "Get", "Buy", "Install", "Play",
         "$", "balance", "Microsoft account", "Requires a game", "launch Roblox",
         "payment", "Checkout", "Roblox", "404", "not available", "isn't available",
         "region", "currency"]
low = body.lower()
print("--- HINTS present on page ---")
for kw in hints:
    if kw.lower() in low:
        print("  +", kw)

# Попробуем вытащить имя залогиненного аккаунта (аватар/меню)
for sel in ['[data-bi-id*="account"]', 'button[aria-label*="account"]',
            'img[alt*="profile"]', '[class*="signin"]', 'a[href*="login"]']:
    try:
        els = d.find_elements("css selector", sel)
        if els:
            txt = (els[0].get_attribute("aria-label") or els[0].text or els[0].get_attribute("alt") or "")[:80]
            print(f"  account-el {sel}: {txt!r}")
    except Exception:
        pass

path = rf"C:\playerok\worker\msstore-worker\{shot}.png"
d.save_screenshot(path)
print("SHOT :", path)
