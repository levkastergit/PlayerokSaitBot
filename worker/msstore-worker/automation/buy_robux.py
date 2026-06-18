"""
Драйвер покупки Robux через UI Automation (Фаза 2).

Основано на записи реального процесса: весь флоу — это именованные UIA-элементы,
поэтому кликаем по элементам, а не по пикселям.

Последовательность:
  1) Страница Roblox «Buy Robux» (внутри окна Roblox / WEBVIEW2BROWSERAPP):
     паки — кнопки с ценой ('0,99 $'=80R$, '4,99 $'=500, '9,99 $'=1000, '19,99 $'=2000),
     рядом слева сумма Robux ('80','500','1 000','2 000'). Кликаем кнопку нужного пака.
  2) Нативное окно 'Узел для покупок в Store' (ApplicationFrameWindow / CoreWindow):
     проверяем способ оплаты 'Баланс учетной записи Microsoft', кликаем кнопку 'Купить'.
  3) Экран 'Покупка завершена.' → кнопка 'Понятно' (autoId='gotItButton').

Режимы:
  python buy_robux.py --find          только найти и показать элементы (НЕ кликает)
  python buy_robux.py --select 80     кликнуть пак (откроется окно оплаты) и ОСТАНОВИТЬСЯ
  python buy_robux.py --buy 80        полная покупка (РЕАЛЬНО спишет баланс MS)

Приложение Roblox должно быть открыто на странице покупки Robux. Денег режимы --find/--select
не тратят (--select открывает окно оплаты, но НЕ подтверждает — закрой окно вручную).
"""

import sys
import time
import argparse

# Чтобы кириллица в выводе не падала на консолях с не-UTF-8 кодовой страницей.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

try:
    import uiautomation as auto
except Exception:  # noqa: BLE001
    print("Нет uiautomation. Установи: pip install uiautomation")
    sys.exit(2)

# Цена пака -> сколько Robux (для подписи; матчим всё равно по сумме рядом с кнопкой).
PAYMENT_MS_PREFIX = "Баланс учетной записи Microsoft"
STORE_WINDOW_NAME = "Узел для покупок в Store"
DONE_TEXT = "Покупка завершена."


def norm_num(s):
    """'1\xa0000' / '1 000' -> '1000'; вернёт '' если не число."""
    if not s:
        return ""
    t = "".join(ch for ch in str(s) if ch.isdigit())
    return t


def is_amount(s):
    """True для чистой суммы Robux вида '80' / '1 000' / '2\xa0000' (только цифры и пробелы)."""
    t = (s or "").replace("\xa0", " ").strip()
    return bool(t) and all(ch.isdigit() or ch == " " for ch in t)


def walk(ctrl, maxd=40, maxsib=300):
    """Рекурсивный обход поддерева UIA → список словарей с контролами."""
    out = []

    def rec(c, depth):
        try:
            r = c.BoundingRectangle
            rect = (r.left, r.top, r.right, r.bottom)
        except Exception:  # noqa: BLE001
            rect = (0, 0, 0, 0)
        try:
            out.append({
                "ctrl": c,
                "type": c.ControlTypeName,
                "name": c.Name or "",
                "cls": c.ClassName or "",
                "autoId": c.AutomationId or "",
                "rect": rect,
            })
        except Exception:  # noqa: BLE001
            return
        if depth >= maxd:
            return
        try:
            kids = c.GetChildren()
        except Exception:  # noqa: BLE001
            kids = []
        for i, k in enumerate(kids):
            if i >= maxsib:
                break
            rec(k, depth + 1)

    rec(ctrl, 0)
    return out


def find_roblox_window(timeout=8):
    deadline = time.time() + timeout
    while time.time() < deadline:
        w = auto.WindowControl(searchDepth=1, ClassName="WINDOWSCLIENT", Name="Roblox")
        if w.Exists(0, 0):
            return w
        # запасной поиск по имени
        w = auto.WindowControl(searchDepth=1, Name="Roblox")
        if w.Exists(0, 0):
            return w
        time.sleep(0.5)
    return None


