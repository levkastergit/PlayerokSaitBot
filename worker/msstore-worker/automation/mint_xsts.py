#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mint_xsts.py — ПРОТОТИП B: минт коммерческого токена XSTS ("XBL3.0 x=<uhs>;<XSTS>")
для MS-Store покупки Robux (Путь B), и БЕЗОПАСНАЯ проверка токена на read-only
эндпоинте каталога (НИЧЕГО не покупает, деньги не списываются).

ЦЕПОЧКА (по build-spec из живого дампа):
  MSA вход (device-code OAuth, login.live.com)
    → access_token (RPS-тикет "d=<token>")
    → user.auth.xboxlive.com  → Xbox user token + uhs
    → xsts.auth.xboxlive.com  → XSTS  (relying-party перебираем — RP для commerce пока [ПРОВЕРИТЬ])
    → header "XBL3.0 x=<uhs>;<XSTS>"
  ПРОВЕРКА: GET gold.xboxservices.com/PurchaseExperienceFD/Product/9NH6SMMZQHM9
            (read-only карточка "80 Robux"; 200 = токен принят коммерцией → блокер №1 снят)

ЗАПУСК (на машине с доступом в интернет; залогинивать будешь FUNDED MSA-плательщика):
  python mint_xsts.py
  # покажет код — открой aka.ms/link (microsoft.com/link), введи код, подтверди вход MSA
  # refresh-токен сохранится в xsts_refresh.txt → повторные прогоны без ручного входа

