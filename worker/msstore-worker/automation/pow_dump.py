"""mitmproxy-аддон: печатает тела запросов/ответов PoW и challenge/continue при логине Roblox."""
import json
from mitmproxy import http

TARGETS = ("proof-of-work", "pow-puzzle", "challenge/v1/continue")


def response(flow: http.HTTPFlow):
    url = flow.request.pretty_url
    if not any(t in url for t in TARGETS):
        return
    try:
        req_body = flow.request.get_text() or ""
    except Exception:
        req_body = "<bin>"
    try:
        resp_body = flow.response.get_text() if flow.response else ""
    except Exception:
        resp_body = "<bin>"
    out = {
        "method": flow.request.method,
        "url": url,
        "req_headers_csrf": flow.request.headers.get("x-csrf-token", ""),
        "req_body": req_body[:2500],
        "status": flow.response.status_code if flow.response else 0,
        "resp_body": resp_body[:2500],
    }
    print("POWFLOW " + json.dumps(out, ensure_ascii=False), flush=True)
