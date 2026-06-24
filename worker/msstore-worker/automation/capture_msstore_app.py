#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
capture_msstore_app.py — mitmproxy-аддон: снимает HTTPS-трафик ПРИЛОЖЕНИЯ Roblox
из Microsoft Store во время покупки Robux (Путь B / WLID / MS-billing).

Запускать НЕ напрямую, а через run_msstore_capture.ps1 (от админа): он поднимает
mitmproxy, доверяет CA, делает loopback-exempt приложению и ставит системный прокси.
Этот аддон фильтрует/маскирует трафик и сам отправляет отчёт на сервер.

БЕЗОПАСНОСТЬ: это СЕТЕВОЙ перехват (proxy + доверенный CA). Он НЕ трогает процесс
RobloxPlayerBeta и не инжектит в него — Hyperion защищает память процесса, а не сеть.
ВАЖНО: часть хостов Microsoft Store может пиннить сертификат → шаг оплаты может дать
белый экран. Это само по себе ответ (нога оплаты не перехватывается). Всё до этого
момента (Roblox-вызовы, токен-чейн login.live/xboxlive) останется снято.

Полный дамп (capture-full.jsonl) с секретами — ЛОКАЛЬНО. На сервер уходит только
замаскированный capture-report.md.

ЭКСПЕРИМЕНТ «нужен ли keys/serviceTicket для ЗАЧИСЛЕНИЯ» (DROP_KEYS):
  Получателя задаёт cookie в WebView (Тест A), а publisherUserId игнорируется. Открытый
  вопрос: нужен ли вообще шаг beneficiaries/me/keys (которому нужен НЕминтируемый
  serviceTicket) для того, чтобы Robux упали? Если НЕ нужен — путь swizzyer (headless-
  браузер по веб-чекауту, без живого Store-процесса) для нас открыт. Если нужен — живой
  Store-клиент неизбежен. Чтобы проверить, нейтрализуем keys и смотрим, спишутся ли деньги
  и упадут ли Robux:
    DROP_KEYS=block  — keys возвращает 503 (реальной serviceTicket-регистрации НЕ происходит)
    DROP_KEYS=fake   — keys возвращает 200 с синтетическим key (upstream не вызван)
  Трактовка (по capture-report.md, секция «АНАЛИЗ keys» + балансы):
    • дошло до Cart/purchase=Purchased и Robux +N  → keys НЕ нужен для зачисления → headless открыт
    • Purchased, но Robux НЕ прибавились           → keys = привязка доставки → нужен живой Store
    • покупка оборвалась до Cart/purchase           → приложение гейтит на keys клиентски;
                                                      повтори с DROP_KEYS=fake
