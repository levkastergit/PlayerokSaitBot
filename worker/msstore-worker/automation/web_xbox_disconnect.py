#!/usr/bin/env python3
"""
Веб-автоматизация шага «отвязать Xbox» перед сменой аккаунта в приложении (шаги 2-4 флоу).

Зачем: приложение Roblox из Microsoft Store входит в аккаунт через привязанную Xbox/Microsoft-
личность (SSO). Чтобы Robux ушли НУЖНОМУ покупателю, перед сменой аккаунта в приложении надо на
ПРЕДЫДУЩЕМ аккаунте на странице безопасности нажать Disconnect у «Connected with an Xbox account».
Если такой привязки нет — аккаунт уже отвязан, делать нечего.

Что делает скрипт:
  1) «Сбрасывает» сессию: каждый запуск стартует ЧИСТЫЙ профиль браузера (свой временный
     user-data-dir), т.е. предыдущий вход не подхватывается.
  2) Логинит нужный аккаунт инъекцией cookie .ROBLOSECURITY (это и есть «вход в веб-версию»;
     для автоматизации это надёжнее логина по паролю — без FunCaptcha). Cookie берём из того же
     хранилища, что и баланс/выдача (roblox_accounts).
  3) Идёт на https://www.roblox.com/my/account#!/security и ищет блок Xbox.

Режимы:
  python web_xbox_disconnect.py --check     только проверить, привязан ли Xbox (без изменений)
  python web_xbox_disconnect.py --inspect   дамп кандидатов-элементов + скриншот + HTML (для отладки селекторов)
  python web_xbox_disconnect.py --run        найти и нажать Disconnect у Xbox-привязки, подтвердить

Вход (по приоритету):
  • Логин/пароль: --username/--password (или env ROBLOX_USER/ROBLOX_PASS). Браузер видимый — при
    капче (FunCaptcha) или 2FA реши их РУКАМИ в открытом окне, скрипт ждёт до --login-wait сек.
    После входа можно достать .ROBLOSECURITY (--emit-cookie) и переиспользовать (без повторной капчи).
  • Cookie: --cookie <значение> | env ROBLOX_COOKIE | stdin (если логина/пароля нет).
Браузер: --browser chrome|edge (по умолчанию chrome; на Win11 есть edge как запасной).
Вывод: финальный JSON-результат в stdout (последняя строка), логи — в stderr.

ВАЖНО: --run выполняет РЕАЛЬНОЕ действие над живым аккаунтом (отвязка). Запускать осознанно.
"""

import os
import sys
import json
import time
import tempfile
import argparse
import shutil

# Кириллица в выводе на консолях с не-UTF-8 кодовой страницей.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

try:
    from selenium import webdriver
    from selenium.webdriver.common.by import By
    from selenium.webdriver.common.keys import Keys
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
    from selenium.common.exceptions import (
        TimeoutException,
        NoSuchElementException,
        WebDriverException,
    )
except Exception:  # noqa: BLE001
    print("Нет selenium. Установи: pip install selenium", file=sys.stderr)
    sys.exit(2)

SECURITY_URL = "https://www.roblox.com/my/account#!/security"
HOME_URL = "https://www.roblox.com/"
AUTH_URL = "https://users.roblox.com/v1/users/authenticated"

# Тексты кнопок «отключить» на разных языках аккаунта.
DISCONNECT_WORDS = ["disconnect", "unlink", "remove", "отключить", "отвязать", "удалить"]
# Слова, по которым опознаём блок Xbox/Microsoft-привязки.
XBOX_WORDS = ["xbox", "microsoft"]


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def _safe_get(driver, url):
    """Навигация, которая НЕ вешает скрипт: страница Roblox/капча может грузиться вечно."""
    try:
        driver.get(url)
    except WebDriverException as e:
        log("Навигация %s прервана (продолжаю): %s" % (url, str(e)[:120]))


