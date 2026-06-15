#!/usr/bin/env python3
"""
Windows-воркер автовыдачи Robux методом «Microsoft Store».

Запускается НА Windows-машине (не в Docker-контейнере бэкенда), где установлено
приложение Roblox из Microsoft Store. Воркер:
  1) опрашивает очередь бэкенда (/roblox/worker/poll) с секретом X-Worker-Token;
  2) на каждый готовый заказ выполняет покупку Robux в UWP-приложении за баланс
     Microsoft-аккаунта (phase_ms_buy) и зачисление на аккаунт покупателя
     (phase_generate_store_id / phase_claim);
  3) проверяет баланс покупателя (phase_verify) и отчитывается (/roblox/worker/report).

ВАЖНО — границы Фазы 1:
  * Шаги ms_buy и claim требуют РЕАЛЬНОЙ автоматизации UWP-приложения Microsoft Store
    и/или снятых «живых» эндпоинтов Roblox (см. README.md → «Снятие эндпоинтов»).
    Здесь они выделены в функции-заглушки purchase_robux()/claim_robux() с чёткими TODO.
    По умолчанию воркер ЧЕСТНО помечает заказ как failed с пояснением, а не имитирует успех.
  * Шаг verify реализован по-настоящему: баланс покупателя читается через economy.roblox.com.

Конфигурация — через переменные окружения (см. README.md):
  ROBLOX_WORKER_BACKEND   напр. https://playerokbot.com
  ROBLOX_WORKER_TOKEN     тот же секрет, что ROBLOX_WORKER_TOKEN на бэкенде
  ROBLOX_WORKER_ID        имя этой машины, напр. win-01
  ROBLOX_WORKER_POLL_SEC  интервал опроса, по умолчанию 5
"""

import os
import sys
import time
import json
import urllib.request
import urllib.error

BACKEND = os.environ.get("ROBLOX_WORKER_BACKEND", "").rstrip("/")
TOKEN = os.environ.get("ROBLOX_WORKER_TOKEN", "").strip()
WORKER_ID = os.environ.get("ROBLOX_WORKER_ID", "win-worker").strip()
POLL_SEC = float(os.environ.get("ROBLOX_WORKER_POLL_SEC", "5"))

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) RobloxMsStoreWorker/0.1"


def _http(method, url, headers=None, body=None, timeout=30):
    data = None
    h = {"User-Agent": UA, "Accept": "application/json"}
    if headers:
        h.update(headers)
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "ignore")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"error": raw}
    except Exception as e:  # noqa: BLE001
        return 0, {"error": str(e)}


def poll():
    status, data = _http(
        "POST",
        f"{BACKEND}/roblox/worker/poll",
        headers={"X-Worker-Token": TOKEN},
        body={"workerId": WORKER_ID},
    )
    if status != 200 or not data or not data.get("ok"):
        return None
    return data.get("order")


def report(order_id, status=None, phase=None, error=None, message=None):
    payload = {"orderId": order_id}
    if status is not None:
        payload["status"] = status
    if phase is not None:
        payload["phase"] = phase
    if error is not None:
        payload["error"] = error
    if message is not None:
        payload["message"] = message
    _http("POST", f"{BACKEND}/roblox/worker/report", headers={"X-Worker-Token": TOKEN}, body=payload)


def get_buyer_balance(buyer_cookie, user_id):
    """phase_verify: реальный запрос баланса Robux покупателя (economy.roblox.com)."""
    status, data = _http(
        "GET",
        f"https://economy.roblox.com/v1/users/{user_id}/currency",
        headers={"Cookie": f".ROBLOSECURITY={buyer_cookie}"},
    )
    if status == 200 and data and "robux" in data:
        return int(data["robux"])
    return None


def get_authenticated_user(buyer_cookie):
    status, data = _http(
        "GET",
        "https://users.roblox.com/v1/users/authenticated",
        headers={"Cookie": f".ROBLOSECURITY={buyer_cookie}"},
    )
    if status == 200 and data and data.get("id"):
        return data
    return None


# ─────────────────────────────────────────────────────────────────────────────
# ШАГИ, ТРЕБУЮЩИЕ РЕАЛЬНОЙ АВТОМАТИЗАЦИИ / СНЯТЫХ ЭНДПОИНТОВ (Фаза 2)
# ─────────────────────────────────────────────────────────────────────────────

class NotImplementedStep(Exception):
    pass


