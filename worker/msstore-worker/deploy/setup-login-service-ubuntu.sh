#!/usr/bin/env bash
# Установка login_service на Ubuntu VPS: Google Chrome + Xvfb + Python/Selenium.
# Запускать от root (или через sudo). Идемпотентно. Тестировано на Ubuntu 22.04/24.04.
#
#   sudo bash setup-login-service-ubuntu.sh /path/to/repo/worker/msstore-worker/automation
#
# Аргумент — каталог с login_service.py/buyer_login.py (по умолчанию рядом со скриптом: ../automation).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
AUTOMATION_DIR="${1:-$(cd "$HERE/../automation" && pwd)}"
SERVICE_PORT="${LOGIN_SERVICE_PORT:-8765}"
RUN_USER="${LOGIN_SERVICE_USER:-rbxlogin}"

echo "==> Каталог сервиса: $AUTOMATION_DIR"
test -f "$AUTOMATION_DIR/login_service.py" || { echo "Нет login_service.py в $AUTOMATION_DIR"; exit 1; }

echo "==> apt: базовые пакеты + Xvfb + Python"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg xvfb python3 python3-pip python3-venv \
  fonts-liberation libnss3 libxss1 libasound2t64 libgbm1 libgtk-3-0 || \
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg xvfb python3 python3-pip python3-venv \
  fonts-liberation libnss3 libxss1 libasound2 libgbm1 libgtk-3-0

echo "==> Google Chrome stable"
if ! command -v google-chrome >/dev/null 2>&1; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list
  apt-get update -y
  apt-get install -y google-chrome-stable
fi
google-chrome --version

echo "==> Python: selenium (Selenium Manager сам подтянет chromedriver)"
python3 -m pip install --upgrade --break-system-packages selenium 2>/dev/null || python3 -m pip install --upgrade selenium

echo "==> Пользователь сервиса: $RUN_USER"
id -u "$RUN_USER" >/dev/null 2>&1 || useradd -r -m -s /usr/sbin/nologin "$RUN_USER"

echo "==> systemd-юнит login_service (headed Chrome под Xvfb на :8765 → 127.0.0.1)"
cat > /etc/systemd/system/roblox-login.service <<UNIT
[Unit]
Description=Roblox cooperative login service (browser engine)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$AUTOMATION_DIR
# xvfb-run даёт виртуальный дисплей → Chrome НЕ headless (Arkose/PoW не палят автоматизацию)
ExecStart=/usr/bin/xvfb-run -a -s "-screen 0 1280x1024x24" /usr/bin/python3 $AUTOMATION_DIR/login_service.py --port $SERVICE_PORT
Restart=on-failure
RestartSec=5
# чистим временные профили браузера
PrivateTmp=true

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable roblox-login.service
systemctl restart roblox-login.service
sleep 3
echo "==> Проверка:"
curl -s "http://127.0.0.1:$SERVICE_PORT/health" || echo "(сервис ещё стартует — проверь: journalctl -u roblox-login -f)"
echo ""
echo "Готово. Сервис: http://127.0.0.1:$SERVICE_PORT  (логи: journalctl -u roblox-login -f)"
echo "Теперь на бэкенде задай env:  LOGIN_SERVICE_URL=http://127.0.0.1:$SERVICE_PORT  PUBLIC_BASE_URL=https://wesqaliqo.com"