def get_cookie(args):
    if args.cookie:
        return args.cookie.strip()
    env = os.environ.get("ROBLOX_COOKIE", "").strip()
    if env:
        return env
    if not sys.stdin.isatty():
        data = sys.stdin.read().strip()
        if data:
            return data
    return ""


def normalize_cookie(raw):
    v = (raw or "").strip()
    if v.lower().startswith(".roblosecurity="):
        v = v.split("=", 1)[1]
    return v.strip()


def make_driver(browser, headless, profile_dir):
    """Чистый профиль (свой user-data-dir) => сессия предыдущего входа НЕ подхватывается."""
    if browser == "edge":
        from selenium.webdriver.edge.options import Options as EdgeOptions
        opts = EdgeOptions()
        flag = "--user-data-dir=" + profile_dir
    else:
        from selenium.webdriver.chrome.options import Options as ChromeOptions
        opts = ChromeOptions()
        flag = "--user-data-dir=" + profile_dir

    opts.page_load_strategy = "eager"  # отдаёт управление по DOMContentLoaded, не ждёт все ресурсы/капчу
    opts.add_argument(flag)
    opts.add_argument("--no-first-run")
    opts.add_argument("--no-default-browser-check")
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_argument("--window-size=1280,1000")
    opts.add_argument("--lang=en-US")
    if headless:
        opts.add_argument("--headless=new")

    if browser == "edge":
        return webdriver.Edge(options=opts)
    return webdriver.Chrome(options=opts)


def inject_cookie_login(driver, cookie):
    """«Вход в веб-версию» = инъекция .ROBLOSECURITY в чистую сессию."""
    _safe_get(driver, HOME_URL)
    time.sleep(1.0)
    # На всякий случай вычистим всё, что могло прийти с домашней страницы (полный сброс сессии).
    try:
        driver.delete_all_cookies()
    except WebDriverException:
        pass
    driver.add_cookie(
        {
            "name": ".ROBLOSECURITY",
            "value": cookie,
            "domain": ".roblox.com",
            "path": "/",
            "secure": True,
        }
    )
    _safe_get(driver, HOME_URL)
    time.sleep(1.5)


def _find_first(driver, locators, timeout=15):
    """Первый видимый элемент из списка (by, selector). None, если не нашли за timeout."""
    end = time.time() + timeout
    while time.time() < end:
        for by, sel in locators:
            try:
                el = driver.find_element(by, sel)
                if el.is_displayed():
                    return el
            except WebDriverException:
                pass
        time.sleep(0.4)
    return None


def _react_set_value(driver, el, value):
    """Выставить значение так, чтобы React-форма зарегистрировала ввод (иначе кнопка остаётся disabled)."""
    driver.execute_script(
        "const el=arguments[0],val=arguments[1];"
        "const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;"
        "s.call(el,val);"
        "el.dispatchEvent(new Event('input',{bubbles:true}));"
        "el.dispatchEvent(new Event('change',{bubbles:true}));",
        el, value,
    )


def _fill(driver, el, value):
    try:
        el.click()
    except WebDriverException:
        pass
    try:
        el.clear()
        el.send_keys(value)  # обычный путь — шлёт реальные key-события
    except WebDriverException:
        pass
    try:
        if (el.get_attribute("value") or "") != value:
            _react_set_value(driver, el, value)  # запасной React-путь
    except WebDriverException:
        pass


