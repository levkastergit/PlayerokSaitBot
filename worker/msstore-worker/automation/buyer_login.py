#!/usr/bin/env python3
"""
Движок входа ПОКУПАТЕЛЯ: headless-браузер логинится по логину/паролю и отдаёт .ROBLOSECURITY.

Почему браузер, а не чистый HTTP: вход в Roblox теперь проходит через Generic Challenge —
proof-of-work (apis.roblox.com/proof-of-work-service/v1/pow-puzzle) и Arkose/FunCaptcha. Реальный
браузер решает PoW и прозрачную капчу САМ, без участия человека (проверено: AUTHENTICATED=true при
нулевом вводе). Человек нужен только если выскочит ИНТЕРАКТИВНАЯ капча или 2FA — тогда сообщаем об этом.

Запуск:
  python buyer_login.py --username U --password P [--headed] [--timeout 75]
  (или env ROBLOX_USER / ROBLOX_PASS)

Выход — последняя строка stdout это JSON:
  {"ok": true,  "account": {"id":..,"name":..}, "roblosecurity":"...", "cookieObtained": true}
  {"ok": false, "needs": "2fa",     "mediaType":"email|authenticator|..."}   — нужен код от покупателя
  {"ok": false, "needs": "captcha"}                                           — нужна интерактивная капча
  {"ok": false, "needs": null, "error": "..."}                                — неверные данные/таймаут

ВНИМАНИЕ: roblosecurity в выводе — это полный доступ к аккаунту. Канал до бэкенда должен быть защищён.
"""

import os
import sys
import json
import time
import tempfile
import shutil
import argparse

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

try:
    from selenium import webdriver
    from selenium.webdriver.common.by import By
    from selenium.common.exceptions import WebDriverException
except Exception:  # noqa: BLE001
    print("Нет selenium. Установи: pip install selenium", file=sys.stderr)
    sys.exit(2)

LOGIN_URL = "https://www.roblox.com/login"
AUTH_URL = "https://users.roblox.com/v1/users/authenticated"


def log(m):
    print(m, file=sys.stderr, flush=True)


def make_driver(headless, profile_dir):
    from selenium.webdriver.chrome.options import Options
    o = Options()
    o.add_argument("--user-data-dir=" + profile_dir)
    o.add_argument("--no-first-run")
    o.add_argument("--no-default-browser-check")
    o.add_argument("--disable-blink-features=AutomationControlled")
    o.add_argument("--window-size=1280,1000")
    o.add_argument("--lang=en-US")
    o.page_load_strategy = "eager"
    if headless:
        o.add_argument("--headless=new")
    return webdriver.Chrome(options=o)


def safe_get(driver, url):
    try:
        driver.get(url)
    except WebDriverException as e:
        log("get %s прерван (продолжаю): %s" % (url, str(e)[:100]))


def find_first(driver, locators, timeout=15):
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


def react_fill(driver, el, value):
    try:
        el.click()
    except WebDriverException:
        pass
    try:
        el.clear(); el.send_keys(value)
    except WebDriverException:
        pass
    try:
        if (el.get_attribute("value") or "") != value:
            driver.execute_script(
                "const el=arguments[0],v=arguments[1];"
                "const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;"
                "s.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}));"
                "el.dispatchEvent(new Event('change',{bubbles:true}));", el, value)
    except WebDriverException:
        pass


def who_am_i(driver):
    driver.set_script_timeout(15)
    try:
        r = driver.execute_async_script(
            "const done=arguments[arguments.length-1];"
            "fetch('%s',{credentials:'include'}).then(x=>x.json())"
            ".then(j=>done(j&&j.id?j:null)).catch(()=>done(null));" % AUTH_URL)
        return r
    except WebDriverException:
        return None


def detect_challenge(driver):
    """Грубая классификация того, что на экране, если вход ещё не прошёл: '2fa' | 'captcha' | None."""
    try:
        body = (driver.find_element(By.TAG_NAME, "body").text or "").lower()
    except WebDriverException:
        body = ""
    # 2FA / код
    twofa_markers = ["2-step verification", "two-step", "verification code", "enter the code",
                     "authenticator", "проверьте", "код подтверждения", "двухэтап"]
    if any(m in body for m in twofa_markers):
        # уточним тип по тексту
        media = "authenticator"
        if "email" in body or "почт" in body:
            media = "email"
        elif "text" in body or "sms" in body or "phone" in body:
            media = "sms"
        return ("2fa", media)
    # интерактивная капча (видимый iframe Arkose)
    try:
        for fr in driver.find_elements(By.CSS_SELECTOR, "iframe[src*='arkoselabs'], iframe[id*='arkose'], iframe[data-e2e*='enforcement']"):
            if fr.is_displayed() and fr.size.get("height", 0) > 60:
                return ("captcha", None)
    except WebDriverException:
        pass
    if "enter the code" in body or "puzzle" in body or "verify you are human" in body:
        return ("captcha", None)
    return (None, None)


