#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mint_pay_token.py — ТЕСТ масштабирующего звена: добыть КОММЕРЧЕСКИЙ XSTS-токен
для MSA из ЧИСТОГО email+password, HEADLESS (без WAM, без залогиненного Windows).

Зачем: один сервер должен обслуживать ПУЛ funded-MSA. Для этого он обязан по
логину/паролю сам сминтить XSTS (createOrder=200), без отдельной Windows-машины
на каждый аккаунт. WAM-минт (mint_wam.py) это НЕ даёт — он требует MSA в Windows.
Здесь — путь login.live.com (форма OAuth, как у Xbox/Minecraft-библиотек).

Цепочка (нижняя половина уже доказана у нас через mint_wam):
  email+password --[login.live.com form]--> access/RPS token
                 --[user.auth.xboxlive]--> user_token (uhs)
                 --[xsts.authorize RP=http://mp.microsoft.com/]--> XSTS -> "XBL3.0 x=uhs;XSTS"
                 --[createOrder КАНАРЕЙКА]--> 200 = коммерция приняла токен (ДЕНЕГ НЕ СПИСЫВАЕТ)

ЧИСТЫЙ stdlib — запускается и на Windows, и на Linux/VPS (headless = доказательство).

ЗАПУСК (НЕ клади пароль в командную строку — попадёт в историю):
  # вариант 1 — env:
  MSA_USER=mail@example.com MSA_PASS='...' python mint_pay_token.py
  # вариант 2 — файл creds.txt (две строки: email и пароль):
  python mint_pay_token.py creds.txt

ИНТЕРПРЕТАЦИЯ:
  - "createOrder=200" -> headless-минт XSTS из пароля РАБОТАЕТ => payer-сторона масштабируема.
  - "captcha/2FA" на логине -> MS требует челлендж; для НАШИХ funded-MSA выключи 2FA
    или решай челлендж (это отдельный шаг, как у swizzyer-солвера).
  - "invalid creds" -> неверный логин/пароль.
"""
import json
import os
import re
import sys
import http.cookiejar
import urllib.request
import urllib.parse
from urllib.error import HTTPError, URLError

# Well-known публичный клиент Xbox Live (его же используют Minecraft-логин-библиотеки).
# Легаси oauth20_authorize + scope ...MBI_SSL отдаёт токен, годный как RpsTicket в user.auth.
OAUTH_CLIENT = "000000004C12AE6F"
OAUTH_SCOPE = "service::user.auth.xboxlive.com::MBI_SSL"
REDIRECT = "https://login.live.com/oauth20_desktop.srf"
AUTHORIZE = ("https://login.live.com/oauth20_authorize.srf?client_id=%s"
             "&redirect_uri=%s&response_type=token&scope=%s&display=touch&locale=en") % (
    OAUTH_CLIENT, urllib.parse.quote(REDIRECT, safe=""), urllib.parse.quote(OAUTH_SCOPE, safe=""))

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")

USER_AUTH = "https://user.auth.xboxlive.com/user/authenticate"
XSTS_AUTH = "https://xsts.auth.xboxlive.com/xsts/authorize"
XSTS_RP = "http://mp.microsoft.com/"

CREATEORDER_URL = (
    "https://gold.xboxservices.com/PurchaseExperienceFD/createOrder/9NH6SMMZQHM9"
    "?market=US&language=en&deviceFamily=Windows.Desktop&appVersion=2604.8.1.0")
CREATEORDER_BODY = {"invokedApi": "RequestPurchase",
                    "parentProductId": "9PMF91N3LZ3M", "timezoneOffset": 0}


def _new_cv():
    import base64
    return base64.b64encode(os.urandom(12)).decode("ascii") + ".0"


# ---- redirect-перехватчик: ловим Location с access_token во фрагменте ----
class _Catch(urllib.request.HTTPRedirectHandler):
    captured = []
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        _Catch.captured.append(newurl)
        if "access_token=" in newurl:
            return None  # стоп — токен у нас
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def oauth_login(user, password):
    """login.live.com форм-флоу: email+password -> access token (RPS). Вернёт (token, diag)."""
    _Catch.captured = []
    cj = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(_Catch, urllib.request.HTTPCookieProcessor(cj))
    opener.addheaders = [("User-Agent", UA), ("Accept", "text/html,application/xhtml+xml")]

    # 1) GET страницы логина -> вытащить PPFT и urlPost
    try:
        resp = opener.open(AUTHORIZE, timeout=30)
        status = getattr(resp, "status", "?")
        final_url = resp.geturl()
        html = resp.read().decode("utf-8", "replace")
    except (HTTPError, URLError) as e:
        return None, "GET authorize упал: %s" % e
    # современный login.live.com: ServerData-блоб. PPFT — в ЭКРАНИРОВАННОМ sFTTag
    #   "sFTTag":"<input ... name=\"PPFT\" ... value=\"<PPFT>\">", urlPost — обычный JSON.
    m_ppft = (re.search(r'name=\\"PPFT\\".*?value=\\"([^"\\]+)', html)
              or re.search(r'name="PPFT"[^>]*value="([^"]+)"', html)
              or re.search(r'"sFT"\s*:\s*"([^"]+)"', html))
    m_post = (re.search(r'"urlPost"\s*:\s*"([^"]+)"', html)
              or re.search(r"urlPost:'([^']+)'", html))
    if not m_ppft or not m_post:
        low = html.lower()
        markers = []
        for kw in ("ppft", "urlpost", "arkose", "funcaptcha", "captcha", "sign in", "sign-in",
                   "account.live.com", "blocked", "unusual", "verify", "robot", "access denied",
                   "<title"):
            if kw in low:
                markers.append(kw)
        title = re.search(r"<title[^>]*>(.*?)</title>", html, re.I | re.S)
        ctx = []
        for kw in ("urlPost", "PPFT", "sFT", "sFTTag", "fmHF"):
            i = html.find(kw)
            if i >= 0:
                ctx.append("[%s]…%s…" % (kw, html[max(0, i - 10):i + 90].replace("\n", " ")))
        diag = ("не нашёл PPFT/urlPost. status=%s len=%d title=%r markers=%s\n      КОНТЕКСТ:\n      %s"
                % (status, len(html),
                   (title.group(1).strip()[:60] if title else None),
                   ",".join(markers) or "(нет)",
                   "\n      ".join(ctx) or "(маркеры не найдены в тексте)"))
        return None, diag
    ppft = m_ppft.group(1)
    url_post = m_post.group(1).replace("\\/", "/")

    # 2) POST логин/пароль
    data = urllib.parse.urlencode({"login": user, "loginfmt": user,
                                   "passwd": password, "PPFT": ppft}).encode()
    req = urllib.request.Request(url_post, data=data, headers={
        "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "text/html,application/xhtml+xml"})
    try:
        resp = opener.open(req, timeout=30)
        final_url = resp.geturl()
        body = resp.read().decode("utf-8", "replace")
    except (HTTPError, URLError) as e:
        final_url = ""; body = str(e)

    # 3) ищем access_token во всех перехваченных redirect-URL и финальном URL
    for u in _Catch.captured + [final_url]:
        if u and "access_token=" in u:
            frag = u.split("#", 1)[-1]
            qs = urllib.parse.parse_qs(frag)
            tok = (qs.get("access_token") or [None])[0]
            if tok:
                return urllib.parse.unquote(tok), "OK"

    # диагностика причины
    low = body.lower()
    if "arkose" in low or "captcha" in low or "challenge" in low:
        return None, "MS требует КАПЧУ/челлендж (anti-bot). Для своих MSA выключи 2FA или решай челлендж."
    if "proof" in low or "two-step" in low or "verify your identity" in low or "/recover" in low:
        return None, "MS требует 2FA/подтверждение личности. Отключи 2FA на этом funded-MSA."
    if "incorrect" in low or "account or password" in low or "1041" in body:
        return None, "неверный email/пароль."
    return None, "токен не пришёл (логин не завершился). Хвост ответа: " + body[:200].replace("\n", " ")


# ---- нижняя половина (уже доказана в mint_wam): user.auth -> XSTS -> createOrder ----
def _post_json(url, obj, headers=None):
    h = {"Content-Type": "application/json", "Accept": "application/json", "x-xbl-contract-version": "1"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=json.dumps(obj).encode(), headers=h, method="POST")
    try:
        r = urllib.request.urlopen(req, timeout=30)
        return r.status, r.read().decode("utf-8", "replace")
    except HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except URLError as e:
        return 0, str(e)


def xbox_chain(token):
    """token -> user.auth (пробуем префиксы) -> XSTS RP=mp.microsoft.com -> XBL3.0 + canary."""
    user_token = uhs = None
    for label, rps in (("d=", "d=" + token), ("raw", token), ("t=", "t=" + token)):
        st, body = _post_json(USER_AUTH, {
            "RelyingParty": "http://auth.xboxlive.com", "TokenType": "JWT",
            "Properties": {"AuthMethod": "RPS", "SiteName": "user.auth.xboxlive.com", "RpsTicket": rps}})
        print("    user.auth (RpsTicket=%s): %s %s" % (label, st, "" if st == 200 else body[:90]))
        if st == 200:
            d = json.loads(body)
            user_token = d["Token"]; uhs = d["DisplayClaims"]["xui"][0]["uhs"]
            break
    if not user_token:
        return None, "user.auth не принял токен ни в одном формате"

    st, body = _post_json(XSTS_AUTH, {
        "RelyingParty": XSTS_RP, "TokenType": "JWT",
        "Properties": {"SandboxId": "RETAIL", "UserTokens": [user_token]}})
    if st != 200:
        return None, "XSTS authorize отказал: %s %s" % (st, body[:120])
    d = json.loads(body)
    xsts = d["Token"]; xuhs = d["DisplayClaims"]["xui"][0]["uhs"]
    header = "XBL3.0 x=%s;%s" % (xuhs or uhs, xsts)

    # КАНАРЕЙКА createOrder — реальный сигнал коммерции (НЕ списывает деньги)
    st, body = _post_json(CREATEORDER_URL, CREATEORDER_BODY, {
        "Authorization": header, "x-ms-api-version": "2.0", "MS-CV": _new_cv(),
        "User-Agent": "mint-pay/1"})
    accepted = st not in (401, 403)
    print("    createOrder: %s %s" % (st, "ПРИНЯТ" if accepted else "ОТВЕРГНУТ"))
    if st == 200:
        return header, "createOrder=200 — XSTS принят коммерцией"
    if accepted:
        return header, "createOrder=%d (не 401/403) — токен принят, тело/контекст неполны" % st
    return None, "createOrder отверг токен (%d): %s" % (st, body[:120])


def _load_creds():
    if len(sys.argv) > 1 and os.path.isfile(sys.argv[1]):
        lines = [l.strip() for l in open(sys.argv[1], encoding="utf-8") if l.strip()]
        if len(lines) >= 2:
            return lines[0], lines[1]
    u, p = os.environ.get("MSA_USER"), os.environ.get("MSA_PASS")
    if u and p:
        return u, p
    print("Дай креды: MSA_USER/MSA_PASS в env, либо creds.txt (email на 1-й строке, пароль на 2-й).")
    sys.exit(2)


def main():
    user, password = _load_creds()
    print("=" * 68)
    print("[*] Headless-минт XSTS из пароля для:", user)
    print("=" * 68)
    print("[1] login.live.com (форма OAuth)...")
    token, diag = oauth_login(user, password)
    if not token:
        print("    [FAIL]", diag)
        print("\n[ИТОГ] Headless-логин НЕ прошёл — см. причину выше.")
        print("       Это и есть барьер масштаба; дальше — снимать 2FA на MSA или решать челлендж.")
        sys.exit(1)
    print("    [OK] токен получен (len=%d, prefix=%r)" % (len(token), token[:6]))
    print("[2] user.auth -> XSTS -> createOrder canary...")
    header, diag = xbox_chain(token)
    print("\n" + "=" * 68)
    if header and "200" in diag:
        print("[ИТОГ] УСПЕХ:", diag)
        print("       => headless-минт платёжного XSTS из email+password РАБОТАЕТ.")
        print("       => payer-сторона масштабируема без Windows-машины на аккаунт.")
    elif header:
        print("[ИТОГ] ЧАСТИЧНО:", diag)
    else:
        print("[ИТОГ] НЕ вышло на этапе цепочки:", diag)
    print("=" * 68)


if __name__ == "__main__":
    main()
