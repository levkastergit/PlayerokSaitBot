#!/usr/bin/env bash
set -euo pipefail
SAIT_DIR="${SAIT_DIR:-/opt/sait}"
APP_ENV_FILE="${SAIT_DIR}/backend/.env"
CERTBOT_ENV_FILE="${SAIT_DIR}/.env"
COMPOSE_FILE="${SAIT_DIR}/docker-compose.yml"
LEGACY_CONTAINER_NAME="saitplayerok"

docker_compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
    return
  fi
  if command -v docker-compose >/dev/null 2>&1; then
    docker-compose "$@"
    return
  fi
  echo "docker compose not found (need docker compose v2 or docker-compose)" >&2
  exit 1
}

echo "=== Check docker ==="
command -v docker >/dev/null 2>&1 || { echo "docker not found"; exit 1; }
docker_compose version >/dev/null 2>&1 || { echo "docker compose not found"; exit 1; }
echo "=== Prepare folders in ${SAIT_DIR} ==="
mkdir -p "${SAIT_DIR}/backend/data"
if [ ! -f "${APP_ENV_FILE}" ]; then
  echo "Missing ${APP_ENV_FILE}. Creating template (change password!)."
  cat > "${APP_ENV_FILE}" <<'ENV'
AUTH_LOGIN=admin
AUTH_PASSWORD=your-secret-password
ENV
fi
if [ ! -f "${CERTBOT_ENV_FILE}" ]; then
  echo "Missing ${CERTBOT_ENV_FILE}. Creating template (set your email!)."
  cat > "${CERTBOT_ENV_FILE}" <<'ENV'
CERTBOT_EMAIL=admin@playerokbot.com
ENV
fi
echo "=== Check compose files ==="
if [ ! -f "${COMPOSE_FILE}" ]; then
  echo "Missing ${COMPOSE_FILE}"
  exit 2
fi
if [ ! -d "${SAIT_DIR}/nginx" ]; then
  echo "Missing ${SAIT_DIR}/nginx"
  exit 2
fi
echo "=== Stop legacy container (breaks SSL) ==="
docker rm -f "${LEGACY_CONTAINER_NAME}" >/dev/null 2>&1 || true
echo "=== Start via docker compose ==="
cd "${SAIT_DIR}"
docker_compose pull app || true
docker_compose up -d --build --force-recreate
echo ""
docker_compose ps
if cid="$(docker_compose ps -q app 2>/dev/null)" && [ -n "${cid}" ]; then
  echo "app NetworkMode: $(docker inspect "${cid}" --format '{{.HostConfig.NetworkMode}}')"
fi
echo ""
echo "Open: https://playerokbot.com"
echo "Logs: cd ${SAIT_DIR} && docker_compose logs -f nginx"
