#!/usr/bin/env bash
# Установка XFCE + XRDP и исправление чёрного экрана / мгновенного отключения RDP.
# Запуск на сервере (Ubuntu/Debian):
#   sudo bash setup-ubuntu-gui-xrdp.sh
#   sudo bash setup-ubuntu-gui-xrdp.sh root
#   sudo bash setup-ubuntu-gui-xrdp.sh myuser
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "[error] Запустите от root: sudo bash $0 [имя_пользователя]"
  exit 1
fi

TARGET_USER="${SUDO_USER:-${1:-root}}"
if [[ -z "${TARGET_USER}" ]]; then
  echo "[error] Укажите пользователя для RDP: sudo bash $0 <username>"
  exit 1
fi

if ! id "${TARGET_USER}" >/dev/null 2>&1; then
  echo "[error] Пользователь '${TARGET_USER}' не существует."
  exit 1
fi

TARGET_HOME="$(getent passwd "${TARGET_USER}" | cut -d: -f6)"
if [[ -z "${TARGET_HOME}" || ! -d "${TARGET_HOME}" ]]; then
  echo "[error] Домашний каталог для '${TARGET_USER}' не найден."
  exit 1
fi

echo "=============================================="
echo " XFCE + XRDP setup for user: ${TARGET_USER}"
echo " Home: ${TARGET_HOME}"
echo "=============================================="

echo "[step] Обновление списка пакетов..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y

echo "[step] Установка XFCE, XRDP и зависимостей..."
apt-get install -y \
  xfce4 xfce4-goodies xfce4-session \
  xorg dbus-x11 x11-xserver-utils xrdp \
  policykit-1

echo "[step] Настройка /etc/xrdp/startwm.sh (сброс D-Bus от SSH)..."
if [[ -f /etc/xrdp/startwm.sh ]]; then
  cp -a /etc/xrdp/startwm.sh "/etc/xrdp/startwm.sh.bak.$(date +%Y%m%d%H%M%S)"
fi

cat >/etc/xrdp/startwm.sh <<'STARTWM_EOF'
#!/bin/sh
if [ -r /etc/default/locale ]; then
  . /etc/default/locale
  export LANG LANGUAGE
fi

# Не подхватывать D-Bus и runtime от уже открытой SSH-сессии — иначе чёрный экран.
unset DBUS_SESSION_BUS_ADDRESS
unset XDG_RUNTIME_DIR

if [ -f /etc/X11/Xsession ]; then
  exec /etc/X11/Xsession
fi

exec /bin/sh /etc/X11/Xsession
STARTWM_EOF
chmod +x /etc/xrdp/startwm.sh

echo "[step] Сессия XFCE для ${TARGET_USER}..."
cat >"${TARGET_HOME}/.xsession" <<'XSESSION_EOF'
xfce4-session
XSESSION_EOF

cat >"${TARGET_HOME}/.xsessionrc" <<'XSESSIONRC_EOF'
unset DBUS_SESSION_BUS_ADDRESS
unset XDG_RUNTIME_DIR
export XDG_SESSION_TYPE=x11
export GTK_IM_MODULE=
export QT_IM_MODULE=
export XMODIFIERS=
XSESSIONRC_EOF

chown "${TARGET_USER}:${TARGET_USER}" \
  "${TARGET_HOME}/.xsession" \
  "${TARGET_HOME}/.xsessionrc"
chmod 755 "${TARGET_HOME}/.xsession"
chmod 644 "${TARGET_HOME}/.xsessionrc"

echo "[step] Polkit (colord) для RDP..."
mkdir -p /etc/polkit-1/localauthority/50-local.d
cat >/etc/polkit-1/localauthority/50-local.d/45-allow-colord.pkla <<'POLKIT_EOF'
[Allow Colord all Users]
Identity=unix-user:*
Action=org.freedesktop.color-manager.create-device;org.freedesktop.color-manager.create-profile;org.freedesktop.color-manager.delete-device;org.freedesktop.color-manager.delete-profile;org.freedesktop.color-manager.modify-device;org.freedesktop.color-manager.modify-profile
ResultAny=no
ResultInactive=no
ResultActive=yes
POLKIT_EOF

echo "[step] Группа ssl-cert для xrdp..."
adduser xrdp ssl-cert >/dev/null 2>&1 || true

echo "[step] Остановка зависших сессий ${TARGET_USER}..."
pkill -u "${TARGET_USER}" -x xfce4-session 2>/dev/null || true
pkill -u "${TARGET_USER}" -x xfce4-panel 2>/dev/null || true
sleep 1

echo "[step] Включение и перезапуск XRDP..."
systemctl enable xrdp
systemctl restart xrdp

if command -v ufw >/dev/null 2>&1; then
  UFW_STATE="$(ufw status 2>/dev/null | sed -n '1p' || true)"
  if echo "${UFW_STATE}" | grep -qi "Status: active"; then
    echo "[step] Открытие порта 3389 в UFW..."
    ufw allow 3389/tcp >/dev/null || true
  else
    echo "[info] UFW не активен — правило для 3389 не добавлялось."
  fi
else
  echo "[info] UFW не установлен."
fi

echo
echo "=============================================="
echo " Готово"
echo "=============================================="
echo "Пользователь RDP : ${TARGET_USER}"
echo "Пароль           : пароль Linux (passwd ${TARGET_USER})"
echo
echo "IP сервера:"
hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^$' || true
echo
echo "Статус XRDP:"
systemctl --no-pager is-active xrdp || true
echo
echo "Подключение с Windows:"
echo "  Win+R -> mstsc -> IP сервера"
echo "  Логин: ${TARGET_USER}"
echo "  Сессия в окне XRDP: Xorg"
echo
if [[ "${TARGET_USER}" == "root" ]]; then
  echo "[warning] Вход под root не рекомендуется. Лучше:"
  echo "  adduser rdpuser && sudo bash $0 rdpuser"
  echo
fi