def submit_login(driver, username, password):
    safe_get(driver, LOGIN_URL)
    time.sleep(1.2)
    try:
        driver.delete_all_cookies()
    except WebDriverException:
        pass
    safe_get(driver, LOGIN_URL)
    time.sleep(1.5)
    u = find_first(driver, [(By.ID, "login-username"), (By.NAME, "username"),
                            (By.CSS_SELECTOR, "input[autocomplete='username']"), (By.CSS_SELECTOR, "input[type='text']")], timeout=20)
    p = find_first(driver, [(By.ID, "login-password"), (By.NAME, "password"), (By.CSS_SELECTOR, "input[type='password']")], timeout=10)
    if not u or not p:
        return False
    react_fill(driver, u, username)
    react_fill(driver, p, password)
    btn = find_first(driver, [(By.ID, "login-button"), (By.CSS_SELECTOR, "button[type='submit']"),
                              (By.XPATH, "//button[contains(.,'Log In') or contains(.,'Войти')]")], timeout=8)
    if btn:
        try:
            driver.execute_script("arguments[0].click();", btn)
        except WebDriverException:
            pass
    else:
        try:
            from selenium.webdriver.common.keys import Keys
            p.send_keys(Keys.RETURN)
        except WebDriverException:
            pass
    return True


def run(username, password, headless, timeout):
    out = {"ok": False, "needs": None, "error": None}
    profile = tempfile.mkdtemp(prefix="rbx-login-")
    driver = None
    try:
        driver = make_driver(headless, profile)
        try:
            driver.set_page_load_timeout(45)
        except WebDriverException:
            pass
        if not submit_login(driver, username, password):
            out["error"] = "Не нашёл форму логина."
            return out
        log("Логин отправлен. Жду авторизацию до %ss (браузер сам решает PoW/прозрачную капчу)…" % timeout)

        deadline = time.time() + timeout
        last_challenge = (None, None)
        while time.time() < deadline:
            user = who_am_i(driver)
            if user:
                out["ok"] = True
                out["account"] = {"id": user.get("id"), "name": user.get("name"), "displayName": user.get("displayName")}
                try:
                    c = driver.get_cookie(".ROBLOSECURITY")
                    if c and c.get("value"):
                        out["roblosecurity"] = c["value"]
                        out["cookieObtained"] = True
                except WebDriverException:
                    pass
                log("Вошёл как @%s (id=%s)" % (user.get("name"), user.get("id")))
                return out
            last_challenge = detect_challenge(driver)
            if last_challenge[0] == "2fa":
                out["needs"] = "2fa"
                out["mediaType"] = last_challenge[1]
                out["error"] = "Требуется 2FA-код от покупателя."
                return out
            time.sleep(3)

        # таймаут — классифицируем, почему не вошли
        ch, media = detect_challenge(driver)
        if ch == "captcha":
            out["needs"] = "captcha"
            out["error"] = "Нужна интерактивная капча (покупатель решает по ссылке)."
        elif ch == "2fa":
            out["needs"] = "2fa"; out["mediaType"] = media
            out["error"] = "Требуется 2FA-код."
        else:
            out["error"] = "Не удалось войти за %ss (неверные данные или непройденная капча)." % timeout
        return out
    except WebDriverException as e:
        out["error"] = "Ошибка браузера: " + str(e)[:200]
        return out
    finally:
        if driver is not None:
            try:
                driver.quit()
            except Exception:  # noqa: BLE001
                pass
        shutil.rmtree(profile, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser(description="Движок входа покупателя Roblox (headless браузер).")
    ap.add_argument("--username", help="логин (иначе env ROBLOX_USER)")
    ap.add_argument("--password", help="пароль (иначе env ROBLOX_PASS)")
    # По умолчанию HEADED: в headless Arkose/PoW детектят автоматизацию и вход не проходит
    # (проверено на @levkaster). Воркер — выделенная Windows-машина, видимое окно там нормально.
    ap.add_argument("--headless", action="store_true", help="headless (НЕ рекомендуется: Arkose детектит, вход не проходит)")
    ap.add_argument("--timeout", type=int, default=75, help="сек ожидания авторизации")
    args = ap.parse_args()
    username = (args.username or os.environ.get("ROBLOX_USER", "")).strip()
    password = args.password if args.password is not None else os.environ.get("ROBLOX_PASS", "")
    if not username or not password:
        print(json.dumps({"ok": False, "error": "Нужны --username/--password или env ROBLOX_USER/ROBLOX_PASS"}, ensure_ascii=False))
        return 2
    res = run(username, password, headless=args.headless, timeout=args.timeout)
    print(json.dumps(res, ensure_ascii=False))
    return 0 if res.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
