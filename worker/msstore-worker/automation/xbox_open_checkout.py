#!/usr/bin/env python3
"""Открывает окно покупки 400 Robux (клик по первичной кнопке BUY) и СКРИНшотит
способы оплаты. НЕ нажимает финальное подтверждение покупки.

usage: python xbox_open_checkout.py
"""
import time
from selenium import webdriver
from selenium.webdriver.edge.options import Options

URL = "https://www.xbox.com/en-US/games/store/400-robux-for-xbox/BS5KH5D3QQWV"

opts = Options()
opts.add_experimental_option("debuggerAddress", "127.0.0.1:9333")
d = webdriver.Edge(options=opts)

d.get(URL)
time.sleep(6)

# Найти первичную кнопку покупки (зелёная "Buy $4.99"), НЕ wishlist
btns = d.find_elements("css selector", "button, a")
cand = []
for b in btns:
    try:
        t = (b.text or "").strip()
    except Exception:
        continue
    if not t:
        continue
    low = t.lower()
    if low.startswith("buy") or ("buy" in low and "$" in low) or low == "get":
        cand.append((t, b))

print("Кандидаты-кнопки покупки:")
for t, _ in cand[:10]:
    print("   ", repr(t))

clicked = None
for t, b in cand:
    if "wishlist" in t.lower():
        continue
    try:
        d.execute_script("arguments[0].scrollIntoView({block:'center'});", b)
        time.sleep(0.5)
        b.click()
        clicked = t
        break
    except Exception as e:
        print("click err on", repr(t), e)

print("Кликнул:", repr(clicked))
time.sleep(8)  # ждём модалку оплаты

# Собрать текст модалки/страницы оплаты
try:
    body = d.find_element("tag name", "body").text
except Exception:
    body = ""
low = body.lower()
print("URL after:", d.current_url)
print("--- сигналы способов оплаты ---")
for kw in ["microsoft account balance", "account balance", "balance",
           "credit card", "debit", "visa", "mastercard", "paypal",
           "payment", "add a new way to pay", "redeem", "verify",
           "$4.99", "robux", "buy", "confirm", "place order", "order total"]:
    if kw in low:
        print("   +", kw)

d.save_screenshot(r"C:\playerok\worker\msstore-worker\xbox-checkout.png")
print("SHOT: xbox-checkout.png")