def password_login(driver, username, password, wait_auth=180):
    """Вход по логину/паролю на roblox.com с человеком-в-цикле для капчи/2FA.
    Заполняет форму (React-надёжно), жмёт вход кнопкой И Enter, затем ОПРАШИВАЕТ who_am_i, давая
    время решить FunCaptcha/2FA в видимом окне. Возвращает user или None. Сессия чистая (свежий профиль)."""
    _safe_get(driver, "https://www.roblox.com/login")
    time.sleep(1.5)
    try:
        driver.delete_all_cookies()  # гарантированно сбрасываем прошлый вход
    except WebDriverException:
        pass
    _safe_get(driver, "https://www.roblox.com/login")
    time.sleep(2.0)

    user_el = _find_first(driver, [
        (By.ID, "login-username"), (By.NAME, "username"),
        (By.CSS_SELECTOR, "input[autocomplete='username']"),
        (By.CSS_SELECTOR, "input[type='text']"),
    ], timeout=20)
    pass_el = _find_first(driver, [
        (By.ID, "login-password"), (By.NAME, "password"),
        (By.CSS_SELECTOR, "input[type='password']"),
    ], timeout=10)

    if user_el and pass_el:
        _fill(driver, user_el, username)
        _fill(driver, pass_el, password)
        uv = (user_el.get_attribute("value") or "")
        log("Поля заполнены (user='%s', pass=%d симв.)." % (uv, len(pass_el.get_attribute("value") or "")))
        btn = _find_first(driver, [
            (By.ID, "login-button"),
            (By.CSS_SELECTOR, "button#login-button"),
            (By.CSS_SELECTOR, "button[type='submit']"),
            (By.XPATH, "//button[contains(.,'Log In') or contains(.,'Войти') or contains(.,'Вход') or contains(.,'Sign In')]"),
        ], timeout=8)
        clicked = False
        if btn:
            try:
                driver.execute_script("arguments[0].scrollIntoView({block:'center'});", btn)
                btn.click()
                clicked = True
                log("Нажал кнопку входа: %r" % (btn.text or "").strip())
            except WebDriverException:
                try:
                    driver.execute_script("arguments[0].click();", btn)
                    clicked = True
                    log("Нажал кнопку входа (JS-клик).")
                except WebDriverException as e:
                    log("Кнопку входа кликнуть не удалось: %s" % e)
        if not clicked:
            try:
                pass_el.send_keys(Keys.RETURN)
                log("Кнопку не нашёл — отправил форму клавишей Enter.")
            except WebDriverException:
                log("Не удалось отправить форму (ни кнопки, ни Enter).")
    else:
        log("Поля логина не нашлись — войди ВРУЧНУЮ в открытом окне.")

    log("Если появилась КАПЧА/2FA — реши её в окне браузера (жду до %ss)." % wait_auth)
    deadline = time.time() + wait_auth
    while time.time() < deadline:
        user, _ = who_am_i(driver)
        if user:
            log("Авторизован как @%s (id=%s)" % (user.get("name"), user.get("id")))
            return user
        time.sleep(3)
    # Диагностика при неудаче: скрин текущего состояния.
    try:
        dbg = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web-inspect")
        os.makedirs(dbg, exist_ok=True)
        shot = os.path.join(dbg, "login-fail.png")
        driver.save_screenshot(shot)
        log("Не дождался входа. Скрин состояния: %s" % shot)
    except WebDriverException:
        pass
    return None


def who_am_i(driver):
    """Проверка входа: same-origin fetch к users.roblox.com (cookie уходит, CORS у Roblox разрешён)."""
    script = """
    const done = arguments[arguments.length - 1];
    fetch('%s', {credentials:'include'})
      .then(r => r.json().then(j => done({status:r.status, body:j})).catch(() => done({status:r.status, body:null})))
      .catch(e => done({status:0, body:String(e)}));
    """ % AUTH_URL
    driver.set_script_timeout(20)
    try:
        res = driver.execute_async_script(script)
    except WebDriverException as e:
        return None, {"error": str(e)}
    if res and res.get("status") == 200 and isinstance(res.get("body"), dict) and res["body"].get("id"):
        return res["body"], res
    return None, res


def _in_page_fetch(driver, js_body, timeout=20):
    """Выполнить fetch ИЗ КОНТЕКСТА залогиненной страницы roblox.com (cookie + CORS + CSRF как у самого сайта)."""
    driver.set_script_timeout(timeout)
    script = "const done = arguments[arguments.length-1];\n(async () => {\n" + js_body + "\n})().then(done).catch(e => done({status:0, body:String(e)}));"
    try:
        return driver.execute_async_script(script)
    except WebDriverException as e:
        return {"status": 0, "body": str(e)}


