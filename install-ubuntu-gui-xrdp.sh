#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "[error] Run as root: sudo bash $0"
  exit 1
fi

TARGET_USER="${SUDO_USER:-${1:-}}"
if [[ -z "${TARGET_USER}" ]]; then
  echo "[error] Could not detect target user."
  echo "Usage:"
  echo "  sudo bash $0 <ubuntu_username>"
  echo "or run via sudo from that user session."
  exit 1
fi

if ! id "${TARGET_USER}" >/dev/null 2>&1; then
  echo "[error] User '${TARGET_USER}' does not exist."
  exit 1
fi

TARGET_HOME="$(getent passwd "${TARGET_USER}" | cut -d: -f6)"
if [[ -z "${TARGET_HOME}" || ! -d "${TARGET_HOME}" ]]; then
  echo "[error] Home directory for '${TARGET_USER}' not found."
  exit 1
fi

echo "[step] Updating package index..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y

echo "[step] Installing XFCE desktop and XRDP..."
apt-get install -y xfce4 xfce4-goodies xorg dbus-x11 x11-xserver-utils xrdp

echo "[step] Configuring desktop session for user '${TARGET_USER}'..."
printf '%s\n' "xfce4-session" > "${TARGET_HOME}/.xsession"
chown "${TARGET_USER}:${TARGET_USER}" "${TARGET_HOME}/.xsession"
chmod 644 "${TARGET_HOME}/.xsession"

echo "[step] Ensuring xrdp is in ssl-cert group..."
adduser xrdp ssl-cert >/dev/null 2>&1 || true

echo "[step] Enabling and restarting XRDP..."
systemctl enable xrdp
systemctl restart xrdp

if command -v ufw >/dev/null 2>&1; then
  UFW_STATE="$(ufw status | sed -n '1p' || true)"
  if echo "${UFW_STATE}" | grep -qi "Status: active"; then
    echo "[step] Opening RDP port 3389 in UFW..."
    ufw allow 3389/tcp >/dev/null
  else
    echo "[info] UFW installed but inactive. Skipping firewall rule."
  fi
else
  echo "[info] UFW not installed. Skipping firewall rule."
fi

echo
echo "=== Done ==="
echo "XRDP service status:"
systemctl --no-pager --full status xrdp | sed -n '1,12p'
echo
echo "Server IP addresses:"
hostname -I || true
echo
echo "Connect from Windows:"
echo "  1) Win+R -> mstsc"
echo "  2) Enter server IP"
echo "  3) Log in as '${TARGET_USER}' with Linux password"
echo "  4) If prompted, choose session: Xorg"

