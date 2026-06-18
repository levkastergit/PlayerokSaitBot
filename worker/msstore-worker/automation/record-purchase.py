"""
Комплексный рекордер процесса покупки Robux (для Фазы 2 — UI-автоматизация).

Экран покупки Roblox невидим для UI Automation, поэтому пишем ВСЁ, что может пригодиться:
  • на каждый клик — скриншот активного окна + вырезка вокруг курсора (шаблон кнопки)
    + ещё скриншот через ~1.2 c (поймать появившийся экран / нативное окно оплаты);
  • UIA-дерево активного окна на каждом клике (-uia.txt) — чтобы увидеть, автоматизируемо ли
    нативное окно оплаты Microsoft (оно — отдельное окно и, скорее всего, ДА, в отличие от webview);
  • элемент UIA под курсором в момент клика;
  • список верхнеуровневых окон (заголовок/класс/PID/процесс) — опознать окно оплаты;
  • таймлайн-скриншоты каждые 1.5 c (переходы экранов без кликов);
  • скроллы и навигационные клавиши (Enter/Tab/Esc/стрелки/F-клавиши).
    ТЕКСТ НЕ ЛОГИРУЕТСЯ — символьные клавиши (пароль/PIN) не записываются.

Запуск:   python record-purchase.py
Пройди мышью весь путь покупки. Останови — F12.
Результат — папка recording/ (скриншоты + events.jsonl + *-uia.txt).
Папка в .gitignore. Сеть/прокси не трогаем — покупка идёт как обычно.
"""

import os
import sys
import time
import json
import threading
import queue
import ctypes
from ctypes import wintypes

try:
    from pynput import mouse, keyboard
except Exception:  # noqa: BLE001
    print("Нет pynput. Установи: pip install pynput")
    sys.exit(2)
try:
    import mss
    import mss.tools
except Exception:  # noqa: BLE001
    print("Нет mss. Установи: pip install mss")
    sys.exit(2)

try:
    import uiautomation as auto
    _HAS_UIA = True
except Exception:  # noqa: BLE001
    _HAS_UIA = False

OUTDIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "recording")
os.makedirs(OUTDIR, exist_ok=True)
LOG = os.path.join(OUTDIR, "events.jsonl")

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
try:
    user32.SetProcessDPIAware()
except Exception:  # noqa: BLE001
    pass

_idx = 0
_lock = threading.Lock()
_stop = threading.Event()
_uia_q = queue.Queue()


# ── низкоуровневые хелперы (ctypes, потокобезопасны) ─────────────────────────
def proc_name(pid):
    if not pid:
        return ""
    h = kernel32.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED_INFORMATION
    if not h:
        return ""
    try:
        size = wintypes.DWORD(260)
        buf = ctypes.create_unicode_buffer(260)
        if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return os.path.basename(buf.value)
    finally:
        kernel32.CloseHandle(h)
    return ""


def win_info(hwnd):
    rect = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    title = ctypes.create_unicode_buffer(512)
    user32.GetWindowTextW(hwnd, title, 512)
    cls = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, cls, 256)
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return {
        "hwnd": int(hwnd),
        "title": title.value,
        "class": cls.value,
        "pid": int(pid.value),
        "proc": proc_name(pid.value),
        "rect": (int(rect.left), int(rect.top), int(rect.right), int(rect.bottom)),
    }


def fg_window():
    return win_info(user32.GetForegroundWindow())


def top_windows():
    res = []
    proto = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

    def cb(hwnd, _):
        try:
            if not user32.IsWindowVisible(hwnd):
                return True
            info = win_info(hwnd)
            w = info["rect"][2] - info["rect"][0]
            h = info["rect"][3] - info["rect"][1]
            if not info["title"].strip() and (w < 80 or h < 80):
                return True
            res.append(info)
        except Exception:  # noqa: BLE001
            pass
        return True

    user32.EnumWindows(proto(cb), 0)
    return res


# ── скриншоты (mss; свой инстанс на вызов = потокобезопасно) ─────────────────
def grab_png(region, path):
    left, top, right, bottom = region
    w, h = max(1, right - left), max(1, bottom - top)
    try:
        with mss.mss() as sct:
            shot = sct.grab({"left": left, "top": top, "width": w, "height": h})
            mss.tools.to_png(shot.rgb, shot.size, output=path)
    except Exception as e:  # noqa: BLE001
        print(f"  grab err: {e}")


def monitor_of(rect):
    cx = (rect[0] + rect[2]) // 2
    cy = (rect[1] + rect[3]) // 2
    try:
        with mss.mss() as sct:
            for m in sct.monitors[1:]:
                if m["left"] <= cx < m["left"] + m["width"] and m["top"] <= cy < m["top"] + m["height"]:
                    return (m["left"], m["top"], m["left"] + m["width"], m["top"] + m["height"])
    except Exception:  # noqa: BLE001
        pass
    return rect


# ── UIA-дамп (отдельный поток с инициализированным COM) ──────────────────────
def _uia_line(c, depth):
    try:
        r = c.BoundingRectangle
        rect = (r.left, r.top, r.right, r.bottom)
    except Exception:  # noqa: BLE001
        rect = None
    try:
        return f"{'  ' * depth}{c.ControlTypeName} name={c.Name!r} cls={c.ClassName!r} autoId={c.AutomationId!r} rect={rect}"
    except Exception as e:  # noqa: BLE001
        return f"{'  ' * depth}<err {e}>"