def api_xbox_status(driver):
    """Привязка Xbox через документированный эндпоинт GET auth.roblox.com/v1/xbox-live/account.
    Сначала получаем CSRF (без него Roblox отдаёт 400 «Invalid Token»), затем GET с X-CSRF-TOKEN.
    Возвращает {'linked': True/False/None, 'raw': {...}}. None = эндпоинт не дал однозначного ответа."""
    res = _in_page_fetch(driver, """
      let csrf = null;
      try {
        const c = await fetch('https://auth.roblox.com/v1/authentication-ticket/', {
          method:'POST', credentials:'include', headers:{'Content-Type':'application/json'}, body:'{}'});
        csrf = c.headers.get('x-csrf-token');
      } catch(e) {}
      const h = {}; if (csrf) h['X-CSRF-TOKEN'] = csrf;
      const r = await fetch('https://auth.roblox.com/v1/xbox-live/account', {credentials:'include', headers:h});
      const t = await r.text();
      return {status:r.status, body:t, csrf: csrf ? 'yes' : 'no'};
    """)
    raw = {"endpoint": "GET /v1/xbox-live/account", **(res or {})}
    status = (res or {}).get("status")
    body = (res or {}).get("body") or ""
    linked = None
    if status == 200:
        low = body.lower()
        # тело с userId/accountName/связанным аккаунтом => привязан; пустой/false => нет
        if any(k in low for k in ['"userid"', '"accountname"', '"robloxuserid"', '"name"', '"id":']):
            linked = True
        elif body.strip() in ("", "null", "{}", "false"):
            linked = False
    elif status in (400, 404):
        linked = False  # «нет связанного аккаунта» обычно так и отдаётся
    return {"linked": linked, "raw": raw}


def api_xbox_disconnect(driver):
    """Отвязать через API (то, что под кнопкой Disconnect). Пробуем оба известных пути + CSRF.
    Эндпоинты community-документированы и НЕ подтверждены на 2026 — ответ логируем, после проверяем статус."""
    res = _in_page_fetch(driver, """
      const paths = ['https://auth.roblox.com/v1/xbox/disconnect',
                     'https://auth.roblox.com/v1/xbox-live/disconnect'];
      const out = [];
      let csrf = null;
      for (const url of paths) {
        let r = await fetch(url, {method:'POST', credentials:'include',
                 headers:{'Content-Type':'application/json'}, body:'{}'});
        csrf = r.headers.get('x-csrf-token') || csrf;
        if (r.status === 403 && csrf) {
          r = await fetch(url, {method:'POST', credentials:'include',
               headers:{'Content-Type':'application/json','X-CSRF-TOKEN':csrf}, body:'{}'});
        }
        const t = await r.text();
        out.push({url, status:r.status, body:(t||'').slice(0,300)});
        if (r.status === 200) break;
      }
      return {tried: out};
    """)
    tried = (res or {}).get("tried") or []
    ok = any(t.get("status") == 200 for t in tried)
    return {"ok": ok, "raw": res}


def open_security(driver):
    _safe_get(driver, SECURITY_URL)
    # SPA с hash-роутом: подождём, пока подтянется контент аккаунта.
    deadline = time.time() + 25
    while time.time() < deadline:
        try:
            body = driver.find_element(By.TAG_NAME, "body").text.lower()
        except WebDriverException:
            body = ""
        if "security" in body or "xbox" in body or "two step" in body or "двух" in body:
            break
        time.sleep(0.8)
    time.sleep(1.5)


