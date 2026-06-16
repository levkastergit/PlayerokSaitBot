"""
mitmproxy addon: перехват и подсветка запросов, относящихся к покупке Robux
через Microsoft Store (Шаг 0 разведки для Фазы 2).

Все флоу пишутся в robux-capture.flows (бинарный формат mitmproxy, открывается
mitmweb/mitmproxy). Релевантные запросы (Microsoft commerce + Roblox billing)
дополнительно печатаются в консоль и дублируются в robux-capture.txt с телами,
чтобы их было легко найти в шуме.

Запуск (из этой папки):
    mitmdump -s highlight.py -w robux-capture.flows
или через start-capture.ps1.
"""

import os
import re
from mitmproxy import http

# Хосты, на которых живёт логика покупки/лицензии/зачисления.
TARGET_HOST = re.compile(
    r"(\.microsoft\.com|\.xboxlive\.com|\.roblox\.com|login\.live\.com)$",
    re.IGNORECASE,
)

# Имя файла выжимки можно переопределить через CAPTURE_TXT (для отдельных прогонов).
TXT = os.environ.get("CAPTURE_TXT") or "robux-capture.txt"
MAX_BODY = 4000


def _is_target(flow: http.HTTPFlow) -> bool:
    return bool(TARGET_HOST.search(flow.request.pretty_host))


def _dump(title: str, text: str) -> None:
    print(title)
    try:
        with open(TXT, "a", encoding="utf-8") as f:
            f.write(text + "\n")
    except Exception:
        pass


def request(flow: http.HTTPFlow) -> None:
    if not _is_target(flow):
        return
    body = ""
    try:
        if flow.request.content:
            body = flow.request.get_text(strict=False)[:MAX_BODY]
    except Exception:
        body = "<binary>"
    block = (
        f"\n===== REQUEST >> {flow.request.method} {flow.request.pretty_url}\n"
        f"-- headers --\n"
        + "\n".join(f"{k}: {v}" for k, v in flow.request.headers.items())
        + (f"\n-- body --\n{body}" if body else "")
    )
    _dump(f"[RELEVANT >>] {flow.request.method} {flow.request.pretty_url}", block)


def response(flow: http.HTTPFlow) -> None:
    if not _is_target(flow) or flow.response is None:
        return
    body = ""
    try:
        if flow.response.content:
            body = flow.response.get_text(strict=False)[:MAX_BODY]
    except Exception:
        body = "<binary>"
    block = (
        f"----- RESPONSE << {flow.response.status_code} {flow.request.pretty_url}\n"
        f"-- headers --\n"
        + "\n".join(f"{k}: {v}" for k, v in flow.response.headers.items())
        + (f"\n-- body --\n{body}" if body else "")
    )
    _dump(f"[RELEVANT <<] {flow.response.status_code} {flow.request.pretty_url}", block)