def _uia_dump(c, f, depth=0, maxd=28, maxsib=250):
    f.write(_uia_line(c, depth) + "\n")
    if depth >= maxd:
        return
    try:
        kids = c.GetChildren()
    except Exception:  # noqa: BLE001
        kids = []
    for i, k in enumerate(kids):
        if i >= maxsib:
            f.write(f"{'  ' * (depth + 1)}... (ещё {len(kids) - maxsib})\n")
            break
        _uia_dump(k, f, depth + 1, maxd, maxsib)


def uia_worker():
    try:
        ctypes.windll.ole32.CoInitializeEx(None, 0)
    except Exception:  # noqa: BLE001
        pass
    while not _stop.is_set() or not _uia_q.empty():
        try:
            idx, x, y, hwnd = _uia_q.get(timeout=0.5)
        except queue.Empty:
            continue
        if not _HAS_UIA:
            continue
        try:
            el = auto.ControlFromPoint(x, y)
            with open(os.path.join(OUTDIR, f"{idx:03d}-uia.txt"), "w", encoding="utf-8") as f:
                f.write("== ЭЛЕМЕНТ ПОД КУРСОРОМ ==\n")
                if el:
                    f.write(_uia_line(el, 0) + "\n")
                    p = el.GetParentControl()
                    d = 1
                    while p and d <= 4:
                        f.write(_uia_line(p, d) + "  (предок)\n")
                        p = p.GetParentControl()
                        d += 1
                f.write("\n== ДЕРЕВО АКТИВНОГО ОКНА ==\n")
                try:
                    win = auto.ControlFromHandle(hwnd)
                    if win:
                        _uia_dump(win, f)
                except Exception as e:  # noqa: BLE001
                    f.write(f"<dump err {e}>\n")
        except Exception as e:  # noqa: BLE001
            print(f"  uia err: {e}")


# ── обработчики событий ──────────────────────────────────────────────────────
def on_click(x, y, button, pressed):
    global _idx
    if not pressed:
        return
    with _lock:
        _idx += 1
        idx = _idx
    fg = fg_window()
    grab_png(fg["rect"], os.path.join(OUTDIR, f"{idx:03d}-window.png"))
    grab_png((x - 150, y - 90, x + 150, y + 90), os.path.join(OUTDIR, f"{idx:03d}-click.png"))
    rec = {
        "idx": idx, "t": round(time.time(), 3), "type": "click", "button": str(button),
        "x": int(x), "y": int(y),
        "rel_x": int(x - fg["rect"][0]), "rel_y": int(y - fg["rect"][1]),
        "fg": fg, "windows": top_windows(),
    }
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    print(f"[{idx}] клик ({x},{y}) отн.окна ({rec['rel_x']},{rec['rel_y']}) окно='{fg['title']}' [{fg['proc']}]")
    _uia_q.put((idx, x, y, fg["hwnd"]))

    def after():
        fg2 = fg_window()
        grab_png(fg2["rect"], os.path.join(OUTDIR, f"{idx:03d}-after.png"))
    threading.Timer(1.2, after).start()


def on_scroll(x, y, dx, dy):
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps({"t": round(time.time(), 3), "type": "scroll", "x": int(x), "y": int(y), "dx": dx, "dy": dy}, ensure_ascii=False) + "\n")


# Только навигационные клавиши; символьные (текст/пароль/PIN) НЕ логируем.
_NAV_KEYS = {
    keyboard.Key.enter, keyboard.Key.tab, keyboard.Key.esc, keyboard.Key.space,
    keyboard.Key.up, keyboard.Key.down, keyboard.Key.left, keyboard.Key.right,
    keyboard.Key.backspace, keyboard.Key.delete, keyboard.Key.home, keyboard.Key.end,
}


def on_press(key):
    if key == keyboard.Key.f12:
        print("F12 — остановка записи")
        _stop.set()
        return False
    if key in _NAV_KEYS:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(json.dumps({"t": round(time.time(), 3), "type": "key", "key": str(key)}, ensure_ascii=False) + "\n")


def timeline_worker():
    seq = 0
    tdir = os.path.join(OUTDIR, "timeline")
    os.makedirs(tdir, exist_ok=True)
    while not _stop.is_set():
        seq += 1
        try:
            fg = fg_window()
            grab_png(monitor_of(fg["rect"]), os.path.join(tdir, f"t{seq:04d}.png"))
        except Exception:  # noqa: BLE001
            pass
        _stop.wait(1.5)


def main():
    open(LOG, "w", encoding="utf-8").close()
    print("=" * 72)
    print(" КОМПЛЕКСНАЯ ЗАПИСЬ ПОКУПКИ. Пройди мышью весь путь покупки Robux:")
    print("   пак Robux -> Купить -> 'Microsoft account balance' -> Подтвердить.")
    print(" Пишем: клики, скриншоты, UIA-дерево, окна/процессы, таймлайн, скроллы.")
    print(" Текст/пароль НЕ пишем. Останов — F12.   Папка:", OUTDIR)
    print(" UIA:", "доступен" if _HAS_UIA else "НЕТ (pip install uiautomation)")
    print("=" * 72)

    tl = threading.Thread(target=timeline_worker, daemon=True)
    tl.start()
    uw = threading.Thread(target=uia_worker, daemon=True)
    uw.start()

    ml = mouse.Listener(on_click=on_click, on_scroll=on_scroll)
    ml.start()
    with keyboard.Listener(on_press=on_press) as kl:
        kl.join()
    ml.stop()
    time.sleep(2.0)  # дать дописаться отложенным скриншотам и UIA
    print(f"Готово. Кликов: {_idx}. Файлы в {OUTDIR}")


if __name__ == "__main__":
    main()
