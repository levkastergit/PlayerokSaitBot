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
"""
from mitmproxy import ctx
import json
import os
import re
from datetime import datetime
from urllib.request import Request, urlopen, build_opener, ProxyHandler

ENDPOINT = os.environ.get("CAPTURE_ENDPOINT", "https://wesqaliqo.com/download/capture")
TOKEN = os.environ.get("CAPTURE_TOKEN", "rbxcap-2f9a4c7e")

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


def mask_headers(h):
    out = {}
    for k, v in h.items():
        kl = k.lower()
        if kl in ("authorization", "www-authenticate", "proxy-authorization"):
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
    return re.sub(r"[A-Za-z0-9_\-+/=\.|]{40,}", lambda m: mask_str(m.group(0)), b)[:4000]


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
        ctx.log.info("[robux] захват пишется в %s" % self.out_dir)
        ctx.log.info("[robux] покупай 80 Robux в приложении Roblox, потом Ctrl+C здесь")

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

    def _report(self):
        L = ["# Капчур покупки Robux в приложении MS Store (значения секретов замаскированы)\n",
             "Всего запросов: %d, интересных (roblox/microsoft/xbox/оплата): %d\n" % (self.seq, len(self.records))]
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