def purchase_robux(order):
    """
    phase_ms_buy: купить Robux-пак в приложении Roblox (Microsoft Store), оплатив
    балансом Microsoft-аккаунта order['microsoft'].

    Чисто HTTP это сделать НЕЛЬЗЯ: оплату балансом проводит UWP-вызов
    Windows.Services.Store.StoreContext.RequestPurchaseAsync внутри приложения.
    Реализация (Фаза 2) — один из вариантов:
      (а) UI-автоматизация приложения Roblox (pywinauto / FlaUI / WinAppDriver):
          логин MS-аккаунта в Store, логин аккаунта покупателя в приложении,
          выбор пака Robux, оплата «Microsoft account balance», подтверждение;
      (б) повтор снятых «живых» запросов покупки/лицензирования (см. README →
          «Снятие эндпоинтов»), если они воспроизводимы вне приложения.
    """
    raise NotImplementedStep(
        "phase_ms_buy не реализован: нужна UWP-автоматизация приложения Roblox "
        "или снятые эндпоинты покупки. См. worker/msstore-worker/README.md."
    )


def claim_robux(order):
    """
    phase_generate_store_id + phase_claim: привязать покупку Microsoft Store к аккаунту
    Roblox покупателя и зачислить Robux.

    Точный эндпоинт Roblox для Windows/Xbox-покупки НЕ опубликован (документированы только
    /v1/apple/purchase и /v1/google/purchase). Его нужно СНЯТЬ с живого UWP-клиента
    (Fiddler/mitmproxy) — см. README → «Снятие эндпоинтов». В типовом UWP-флоу Robux
    зачисляются автоматически после успешной оплаты, поэтому отдельный claim может не
    потребоваться; оставлено хуком на случай ручного «redeem».
    """
    raise NotImplementedStep(
        "phase_claim не реализован: нужен снятый эндпоинт зачисления Windows-покупки Roblox. "
        "См. worker/msstore-worker/README.md."
    )


# ─────────────────────────────────────────────────────────────────────────────

def process_order(order):
    oid = order["id"]
    buyer_cookie = order.get("buyerCookie")
    amount = order.get("robuxAmount")
    print(f"[order {order.get('publicId')}] claimed: {amount} R$ → @{order.get('buyerUsername')}")

    if not buyer_cookie:
        report(oid, status="failed", phase="phase_ms_buy", error="нет cookie покупателя")
        return

    user = get_authenticated_user(buyer_cookie)
    if not user:
        report(oid, status="failed", phase="phase_ms_buy", error="cookie покупателя невалидна")
        return
    before = get_buyer_balance(buyer_cookie, user["id"])
    report(oid, status="purchasing", phase="phase_ms_buy",
           message=f"Старт покупки. Баланс покупателя до: {before} R$")

    # phase_ms_buy
    try:
        purchase_robux(order)
    except NotImplementedStep as e:
        report(oid, status="failed", phase="phase_ms_buy", error=str(e),
               message="Шаг покупки не автоматизирован (Фаза 2). Заказ требует ручной выдачи.")
        return
    except Exception as e:  # noqa: BLE001
        report(oid, status="failed", phase="phase_ms_buy", error=str(e))
        return

    # phase_generate_store_id / phase_claim
    report(oid, status="claiming", phase="phase_claim", message="Зачисление на аккаунт Roblox")
    try:
        claim_robux(order)
    except NotImplementedStep as e:
        report(oid, status="failed", phase="phase_claim", error=str(e))
        return
    except Exception as e:  # noqa: BLE001
        report(oid, status="failed", phase="phase_claim", error=str(e))
        return

    # phase_verify — реальная проверка баланса.
    report(oid, status="verifying", phase="phase_verify", message="Проверка баланса покупателя")
    after = get_buyer_balance(buyer_cookie, user["id"])
    if before is not None and after is not None and after >= before + int(amount):
        report(oid, status="delivered", phase="done",
               message=f"Выдано: {before} → {after} R$")
    else:
        report(oid, status="failed", phase="phase_verify",
               error=f"Баланс не вырос как ожидалось: было {before}, стало {after}")


def main():
    if not BACKEND or not TOKEN:
        print("Нужны ROBLOX_WORKER_BACKEND и ROBLOX_WORKER_TOKEN. См. README.md.", file=sys.stderr)
        sys.exit(2)
    print(f"MS Store worker '{WORKER_ID}' → {BACKEND}, опрос каждые {POLL_SEC}s")
    while True:
        try:
            order = poll()
            if order:
                process_order(order)
                continue  # сразу проверяем, нет ли ещё заказов
        except KeyboardInterrupt:
            print("Остановка по Ctrl+C")
            break
        except Exception as e:  # noqa: BLE001
            print(f"Ошибка цикла: {e}", file=sys.stderr)
        time.sleep(POLL_SEC)


if __name__ == "__main__":
    main()
