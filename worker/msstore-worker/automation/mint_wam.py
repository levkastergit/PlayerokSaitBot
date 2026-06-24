#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
mint_wam.py — Шаг 2: минт MSA-токенов через ШТАТНЫЙ Windows-брокер WAM
(WebAuthenticationCoreManager), а НЕ через device-code (mint_xsts.py — тупик)
и НЕ через вычитку credential-кэша. Это тот же API, которым сам Microsoft Store
получает свои токены: запрашиваем токены для СВОЕГО funded MSA-аккаунта,
залогиненного в Windows.

ЧТО ДОБЫВАЕМ (по дампу [[msstore-robux-purchase-mechanism]]):
  - RPS/compact-тикет "t=Ew..." для collections  → заголовок WLID1.0=t=...
    (нужен beneficiaries/me/keys, где задаётся publisherUserId-получатель)
  - RPS для user.auth.xboxlive.com → наша цепочка user.auth→xsts → "XBL3.0 x=uhs;XSTS"
    (нужен createOrder/buynow/updateCart/Cart purchase/PaymentSessionDescriptions)
  - serviceTicket  — аудитория пока [ПРОВЕРИТЬ], кандидаты ниже

ЗАВИСИМОСТЬ: pip install winsdk  (WinRT-проекция; ставится из pypi).

РЕЖИМЫ:
  python mint_wam.py             # ПРОБА: enum аккаунтов + статусы по таргетам,
                                 #        печатает только ПРЕФИКСЫ токенов (безопасно)
  python mint_wam.py --enum      # только перечислить MSA-аккаунты в Windows
  python mint_wam.py --emit FILE # записать рабочие заголовки (WLID/XBL3.0) в FILE
                                 #        (НЕ выкладывать — это твои токены)

ИНТЕРПРЕТАЦИЯ:
  - "no MSA account in Windows" → сперва залогинь funded MSA в Windows
        (Параметры → Учётные записи → Электр. почта и учётные записи → Добавить).
        WAM-минт без аккаунта в системе невозможен (это и проверяем на dev-VM).
  - status SUCCESS + token начинается с "t=Ew"/"Ew" → compact-тикет получен,
        блокер минта снят на этой машине.
  - status USER_INTERACTION_REQUIRED → аккаунт есть, но нет тихого согласия для
        этого client_id; нужен разовый интерактивный RequestTokenAsync (с окном).
  - status ACCOUNT_PROVIDER_NOT_AVAILABLE / PROVIDER_ERROR → провайдер MSA не
        поднялся (служба TokenBroker / сетевой гейт).
