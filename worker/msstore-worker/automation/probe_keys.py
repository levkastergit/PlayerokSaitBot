#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
probe_keys.py — закрыть открытый вопрос: НУЖЕН ли DELEGATION-serviceTicket (длины
~1662, который WAM нам не отдаёт — wamgrant вернул 0x80860003 ONL_E_INVALID_APPLICATION)
для POST collections.mp.microsoft.com/v7.0/beneficiaries/me/keys, или эндпойнт
примет уже имеющиеся токены.

КОНТЕКСТ (см. [[msstore-robux-purchase-mechanism]], [[wam-token-mint-works]]):
  - keys задаёт получателя Robux: body {serviceTicket, publisherUserId:"<robloxUserId>"} -> {key}
  - auth-заголовок в дампе: WLID1.0=t=Ew...
  - serviceTicket в ТЕЛЕ — отдельный MSA-тикет плательщика (RST2.srf). Его силовой
    грант из нашего exe заблокирован (0x80860003). Вопрос: обязателен ли он.

ЧТО ДЕЛАЕТ:
  1) минтит через WAM (mint_wam.request_token) доступные тикеты:
       - collections RPS (CLIENT_STORE, ...collections...::MBI_SSL)  -> WLID1.0=t=
       - xbox RPS -> xbox_chain -> XBL3.0 x=uhs;XSTS  (коммерческая плоскость)
  2) гоняет МАТРИЦУ по реальному keys-эндпойнту:
       {auth-заголовок} × {значение serviceTicket в теле}
     и печатает HTTP-статус + первые ~300 симв. ответа. Сервер сам скажет:
       - 200 + {"key":...}  -> serviceTicket НЕ нужен (или принят имеющийся) => блокер снят
       - 4xx "serviceTicket required/invalid" -> serviceTicket-1662 реально обязателен

БЕЗОПАСНОСТЬ: keys НЕ списывает деньги и НЕ выдаёт Robux — лишь регистрирует
ключ-получателя. Полные токены не печатаются. Запуск из каталога automation/:
    python probe_keys.py [robloxUserId]