ВАЖНО: это эксплоративный прототип. Если Product вернёт 200 — XSTS принят коммерцией.
Если 401/403 — значит для commerce нужен токен Store-клиента/WAM (сообщи мне статус и какой RP сработал).
Только stdlib (urllib). Покупку НЕ совершает.
"""
import argparse
import json
import os
import sys
import time
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

# Well-known публичный клиент Xbox (xbox-webapi/minecraft-auth). Даёт MSA access_token,
# пригодный как RpsTicket для user.auth.xboxlive.com.
CLIENT_ID = "0000000048093EE3"
SCOPE = "service::user.auth.xboxlive.com::MBI_SSL"

DEVICE_AUTH = "https://login.live.com/oauth20_connect.srf"
TOKEN_URL = "https://login.live.com/oauth20_token.srf"
USER_AUTH = "https://user.auth.xboxlive.com/user/authenticate"
XSTS_AUTH = "https://xsts.auth.xboxlive.com/xsts/authorize"

# RP-кандидаты для XSTS под commerce (точный RP из дампа неизвестен — перебираем)
RP_CANDIDATES = [
    "http://xboxlive.com",
    "http://mp.microsoft.com/",
    "http://gold.xboxservices.com",
    "rp://commerce.microsoft.com",
    "http://licensing.xboxlive.com",
    "https://gameservices.xboxlive.com/",
]

PRODUCT_BIGID = "9NH6SMMZQHM9"  # 80 Robux
VALIDATE_URL = (
    "https://gold.xboxservices.com/PurchaseExperienceFD/Product/%s"
    "?market=US&language=en&appVersion=2604.8.1.0&deviceFamily=Windows.Desktop&timezoneOffset=0" % PRODUCT_BIGID
)

REFRESH_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "xsts_refresh.txt")


def _post_form(url, fields):
    body = "&".join("%s=%s" % (k, _enc(v)) for k, v in fields.items()).encode()
    req = Request(url, data=body, headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST")
    return _read(req)


def _post_json(url, obj, headers=None):
    h = {"Content-Type": "application/json", "Accept": "application/json", "x-xbl-contract-version": "1"}
    if headers:
        h.update(headers)
    req = Request(url, data=json.dumps(obj).encode(), headers=h, method="POST")
    return _read(req)


def _enc(s):
    from urllib.parse import quote
    return quote(str(s), safe="")


def _read(req):
    try:
        r = urlopen(req, timeout=30)
        return r.status, r.read().decode("utf-8", "replace")
    except HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except URLError as e:
        return 0, str(e)


# ---------- MSA device-code ----------

def device_login():
    st, body = _post_form(DEVICE_AUTH, {"client_id": CLIENT_ID, "scope": SCOPE, "response_type": "device_code"})
    d = json.loads(body)
    print("\n" + "=" * 64)
    print(" ВОЙДИ В FUNDED MSA-АККАУНТ:")
    print("   открой:  %s" % d.get("verification_uri", "https://www.microsoft.com/link"))
    print("   код:     %s" % d.get("user_code"))
    print("=" * 64 + "\n")
    interval = int(d.get("interval", 5))
    end = time.time() + int(d.get("expires_in", 900))
    while time.time() < end:
        time.sleep(interval)
        st, body = _post_form(TOKEN_URL, {
            "client_id": CLIENT_ID, "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            "device_code": d["device_code"]})
        t = json.loads(body)
        if "access_token" in t:
            print("[ok] MSA access_token получен")
            return t
        if t.get("error") not in ("authorization_pending", "slow_down"):
            raise SystemExit("device-code ошибка: %s" % body[:300])
    raise SystemExit("истёк таймаут входа")


def refresh_login(refresh_token):
    st, body = _post_form(TOKEN_URL, {
        "client_id": CLIENT_ID, "grant_type": "refresh_token", "scope": SCOPE, "refresh_token": refresh_token})
    t = json.loads(body)
    if "access_token" not in t:
        return None
    print("[ok] MSA access_token обновлён по refresh_token")
    return t


# ---------- Xbox auth chain ----------

def xbox_user_token(access_token):
    st, body = _post_json(USER_AUTH, {
        "RelyingParty": "http://auth.xboxlive.com", "TokenType": "JWT",
        "Properties": {"AuthMethod": "RPS", "SiteName": "user.auth.xboxlive.com", "RpsTicket": "d=" + access_token}})
    if st != 200:
        raise SystemExit("user.auth.xboxlive ошибка %s: %s" % (st, body[:300]))
    d = json.loads(body)
    uhs = d["DisplayClaims"]["xui"][0]["uhs"]
    return d["Token"], uhs


def xsts_token(user_token, relying_party):
    st, body = _post_json(XSTS_AUTH, {
        "RelyingParty": relying_party, "TokenType": "JWT",
        "Properties": {"SandboxId": "RETAIL", "UserTokens": [user_token]}})
    if st != 200:
        return None, None, "%s %s" % (st, body[:160])
    d = json.loads(body)
    return d["Token"], d["DisplayClaims"]["xui"][0]["uhs"], None


def validate(xbl_header):
    req = Request(VALIDATE_URL, headers={
        "Authorization": xbl_header, "x-ms-api-version": "1.0",
        "User-Agent": "mint-xsts/1", "Accept": "application/json"}, method="GET")
    st, body = _read(req)
    ok = st == 200 and ("Robux" in body or "productId" in body.lower())
    return st, ok, body[:240]


def main():
    ap = argparse.ArgumentParser(description="Минт XSTS для MS-Store commerce + read-only проверка.")
    ap.add_argument("--rp", default=None, help="форсировать один relying-party вместо перебора")
    args = ap.parse_args()

    tok = None
    if os.path.exists(REFRESH_FILE):
        rt = open(REFRESH_FILE, encoding="utf-8").read().strip()
        if rt:
            tok = refresh_login(rt)
    if not tok:
        tok = device_login()
    if tok.get("refresh_token"):
        open(REFRESH_FILE, "w", encoding="utf-8").write(tok["refresh_token"])

    print("[*] получаю Xbox user token...")
    user_token, uhs = xbox_user_token(tok["access_token"])
    print("    uhs =", uhs)

    rps = [args.rp] if args.rp else RP_CANDIDATES
    print("[*] перебираю relying-party для XSTS + проверяю на каталоге (read-only, без оплаты)...\n")
    winner = None
    for rp in rps:
        xsts, xuhs, err = xsts_token(user_token, rp)
        if err:
            print("  RP %-40s XSTS: ОТКАЗ (%s)" % (rp, err))
            continue
        header = "XBL3.0 x=%s;%s" % (xuhs or uhs, xsts)
        st, ok, preview = validate(header)
        mark = "✅ ПРИНЯТ КОММЕРЦИЕЙ" if ok else ("частично (%d)" % st)
        print("  RP %-40s XSTS ok, Product=%s  %s" % (rp, st, mark))
        if ok and not winner:
            winner = (rp, header, preview)

    print("\n" + "=" * 64)
    if winner:
        rp, header, preview = winner
        print(" РЕЗУЛЬТАТ: рабочий relying-party = %s" % rp)
        print(" XSTS-заголовок готов (длина %d). Блокер минта токена СНЯТ." % len(header))
        print(" Превью карточки: %s" % preview)
        open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "xsts_header.txt"), "w",
             encoding="utf-8").write(header)
        print(" Заголовок сохранён в xsts_header.txt (НЕ выкладывай — это твой токен).")
        print(" Сообщи мне: какой RP сработал и статус Product=200.")
    else:
        print(" Ни один RP не дал 200 на каталоге. Вероятно commerce требует токен Store-клиента/WAM.")
        print(" Сообщи мне статусы по каждому RP — подберём client_id/RP или пойдём через WAM.")
    print("=" * 64)


if __name__ == "__main__":
    main()
