# syntax=docker/dockerfile:1

###
# Build frontend (Vite) -> dist/
###
FROM node:20-bullseye-slim AS frontend-builder
WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

###
# Install backend deps (node-gyp may be needed for better-sqlite3)
###
FROM node:20-bullseye-slim AS backend-deps
WORKDIR /app/backend

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY backend/package*.json ./
RUN npm ci --omit=dev

###
# Runtime image
###
FROM node:20-bullseye-slim
WORKDIR /app/backend

# Python runtime for supercell_auto_otp_plugin + docker cli for /docker deploy button
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates docker.io docker-compose \
  && rm -rf /var/lib/apt/lists/* \
  && python3 -m pip install --no-cache-dir --upgrade pip \
  && python3 -m pip install --no-cache-dir httpx fake-useragent

COPY --from=backend-deps /app/backend/node_modules ./node_modules
COPY backend/ ./
COPY --from=frontend-builder /app/frontend/dist ../frontend/dist

# Раздел «Загрузка»: скрипты капчура впекаем из worker/ (единый источник правды).
COPY worker/msstore-worker/automation/capture_robux_purchase.py ./public/downloads/capture_robux_purchase.py
COPY worker/msstore-worker/automation/capture_msstore_app.py ./public/downloads/capture_msstore_app.py
COPY worker/msstore-worker/automation/run_msstore_capture.ps1 ./public/downloads/run_msstore_capture.ps1
COPY worker/msstore-worker/automation/mint_xsts.py ./public/downloads/mint_xsts.py

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]

