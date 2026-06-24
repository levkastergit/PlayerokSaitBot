#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
headless_buy.py — путь B1: cart через WLID + реальный muid (тест переносимости).
Ключевая поправка: Dynamics cart авторизуется WLID1.0=t= (НЕ XSTS), нужен реальный
x-authorization-muid (снят капчуром). Реплеим updateCart точным телом из дампа [226].

login -> XSTS (для PSD) + WLID (для cart)
  -> paymentInstrumentsEx (piid/accountId) -> addresses (soldToAddressId)
  -> PaymentSessionDescriptions (paymentSessionId)
  -> updateCart (WLID + real muid + полное тело) -> readyToPurchase
  -> [--charge] Cart/purchase.
Креды: env MSA_USER/MSA_PASS или creds.txt.
"""
import json, os, re, sys, uuid, http.cookiejar, urllib.parse, urllib.request
from urllib.error import HTTPError, URLError

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mint_pay_token import oauth_login, xbox_chain, _load_creds, _new_cv  # noqa: E402

# Каталог MS-Store-паков Robux (из публичной API-доки swizzyer/2faroblox.com, 2026-06-24).
# Цена = розница MS Store. sku_id всегда "0010". Выбор: --denom <ключ> (дефолт "80"),
# опц. --qty <n>. Произвольную сумму swizzyer собирает комбинацией items[] — здесь
# поддержан один пак×qty (самый частый кейс); для микса добавить items вручную.
PRODUCTS_BY_DENOM = {
    # Стандартные (аккаунт БЕЗ Premium, без бонуса)
    "80":        {"productId": "9NH6SMMZQHM9", "skuId": "0010", "availabilityId": "9VH3WJX9DHDB", "amount": 0.99,  "robux": 80,   "premium": False, "label": "80 R$"},
    "500":       {"productId": "9PH0VHQ4CNFF", "skuId": "0010", "availabilityId": "9XL2GVHJGV0Z", "amount": 4.99,  "robux": 500,  "premium": False, "label": "500 R$"},
    "1000":      {"productId": "9NRQLWSN0K89", "skuId": "0010", "availabilityId": "9VZ9ZH7Z8GBZ", "amount": 9.99,  "robux": 1000, "premium": False, "label": "1000 R$"},
    "2000":      {"productId": "9NH22L8775FQ", "skuId": "0010", "availabilityId": "9XD28K6ZW97V", "amount": 19.99, "robux": 2000, "premium": False, "label": "2000 R$"},
    # С Premium (Robux + 1 мес Roblox Premium; Premium даётся 1 раз на заказ)
    "450+prem":  {"productId": "9NT8XD0WZ4JT", "skuId": "0010", "availabilityId": "B3DC4QQRM2PJ", "amount": 4.99,  "robux": 450,  "premium": True,  "label": "450 R$ + Premium"},
    "1000+prem": {"productId": "9PJSPHF65QVG", "skuId": "0010", "availabilityId": "9PXTFMW31KG0", "amount": 9.99,  "robux": 1000, "premium": True,  "label": "1000 R$ + Premium"},
    "2200+prem": {"productId": "9PJKVXL2N2LZ", "skuId": "0010", "availabilityId": "9SBR9RH761MB", "amount": 19.99, "robux": 2200, "premium": True,  "label": "2200 R$ + Premium"},
}


def _argval(flag, default=None):
    """Значение CLI-флага вида `--flag VALUE` (или default)."""
    if flag in sys.argv:
        i = sys.argv.index(flag)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return default


DENOM = _argval("--denom", "80")
if DENOM not in PRODUCTS_BY_DENOM:
    sys.exit("[FAIL] неизвестный --denom %r; доступно: %s" % (DENOM, ", ".join(PRODUCTS_BY_DENOM)))
QTY = max(1, int(_argval("--qty", "1")))
PRODUCT = PRODUCTS_BY_DENOM[DENOM]
TOTAL = round(PRODUCT["amount"] * QTY, 2)
DYN = "https://buynow.production.store-web.dynamics.com/v1.0"
UA_WV = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; WebView/3.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.102 Safari/537.36 Edge/18.26200"
# Реальные device/session id, снятые капчуром (тест: переносимы ли они headless)
MUID = "7DD65CB5B930407EA9B2903EC932605E"
VECTOR = "9FF68CE13116AF3C64F40A1835AD556DA4C5AC2E1CB2C75F1899C43816594C69"
FLIGHTS = ["sc_xboxgamepad", "sc_xboxspinner", "sc_windowexternalnotify", "sc_disabledefaultstyles",
           "sc_xboxuiexp", "sc_reactredeem", "sc_enablecsvforredeem"]
DO_CHARGE = "--charge" in sys.argv
REDIRECT = "https://login.live.com/oauth20_desktop.srf"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"


def mint_rps(user, pw, scope, client="000000004C12AE6F"):
    """login.live.com форм-флоу с ПРОИЗВОЛЬНЫМ scope -> RPS-тикет (Ew...)."""
    au = ("https://login.live.com/oauth20_authorize.srf?client_id=%s&redirect_uri=%s"
          "&response_type=token&scope=%s&display=touch&locale=en") % (
        client, urllib.parse.quote(REDIRECT, safe=""), urllib.parse.quote(scope, safe=""))
    caught = []
    class C(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, hdrs, newurl):
            caught.append(newurl)
            return None if "access_token=" in newurl else super().redirect_request(req, fp, code, msg, hdrs, newurl)
    op = urllib.request.build_opener(C, urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    op.addheaders = [("User-Agent", UA), ("Accept", "text/html")]
    try:
        html = op.open(au, timeout=30).read().decode("utf-8", "replace")
    except Exception as e:
        return None, "GET err %s" % e
    ppft = re.search(r'name=\\"PPFT\\".*?value=\\"([^"\\]+)', html) or re.search(r'"sFT"\s*:\s*"([^"]+)"', html)
    post = re.search(r'"urlPost"\s*:\s*"([^"]+)"', html)
    if not ppft or not post:
        return None, "no PPFT/urlPost (scope %s, возможно недоступен этому клиенту)" % scope
    data = urllib.parse.urlencode({"login": user, "loginfmt": user, "passwd": pw, "PPFT": ppft.group(1)}).encode()
    try:
        r = op.open(urllib.request.Request(post.group(1).replace("\\/", "/"), data=data,
                    headers={"User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded"}), timeout=30)
        fin, body = r.geturl(), r.read().decode("utf-8", "replace")
    except Exception as e:
        fin, body = "", str(e)
    for u in caught + [fin]:
        if u and "access_token=" in u:
            t = urllib.parse.parse_qs(u.split("#", 1)[-1]).get("access_token", [None])[0]
            if t:
                return urllib.parse.unquote(t), "OK"
    return None, "no token (%s)" % body[:120].replace("\n", " ")


def req(method, url, auth, body=None, extra=None):
    h = {"User-Agent": UA_WV, "Authorization": auth, "Accept": "application/json", "MS-CV": _new_cv()}
    if extra:
        h.update(extra)
    if body is not None and "Content-Type" not in h:
        h["Content-Type"] = "application/json"
    r = urllib.request.Request(url, data=(body.encode() if isinstance(body, str) else body), headers=h, method=method)
    try:
        x = urllib.request.urlopen(r, timeout=45)
        return x.status, x.read().decode("utf-8", "replace")
    except HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except URLError as e:
        return 0, str(e)


def find(p, s, g=1):
    m = re.search(p, s)
    return m.group(g) if m else None


def main():
    user, pw = _load_creds()
    print("=" * 72)
    print("[*] headless_buy B1 %s — %s" % ("(+СПИСАНИЕ)" if DO_CHARGE else "(dry)", user))
    print("    пак: %s ×%d = $%.2f  [%s]" % (PRODUCT["label"], QTY, TOTAL, PRODUCT["productId"]))
    print("=" * 72)
    tok, d = oauth_login(user, pw)
    if not tok:
        print("[FAIL] login:", d); sys.exit(1)
    xsts, d = xbox_chain(tok)
    if not xsts:
        print("[FAIL] xsts:", d); sys.exit(1)
    print("[1] XSTS ok (len=%d)" % len(xsts))

    # WLID для cart (пробуем collections-аудиторию)
    print("[1b] минчу WLID для cart ...")
    wlid_raw = None
    for scope in ("service::collections.mp.microsoft.com::MBI_SSL",
                  "service::www.microsoft.com::MBI_SSL",
                  "service::cart.mp.microsoft.com::MBI_SSL"):
        wlid_raw, dd = mint_rps(user, pw, scope)
        print("    scope=%s -> %s" % (scope.split("::")[1], "OK len=%d" % len(wlid_raw) if wlid_raw else dd))
        if wlid_raw:
            used_scope = scope
            break
    wlid = ("WLID1.0=t=" + wlid_raw) if wlid_raw else xsts  # fallback XSTS если WLID не вышел

    # PI + address + PSD
    st, pi = req("GET", "https://paymentinstruments.mp.microsoft.com/v6.0/users/me/paymentInstrumentsEx?status=active&language=en-US&partner=webblends&country=US", xsts)
    sv = re.search(r'"paymentMethodType"\s*:\s*"stored_value".*?"id"\s*:\s*"([0-9a-f-]{36})"', pi, re.S)
    piid = (sv.group(1) if sv else None) or find(r'"id"\s*:\s*"([0-9a-f-]{36})"', pi)
    account_id = find(r'"accountId"\s*:\s*"([0-9a-f-]{36})"', pi)
    st, ad = req("GET", "https://paymentinstruments.mp.microsoft.com/v6.0/users/me/addresses?language=en-US&partner=webblends&country=US", xsts)
    addr_id = find(r'"id"\s*:\s*"([0-9a-f-]{36})"', ad)
    print("[2] piid=%s accountId=%s addrId=%s" % (piid, account_id, addr_id))
    cart_id = str(uuid.uuid4())
    cand = {"id": None, "amount": TOTAL, "currency": "USD", "country": "US", "language": "en-US",
            "partner": "webblends", "piid": piid, "billableAccountId": account_id, "hasPreOrder": False,
            "challengeScenario": "PaymentTransaction", "purchaseOrderId": cart_id, "emailAddress": user}
    st, resp = req("GET", "https://paymentinstruments.mp.microsoft.com/v6.0/users/me/PaymentSessionDescriptions?paymentSessionData=%s&operation=Add" % urllib.parse.quote(json.dumps(cand)),
                   xsts, extra={"correlation-context": "v=1,ms.b.tel.scenario=commerce.payments.PaymentSessioncreatePaymentSession"})
    psd_id = find(r'"id"\s*:\s*"([^"]+)"', resp) if st == 200 else None
    print("[3] paymentSessionId=%s" % psd_id)

    # ---- 4. updateCart: WLID + REAL muid + полное тело ----
    print("\n[4] updateCart (WLID + real muid %s…, cartId=%s…) ..." % (MUID[:8], cart_id[:8]))
    sess = str(uuid.uuid4())
    cartx = {"x-ms-client-type": "SaturnPC", "x-ms-market": "US", "x-authorization-muid": MUID,
             "x-ms-correlation-id": str(uuid.uuid4()), "x-ms-tracking-id": str(uuid.uuid4()),
             "x-ms-vector-id": VECTOR, "x-ms-reference-id": uuid.uuid4().hex.upper() + uuid.uuid4().hex.upper(),
             "Origin": "https://www.microsoft.com",
             "Referer": "https://www.microsoft.com/store/purchase/buynowui/buynow?market=US&locale=en"}
    uc = json.dumps({
        "locale": "en", "market": "US", "catalogClientType": "",
        "clientContext": {"client": "SaturnPC", "deviceFamily": "windows.desktop", "osVersion": "2814751477604082",
                          "clientVersion": "2604.8.1.0", "deviceForm": "unknown", "deviceModel": "b450m ds3h"},
        "flights": FLIGHTS,
        "items": [{"productId": PRODUCT["productId"], "skuId": PRODUCT["skuId"], "availabilityId": PRODUCT["availabilityId"], "quantity": QTY}],
        "paymentInstrumentId": piid, "billingAddressId": {"accountId": account_id, "id": addr_id},
        "sessionId": sess, "orderState": "CheckingOut", "riskSessionId": str(uuid.uuid4()), "buyNowScenario": "inAppPurchase",
    })
    st, resp = req("PUT", DYN + "/cart/updateCart?cartId=%s&appId=BuyNow&calculateXboxMastercardPoints=false" % cart_id, wlid, uc, extra=cartx)
    rtp = find(r'"readyToPurchase"\s*:\s*(true|false)', resp)
    print("    updateCart HTTP %s readyToPurchase=%s" % (st, rtp))
    print("      ответ:", resp[:280].replace("\n", " "))

    # ---- 5. charge ----
    print("\n[5] Cart/purchase %s" % ("(СПИСАНИЕ)" if DO_CHARGE else "(SKIP)"))
    if DO_CHARGE and psd_id and rtp == "true":
        pur = json.dumps({"cartId": cart_id, "paymentSessionId": psd_id, "paymentInstrumentId": piid,
                          "paymentInstrumentType": "stored_value", "email": user,
                          "billingAddressId": {"accountId": account_id, "id": addr_id},
                          "currentOrderState": "CheckingOut", "riskChallengeData": None,
                          "callerApplicationId": "_CONVERGED_saturnpc", "buyNowScenario": "inAppPurchase", "itemsToAdd": {}})
        st, resp = req("POST", DYN + "/Cart/purchase?appId=BuyNow", wlid, pur, extra=cartx)
        print("    HTTP %s orderState=%s charged=%s" % (st, find(r'"orderState"\s*:\s*"([^"]+)"', resp), find(r'"chargedAmount"\s*:\s*([0-9.]+)', resp)))
        print("      ", resp[:300].replace("\n", " "))
    elif DO_CHARGE:
        print("    НЕ списываю: psd_id=%s readyToPurchase=%s" % (bool(psd_id), rtp))

    print("\n" + "=" * 72)
    print("[ИТОГ] WLID=%s | psd=%s | readyToPurchase=%s" % (bool(wlid_raw), bool(psd_id), rtp))
    print("=" * 72)


if __name__ == "__main__":
    main()
