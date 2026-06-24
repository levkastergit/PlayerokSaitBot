#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
b3_probe.py — закрыть вопрос «есть ли headless-charge МИМО Dynamics-cart».
Два пробника (read-only / только 4xx, МИНИМАЛЬНЫЕ тела => НЕ завершают покупку, денег НЕ тратят):
  1) PaymentSessions/{id}: есть ли у paymentSessionId независимый finalize/redeem/status вне корзины.
  2) PurchaseExperienceFD: существуют ли verb'ы completeOrder/placeOrder/submitOrder/... (sibling createOrder).
Ищем КОД != 401/403/404 = эндпойнт существует (первый позитивный сигнал не-cart charge).
Сплошь 404/401/403 => подтверждаем: charge только через cart-сессию => B2 неизбежен.

Запуск (дев-VM, как mint_pay_token): MSA_USER=.. MSA_PASS=.. python b3_probe.py
"""
import json, os, re, sys, urllib.parse, urllib.request
from urllib.error import HTTPError, URLError

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mint_pay_token import oauth_login, xbox_chain, _load_creds, _new_cv  # noqa: E402

BIGID = "9NH6SMMZQHM9"
STOREID = {"productId": "9NH6SMMZQHM9", "skuId": "0010", "availabilityId": "9VH3WJX9DHDB"}
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) RobloxApp/2.726"


def req(method, url, header, body=None, extra=None):
    h = {"User-Agent": UA, "Authorization": header, "Accept": "application/json", "MS-CV": _new_cv()}
    if extra:
        h.update(extra)
    if body is not None and "Content-Type" not in h:
        h["Content-Type"] = "application/json"
    r = urllib.request.Request(url, data=(body.encode() if isinstance(body, str) else body), headers=h, method=method)
    try:
        x = urllib.request.urlopen(r, timeout=30)
        return x.status, x.read().decode("utf-8", "replace")
    except HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except URLError as e:
        return 0, str(e)


def find(p, s, g=1):
    m = re.search(p, s)
    return m.group(g) if m else None


def tag(code):
    return "  <<< СУЩЕСТВУЕТ?" if code not in (0, 401, 403, 404) else ""


def main():
    user, pw = _load_creds()
    print("=" * 70)
    print("[*] b3_probe — поиск headless-charge мимо cart-сессии (без списания)")
    print("=" * 70)
    tok, d = oauth_login(user, pw)
    if not tok:
        print("[FAIL] login:", d); sys.exit(1)
    xsts, d = xbox_chain(tok)
    if not xsts:
        print("[FAIL] xsts:", d); sys.exit(1)
    print("[1] XSTS ok")

    # PI + paymentSessionId (как в headless_buy — это уже доказано headless)
    st, pi = req("GET", "https://paymentinstruments.mp.microsoft.com/v6.0/users/me/paymentInstrumentsEx?status=active&language=en-US&partner=webblends&country=US", xsts)
    sv = re.search(r'"paymentMethodType"\s*:\s*"stored_value".*?"id"\s*:\s*"([0-9a-f-]{36})"', pi, re.S)
    piid = (sv.group(1) if sv else None) or find(r'"id"\s*:\s*"([0-9a-f-]{36})"', pi)
    account_id = find(r'"accountId"\s*:\s*"([0-9a-f-]{36})"', pi)
    cand = {"id": None, "amount": 0.99, "currency": "USD", "country": "US", "language": "en-US",
            "partner": "webblends", "piid": piid, "billableAccountId": account_id, "hasPreOrder": False,
            "challengeScenario": "PaymentTransaction", "purchaseOrderId": "00000000-0000-0000-0000-000000000000",
            "emailAddress": user}
    st, resp = req("GET", "https://paymentinstruments.mp.microsoft.com/v6.0/users/me/PaymentSessionDescriptions?paymentSessionData=%s&operation=Add" % urllib.parse.quote(json.dumps(cand)),
                   xsts, extra={"correlation-context": "v=1,ms.b.tel.scenario=commerce.payments.PaymentSessioncreatePaymentSession"})
    psid = find(r'"id"\s*:\s*"([^"]+)"', resp) if st == 200 else None
    print("[2] piid=%s paymentSessionId=%s" % (bool(piid), psid))
    if not psid:
        print("    (нет paymentSessionId — пробник verb-enum всё равно прогоним)")

    PIFD = "https://paymentinstruments.mp.microsoft.com/v6.0/users/me"
    print("\n[3] ПРОБНИК 1 — PaymentSessions/{id} (finalize/redeem/status вне cart):")
    if psid:
        for method, suffix in (("GET", ""), ("GET", "/status"), ("POST", "/confirm"), ("POST", "/authorize"),
                               ("POST", "/finalize"), ("POST", "/redeem"), ("POST", "/complete")):
            url = "%s/PaymentSessions/%s%s" % (PIFD, psid, suffix)
            body = "{}" if method == "POST" else None
            code, b = req(method, url, xsts, body)
            print("    %-4s PaymentSessions/{id}%-10s -> %s%s" % (method, suffix or "", code, tag(code)))
    else:
        print("    SKIP (нет paymentSessionId)")

    print("\n[4] ПРОБНИК 2 — PurchaseExperienceFD verb-enum (sibling createOrder; МИНИМАЛЬНОЕ тело):")
    GOLD = "https://gold.xboxservices.com/PurchaseExperienceFD"
    qs = "?market=US&language=en&deviceFamily=Windows.Desktop&appVersion=2604.8.1.0"
    # минимальное тело: НЕ полноценный charge (без него вернёт 400 'missing', а не спишет)
    minbody = json.dumps({"parentProductId": "9PMF91N3LZ3M"})
    for verb in ("completeOrder", "placeOrder", "submitOrder", "confirmOrder", "checkout",
                 "purchase", "finalizeOrder", "fulfillOrder"):
        url = "%s/%s/%s%s" % (GOLD, verb, BIGID, qs)
        code, b = req("POST", url, xsts, minbody, extra={"x-ms-api-version": "2.0"})
        print("    POST %-14s -> %s%s  %s" % (verb, code, tag(code), b[:60].replace("\n", " ")))

    print("\n" + "=" * 70)
    print("[ЧИТАТЬ] любой код != 401/403/404 у verb/PaymentSessions = эндпойнт ЕСТЬ →")
    print("  потенциальный не-cart charge-путь (копаем дальше). Сплошь 404/401/403 →")
    print("  подтверждено: charge только через cart-сессию → B2 (живой клиент) неизбежен.")
    print("=" * 70)


if __name__ == "__main__":
    main()