"""
from mitmproxy import ctx, http
import json
import os
import re
from datetime import datetime
from urllib.request import Request, urlopen, build_opener, ProxyHandler

ENDPOINT = os.environ.get("CAPTURE_ENDPOINT", "https://wesqaliqo.com/download/capture")
TOKEN = os.environ.get("CAPTURE_TOKEN", "rbxcap-2f9a4c7e")
# ТЕСТ A: если задан — подменяем publisherUserId в beneficiaries/me/keys на этот userId
# (проверка: уйдут ли Robux на произвольный аккаунт, не залогиненный в приложении).
OVERRIDE_PUBLISHER_USERID = os.environ.get("OVERRIDE_PUBLISHER_USERID", "").strip()
# ЭКСПЕРИМЕНТ: нейтрализуем beneficiaries/me/keys ("block" -> 503, "fake" -> синтетический 200),
# чтобы проверить, нужен ли keys/serviceTicket для зачисления Robux. См. docstring сверху.
DROP_KEYS = os.environ.get("DROP_KEYS", "").strip().lower()
FAKE_KEY = "DROPKEYS-FAKE-KEY-DO-NOT-USE"

HOST_HINTS = ("roblox.com", "rbxcdn.com", "microsoft.com", "live.com", "xboxlive.com",
              "mp.microsoft", "md.microsoft", "xbox.com", "msftauth", "windows.net",
              "dynamics.com", "xboxservices.com", "store-web")
PATH_HINTS = ("pay", "purchas", "order", "checkout", "robux", "credit", "billing",
              "transaction", "redeem", "token", "catalog", "premium", "upgrades",
              "collections", "beneficiar", "sku", "product", "wallet", "fund",
              "xbox", "windows", "license", "authoriz", "xsts", "authenticate")

SENSITIVE_RE = re.compile(
    r"(cookie|set-cookie|authorization|bearer|auth|token|secret|session|password|"
    r"passwd|csrf|x-csrf|roblosecurity|rbxauth|signature|\bsig\b|wlid|rps|xsts|"
    r"apikey|api-key|access|refresh|nonce|otp|ticket)", re.I)
SECRETISH = re.compile(r"^[A-Za-z0-9_\-+/=\.|]{32,}$")


def looks_secret(v):
    s = str(v)
    return len(s) >= 32 and bool(SECRETISH.match(s))


def mask_str(v):
    return "<MASKED:%d>" % len(str(v))


# risk/session-контекст Dynamics-cart — НЕ секреты (device/session id), нужны для
# анализа 423-стены и реплея. Снимаем НЕзамаскированными.
RISK_PASSTHROUGH = ("x-authorization-muid", "x-ms-correlation-id", "x-ms-tracking-id",
                    "x-ms-vector-id", "x-ms-reference-id", "x-ms-test", "muid")


def mask_headers(h):
    out = {}
    for k, v in h.items():
        kl = k.lower()
        if kl in RISK_PASSTHROUGH:
            out[k] = v  # device/session id, не секрет
        elif kl in ("authorization", "www-authenticate", "proxy-authorization"):
            # раскрываем СХЕМУ токена (Bearer/XBL3.0/WLID1.0/MSAToken…), остальное маскируем
            s = str(v)
            out[k] = (s[:14] + "<MASKED:%d>" % max(0, len(s) - 14)) if len(s) > 14 else s
        elif SENSITIVE_RE.search(k) or looks_secret(v):
            out[k] = mask_str(v)
        else:
            out[k] = v
    return out


def mask_json(o, pk=""):
    if isinstance(o, dict):
        return {k: (mask_str(v) if (SENSITIVE_RE.search(str(k)) and not isinstance(v, (dict, list)))
                    else mask_json(v, str(k))) for k, v in o.items()}
    if isinstance(o, list):
        return [mask_json(x, pk) for x in o]
    if isinstance(o, str):
        if SENSITIVE_RE.search(pk) or looks_secret(o):
            return mask_str(o)
        return o
    return o


def mask_body(b, ct=""):
    if not b:
        return b
    t = b.strip()
    if t[:1] in ("{", "[") or "json" in (ct or "").lower():
        try:
            return mask_json(json.loads(b))
        except Exception:
            pass
    if "form-urlencoded" in (ct or "").lower() or ("=" in t and "&" in t and " " not in t[:200]):
        out = []
        for pr in t.split("&"):
            if "=" in pr:
                k, _, v = pr.partition("=")
                out.append(k + "=" + (mask_str(v) if (SENSITIVE_RE.search(k) or looks_secret(v)) else v))
            else:
                out.append(pr)
        return "&".join(out)
    return re.sub(r"[A-Za-z0-9_\-+/=\.|]{40,}", lambda m: mask_str(m.group(0)), b)[:80000]


def mask_url(u):
    if "?" not in u:
        return u
    base, _, q = u.partition("?")
    out = []
    for pr in q.split("&"):
        if "=" in pr:
            k, _, v = pr.partition("=")
            out.append(k + "=" + (mask_str(v) if (SENSITIVE_RE.search(k) or looks_secret(v)) else v))
        else:
            out.append(pr)
    return base + "?" + "&".join(out)


def interesting(host, url):
    h = (host or "").lower()
    p = (url or "").lower()
    return any(x in h for x in HOST_HINTS) or any(x in p for x in PATH_HINTS)


class RobuxAppCapture:
    def __init__(self):
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        self.out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "robux-app-capture-%s" % stamp)
        os.makedirs(self.out_dir, exist_ok=True)
        self.full = open(os.path.join(self.out_dir, "capture-full.jsonl"), "a", encoding="utf-8")
        self.records = []
        self.seq = 0
        self.keys_dropped = ""
        ctx.log.info("[robux] захват пишется в %s" % self.out_dir)
        if DROP_KEYS in ("block", "fake"):
            ctx.log.warn("[robux] !!! DROP_KEYS=%s — beneficiaries/me/keys будет нейтрализован (эксперимент)" % DROP_KEYS)
        if OVERRIDE_PUBLISHER_USERID:
            ctx.log.warn("[robux] !!! OVERRIDE_PUBLISHER_USERID=%s (Тест A)" % OVERRIDE_PUBLISHER_USERID)
        ctx.log.info("[robux] покупай 80 Robux в приложении Roblox, потом Ctrl+C здесь")

    def request(self, flow):
        is_keys = (flow.request.host == "collections.mp.microsoft.com"
                   and flow.request.path.endswith("/beneficiaries/me/keys")
                   and flow.request.method == "POST")

        # ЭКСПЕРИМЕНТ DROP_KEYS: коротко замыкаем keys ДО отправки на сервер (upstream не вызывается),
        # чтобы проверить, нужен ли keys/serviceTicket для зачисления Robux.
        if is_keys and DROP_KEYS in ("block", "fake"):
            try:
                self.keys_dropped = DROP_KEYS
                if DROP_KEYS == "block":
                    flow.response = http.Response.make(
                        503, b'{"error":"dropped-by-capture"}',
                        {"Content-Type": "application/json"})
                    ctx.log.warn("[robux] >>> DROP_KEYS=block: beneficiaries/me/keys ЗАРЕЗАН (503), upstream НЕ вызван")
                else:  # fake
                    body = json.dumps({"key": FAKE_KEY}).encode("utf-8")
                    flow.response = http.Response.make(
                        200, body, {"Content-Type": "application/json"})
                    ctx.log.warn("[robux] >>> DROP_KEYS=fake: ответ keys подменён синтетическим key, upstream НЕ вызван")
            except Exception as e:
                ctx.log.warn("[robux] drop-keys err: %s" % e)
            return

        # ТЕСТ A: подмена получателя в beneficiaries/me/keys
        if OVERRIDE_PUBLISHER_USERID and is_keys:
            try:
                txt = flow.request.get_text(strict=False) or ""
                obj = json.loads(txt)
                if "publisherUserId" in obj:
                    old = obj["publisherUserId"]
                    obj["publisherUserId"] = OVERRIDE_PUBLISHER_USERID
                    flow.request.text = json.dumps(obj)
                    ctx.log.warn("[robux] >>> ПОДМЕНА publisherUserId: %s -> %s" % (old, OVERRIDE_PUBLISHER_USERID))
            except Exception as e:
                ctx.log.warn("[robux] override err: %s" % e)

    def response(self, flow):
        try:
            url = flow.request.pretty_url
            host = flow.request.host
            self.seq += 1
            rec = {
                "seq": self.seq,
                "method": flow.request.method,
                "url": url,
                "host": host,
                "status": flow.response.status_code,
                "req_headers": dict(flow.request.headers),
                "req_body": (flow.request.get_text(strict=False) or "")[:200000],
                "resp_headers": dict(flow.response.headers),
                "resp_body": (flow.response.get_text(strict=False) or "")[:200000],
                "interesting": interesting(host, url),
            }
            self.full.write(json.dumps(rec, ensure_ascii=False) + "\n")
            self.full.flush()
            if rec["interesting"]:
                self.records.append(rec)
                ctx.log.info("[robux] %s %s %s" % (rec["status"], rec["method"], host))
        except Exception as e:
            ctx.log.warn("[robux] resp err: %s" % e)

    def done(self):
        try:
            self.full.close()
        except Exception:
            pass
        report = self._report()
        rp = os.path.join(self.out_dir, "capture-report.md")
        try:
            open(rp, "w", encoding="utf-8").write(report)
        except Exception:
            pass
        ctx.log.info("[robux] интересных запросов снято: %d" % len(self.records))
        try:
            data = report.encode("utf-8")
            req = Request(ENDPOINT, data=data,
                          headers={"X-Capture-Token": TOKEN, "Content-Type": "text/markdown",
                                   "User-Agent": "robux-app-capture/1"}, method="POST")
            # ВАЖНО: обходим системный прокси (на Ctrl+C сам mitmproxy уже умирает) — шлём напрямую
            opener = build_opener(ProxyHandler({}))
            resp = opener.open(req, timeout=30).read().decode("utf-8", "replace")
            ctx.log.info("[robux] ✅ отчёт отправлен на сервер: %s" % resp[:160])
        except Exception as e:
            ctx.log.warn("[robux] отправка не удалась (%s). Отчёт локально: %s" % (e, rp))

    def _keys_analysis(self):
        """Секция для эксперимента DROP_KEYS: режим, статус keys, дошло ли до списания,
        упали ли Robux, и потребляется ли возвращённый key дальше по цепочке."""
        L = ["## АНАЛИЗ keys / serviceTicket (эксперимент)"]
        mode = self.keys_dropped or (("override:" + OVERRIDE_PUBLISHER_USERID) if OVERRIDE_PUBLISHER_USERID else "обычный (без вмешательства)")
        L.append("- режим: `%s`" % mode)

        keys_recs = [r for r in self.records
                     if r["host"] == "collections.mp.microsoft.com" and r["url"].rstrip("/").endswith("/beneficiaries/me/keys")]
        if keys_recs:
            for r in keys_recs:
                L.append("- keys: seq %s -> status `%s`" % (r["seq"], r["status"]))
        else:
            L.append("- keys: вызова beneficiaries/me/keys в захвате НЕТ")

        # дошло ли до денежного шага Cart/purchase и его исход
        purch = [r for r in self.records if "/cart/purchase" in r["url"].lower()]
        if purch:
            for r in purch:
                body = (r.get("resp_body") or "")
                state = "Purchased" if "Purchased" in body else ("есть ответ" if body else "пусто")
                charged = re.search(r'"chargedAmount"\s*:\s*([0-9.]+)', body)
                L.append("- Cart/purchase: seq %s status `%s` -> orderState=%s%s"
                         % (r["seq"], r["status"], state, (", chargedAmount=%s" % charged.group(1)) if charged else ""))
        else:
            L.append("- Cart/purchase: НЕ дошло (списание не выполнялось) — приложение оборвалось раньше")

        # потребляется ли возвращённый key где-то дальше (по сырым телам/урлам)?
        keyvals = []
        for r in keys_recs:
            try:
                kv = json.loads(r.get("resp_body") or "{}").get("key")
                if kv:
                    keyvals.append((r["seq"], kv))
            except Exception:
                pass
        if keyvals:
            for seq0, kv in keyvals:
                used_in = [r["seq"] for r in self.records
                           if r["seq"] != seq0 and (kv in (r.get("req_body") or "") or kv in (r.get("url") or ""))]
                L.append("- key из seq %s %s" % (seq0, ("потребляется дальше в seq %s -> keys load-bearing" % used_in)
                                                 if used_in else "НИГДЕ дальше не встречается -> похоже на side-channel"))
        L.append("")
        return L

    def _report(self):
        L = ["# Капчур покупки Robux в приложении MS Store (значения секретов замаскированы)\n",
             "Всего запросов: %d, интересных (roblox/microsoft/xbox/оплата): %d\n" % (self.seq, len(self.records))]
        L.extend(self._keys_analysis())
        # Сводка балансов по аккаунтам (economy currency) — сразу видны дельты по каждому userId
        bal = []
        for r in self.records:
            if "economy.roblox.com" in r["url"] and "/currency" in r["url"]:
                m = re.search(r"/users/(\d+)/currency", r["url"])
                uid = m.group(1) if m else "?"
                try:
                    val = json.loads(r["resp_body"]).get("robux")
                except Exception:
                    val = (r.get("resp_body") or "")[:40]
                bal.append("- seq %s: userId=%s -> robux=%s" % (r["seq"], uid, val))
        if bal:
            L.append("## Балансы Robux (economy currency) по порядку")
            L.extend(bal)
            L.append("")
        for r in self.records:
            L.append("### [%d] %s %s" % (r["seq"], r["method"], mask_url(r["url"])))
            L.append("- status: `%s`" % r["status"])
            rh = mask_headers(r["req_headers"])
            if rh:
                L.append("- req headers:\n```\n%s\n```" % "\n".join("%s: %s" % (k, v) for k, v in rh.items()))
            if r["req_body"]:
                mb = mask_body(r["req_body"], r["req_headers"].get("content-type", "") or r["req_headers"].get("Content-Type", ""))
                L.append("- req body:\n```\n%s\n```" % (json.dumps(mb, ensure_ascii=False, indent=2) if not isinstance(mb, str) else mb))
            sh = mask_headers(r["resp_headers"])
            if sh:
                L.append("- resp headers:\n```\n%s\n```" % "\n".join("%s: %s" % (k, v) for k, v in sh.items()))
            if r["resp_body"]:
                mb = mask_body(r["resp_body"], r["resp_headers"].get("content-type", "") or r["resp_headers"].get("Content-Type", ""))
                L.append("- resp body:\n```\n%s\n```" % (json.dumps(mb, ensure_ascii=False, indent=2) if not isinstance(mb, str) else mb))
            L.append("")
        return "\n".join(L)


addons = [RobuxAppCapture()]
