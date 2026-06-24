#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
headless_cart.py - pure-urllib charge корзины Dynamics с СЕССИОННОЙ непрерывностью:
  - cookie-jar на все вызовы (buynow -> cart) -> сессия не теряется;
  - buynow устанавливает cookie cartMuid (= x-authorization-muid) + vector-id -> берём ИХ, не случайные;
  - точное тело updateCart = cart-контекст из захвата.
Цель: пройдёт ли корзина с РОДНЫМ cartMuid/vector-id из той же buynow-сессии. updateCart->readyToPurchase = БЕСПЛАТНО.
ЗАПУСК: MSA_USER=.. MSA_PASS=.. python headless_cart.py [--charge]
"""
import argparse
import json
import os
import re
import sys
import urllib.parse
import urllib.request
import uuid
from http.cookiejar import CookieJar

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mint_pay_token as M  # noqa: E402

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64; WebView/3.0) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/70.0.3538.102 Safari/537.36 Edge/18.26100")
DYN = "https://buynow.production.store-web.dynamics.com/v1.0"
PIFD = "https://paymentinstruments.mp.microsoft.com/v6.0/users/me"
PRODUCT = {"productId": "9NH6SMMZQHM9", "skuId": "0010", "availabilityId": "9VH3WJX9DHDB"}
JAR = CookieJar()
OPENER = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(JAR))


import base64
_CVB = base64.b64encode(os.urandom(12)).decode("ascii").rstrip("=").replace("+", "a").replace("/", "b")
_CVN = [0]


def cv():
    """ОДИН ms-cv-base на всю покупку (как в захвате: 4Old46jJ6EKxfpM0.*) — сессионная корреляция."""
    _CVN[0] += 1
    return "%s.1.1.2.1.%d" % (_CVB, _CVN[0])


def find(p, s, g=1):
    m = re.search(p, s)
    return m.group(g) if m else None


def req(method, url, header, body=None, extra=None, form=False):
    h = {"User-Agent": UA}
    if header:
        h["Authorization"] = header
    h["Accept"] = "*/*"
    h["MS-CV"] = cv()
    if extra:
        h.update(extra)
    if body is not None:
        h["Content-Type"] = "application/x-www-form-urlencoded" if form else "application/json"
    r = urllib.request.Request(url, data=(body.encode() if isinstance(body, str) else body), headers=h, method=method)
    try:
        x = OPENER.open(r, timeout=30)
        return x.status, x.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except Exception as e:
        return 0, str(e)


def buynow(header):
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
    body = urllib.parse.urlencode({"auth": json.dumps(header), "data": json.dumps(data_obj)})
    st, html = req("POST", "https://www.microsoft.com/store/purchase/buynowui/buynow?market=US&locale=ru&ms-cv=" + urllib.parse.quote(cv()),
                   None, body, extra={"Accept": "text/html", "Accept-Language": "ru-RU", "Upgrade-Insecure-Requests": "1"}, form=True)
    return st, html


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--charge", action="store_true")
    args = ap.parse_args()
    print("=" * 64)
    user, pw = M._load_creds()
    tok, d = M.oauth_login(user, pw)
    if not tok:
        print("[FAIL] login:", d); sys.exit(1)
    header, d = M.xbox_chain(tok)
    if not header:
        print("[FAIL] xsts:", d); sys.exit(1)
    print("[1] XSTS ok")

    # buynow в ТОЙ ЖЕ jar -> ставит cartMuid + (возможно) vector-id
    st, html = buynow(header)
    saturn = "Confirm Purchase" in html
    cartmuid = next((c.value for c in JAR if c.name == "cartMuid"), None)
    allmuid = next((c.value for c in JAR if c.name == "MUID"), None)
    vec = find(r'"[a-zA-Z]*[Vv]ector[a-zA-Z]*"\s*:\s*"([0-9A-Fa-f]{32,64})"', html) or find(r'([0-9A-Fa-f]{64})', html)
    print("[2] buynow HTTP %s (Saturn=%s)  cartMuid=%s  MUID=%s  vector=%s" % (st, saturn, cartmuid, allmuid, (vec or "")[:24]))
    muid = cartmuid or allmuid or uuid.uuid4().hex.upper()
    if not vec:
        vec = (uuid.uuid4().hex + uuid.uuid4().hex).upper()

    st, pi = req("GET", PIFD + "/paymentInstrumentsEx?status=active&language=en-US&partner=webblends&country=US", header)
    sv = re.search(r'"paymentMethodType"\s*:\s*"stored_value".*?"id"\s*:\s*"([0-9a-f-]{36})"', pi, re.S)
    piid = (sv.group(1) if sv else None) or find(r'"id"\s*:\s*"([0-9a-f-]{36})"', pi)
    account_id = find(r'"accountId"\s*:\s*"([0-9a-f-]{36})"', pi)
    st2, ad = req("GET", PIFD + "/addresses?type=billing&language=en-US&partner=webblends&country=US", header)
    addr_id = find(r'"id"\s*:\s*"([0-9a-f-]{36})"', ad)
    print("[3] piid=%s accountId=%s addrId=%s" % (piid, account_id, addr_id))

    psd = {"id": None, "amount": 0.99, "currency": "USD", "country": "US", "language": "en-US",
           "partner": "saturnpc", "piid": piid, "billableAccountId": account_id, "hasPreOrder": False,
           "challengeScenario": "PaymentTransaction", "purchaseOrderId": str(uuid.uuid4()), "emailAddress": user}
    st, resp = req("GET", PIFD + "/PaymentSessionDescriptions?paymentSessionData=%s&operation=Add" % urllib.parse.quote(json.dumps(psd)),
                   header, extra={"correlation-context": "v=1,ms.b.tel.scenario=commerce.payments.PaymentSessioncreatePaymentSession"})
    psid = find(r'"id"\s*:\s*"([^"]+)"', resp)
    print("[4] paymentSessionId=%s" % (psid or "")[:40])

    cart_id = str(uuid.uuid4())
    cart_headers = {"x-authorization-muid": muid, "x-ms-vector-id": vec,
                    "x-ms-reference-id": (uuid.uuid4().hex + uuid.uuid4().hex).upper(),
                    "x-ms-tracking-id": str(uuid.uuid4()), "x-ms-correlation-id": str(uuid.uuid4()),
                    "x-ms-client-type": "SaturnPC", "x-ms-market": "US", "Accept-Language": "ru-RU",
                    "origin": "https://www.microsoft.com",
                    "referer": "https://www.microsoft.com/store/purchase/buynowui/buynow?market=US&locale=ru"}
    uc = json.dumps({"locale": "ru", "market": "US", "catalogClientType": "",
                     "clientContext": {"client": "SaturnPC", "deviceFamily": "windows.desktop",
                                       "osVersion": "2814751477604082", "clientVersion": "2604.8.1.0",
                                       "deviceForm": "unknown", "deviceModel": "b450m ds3h"},
                     "flights": ["sc_xboxgamepad", "sc_reactredeem", "sc_enablecsvforredeem"]})
    st, resp = req("PUT", "%s/cart/updateCart?cartId=%s&appId=BuyNow&calculateXboxMastercardPoints=false" % (DYN, cart_id),
                   header, uc, cart_headers)
    rtp = find(r'"readyToPurchase"\s*:\s*(true|false)', resp)
    print("[5] updateCart (cartMuid=%s..) HTTP %s  readyToPurchase=%s" % ((muid or "")[:8], st, rtp))
    if st != 200:
        print("    ОТВЕТ:", (resp or "")[:300].replace("\n", " "))

    if not args.charge:
        print("\n[ИТОГ] updateCart=%s. Если 200 -> родной cartMuid пробил 423." % st)
        return
    if rtp != "true":
        print("[СТОП] readyToPurchase!=true"); return
    pur = json.dumps({"cartId": cart_id, "market": "US", "locale": "ru", "catalogClientType": "",
                      "callerApplicationId": "_CONVERGED_saturnpc",
                      "clientContext": {"client": "SaturnPC", "deviceFamily": "windows.desktop", "osVersion": "2814751477604082",
                                        "clientVersion": "2604.8.1.0", "deviceForm": "unknown", "deviceModel": "b450m ds3h"},
                      "paymentSessionId": psid, "riskChallengeData": None, "rdsAsyncPaymentStatusCheck": False,
                      "paymentInstrumentId": piid, "paymentInstrumentType": "stored_value", "email": user,
                      "billingAddressId": {"accountId": account_id, "id": addr_id}, "currentOrderState": "CheckingOut"})
    st, resp = req("POST", "%s/Cart/purchase?appId=BuyNow" % DYN, header, pur, cart_headers)
    print("[6] Cart/purchase HTTP %s  orderState=%s charged=%s" % (st, find(r'"orderState"\s*:\s*"([^"]+)"', resp), find(r'"chargedAmount"\s*:\s*([0-9.]+)', resp)))
    print("    ОТВЕТ:", (resp or "")[:400].replace("\n", " "))


if __name__ == "__main__":
    main()