def find_xbox_context(driver):
    """Найти элемент(ы), относящиеся к Xbox/Microsoft-привязке. Возвращает список web-элементов."""
    hits = []
    xpath = "//*[" + " or ".join(
        ["contains(translate(normalize-space(.), 'XBOMICRSFT', 'xbomicrsft'), '%s')" % w for w in XBOX_WORDS]
    ) + "]"
    try:
        for el in driver.find_elements(By.XPATH, xpath):
            try:
                txt = (el.text or "").strip()
            except WebDriverException:
                continue
            low = txt.lower()
            if not txt or len(txt) >= 400 or not any(w in low for w in XBOX_WORDS):
                continue
            # «Microsoft Authenticator» в разделе 2FA — НЕ привязка Xbox; отсекаем ложняк.
            if "authenticator" in low and "xbox" not in low:
                continue
            hits.append(el)
    except WebDriverException:
        pass
    return hits


def find_disconnect_button(driver):
    """Кнопка/ссылка «Disconnect» рядом с Xbox-блоком. Возвращает элемент или None."""
    conds = " or ".join(
        ["contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZАБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ', "
         "'abcdefghijklmnopqrstuvwxyzабвгдеёжзийклмнопрстуфхцчшщъыьэюя'), '%s')" % w for w in DISCONNECT_WORDS]
    )
    xpath = "//button[%s] | //a[%s] | //*[@role='button'][%s]" % (conds, conds, conds)
    try:
        for el in driver.find_elements(By.XPATH, xpath):
            try:
                if not el.is_displayed():
                    continue
            except WebDriverException:
                continue
            return el
    except WebDriverException:
        pass
    return None


def xbox_is_linked(driver):
    """Эвристика: есть блок Xbox И рядом кнопка отключения => привязан. True/False/None(не уверены)."""
    ctx = find_xbox_context(driver)
    if not ctx:
        return False  # упоминаний Xbox нет вовсе — считаем не привязан
    btn = find_disconnect_button(driver)
    if btn is not None:
        return True
    # Есть текст про Xbox, но кнопки отключения не видно — неоднозначно.
    return None


def click_confirm_if_any(driver):
    """После клика Disconnect может всплыть модалка подтверждения — нажать её кнопку."""
    time.sleep(1.0)
    confirm_words = DISCONNECT_WORDS + ["ok", "yes", "confirm", "да", "подтвердить", "продолжить"]
    conds = " or ".join(
        ["contains(translate(., 'ABCDEFGHIJKLMNOPQRSTUVWXYZАБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ', "
         "'abcdefghijklmnopqrstuvwxyzабвгдеёжзийклмнопрстуфхцчшщъыьэюя'), '%s')" % w for w in confirm_words]
    )
    xpath = "//div[contains(@class,'modal')]//button[%s] | //div[@role='dialog']//button[%s]" % (conds, conds)
    try:
        for el in driver.find_elements(By.XPATH, xpath):
            if el.is_displayed():
                el.click()
                log("  подтвердил модалку: %r" % (el.text or "").strip())
                time.sleep(1.5)
                return True
    except WebDriverException:
        pass
    return False


