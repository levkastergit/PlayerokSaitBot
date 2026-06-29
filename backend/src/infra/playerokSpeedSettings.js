'use strict'

// Живые (настраиваемые из /settings без пересборки) параметры скорости/задержек.
//
// Идея: раньше паузы шлюза, лимиты параллельности, интервалы фоновых задач и т.п. были
// «зашиты» константами на момент загрузки модуля (или env). Оператор не мог менять их без
// редеплоя. Теперь значения читаются ЖИВЬЁМ из настроек пользователя-админа через резолвер
// (инъекция в server.js, как у IP-ротации), с TTL-кэшем ~2с, чтобы не дёргать БД на каждый
// запрос. Дефолт = env-значение (обратная совместимость) → встроенный дефолт. Пустое поле в
// настройках = «использовать дефолт» (ключ не хранится).
//
// КЛАМПЫ ОБЯЗАТЕЛЬНЫ: слишком маленькие паузы + большая параллельность = ровно тот 429-шторм,
// ради борьбы с которым эти задержки и вводились. Кламп защищает оператора от прострела ноги.

const { PLAYEROK_REQUEST_TIMEOUT_MS } = require('./playerokRequestTimeout')

function envNum(name) {
  const raw = process.env[name]
  const n = raw != null && raw !== '' ? Number(raw) : NaN
  return Number.isFinite(n) ? n : null
}

// Описание всех настраиваемых параметров. group — для группировки в UI.
// builtin — новый дефолт (быстрее прежнего, но безопасный при ротации IP).
const DEFS = [
  // --- Шлюз запросов (читается на КАЖДЫЙ запрос) ---
  { key: 'serialGapMs', env: 'PLAYEROK_SERIAL_REQUEST_GAP_MS', builtin: 450, min: 150, max: 10000,
    group: 'gate', labelRu: 'Пауза между фоновыми запросами, мс',
    hintRu: 'Главный тормоз фоновых задач. Меньше = быстрее, но выше риск 429. Безопасно снижать только при пуле ≥3 IP.' },
  { key: 'minGapMs', env: 'PLAYEROK_MIN_REQUEST_GAP_MS', builtin: 200, min: 50, max: 5000,
    group: 'gate', labelRu: 'Пауза между быстрыми (операторскими) запросами, мс',
    hintRu: 'Темп операторской/интерактивной полосы (открытие чата, резолв почты).' },
  { key: 'skipMaxConcurrency', env: 'PLAYEROK_SKIP_MAX_CONCURRENCY', builtin: 4, min: 1, max: 16,
    group: 'gate', labelRu: 'Параллельных быстрых запросов, шт.',
    hintRu: 'Сколько операторских запросов идёт одновременно (каждый — с другого IP ротации).' },
  { key: 'retryBaseDelayMs', env: 'PLAYEROK_RETRY_BASE_DELAY_MS', builtin: 500, min: 50, max: 5000,
    group: 'gate', labelRu: 'Базовая задержка повтора запроса, мс',
    hintRu: 'Стартовая пауза экспоненциального повтора при ошибке/429 (повтор берёт другой IP).' },
  { key: 'circuitProbeIntervalMs', env: 'PLAYEROK_CIRCUIT_PROBE_INTERVAL_MS', builtin: 8000, min: 1000, max: 120000,
    group: 'gate', labelRu: 'Интервал пробного запроса при блокировке, мс',
    hintRu: 'Когда все IP в блоке — раз в этот интервал пропускаем 1 пробу. Меньше = быстрее восстановление.' },
  { key: 'ipCooldownFirstRungMs', env: 'PLAYEROK_IP_COOLDOWN_FIRST_MS', builtin: 30000, min: 5000, max: 600000,
    group: 'gate', labelRu: 'Первая ступень блокировки IP после 429, мс',
    hintRu: 'На сколько IP уходит в блок после первого 429 (дальше эскалация ×). Меньше = IP быстрее возвращается в пул.' },

  // --- Интервалы фоновых задач (/execution), читаются перед каждым тиком ---
  { key: 'chatsSyncIntervalMs', env: 'CHATS_SYNC_INTERVAL_MS', builtin: 800, min: 300, max: 10000,
    group: 'jobs', labelRu: 'Период синхронизации чатов, мс',
    hintRu: 'Как часто опрашиваются новые сообщения. Per-user путь — ротация реально поднимает потолок.' },
  { key: 'dealStatusWatchTickMs', env: 'DEAL_STATUS_WATCH_TICK_MS', builtin: 4000, min: 1000, max: 60000,
    group: 'jobs', labelRu: 'Период наблюдателя статусов сделок, мс',
    hintRu: 'Как часто проверяются статусы сделок (триггеры автосообщений «Отправлено/Подтверждено»).' },
  { key: 'autolistTickMs', env: 'AUTOLIST_TICK_MS', builtin: 10000, min: 2000, max: 120000,
    group: 'jobs', labelRu: 'Период тика автовыдачи/чатов, мс',
    hintRu: 'Период обработки оплаченных чатов, автосообщений и флоу выдачи.' },
  { key: 'autobumpTickMs', env: 'AUTOBUMP_TICK_MS', builtin: 15000, min: 3000, max: 120000,
    group: 'jobs', labelRu: 'Период автоподнятия лотов, мс',
    hintRu: 'Как часто проверяются лоты на поднятие.' },
  { key: 'relistTickMs', env: 'RELIST_TICK_MS', builtin: 90000, min: 30000, max: 600000,
    group: 'jobs', labelRu: 'Период перевыставления, мс',
    hintRu: 'Отдельный медленный цикл перевыставления проданных лотов.' },
  { key: 'chatsWarmupIntervalMs', env: 'CHATS_WARMUP_INTERVAL_MS', builtin: 60000, min: 10000, max: 600000,
    group: 'jobs', labelRu: 'Период прогрева чатов, мс',
    hintRu: 'Фоновый прогрев списка чатов. Слишком часто — конкуренция за шлюз.' },
  { key: 'supercellBackfillIntervalMs', env: 'SUPERCELL_BACKFILL_INTERVAL_MS', builtin: 45000, min: 5000, max: 600000,
    group: 'jobs', labelRu: 'Период бэкфилла почты Supercell, мс',
    hintRu: 'Как часто дотягивается почта/отзыв для старых чатов.' },
]

