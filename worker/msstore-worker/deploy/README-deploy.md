# Деплой логин-пайплайна на Ubuntu VPS (wesqaliqo.com)

Что едет на VPS: **бэкенд (Docker, host-network)** + **login_service.py** (вход покупателя в браузере).
Что НЕ едет: покупка Robux в MS Store (UWP-приложение — только Windows). VPS закрывает вход/заказы/ссылки.

## 1. Код на сервер
```bash
git clone <repo> /opt/playerok && cd /opt/playerok
git checkout feat/roblox-msstore-login-captcha
```
Бэкенд деплоится как обычно (Docker образ + `deploy.sh`, host-network). См. [[deploy-architecture]].

## 2. login_service (браузерный движок входа)
```bash
sudo bash worker/msstore-worker/deploy/setup-login-service-ubuntu.sh \
     /opt/playerok/worker/msstore-worker/automation
```
Скрипт ставит Google Chrome + Xvfb + selenium и поднимает systemd-юнит `roblox-login`
(headed Chrome под Xvfb на `127.0.0.1:8765`). Проверка:
```bash
curl -s http://127.0.0.1:8765/health          # {"ok":true,...}
journalctl -u roblox-login -f                  # логи входов
```

## 3. ENV бэкенда (.env, без хвостового перевода строки)
```
PUBLIC_BASE_URL=https://wesqaliqo.com      # домен ссылок 2FA/капчи покупателю
LOGIN_SERVICE_URL=http://127.0.0.1:8765    # где слушает login_service (host-network → 127.0.0.1)
```
Перезапустить бэкенд после правки env.

## 4. Проверка сквозняком
1. На `wesqaliqo.com/roblox` → вкладка «Заказы» → создать заказ: Robux + **логин + пароль** покупателя.
2. Бэкенд дёрнет login_service → если 2FA/капча, у заказа появится **ссылка** (колонка/блок в карточке).
3. Открыть ссылку (имитируя покупателя), ввести код / решить капчу → статус заказа станет **«Готов к выдаче»**.
4. Лог входа: `journalctl -u roblox-login -f` (строки `2FA ок: вошёл @…`).

## Нюансы
- **Капча-перенос (FunCaptcha) ещё не проверен вживую** — нужен аккаунт, реально показывающий капчу.
  2FA-ветка проверена end-to-end.
- **IP дата-центра** → Arkose чаще даёт капчу; `.ROBLOSECURITY` привязан к IP VPS (ок, всё на нём же).
  Под объём — резидентный прокси (Chrome `--proxy-server` в `login_service.make_driver`).
- **Покупка Robux** — отдельная Windows-машина с приложением Roblox (`buy_robux.py`), не на этом VPS.
- Сервис слушает только `127.0.0.1` — наружу не торчит, ходит к нему только бэкенд.
