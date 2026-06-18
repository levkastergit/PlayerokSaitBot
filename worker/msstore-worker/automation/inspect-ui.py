"""
Проба UI Automation для Фазы 2: дамп дерева элементов окна приложения Roblox.
Цель — понять, ВИДИТ ли автоматизация (UIA) кнопки выбора пака Robux и кнопку
покупки, или WebView2 — «чёрный ящик» (тогда нужен путь через WebView2 remote debugging).

Запуск:
  1) Открой приложение Roblox и зайди на экран покупки Robux (Robux → пакеты).
  2) python inspect-ui.py
Результат — ui-tree.txt рядом со скриптом. Пришли его мне.

Денег НЕ тратит, ничего не покупает — только читает дерево интерфейса.
"""
import os
import sys
import time
import collections

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ui-tree.txt")

try:
    import uiautomation as auto
except Exception as e:  # noqa: BLE001
    print(f"Нет uiautomation ({e}). Установи: pip install uiautomation")
    sys.exit(2)


# Настоящее окно приложения Roblox — НЕ редактор Cursor/Code (у тех класс Chrome_WidgetWin_*).
def is_roblox_app(w):
    nm = (w.Name or "").strip().lower()
    cl = (w.ClassName or "")
    if "cursor" in nm or "code" in nm or "powershell" in nm:
        return False
    if cl == "WINDOWSCLIENT":
        return True
    if nm == "roblox":
        return True
    if "roblox" in cl.lower():
        return True
    return False


def bring_to_front(w):
    for fn in ("Restore", "SetActive", "SetTopmost"):
        try:
            getattr(w, fn)()
        except Exception:
            pass
    time.sleep(1.5)


# Ключевые слова экрана покупки Robux / нативного окна оплаты.
KEYWORDS = (
    "robux", "купить", "buy", "microsoft", "balance", "баланс", "оплат", "pay",
    "подтверд", "confirm", "80 robux", "400 robux", "пакет", "package", "price", "цена",
)


def _match(name):
    n = (name or "").lower()
    return any(k in n for k in KEYWORDS)


# Глобальный обход дерева UIA в поисках элементов покупки (на случай, если контент
# WebView2 не попал в дерево окна Roblox). Ограничен по числу узлов, чтобы не зависнуть.
def global_search(f, max_nodes=3500, max_depth=28):
    f.write("\n==================== ГЛОБАЛЬНЫЙ ПОИСК элементов покупки ====================\n")
    root = auto.GetRootControl()
    q = collections.deque([(root, 0)])
    seen = 0
    hits = 0
    while q and seen < max_nodes:
        ctrl, depth = q.popleft()
        seen += 1
        try:
            name = ctrl.Name
            ctype = ctrl.ControlTypeName
        except Exception:
            continue
        if _match(name):
            try:
                r = ctrl.BoundingRectangle
                rect = f"({r.left},{r.top},{r.right},{r.bottom})"
            except Exception:
                rect = "?"
            f.write(f"  HIT {ctype} name={name!r} rect={rect}\n")
            hits += 1
        if depth < max_depth:
            try:
                for c in ctrl.GetChildren():
                    q.append((c, depth + 1))
            except Exception:
                pass
    f.write(f"  --- осмотрено узлов: {seen}, совпадений: {hits} ---\n")
    print(f"  глобальный поиск: узлов={seen}, совпадений={hits}")


def dump(ctrl, f, depth, maxdepth=45, maxsiblings=400):
    if depth > maxdepth:
        return
    try:
        name = ctrl.Name
        cls = ctrl.ClassName
        ctype = ctrl.ControlTypeName
        autoid = ctrl.AutomationId
    except Exception as e:  # noqa: BLE001
        f.write(f"{'  ' * depth}<err {e}>\n")
        return
    f.write(f"{'  ' * depth}{ctype} name={name!r} class={cls!r} autoId={autoid!r}\n")
    try:
        kids = ctrl.GetChildren()
    except Exception:
        kids = []
    for i, c in enumerate(kids):
        if i >= maxsiblings:
            f.write(f"{'  ' * (depth + 1)}... ({len(kids) - maxsiblings} more siblings)\n")
            break
        dump(c, f, depth + 1, maxdepth, maxsiblings)


def main():
    root = auto.GetRootControl()
    windows = root.GetChildren()
    targets = [w for w in windows if is_roblox_app(w)]

    # Выводим окно Roblox на передний план, чтобы содержимое отрисовалось в дерево UIA.
    for w in targets:
        bring_to_front(w)

    with open(OUT, "w", encoding="utf-8") as f:
        if not targets:
            f.write("Окно Roblox не найдено. Top-level окна:\n")
            for w in windows:
                f.write(f"  - name={w.Name!r} class={w.ClassName!r}\n")
            f.write("\nОткрой приложение Roblox и повтори. Либо пришли список выше — найду нужное окно.\n")
            print(f"Окно Roblox не найдено. См. {OUT}")
            return
        for w in targets:
            f.write(f"\n==================== WINDOW name={w.Name!r} class={w.ClassName!r} ====================\n")
            dump(w, f, 0)
        global_search(f)
    # Краткая сводка в консоль: сколько кнопок/текста удалось увидеть.
    print(f"Готово: {OUT}")
    try:
        text = open(OUT, encoding="utf-8").read()
        print(f"  строк в дереве: {text.count(chr(10))}")
        print(f"  ButtonControl: {text.count('ButtonControl')}, TextControl: {text.count('TextControl')}, "
              f"DocumentControl: {text.count('DocumentControl')}")
    except Exception:
        pass


if __name__ == "__main__":
    main()