"""
import argparse
import asyncio
import json
import sys
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

try:
    from winsdk.windows.security.authentication.web.core import (
        WebAuthenticationCoreManager as WACM,
        WebTokenRequest,
    )
    from winsdk.windows.security.credentials import WebAccountProvider  # noqa: F401
except Exception as e:  # noqa: BLE001
    sys.stderr.write(
        "[!] нет winsdk (%s). Установи:  python -m pip install winsdk\n" % e)
    raise SystemExit(2)

# MSA-провайдеры WAM: legacy (live.com) обычно отдаёт RPS/compact "t=Ew...";
# modern (login.microsoft.com/consumers) — OAuth v2 JWT. Пробуем оба.
MSA_PROVIDERS = [
    ("https://login.live.com", None),
    ("https://login.microsoft.com", "consumers"),
]

# Клиенты из живого дампа: Store WS-Trust clientid + well-known Xbox client.
CLIENT_STORE = "000000004824A775"   # MS Store (clientid из RST2.srf, MBI_SSL)
CLIENT_XBOX = "0000000048093EE3"    # well-known Xbox public client

# (label, client_id, scope, назначение)
TARGETS = [
    ("collections-RPS", CLIENT_STORE,
     "service::collections.mp.microsoft.com::MBI_SSL",
     "WLID1.0=t= для beneficiaries/me/keys"),
    ("xboxlive-RPS", CLIENT_XBOX,
     "service::user.auth.xboxlive.com::MBI_SSL",
     "вход в цепочку user.auth->xsts -> XBL3.0"),
    ("www-store-RPS", CLIENT_STORE,
     "service::www.microsoft.com::MBI_SSL",
     "веб-сессия buynow (RST2 RP=www.microsoft.com)"),
    ("license-RPS", CLIENT_STORE,
     "service::licensing.mp.microsoft.com::MBI_SSL",
     "кандидат на serviceTicket [ПРОВЕРИТЬ]"),
    ("purchase-RPS", CLIENT_STORE,
     "service::purchase.mp.microsoft.com::MBI_SSL",
     "кандидат на serviceTicket [ПРОВЕРИТЬ]"),
]

# Цепочка Xbox (как в mint_xsts.py)
USER_AUTH = "https://user.auth.xboxlive.com/user/authenticate"
XSTS_AUTH = "https://xsts.auth.xboxlive.com/xsts/authorize"
# Подтверждено вживую 2026-06-23: коммерческая XSTS-аудитория = http://mp.microsoft.com/
# (createOrder проходит аутентификацию; xboxlive.com/licensing -> 401). Свип сужен.
RP_CANDIDATES = [
    "http://mp.microsoft.com/",
]


def _new_cv():
    """Свежий Microsoft Correlation Vector (base v1: 16 base64-симв + '.0')."""
    import base64
    import os as _os
    return base64.b64encode(_os.urandom(12)).decode("ascii") + ".0"
# Канареечный пробник коммерции: createOrder (шаг 2 дампа). ДЕНЕГ НЕ СПИСЫВАЕТ —
# создаёт заказ в состоянии Editing и возвращает storeId. 200 = XSTS принят коммерцией.
CREATEORDER_URL = (
    "https://gold.xboxservices.com/PurchaseExperienceFD/createOrder/9NH6SMMZQHM9"
    "?market=US&language=en&deviceFamily=Windows.Desktop&appVersion=2604.8.1.0")
CREATEORDER_BODY = {"invokedApi": "RequestPurchase",
                    "parentProductId": "9PMF91N3LZ3M", "timezoneOffset": 0}


def tok_preview(t):
    if not t:
        return "(пусто)"
    return "len=%d  %r...%s" % (len(t), t[:14], t[-4:])


async def get_msa_provider():
    """Вернуть (provider, label) первого доступного MSA-провайдера WAM."""
    last = None
    for pid, authority in MSA_PROVIDERS:
        try:
            if authority:
                p = await WACM.find_account_provider_async(pid, authority)
            else:
                p = await WACM.find_account_provider_async(pid)
        except Exception as e:  # noqa: BLE001
            last = "%s: %s" % (pid, e)
            p = None
        if p is not None:
            return p, "%s%s" % (pid, ("/" + authority if authority else ""))
    sys.stderr.write("[!] MSA-провайдер WAM не найден (%s)\n" % last)
    return None, None


async def enum_accounts():
    p, label = await get_msa_provider()
    if not p:
        print("MSA WAM provider: НЕ ДОСТУПЕН")
        return []
    print("MSA WAM provider: %s  (display=%s)" % (label, getattr(p, "display_name", "?")))
    try:
        res = await WACM.find_all_accounts_async(p)
        status = getattr(res.status, "name", str(res.status))
        accs = list(res.accounts) if res.accounts else []
        print("find_all_accounts: status=%s, accounts=%d" % (status, len(accs)))
        for a in accs:
            print("   - user=%r  id=%s  state=%s" % (
                getattr(a, "user_name", "?"), getattr(a, "id", "?"),
                getattr(getattr(a, "state", None), "name", "?")))
        return accs
    except Exception as e:  # noqa: BLE001
        print("find_all_accounts: ОШИБКА %s" % e)
        return []


async def request_token(client_id, scope):
    """get_token_silently_async для (client_id, scope). Вернуть (status, token, err)."""
    p, _ = await get_msa_provider()
    if not p:
        return "NO_PROVIDER", None, None
    req = WebTokenRequest(p, scope, client_id)
    try:
        res = await WACM.get_token_silently_async(req)
    except Exception as e:  # noqa: BLE001
        return "EXC", None, str(e)
    status = getattr(res.response_status, "name", str(res.response_status))
    if res.response_data and len(res.response_data) > 0:
        resp0 = res.response_data[0]
        tok = resp0.token
        if tok:
            return status, tok, None
        pe = getattr(resp0, "provider_error", None)
        if pe:
            return status, None, "code=0x%X msg=%s" % (pe.error_code, pe.error_message)
        return status, None, None
    err = None
    if getattr(res, "response_error", None):
        err = "code=0x%X msg=%s" % (
            res.response_error.error_code, res.response_error.error_message)
    return status, None, err


# ----- цепочка Xbox -> XSTS -> read-only validate -----

def _post_json(url, obj):
    h = {"Content-Type": "application/json", "Accept": "application/json",
         "x-xbl-contract-version": "1"}
    req = Request(url, data=json.dumps(obj).encode(), headers=h, method="POST")
    try:
        r = urlopen(req, timeout=30)
        return r.status, r.read().decode("utf-8", "replace")
    except HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except URLError as e:
        return 0, str(e)


def xbox_chain(rps_ticket):
    """RPS-тикет (из WAM) -> user.auth -> xsts (перебор RP) -> XBL3.0 + validate."""
    user_token = uhs = None
    for label, rps in (("t=", "t=" + rps_ticket.lstrip("t=")),
                       ("raw", rps_ticket), ("d=", "d=" + rps_ticket)):
        st, body = _post_json(USER_AUTH, {
            "RelyingParty": "http://auth.xboxlive.com", "TokenType": "JWT",
            "Properties": {"AuthMethod": "RPS",
                           "SiteName": "user.auth.xboxlive.com", "RpsTicket": rps}})
        if st == 200:
            d = json.loads(body)
            user_token = d["Token"]
            uhs = d["DisplayClaims"]["xui"][0]["uhs"]
            print("    user.auth: OK (RpsTicket=%s)" % label)
            break
        print("    user.auth: %s (RpsTicket=%s) %s" % (st, label, body[:120]))
    if not user_token:
        return None
    for rp in RP_CANDIDATES:
        st, body = _post_json(XSTS_AUTH, {
            "RelyingParty": rp, "TokenType": "JWT",
            "Properties": {"SandboxId": "RETAIL", "UserTokens": [user_token]}})
        if st != 200:
            print("    xsts RP %-32s ОТКАЗ %s %s" % (rp, st, body[:80]))
            continue
        d = json.loads(body)
        xsts = d["Token"]
        xuhs = d["DisplayClaims"]["xui"][0]["uhs"]
        header = "XBL3.0 x=%s;%s" % (xuhs or uhs, xsts)
        # канарейка createOrder (POST, без списания) — реальный сигнал коммерции
        vr = Request(CREATEORDER_URL, data=json.dumps(CREATEORDER_BODY).encode(),
                     headers={"Authorization": header, "x-ms-api-version": "2.0",
                              "Content-Type": "application/json", "MS-CV": _new_cv(),
                              "Accept": "application/json", "User-Agent": "mint-wam/1"},
                     method="POST")
        try:
            r = urlopen(vr, timeout=30)
            vst, vbody = r.status, r.read().decode("utf-8", "replace")
        except HTTPError as e:
            vst, vbody = e.code, e.read().decode("utf-8", "replace")
        accepted = vst not in (401, 403)  # 401/403 = токен отвергнут; иначе принят
        tag = ("ПРИНЯТ (createOrder=%d)" % vst) if accepted else ("ОТВЕРГНУТ %d" % vst)
        print("    xsts RP %-28s XSTS ok, %s  %s" % (rp, tag, vbody[:100]))
        if vst == 200:
            return rp, header
        if accepted:
            # 4xx-не-401/403 = RP принят, но запрос/контекст неполон — запомним и продолжим
            globals().setdefault("_accepted_rps", []).append((rp, vst, header))
    acc = globals().get("_accepted_rps") or []
    if acc:
        rp, vst, header = acc[0]
        print("    => лучший RP=%s (createOrder=%d, не 401/403) — токен принят коммерцией" % (rp, vst))
        return rp, header
    return None


# Поиск scope для serviceTicket (тело beneficiaries/keys) по фингерпринту длины 1662.
# collections/www/license/purchase::MBI_SSL дают 1361 (общий store-тикет) — ищем 1662.
HUNT = [
    (CLIENT_STORE, "service::collections.mp.microsoft.com::DELEGATION"),
    (CLIENT_STORE, "service::collections.mp.microsoft.com::MBI"),
    (CLIENT_STORE, "service::purchase.mp.microsoft.com::DELEGATION"),
    (CLIENT_STORE, "service::dpurchase.mp.microsoft.com::MBI_SSL"),
    (CLIENT_STORE, "service::cart.mp.microsoft.com::MBI_SSL"),
    (CLIENT_STORE, "service::pay.microsoft.com::MBI_SSL"),
    (CLIENT_STORE, "service::paymentinstruments.mp.microsoft.com::MBI_SSL"),
    (CLIENT_STORE, "service::storeedgefd.dsx.mp.microsoft.com::MBI_SSL"),
    (CLIENT_STORE, "service::licensing.mp.microsoft.com::DELEGATION"),
    (CLIENT_STORE, "service::displaycatalog.mp.microsoft.com::MBI_SSL"),
    (CLIENT_XBOX, "service::collections.mp.microsoft.com::MBI_SSL"),
    (CLIENT_STORE, "service::www.microsoft.com::DELEGATION"),
]


async def hunt_service_ticket():
    print("[*] Поиск serviceTicket (цель длины ~1662; collections MBI_SSL=1361):\n")
    for client, scope in HUNT:
        status, tok, err = await request_token(client, scope)
        ln = len(tok) if tok else 0
        flag = "  <<< КАНДИДАТ 1662" if 1600 <= ln <= 1720 else ""
        print("  [%-7s] len=%-5d %s%s" % (status, ln, scope, flag))


# DELEGATION-кандидаты на serviceTicket (тихо дают USER_INTERACTION_REQUIRED →
# нужен разовый интерактивный грант). beneficiaries/keys живёт на collections.
GRANT_SCOPES = [
    "service::collections.mp.microsoft.com::DELEGATION",
    "service::purchase.mp.microsoft.com::DELEGATION",
]


def _console_hwnd():
    """HWND консоли — для привязки интерактивного WAM-диалога из desktop-процесса."""
    try:
        import ctypes
        h = ctypes.windll.kernel32.GetConsoleWindow()
        if not h:
            h = ctypes.windll.user32.GetForegroundWindow()
        return int(h) if h else 0
    except Exception:  # noqa: BLE001
        return 0


async def _request_interactive(provider, scope, client):
    """Интерактивный RequestTokenAsync (штатный путь winsdk). Если упадёт с
    требованием HWND — сообщим: тогда нужен COM-interop RequestTokenForWindowAsync."""
    req = WebTokenRequest(provider, scope, client)
    try:
        res = await WACM.request_token_async(req)
        return res, "request_token_async"
    except Exception as e:  # noqa: BLE001
        return None, "ОШИБКА request_token_async (вероятно нужен HWND-interop): %r" % e


async def grant_service_ticket():
    p, _ = await get_msa_provider()
    if not p:
        print("[!] MSA-провайдер недоступен."); return
    print("[*] Интерактивный грант serviceTicket (появится окно согласия — подтверди).")
    print("    HWND консоли:", _console_hwnd(), "\n")
    for scope in GRANT_SCOPES:
        res, how = await _request_interactive(p, scope, CLIENT_STORE)
        if res is None:
            print("  %-52s -> %s" % (scope, how)); continue
        status = getattr(res.response_status, "name", str(res.response_status))
        tok = res.response_data[0].token if res.response_data and len(res.response_data) else None
        ln = len(tok) if tok else 0
        flag = "  <<< 1662 = serviceTicket!" if 1600 <= ln <= 1720 else ""
        print("  [%-22s] len=%-5d via %s  %s%s" % (status, ln, how, scope, flag))
        if tok:
            print("     префикс:", repr(tok[:16]))


async def amain():
    ap = argparse.ArgumentParser(description="WAM-минт MSA-токенов (проба).")
    ap.add_argument("--enum", action="store_true", help="только перечислить MSA-аккаунты")
    ap.add_argument("--hunt", action="store_true", help="искать scope для serviceTicket (длина 1662)")
    ap.add_argument("--grant", action="store_true", help="интерактивный грант serviceTicket (DELEGATION)")
    ap.add_argument("--emit", metavar="FILE", help="записать рабочие заголовки в FILE")
    args = ap.parse_args()
    if args.hunt:
        await hunt_service_ticket()
        return
    if args.grant:
        await grant_service_ticket()
        return

    print("=" * 68)
    accs = await enum_accounts()
    print("=" * 68)
    if args.enum:
        return
    if not accs:
        print("[!] enum пуст / PROVIDER_ERROR — это НЕ доказывает отсутствие MSA:")
        print("    FindAllAccounts из непакетированного процесса часто ошибается")
        print("    даже при залогиненном аккаунте. Авторитетный сигнал — статус минта ниже.")
        print("    (Глянь визуально: Параметры → Учётные записи → Электр. почта и уч. записи.)\n")

    print("[*] Пробую тихий минт токенов (статус + только префиксы):\n")
    emit = {}
    xbox_rps = None
    seen_status = set()
    for label, client, scope, purpose in TARGETS:
        status, tok, err = await request_token(client, scope)
        seen_status.add(status)
        line = "  %-16s [%s]" % (label, status)
        if tok:
            line += "  " + tok_preview(tok)
            emit[label] = (scope, tok)
            if label == "xboxlive-RPS":
                xbox_rps = tok
        elif err:
            line += "  ERR " + err
        line += "   — " + purpose
        print(line)

    print("\n[ЛЕГЕНДА статусов]")
    if "SUCCESS" in seen_status:
        print("  SUCCESS → тикет получен; блокер минта снят на этой машине.")
    if "USER_INTERACTION_REQUIRED" in seen_status:
        print("  USER_INTERACTION_REQUIRED → аккаунт ЕСТЬ, но нет тихого согласия для")
        print("    этого client_id. Нужен РАЗОВЫЙ интерактивный грант (окно входа).")
    if "ACCOUNT_PROVIDER_NOT_AVAILABLE" in seen_status or "NO_PROVIDER" in seen_status:
        print("  ACCOUNT_PROVIDER_NOT_AVAILABLE → MSA не залогинен / провайдер не поднялся.")
    if "PROVIDER_ERROR" in seen_status or "EXC" in seen_status:
        print("  PROVIDER_ERROR/EXC → провайдер отверг запрос. Возможные причины: нет")
        print("    package identity у нашего процесса, либо чужой client_id не выдаётся силой.")

    if xbox_rps:
        print("\n[*] xboxlive RPS получен → гоню цепочку user.auth->xsts (read-only validate):")
        res = xbox_chain(xbox_rps)
        if res:
            rp, header = res
            print("    => XSTS принят коммерцией, RP=%s" % rp)
            emit["XBL3.0-header"] = (rp, header)

    print("\n" + "=" * 68)
    if emit:
        print("[ИТОГ] Получены тикеты:", ", ".join(emit.keys()))
        if args.emit:
            with open(args.emit, "w", encoding="utf-8") as f:
                for k, (scope, val) in emit.items():
                    f.write("%s\t%s\t%s\n" % (k, scope, val))
            print("[ИТОГ] Заголовки записаны в %s (НЕ выкладывай — это токены)." % args.emit)
        else:
            print("[ИТОГ] Полные токены НЕ печатаю. Для записи в файл:  --emit tokens.tsv")
    else:
        print("[ИТОГ] Ни один таргет не дал токен — см. статусы выше.")
    print("=" * 68)


if __name__ == "__main__":
    asyncio.run(amain())