def dump_inspect(driver, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    shot = os.path.join(out_dir, "security.png")
    html = os.path.join(out_dir, "security.html")
    try:
        driver.save_screenshot(shot)
    except WebDriverException:
        shot = None
    try:
        with open(html, "w", encoding="utf-8") as f:
            f.write(driver.page_source)
    except OSError:
        html = None

    candidates = []
    for el in find_xbox_context(driver):
        try:
            candidates.append({
                "tag": el.tag_name,
                "text": (el.text or "").strip()[:200],
                "class": el.get_attribute("class"),
                "id": el.get_attribute("id"),
            })
        except WebDriverException:
            continue
    # Все видимые кнопки/ссылки — чтобы потом закрепить точный селектор.
    buttons = []
    try:
        for el in driver.find_elements(By.XPATH, "//button | //a[@href] | //*[@role='button']"):
            try:
                if not el.is_displayed():
                    continue
                t = (el.text or "").strip()
                if t:
                    buttons.append({"tag": el.tag_name, "text": t[:80], "class": el.get_attribute("class")})
            except WebDriverException:
                continue
    except WebDriverException:
        pass
    return {"screenshot": shot, "html": html, "xbox_candidates": candidates, "buttons": buttons[:60]}


def run(args):
    result = {"mode": args.mode, "logged_in": False, "account": None,
              "xbox_linked": None, "disconnected": False, "message": ""}
    username = (args.username or os.environ.get("ROBLOX_USER", "")).strip()
    password = args.password if args.password is not None else os.environ.get("ROBLOX_PASS", "")
    use_password = bool(username and password)
    cookie = "" if use_password else normalize_cookie(get_cookie(args))
    if not use_password and not cookie:
        result["message"] = "Нужен вход: --username/--password (env ROBLOX_USER/ROBLOX_PASS) или --cookie."
        print(json.dumps(result, ensure_ascii=False))
        return 2

    headless = args.headless
    if use_password and headless:
        log("⚠ Вход паролем в headless невозможен (капча/2FA) — запускаю headed.")
        headless = False

    profile_dir = tempfile.mkdtemp(prefix="rbx-web-")
    driver = None
    try:
        log("Старт %s (%s, чистый профиль, вход: %s)" % (
            args.browser, "headless" if headless else "headed", "пароль" if use_password else "cookie"))
        driver = make_driver(args.browser, headless, profile_dir)
        try:
            driver.set_page_load_timeout(45)
        except WebDriverException:
            pass
        if use_password:
            user = password_login(driver, username, password, wait_auth=args.login_wait)
            if not user:
                result["message"] = "Вход не выполнен: не дождался авторизации (капча/2FA не решены или неверные данные)."
                print(json.dumps(result, ensure_ascii=False))
                return 1
        else:
            inject_cookie_login(driver, cookie)
            user, raw = who_am_i(driver)
            if not user:
                result["message"] = "Вход не выполнен: cookie невалидна/истекла или сменился IP. raw=%s" % json.dumps(raw, ensure_ascii=False)[:300]
                print(json.dumps(result, ensure_ascii=False))
                return 1
        result["logged_in"] = True
        result["account"] = {"id": user.get("id"), "name": user.get("name"), "displayName": user.get("displayName")}
        # Свежая сессия — отдаём факт получения cookie (значение только по --emit-cookie: это секрет).
        try:
            c = driver.get_cookie(".ROBLOSECURITY")
            result["cookie_obtained"] = bool(c and c.get("value"))
            if args.emit_cookie and c and c.get("value"):
                result["roblosecurity"] = c["value"]
        except WebDriverException:
            pass
        log("Вошёл как @%s (id=%s)" % (user.get("name"), user.get("id")))

        open_security(driver)

        if args.mode == "inspect":
            out_dir = args.out or os.path.join(os.path.dirname(__file__), "web-inspect")
            info = dump_inspect(driver, out_dir)
            result.update(info)
            result["api_status"] = api_xbox_status(driver)["raw"]
            result["xbox_linked"] = xbox_is_linked(driver)
            result["message"] = "Инспекция сохранена в %s (DOM + API-статус для отладки)" % out_dir
            print(json.dumps(result, ensure_ascii=False))
            return 0

        # Статус: сначала API (надёжно), затем DOM как запасной (селекторы 2026 не подтверждены).
        api = api_xbox_status(driver)
        dom_linked = xbox_is_linked(driver)
        linked = api["linked"] if api["linked"] is not None else dom_linked
        result["xbox_linked"] = linked
        result["api_status"] = api["raw"]
        result["dom_linked"] = dom_linked

        if args.mode == "check":
            result["message"] = {True: "Xbox привязан.", False: "Xbox не привязан (уже отвязан).",
                                 None: "Неоднозначно (API не дал ответа, DOM пуст) — запусти --inspect."}[linked]
            print(json.dumps(result, ensure_ascii=False))
            return 0

        # mode == run
        if linked is False:
            result["message"] = "Привязки Xbox нет — аккаунт уже отвязан, ничего не делаю."
            print(json.dumps(result, ensure_ascii=False))
            return 0

        # 1) пробуем отвязать через API (это и есть действие под кнопкой Disconnect).
        api_dis = api_xbox_disconnect(driver)
        result["api_disconnect"] = api_dis["raw"]
        if not api_dis["ok"]:
            # 2) запасной путь — клик по кнопке в DOM.
            log("API-отвязка не подтвердилась (HTTP!=200) — пробую клик по кнопке в DOM.")
            btn = find_disconnect_button(driver)
            if btn:
                log("Нажимаю Disconnect: %r" % (btn.text or "").strip())
                try:
                    driver.execute_script("arguments[0].scrollIntoView({block:'center'});", btn)
                    time.sleep(0.3)
                    btn.click()
                    click_confirm_if_any(driver)
                except WebDriverException as e:
                    log("Клик не удался: %s" % e)
            else:
                log("Кнопку Disconnect в DOM тоже не нашёл.")

        # Перепроверка состояния.
        time.sleep(2.0)
        open_security(driver)
        after = api_xbox_status(driver)["linked"]
        if after is None:
            after = xbox_is_linked(driver)
        result["disconnected"] = (after is False)
        result["xbox_linked"] = after
        if after is False:
            result["message"] = ("Xbox отвязан на стороне Roblox. ВНИМАНИЕ: чтобы приложение MS Store "
                                 "не привязало его обратно — также выйди из этого Microsoft-аккаунта в "
                                 "Windows/Xbox (или смени пользователя Windows) перед входом в новый аккаунт.")
        else:
            result["message"] = ("Отвязать не удалось/не подтвердилось — запусти --inspect и пришли дамп "
                                 "(мог потребоваться ввод пароля/2FA, или эндпоинт изменился в 2026).")
        print(json.dumps(result, ensure_ascii=False))
        return 0 if after is False else 1
    except TimeoutException as e:
        result["message"] = "Таймаут: %s" % e
        print(json.dumps(result, ensure_ascii=False))
        return 1
    except WebDriverException as e:
        result["message"] = "Ошибка браузера/драйвера: %s" % e
        print(json.dumps(result, ensure_ascii=False))
        return 1
    finally:
        if driver is not None:
            try:
                driver.quit()
            except Exception:  # noqa: BLE001
                pass
        shutil.rmtree(profile_dir, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description="Отвязать Xbox у аккаунта Roblox через веб (шаги 2-4).")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--check", action="store_true", help="только проверить, привязан ли Xbox")
    g.add_argument("--inspect", action="store_true", help="дамп элементов + скриншот + HTML страницы security")
    g.add_argument("--run", action="store_true", help="отвязать Xbox (РЕАЛЬНОЕ действие)")
    ap.add_argument("--username", help="логин Roblox (вход паролем; иначе env ROBLOX_USER)")
    ap.add_argument("--password", help="пароль Roblox (иначе env ROBLOX_PASS)")
    ap.add_argument("--login-wait", type=int, default=180, help="сек ожидания ручного решения капчи/2FA")
    ap.add_argument("--emit-cookie", action="store_true", help="вывести полученную .ROBLOSECURITY в JSON (СЕКРЕТ!)")
    ap.add_argument("--cookie", help=".ROBLOSECURITY (если без логина/пароля; иначе env ROBLOX_COOKIE или stdin)")
    ap.add_argument("--browser", choices=["chrome", "edge"], default="chrome")
    ap.add_argument("--headless", action="store_true", help="без окна браузера (только для входа по cookie)")
    ap.add_argument("--out", help="каталог для --inspect (по умолчанию ./web-inspect)")
    args = ap.parse_args()
    args.mode = "check" if args.check else "inspect" if args.inspect else "run"
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
