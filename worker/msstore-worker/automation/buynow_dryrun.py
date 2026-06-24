#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
buynow_dryrun.py — headless прогон платёжной цепочки, с опциональным РЕАЛЬНЫМ списанием.

Цепочка: login.live.com -> XSTS -> createOrder -> buynow (cart-контекст) ->
PaymentSessionDescriptions (реверс paymentSessionData по ошибкам) -> updateCart ->
[--charge] Cart/purchase ($0.99 stored_value).

ВНИМАНИЕ: с флагом --charge делает РЕАЛЬНОЕ списание. Без флага останавливается
перед Cart/purchase (денег не тратит). Идём БЕЗ keys/serviceTicket и без Roblox-cookie,
поэтому даже успешное списание может НЕ зачислить Robux (получатель не привязан) —
это тест платёжной плоскости.

Запуск:
  MSA_USER=mail MSA_PASS='...' python buynow_dryrun.py            # dry-run
  MSA_USER=mail MSA_PASS='...' python buynow_dryrun.py --charge   # с реальным списанием
"""
import json
import sys
import os
import re
import uuid
import urllib.parse
import urllib.request
from urllib.error import HTTPError, URLError

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mint_pay_token import oauth_login, xbox_chain, _load_creds, _new_cv  # noqa: E402

PRODUCT = {"productId": "9NH6SMMZQHM9", "skuId": "0010", "availabilityId": "9VH3WJX9DHDB"}
# UA как у реального WebView-чекаута (дамп [145]) — RobloxApp-UA давал "Page not found".
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64; WebView/3.0) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/70.0.3538.102 Safari/537.36 Edge/18.26100")
DO_CHARGE = "--charge" in sys.argv


def _req(method, url, headers, data=None):
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        r = urllib.request.urlopen(req, timeout=45)
        return r.status, r.read().decode("utf-8", "replace")
    except HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except URLError as e:
        return 0, str(e)


def find(pat, s, grp=1):
    m = re.search(pat, s)
    return m.group(grp) if m else None


def deep_find(obj, key):
    """первое значение ключа key в произвольно вложенном dict/list."""
    if isinstance(obj, dict):
        if key in obj and isinstance(obj[key], (str, int, float)):
            return obj[key]
        for v in obj.values():
            r = deep_find(v, key)
            if r is not None:
                return r
    elif isinstance(obj, list):
        for v in obj:
            r = deep_find(v, key)
            if r is not None:
                return r
    return None


def main():
    user, password = _load_creds()
    print("=" * 72)
    print("[*] buynow %s для: %s" % ("+ РЕАЛЬНОЕ СПИСАНИЕ" if DO_CHARGE else "dry-run (без списания)", user))
    print("=" * 72)

    print("[1] login.live.com -> XSTS ...")
    token, diag = oauth_login(user, password)
    if not token:
        print("    [FAIL]", diag); sys.exit(1)
    header, diag = xbox_chain(token)
    if not header:
        print("    [FAIL] XSTS:", diag); sys.exit(1)
    print("    [OK] XSTS готов (len=%d)" % len(header))

    # ---- 2. buynow (полный data + ms-cv) ----
    print("\n[2] buynow ...")
    # точная форма data из дампа [145] (scenario="", конкретные flights, nested data{usePurchaseSdk})
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
    # сервер делает JSON.parse(auth) -> auth должен быть валидным JSON (строка в кавычках)
    body = urllib.parse.urlencode({"auth": json.dumps(header), "data": json.dumps(data_obj)}).encode()
    cv = _new_cv()
    st, html = _req("POST",
                    "https://www.microsoft.com/store/purchase/buynowui/buynow?market=US&locale=ru&ms-cv=" + urllib.parse.quote(cv),
                    {"User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded",
                     "Accept": "text/html,application/xhtml+xml", "Accept-Language": "ru-RU",
                     "Upgrade-Insecure-Requests": "1"}, body)
    print("    buynow HTTP %s (len=%d)" % (st, len(html)))
    import tempfile
    _hp = os.path.join(tempfile.gettempdir(), "buynow_last.html")
    try:
        open(_hp, "w", encoding="utf-8").write(html)
        print("    [сохранено] %s" % _hp)
    except Exception as _e:
        print("    [save err] %s" % _e)

    # вытащить Redux preloaded-state JSON
    state = None
    m = re.search(r'(?:preloadedState|__INITIAL_STATE__|window\.__data)\s*[=:]\s*(\{.*?\})\s*(?:;|</script)', html, re.S)
    if not m:
        m = re.search(r'(\{"cart.*?\})\s*(?:;|</script)', html, re.S)
    if m:
        try:
            state = json.loads(m.group(1))
        except Exception:
            state = None
    ctx = {}
    if state:
        ctx = {
            "cartId": deep_find(state, "cartId") or deep_find(state, "id"),
            "sessionId": deep_find(state, "sessionId"),
            "piid": deep_find(state, "paymentInstrumentId"),
            "accountId": deep_find(state, "accountId"),
            "soldToAddressId": deep_find(state, "soldToAddressId"),
            "email": deep_find(state, "emailAddress"),
        }
    else:
        ctx = {
            "cartId": find(r'"cartId"\s*:\s*"([^"]+)"', html),
            "sessionId": find(r'"sessionId"\s*:\s*"([^"]+)"', html),
            "piid": find(r'"paymentInstrumentId"\s*:\s*"([^"]+)"', html),
            "accountId": find(r'"accountId"\s*:\s*"([^"]+)"', html),
            "soldToAddressId": find(r'"soldToAddressId"\s*:\s*"([^"]+)"', html),
            "email": find(r'"emailAddress"\s*:\s*"([^"]+)"', html),
        }
    for k, v in ctx.items():
        print("      %-16s = %s" % (k, v))
    if not ctx.get("cartId"):
        print("      [тело buynow, 600 симв]:", html[:600].replace("\n", " "))

    # ---- 3. PaymentSessionDescriptions: реверс paymentSessionData по ошибкам ----
    print("\n[3] PaymentSessionDescriptions — реверс схемы paymentSessionData:")
    def psd(blob):
        return _req("GET",
                    "https://paymentinstruments.mp.microsoft.com/v6.0/users/me/PaymentSessionDescriptions?paymentSessionData=%s&operation=Add" % urllib.parse.quote(json.dumps(blob)),
                    {"User-Agent": UA, "Authorization": header, "Accept": "application/json", "MS-CV": _new_cv(),
                     "correlation-context": "v=1,ms.b.tel.scenario=commerce.payments.PaymentSessioncreatePaymentSession"})
    psd_id = None
    cand = {
        "amount": 0.99, "currency": "USD", "country": "US", "language": "en-US",
        "partner": "saturnpc", "piid": ctx.get("piid"),
        "billableAccountId": ctx.get("accountId"),
        "hasPreOrder": False, "challengeScenario": "PaymentTransaction",
        "purchaseOrderId": ctx.get("cartId"),
    }
    for attempt in range(6):
        st, resp = psd(cand)
        sid = find(r'"id"\s*:\s*"([^"]+)"', resp)
        if st == 200 and sid:
            psd_id = sid
            print("    [OK] paymentSessionId=%s" % psd_id[:40])
            break
        msg = find(r'"message"\s*:\s*"([^"]+)"', resp) or resp[:200]
        # вытащить имя недостающего/битого поля
        miss = find(r"[Pp]arameter name:\s*([A-Za-z0-9_]+)", resp) or find(r"required property '([^']+)'", resp) or find(r"Path '([^']*)'", resp)
        print("    try#%d HTTP %s  miss=%s  | %s" % (attempt + 1, st, miss, msg[:140]))
        if not miss or miss in cand:
            break
        cand[miss] = ""  # добавим пустым и посмотрим, что скажет дальше

    # ---- 4. updateCart ----
    rtp = None
    if ctx.get("cartId"):
        print("\n[4] updateCart (riskSessionId=свежий GUID) ...")
        risk = str(uuid.uuid4())
        uc = json.dumps({"paymentInstrumentId": ctx.get("piid"),
                         "billingAddressId": {"accountId": ctx.get("accountId"), "id": ctx.get("soldToAddressId")},
                         "sessionId": ctx.get("sessionId"), "orderState": "CheckingOut",
                         "riskSessionId": risk, "buyNowScenario": "inAppPurchase"}).encode()
        st, resp = _req("PUT",
                        "https://buynow.production.store-web.dynamics.com/v1.0/cart/updateCart?cartId=%s&appId=BuyNow" % ctx["cartId"],
                        {"User-Agent": UA, "Authorization": header, "Content-Type": "application/json",
                         "x-ms-client-type": "SaturnPC", "x-ms-market": "US", "MS-CV": _new_cv()}, uc)
        rtp = find(r'"readyToPurchase"\s*:\s*(true|false)', resp)
        print("    updateCart HTTP %s  readyToPurchase=%s" % (st, rtp))
        if st != 200:
            print("      ответ:", resp[:240].replace("\n", " "))
    else:
        print("\n[4] updateCart — SKIP (нет cartId)")

    # ---- 5. Cart/purchase (СПИСАНИЕ) ----
    print("\n[5] Cart/purchase %s" % ("(РЕАЛЬНОЕ СПИСАНИЕ)" if DO_CHARGE else "— SKIP (нет --charge)"))
    if DO_CHARGE and psd_id and rtp == "true":
        pur = json.dumps({"cartId": ctx["cartId"], "paymentSessionId": psd_id,
                          "paymentInstrumentId": ctx.get("piid"), "paymentInstrumentType": "stored_value",
                          "email": ctx.get("email"), "billingAddressId": {"accountId": ctx.get("accountId"), "id": ctx.get("soldToAddressId")},
                          "currentOrderState": "CheckingOut", "riskChallengeData": None,
                          "callerApplicationId": "_CONVERGED_saturnpc", "buyNowScenario": "inAppPurchase", "itemsToAdd": {}}).encode()
        st, resp = _req("POST", "https://buynow.production.store-web.dynamics.com/v1.0/Cart/purchase?appId=BuyNow",
                        {"User-Agent": UA, "Authorization": header, "Content-Type": "application/json",
                         "x-ms-client-type": "SaturnPC", "x-ms-market": "US", "MS-CV": _new_cv()}, pur)
        ostate = find(r'"orderState"\s*:\s*"([^"]+)"', resp)
        charged = find(r'"chargedAmount"\s*:\s*([0-9.]+)', resp)
        print("    Cart/purchase HTTP %s  orderState=%s  chargedAmount=%s" % (st, ostate, charged))
        print("      ответ:", resp[:300].replace("\n", " "))
    elif DO_CHARGE:
        print("    НЕ списываю: нет paymentSessionId (%s) или readyToPurchase!=true (%s)." % (bool(psd_id), rtp))

    print("\n" + "=" * 72)
    print("[ИТОГ] buynow cartId=%s | paymentSessionId=%s | readyToPurchase=%s" % (
        bool(ctx.get("cartId")), bool(psd_id), rtp))
    print("=" * 72)


if __name__ == "__main__":
    main()