def scan_window_nodes(timeout=20, debug=False):
    """Обойти всё дерево окна Roblox, предварительно «прогрев» ленивую доступность WebView2
    через ControlFromPoint в центр окна (как это делали клики в записи). Ретраим, пока не
    появятся кнопки-цены ('$'). Возвращает (win, nodes)."""
    rb = find_roblox_window()
    if not rb:
        return None, []
    try:
        hwnd = rb.NativeWindowHandle
    except Exception:  # noqa: BLE001
        hwnd = 0
    deadline = time.time() + timeout
    last = []
    attempt = 0
    while time.time() < deadline:
        attempt += 1
        # триггерим ленивую a11y веб-контента
        try:
            r = rb.BoundingRectangle
            for px, py in (((r.left + r.right) // 2, (r.top + r.bottom) // 2),
                           ((r.left + r.right) // 2, r.top + (r.bottom - r.top) // 3)):
                auto.ControlFromPoint(px, py)
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.5)
        try:
            win = auto.ControlFromHandle(hwnd) if hwnd else rb
            nodes = walk(win, maxd=55)
        except Exception:  # noqa: BLE001
            win, nodes = rb, []
        last = nodes
        n_price = sum(1 for n in nodes if n["type"] == "ButtonControl" and "$" in n["name"])
        if debug:
            print(f"  [debug] попытка {attempt}: узлов={len(nodes)} кнопок-цен={n_price}")
        if n_price > 0:
            return win, nodes
        time.sleep(0.4)
    return None, last


def find_packs(nodes, debug=False):
    """Паки: {robux, price, button}. Привязка ОТНОСИТЕЛЬНАЯ (не по экранным координатам):
    к каждой кнопке-цене ищем сумму Robux в той же строке слева от кнопки и берём самую левую (заголовок)."""
    prices = [
        n for n in nodes
        if n["type"] == "ButtonControl" and "$" in n["name"] and any(c.isdigit() for c in n["name"])
    ]
    amounts = [
        n for n in nodes
        if n["type"] == "TextControl" and is_amount(n["name"]) and (n["rect"][2] - n["rect"][0]) > 4
    ]
    if debug:
        print(f"  [debug] узлов={len(nodes)} кнопок-цен={len(prices)} сумм={len(amounts)}")
        print(f"  [debug] цены: {[p['name'] for p in prices][:10]}")
        print(f"  [debug] суммы: {[a['name'] for a in amounts][:15]}")

    packs = []
    for b in prices:
        bl = b["rect"][0]
        bcy = (b["rect"][1] + b["rect"][3]) // 2
        # сумма этого пака — слева от кнопки и в ТОЙ ЖЕ строке (минимальная разница Y-центров)
        cands = [
            a for a in amounts
            if a["rect"][2] <= bl and abs(((a["rect"][1] + a["rect"][3]) // 2) - bcy) <= 30
        ]
        if not cands:
            continue
        # сначала ближайшая строка, среди одной строки — самая левая (заголовок, не зачёркнутая цена)
        head = min(cands, key=lambda a: (abs(((a["rect"][1] + a["rect"][3]) // 2) - bcy), a["rect"][0]))
        packs.append({"robux": int(norm_num(head["name"])), "price": b["name"], "button": b["ctrl"]})

    seen = set()
    uniq = []
    for p in sorted(packs, key=lambda x: x["robux"]):
        if p["robux"] in seen:
            continue
        seen.add(p["robux"])
        uniq.append(p)
    return uniq


def find_store_dialog(timeout=30):
    """Нативное окно 'Узел для покупок в Store'."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        w = auto.WindowControl(searchDepth=3, Name=STORE_WINDOW_NAME)
        if w.Exists(0, 0):
            return w
        time.sleep(0.5)
    return None


def dialog_payment_method(dlg):
    """Текст выбранного способа оплаты в окне Store (ищем кнопку 'Оплатить с помощью ...')."""
    for n in walk(dlg, maxd=30):
        if n["type"] == "ButtonControl" and n["name"].startswith(PAYMENT_MS_PREFIX):
            return n["name"]
    return None


def find_in(ctrl, ctype, name=None, name_prefix=None, autoId=None, maxd=30):
    for n in walk(ctrl, maxd=maxd):
        if n["type"] != ctype:
            continue
        if name is not None and n["name"] != name:
            continue
        if name_prefix is not None and not n["name"].startswith(name_prefix):
            continue
        if autoId is not None and n["autoId"] != autoId:
            continue
        return n["ctrl"]
    return None


def click(ctrl, label=""):
    try:
        ctrl.SetActive()
    except Exception:  # noqa: BLE001
        pass
    # реальный клик мышью по центру (надёжно и для web, и для нативных кнопок)
    try:
        ctrl.Click(simulateMove=False, waitTime=0.2)
        print(f"  клик: {label}")
        return True
    except Exception as e:  # noqa: BLE001
        # запасной путь — InvokePattern
        try:
            ctrl.GetInvokePattern().Invoke()
            print(f"  invoke: {label}")
            return True
        except Exception as e2:  # noqa: BLE001
            print(f"  ОШИБКА клика {label}: {e} / {e2}")
            return False


def confirm_purchase(do_click):
    """Окно Store: проверить оплату MS-балансом и нажать 'Купить'."""
    time.sleep(3.0)  # дать окну оплаты появиться после клика по паку (бывает не сразу)
    dlg = find_store_dialog(timeout=60)
    if not dlg:
        print("  окно 'Узел для покупок в Store' не появилось")
        return False
    pay = dialog_payment_method(dlg)
    print(f"  способ оплаты: {pay}")
    if not pay:
        print("  ⚠ не вижу 'Баланс учетной записи Microsoft' — оплата может быть не тем средством.")
    buy_btn = find_in(dlg, "ButtonControl", name="Купить")
    if not buy_btn:
        print("  кнопка 'Купить' не найдена")
        return False
    print("  кнопка 'Купить' найдена" + ("" if do_click else " (не нажимаю — режим без покупки)"))
    if not do_click:
        return True
    if not click(buy_btn, "Купить"):
        return False
    # ждём экран успеха (внутри того же окна Store): текст 'Покупка завершена.' или кнопка 'Понятно'
    deadline = time.time() + 45
    while time.time() < deadline:
        ok = find_store_dialog(timeout=2)
        if ok:
            done = find_in(ok, "TextControl", name=DONE_TEXT)
            got = find_in(ok, "ButtonControl", autoId="gotItButton") or find_in(ok, "ButtonControl", name="Понятно")
            if done or got:
                print("  ✓ Покупка завершена")
                if got:
                    click(got, "Понятно")
                return True
        time.sleep(1.0)
    print("  ⚠ экран 'Покупка завершена' не дождались (проверь баланс Robox вручную)")
    return False


def run(mode, target):
    win, nodes = scan_window_nodes(debug=(mode == "find"))
    if not nodes:
        print("Окно Roblox / страница Buy Robux не найдены. Открой в Roblox экран покупки Robux и повтори.")
        return 1
    packs = find_packs(nodes, debug=(mode == "find"))
    print(f"Найдено паков: {len(packs)}")
    for p in packs:
        print(f"  - {p['robux']} Robux — {p['price']}")

    if mode == "find":
        # покажем окно оплаты и успех, если открыты сейчас
        dlg = auto.WindowControl(searchDepth=3, Name=STORE_WINDOW_NAME)
        if dlg.Exists(0, 0):
            print(f"Окно оплаты открыто. Способ оплаты: {dialog_payment_method(dlg)}; "
                  f"кнопка 'Купить': {'есть' if find_in(dlg, 'ButtonControl', name='Купить') else 'нет'}")
        return 0

    if target is None:
        print("Укажи сумму Robux: --select N или --buy N")
        return 1
    pack = next((p for p in packs if p["robux"] == int(target)), None)
    if not pack:
        print(f"Пак на {target} Robux не найден среди: {[p['robux'] for p in packs]}")
        return 1

    print(f"Выбираю пак {pack['robux']} Robux ({pack['price']})…")
    if not click(pack["button"], f"пак {pack['robux']}"):
        return 1

    do_buy = (mode == "buy")
    ok = confirm_purchase(do_click=do_buy)
    if mode == "select":
        print("Режим --select: окно оплаты открыто, подтверждение НЕ нажато. "
              "Закрой окно вручную, если не покупаешь.")
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--find", action="store_true", help="найти и показать элементы, без кликов")
    g.add_argument("--select", type=int, metavar="ROBUX", help="кликнуть пак и открыть окно оплаты (без подтверждения)")
    g.add_argument("--buy", type=int, metavar="ROBUX", help="полная покупка (спишет баланс MS!)")
    args = ap.parse_args()

    auto.SetGlobalSearchTimeout(2)
    if args.find:
        return run("find", None)
    if args.select is not None:
        return run("select", args.select)
    return run("buy", args.buy)


if __name__ == "__main__":
    sys.exit(main())