const DEFS_BY_KEY = new Map(DEFS.map((d) => [d.key, d]))

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n))
}

// Встроенный дефолт каждого ключа: env (если задан и валиден) → builtin.
function builtinDefault(def) {
  const e = envNum(def.env)
  if (e != null) return clamp(e, def.min, def.max)
  return def.builtin
}

// Нормализуем СЫРОЙ объект из БД: оставляем только валидные числа в пределах кламп.
// Пустые/невалидные ключи отбрасываем → для них берётся дефолт. (Пусто = дефолт.)
function normalizeSpeedConfig(raw) {
  const out = {}
  const src = raw && typeof raw === 'object' ? raw : {}
  for (const def of DEFS) {
    const v = src[def.key]
    if (v === '' || v == null) continue
    const n = Number(v)
    if (!Number.isFinite(n)) continue
    out[def.key] = clamp(Math.round(n), def.min, def.max)
  }
  return out
}

// ---- Резолвер (инъекция из server.js, как setOutboundRotationResolver) ----
let speedResolver = null
function setSpeedSettingsResolver(fn) {
  speedResolver = typeof fn === 'function' ? fn : null
}

// Настройки скорости — ГЛОБАЛЬНЫЕ для шлюза (он один на процесс), а хранятся по user_id.
// Фоновые пути часто без userId в контексте → берём фиксированного админа (single-admin).
const GATE_SETTINGS_USER_ID = Number(process.env.PLAYEROK_GATE_SETTINGS_USER_ID) || 1

let __cache = null
let __cacheAt = 0
const CACHE_TTL_MS = 2000

// Эффективные значения ВСЕХ ключей (userVal в клампе → дефолт). Кэш ~2с.
function getLiveSpeedSettings() {
  const now = Date.now()
  if (__cache && now - __cacheAt < CACHE_TTL_MS) return __cache
  let stored = {}
  if (speedResolver) {
    try {
      stored = normalizeSpeedConfig(speedResolver(GATE_SETTINGS_USER_ID))
    } catch (_) {
      stored = {}
    }
  }
  const eff = {}
  for (const def of DEFS) {
    eff[def.key] = Object.prototype.hasOwnProperty.call(stored, def.key)
      ? stored[def.key]
      : builtinDefault(def)
  }
  __cache = eff
  __cacheAt = now
  return eff
}

// Сброс кэша — вызывается при сохранении настроек, чтобы изменения применились сразу.
function invalidateSpeedCache() {
  __cache = null
  __cacheAt = 0
}

// Одно значение (с дефолтом) — для точечного чтения.
function getSpeed(key) {
  const live = getLiveSpeedSettings()
  if (Object.prototype.hasOwnProperty.call(live, key)) return live[key]
  const def = DEFS_BY_KEY.get(key)
  return def ? builtinDefault(def) : null
}

// Метаданные + текущие значения для UI: { defs:[{key,labelRu,hintRu,group,min,max,default}], values:{...} }
function getSpeedSettingsForUi() {
  let stored = {}
  if (speedResolver) {
    try {
      stored = normalizeSpeedConfig(speedResolver(GATE_SETTINGS_USER_ID))
    } catch (_) {
      stored = {}
    }
  }
  return {
    defs: DEFS.map((d) => ({
      key: d.key,
      labelRu: d.labelRu,
      hintRu: d.hintRu || '',
      group: d.group,
      min: d.min,
      max: d.max,
      default: builtinDefault(d),
    })),
    values: stored, // только явно заданные оператором (пусто = дефолт)
  }
}

module.exports = {
  setSpeedSettingsResolver,
  normalizeSpeedConfig,
  getLiveSpeedSettings,
  invalidateSpeedCache,
  getSpeed,
  getSpeedSettingsForUi,
  GATE_REQUEST_TIMEOUT_MS: PLAYEROK_REQUEST_TIMEOUT_MS,
}
