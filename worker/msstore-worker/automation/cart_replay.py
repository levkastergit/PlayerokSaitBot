#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
cart_replay.py — реплей updateCart с РЕАЛЬНЫМИ захваченными значениями (а не случайными/cartMuid-кукой).
Гипотеза: muid статичен по машине, vector-id живёт на сессию. Значения берём из своего захвата
(capture-full.jsonl, req_headers успешного updateCart) и передаём через env:
  - REPLAY_MUID    = x-authorization-muid  (стабилен по машине)
  - REPLAY_VECTOR  = x-ms-vector-id        (на сессию)
  - REPLAY_CVBASE  = первый сегмент MS-CV  (ms-cv base)
  - тело updateCart = _real_uc_body.json (реальное ~6КБ, НЕ урезанное; рядом, gitignored)
XSTS минтим для funded-MSA (тот же аккаунт, что делал покупку в захвате) -> identity match.
Тест: 200 -> захваченный device-fingerprint реплеится. 423 -> сессия live-bound к устройству/IP.
ЗАПУСК: REPLAY_MUID=.. REPLAY_VECTOR=.. REPLAY_CVBASE=.. MSA_USER=.. MSA_PASS=.. python cart_replay.py
"""
import json
import os
import sys
import urllib.request
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mint_pay_token as M  # noqa: E402

DYN = "https://buynow.production.store-web.dynamics.com/v1.0"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64; WebView/3.0) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/70.0.3538.102 Safari/537.36 Edge/18.26100")

# === Реальные device-значения берём из ENV (не хардкодим — это fingerprint конкретной машины) ===
# Источник: req_headers успешного updateCart в capture-full.jsonl (поля x-authorization-muid,
# x-ms-vector-id; ms-cv base = первый сегмент MS-CV). Пример извлечения — см. docstring.
REAL_MUID = os.environ.get("REPLAY_MUID", "")
REAL_VECTOR = os.environ.get("REPLAY_VECTOR", "")
CV_BASE = os.environ.get("REPLAY_CVBASE", "")
HERE = os.path.dirname(os.path.abspath(__file__))
if not (REAL_MUID and REAL_VECTOR and CV_BASE):
    print("[!] нужны env REPLAY_MUID / REPLAY_VECTOR / REPLAY_CVBASE (из capture-full.jsonl updateCart)")
    sys.exit(2)


def req(method, url, headers, body=None):
    data = body.encode() if isinstance(body, str) else body
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        x = urllib.request.urlopen(r, timeout=30)
        return x.status, x.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return 0, str(e)


def main():
    user, pw = M._load_creds()
    print("[*] минчу XSTS для", user)
    tok, d = M.oauth_login(user, pw)
    if not tok:
        print("[FAIL] login:", d); sys.exit(1)
    header, d = M.xbox_chain(tok)
    if not header:
        print("[FAIL] xsts:", d); sys.exit(1)
    print("[1] XSTS ok (len=%d)" % len(header))

    body = open(os.path.join(HERE, "_real_uc_body.json"), encoding="utf-8").read()
    cart_id = str(uuid.uuid4())
    cv = "%s.8.1.1.2.1.11.3" % CV_BASE
    h = {
        "origin": "https://www.microsoft.com",
        "referer": "https://www.microsoft.com/store/purchase/buynowui/buynow?market=US&locale=ru",
        "accept": "*/*",
        "accept-language": "ru-RU",
        "authorization": header,
        "content-type": "application/json",
        "ms-cv": cv,
        "x-authorization-muid": REAL_MUID,
        "x-ms-client-type": "SaturnPC",
        "x-ms-correlation-id": str(uuid.uuid4()),
        "x-ms-market": "US",
        "x-ms-reference-id": (uuid.uuid4().hex + uuid.uuid4().hex).upper(),
        "x-ms-tracking-id": str(uuid.uuid4()),
        "x-ms-vector-id": REAL_VECTOR,
        "accept-encoding": "gzip, deflate, br",
        "user-agent": UA,
        "cache-control": "no-cache",
    }
    url = "%s/cart/updateCart?cartId=%s&appId=BuyNow&calculateXboxMastercardPoints=false" % (DYN, cart_id)
    print("[2] updateCart с РЕАЛЬНЫМ muid=%s vector=%s..." % (REAL_MUID[:12], REAL_VECTOR[:12]))
    st, resp = req("PUT", url, h, body)
    rtp = '"readyToPurchase":true' in resp or '"readyToPurchase": true' in resp
    print("    -> HTTP %s  readyToPurchase=%s" % (st, rtp))
    print("    ОТВЕТ:", (resp or "")[:400].replace("\n", " "))
    print()
    if st == 200:
        print("[ПРОРЫВ] updateCart=200 с захваченными device-значениями -> реплей возможен!")
    else:
        print("[ИТОГ] updateCart=%s -> подтверждает: сессия live-bound (muid/vector-id не реплеятся вне устройства)." % st)


if __name__ == "__main__":
    main()