По умолчанию publisherUserId = 5304760791 (levkaster, из дампа).
"""
import asyncio
import json
import os
import sys
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

# переиспользуем уже рабочий WAM-минт
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from mint_wam import request_token, xbox_chain, CLIENT_STORE, CLIENT_XBOX  # noqa: E402

KEYS_URL = "https://collections.mp.microsoft.com/v7.0/beneficiaries/me/keys"
COLLECTIONS_SCOPE = "service::collections.mp.microsoft.com::MBI_SSL"
XBOX_SCOPE = "service::user.auth.xboxlive.com::MBI_SSL"

DEFAULT_USERID = "5304760791"  # levkaster (из дампа)


def _new_cv():
    import base64
    return base64.b64encode(os.urandom(12)).decode("ascii") + ".0"


def _norm_t(tok):
    """Нормализовать compact-тикет к виду без префикса (t=/d=)."""
    if not tok:
        return None
    t = tok
    for p in ("WLID1.0=", "t=", "d="):
        if t.startswith(p):
            t = t[len(p):]
    return t


def post_keys(auth_header, service_ticket, publisher_user_id):
    """Один вызов keys. service_ticket=None => поле опускаем. Вернуть (status, body)."""
    body = {"publisherUserId": str(publisher_user_id)}
    if service_ticket is not None:
        body["serviceTicket"] = service_ticket
    headers = {
        "Authorization": auth_header,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "MS-CV": _new_cv(),
        "User-Agent": "probe-keys/1",
    }
    req = Request(KEYS_URL, data=json.dumps(body).encode(), headers=headers, method="POST")
    try:
        r = urlopen(req, timeout=30)
        return r.status, r.read().decode("utf-8", "replace")
    except HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except URLError as e:
        return 0, str(e)


async def amain():
    uid = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_USERID
    print("=" * 72)
    print("[*] probe_keys: publisherUserId = %s" % uid)
    print("    эндпойнт: POST %s" % KEYS_URL)
    print("=" * 72)

    # --- 1. минтим доступные токены ---
    print("\n[1] Минт токенов через WAM:")
    st, wlid_tok, err = await request_token(CLIENT_STORE, COLLECTIONS_SCOPE)
    print("    collections RPS  [%s] %s%s" % (
        st, ("len=%d" % len(wlid_tok)) if wlid_tok else "(нет)",
        ("  ERR " + err) if err else ""))

    st, xbox_rps, err = await request_token(CLIENT_XBOX, XBOX_SCOPE)
    print("    xbox RPS         [%s] %s%s" % (
        st, ("len=%d" % len(xbox_rps)) if xbox_rps else "(нет)",
        ("  ERR " + err) if err else ""))

    xbl_header = None
    if xbox_rps:
        print("    -> цепочка user.auth->xsts:")
        res = xbox_chain(xbox_rps)
        if res:
            _, xbl_header = res

    # --- 2. собираем варианты auth-заголовка и serviceTicket ---
    wlid_compact = _norm_t(wlid_tok)
    auth_variants = []
    if wlid_compact:
        auth_variants.append(("WLID1.0=t=", "WLID1.0=t=" + wlid_compact))
        auth_variants.append(("bare t=", "t=" + wlid_compact))
    if xbl_header:
        auth_variants.append(("XBL3.0", xbl_header))

    if not auth_variants:
        print("\n[!] Ни один auth-заголовок не сминтился — нечего слать. Сначала залогинь")
        print("    funded MSA в Windows и проверь mint_wam.py.")
        return

    # значения для тела serviceTicket: опустить / пусто / сам collections-тикет
    st_variants = [("без поля", None), ("пусто", "")]
    if wlid_compact:
        st_variants.append(("=collections-тикет", wlid_compact))

    # --- 3. матрица ---
    print("\n[2] Матрица keys (auth × serviceTicket):")
    print("    %-12s %-20s %-5s  ответ" % ("auth", "serviceTicket", "HTTP"))
    print("    " + "-" * 64)
    success = []
    for aname, aval in auth_variants:
        for sname, sval in st_variants:
            code, body = post_keys(aval, sval, uid)
            snippet = body.replace("\n", " ")[:300]
            print("    %-12s %-20s %-5s  %s" % (aname, sname, code, snippet))
            if code == 200 and ("key" in body):
                success.append((aname, sname))

    # --- 4. широкий свип serviceTicket: длина 1662 была лишь догадкой, судья — keys.
    #        Фиксируем рабочий auth (WLID1.0=t=collections), перебираем КАЖДЫЙ тихо
    #        минтящийся тикет как serviceTicket × форматы префикса.
    if wlid_compact:
        auth_fixed = "WLID1.0=t=" + wlid_compact
        print("\n[3] Свип serviceTicket (auth=WLID1.0=t=collections фиксирован):")
        svc_scopes = [
            (CLIENT_STORE, "service::collections.mp.microsoft.com::MBI_SSL"),
            (CLIENT_STORE, "service::storeedgefd.dsx.mp.microsoft.com::MBI_SSL"),
            (CLIENT_STORE, "service::displaycatalog.mp.microsoft.com::MBI_SSL"),
            (CLIENT_STORE, "service::purchase.mp.microsoft.com::MBI_SSL"),
            (CLIENT_STORE, "service::licensing.mp.microsoft.com::MBI_SSL"),
            (CLIENT_STORE, "service::dpurchase.mp.microsoft.com::MBI_SSL"),
        ]
        print("    %-26s %-5s %-9s %-5s  ответ" % ("svc-scope", "len", "формат", "HTTP"))
        print("    " + "-" * 70)
        for client, scope in svc_scopes:
            st, tok, _ = await request_token(client, scope)
            if not tok:
                print("    %-26s [%s]" % (scope.split("::")[1], st))
                continue
            host = scope.split("::")[1]
            raw = _norm_t(tok)
            for fmt_name, sval in (("raw", raw), ("t=", "t=" + raw),
                                   ("WLID1.0=t=", "WLID1.0=t=" + raw)):
                code, body = post_keys(auth_fixed, sval, uid)
                snippet = body.replace("\n", " ")[:120]
                print("    %-26s %-5d %-9s %-5s  %s" % (host, len(tok), fmt_name, code, snippet))
                if code == 200 and ("key" in body):
                    success.append(("WLID1.0=t=", "svc=%s/%s" % (host, fmt_name)))

    print("\n" + "=" * 72)
    if success:
        print("[ИТОГ] keys ОТДАЛ key без DELEGATION-serviceTicket-1662:")
        for a, s in success:
            print("       auth=%s  serviceTicket=%s" % (a, s))
        print("       => блокер wamgrant/0x80860003 ОБХОДИТСЯ. Трек DELEGATION можно закрыть.")
    else:
        print("[ИТОГ] Ни одна комбинация не дала key. Смотри тексты ошибок выше:")
        print("       - 'serviceTicket' required/invalid -> тикет-1662 реально обязателен")
        print("         (остаётся только дамп из живого трафика Store).")
        print("       - 401/403 на auth -> не тот заголовок/плоскость для collections.")
    print("=" * 72)


if __name__ == "__main__":
    asyncio.run(amain())
