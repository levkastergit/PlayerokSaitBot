try {
  require('dotenv').config()
} catch (_) {
  // dotenv не установлен — запустите в папке backend: npm install dotenv
}
const http = require('http')
const https = require('https')
const crypto = require('crypto')
const path = require('path')
const fs = require('fs')
const { URLSearchParams } = require('url')
const { execFile, spawnSync } = require('child_process')
const { isTrustedInternalRequest } = require('./src/infra/internalAuth')

const PORT = parseInt(process.env.PORT, 10) || 3000

// Глобальная страховка: одиночный необработанный промис/исключение в любом обработчике
// или фоновой задаче НЕ должен ронять весь процесс (иначе все висящие запросы превращаются
// в 502/504 до перезапуска контейнера). Логируем и продолжаем работать.
process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandledRejection:', reason && reason.stack ? reason.stack : reason)
})
process.on('uncaughtException', (err) => {
  console.error('[process] uncaughtException:', err && err.stack ? err.stack : err)
})

let playerokDdosCookie = String(process.env.PLAYEROK_DDOS_COOKIE || '').trim()

function getPlayerokDdosCookie() {
  return playerokDdosCookie
}

function setPlayerokDdosCookie(nextValue) {
  playerokDdosCookie = String(nextValue || '').trim()
}

;(function patchHttpsRequestForPlayerokCookie() {
  const originalRequest = https.request.bind(https)

  function appendCookie(headers) {
    const extraCookie = getPlayerokDdosCookie()
    if (!extraCookie) return String((headers && headers.cookie) || '').trim()
    const current = String((headers && headers.cookie) || '').trim()
    if (!current) return extraCookie
    if (current.includes(extraCookie)) return current
    return `${current}; ${extraCookie}`
  }

  function shouldPatchHost(hostname) {
    const host = String(hostname || '').toLowerCase()
    return host === 'playerok.com' || host.endsWith('.playerok.com')
  }

  function patchOptions(options) {
    if (!options || typeof options !== 'object') return options
    if (!shouldPatchHost(options.hostname || options.host)) return options
    const headers = Object.assign({}, options.headers || {})
    const mergedCookie = appendCookie(headers)
    if (mergedCookie) headers.cookie = mergedCookie
    return Object.assign({}, options, { headers })
  }

  https.request = function patchedHttpsRequest(input, options, callback) {
    // signature: request(options[, cb])
    if (input && typeof input === 'object' && !Array.isArray(input) && !(input instanceof URL)) {
      const patchedInput = patchOptions(input)
      return originalRequest(patchedInput, options)
    }
    // signature: request(url[, options][, cb])
    if (typeof input === 'string' || input instanceof URL) {
      const patchedOptions = patchOptions(options)
      return originalRequest(input, patchedOptions, callback)
    }
    return originalRequest(input, options, callback)
  }

  if (getPlayerokDdosCookie()) {
    console.log('[playerok] включён PLAYEROK_DDOS_COOKIE: доп. cookie будет добавлен к запросам playerok.com')
  }
})()

;(function warnPlayerokOutboundIpIfUnavailable() {
  const ip = String(process.env.PLAYEROK_OUTBOUND_IP || '').trim()
  if (!ip) return
  const { networkInterfaces } = require('os')
  const v4 = (f) => f === 'IPv4' || f === 4
  let found = false
  for (const list of Object.values(networkInterfaces())) {
    if (!list) continue
    for (const a of list) {
      if (a && !a.internal && v4(a.family) && a.address === ip) {
        found = true
        break
      }
    }
    if (found) break
  }
  if (!found) {
    console.warn(
      `[playerok] PLAYEROK_OUTBOUND_IP=${ip}: этого IPv4 нет в сетевом стеке процесса (см. os.networkInterfaces). ` +
        'Частый случай — Docker без network_mode: host. Запросы к Playerok дадут bind EADDRNOTAVAIL. ' +
        'Либо включите host network для контейнера, либо уберите PLAYEROK_OUTBOUND_IP.'
    )
  }
})()

// Вход только через регистрацию на сайте (SQLite `users`). Учётные данные в .env не задаются.

// Кэш для лотов: уменьшает количество запросов к Playerok API и предотвращает rate limit
const LOTS_CACHE_TTL_MS = 2 * 60 * 1000 // 2 минуты
const lotsCache = new Map() // token -> { active: { data, expiresAt }, completed: { data, expiresAt } }
const CHATS_CACHE_TTL_MS = 90 * 1000 // 90 секунд
const chatsRefreshInFlight = new Set()
let postLocalRef = null
let chatSnapshotsRepo = null

function getChatsSnapshotCache(userId, cacheKey) {
  if (!chatSnapshotsRepo) return null
  const row = chatSnapshotsRepo.getChatSnapshot.get(Number(userId), String(cacheKey || ''))
  if (!row || !row.payload) return null
  try {
    const data = JSON.parse(row.payload)
    return {
      data,
      updatedAt: Number(row.updated_at || 0),
    }
  } catch (_) {
    return null
  }
}

function setChatsSnapshotCache(userId, cacheKey, data) {
  if (!chatSnapshotsRepo) return
  const uid = Number(userId)
  const key = String(cacheKey || '')
  if (!Number.isFinite(uid) || uid <= 0 || !key) return
  try {
    const payload = JSON.stringify(data || {})
    chatSnapshotsRepo.upsertChatSnapshot.run(uid, key, payload, Date.now())
  } catch (_) {
    // ignore cache write errors
  }
}

function isChatsSnapshotFresh(userId, cacheKey) {
  const entry = getChatsSnapshotCache(userId, cacheKey)
  if (!entry) return false
  return Date.now() - Number(entry.updatedAt || 0) <= CHATS_CACHE_TTL_MS
}

function scheduleChatsSnapshotRefresh(userId, token, userAgent, opts = {}) {
  if (!postLocalRef || !token) return
  const uid = Number(userId)
  if (!Number.isFinite(uid) || uid <= 0) return
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 24
  const afterCursor = opts.afterCursor || null
  const key = `${uid}:${limit}:${afterCursor || ''}`
  if (chatsRefreshInFlight.has(key)) return
  chatsRefreshInFlight.add(key)
  setTimeout(async () => {
    try {
      await postLocalRef('/api/playerok/chats', {
        token,
        userAgent,
        limit,
        ...(afterCursor ? { afterCursor } : {}),
        preferCache: false,
        warmup: true,
      })
    } catch (_) {
      // ignore background refresh errors
    } finally {
      chatsRefreshInFlight.delete(key)
    }
  }, 0)
}

// Периодическая очистка кэша лотов. ВАЖНО: истёкшую запись НЕ удаляем сразу —
// держим её как last-good для отдачи при storm/брейкере/504 (помечаем stale).
// Жёсткое выселение — только сильно протухшие (LOTS_STALE_HARD_EVICT_MS, 30 мин).
const LOTS_STALE_HARD_EVICT_MS = Number(process.env.LOTS_STALE_HARD_EVICT_MS) || 30 * 60 * 1000
setInterval(() => {
  const now = Date.now()
  for (const [token, cache] of lotsCache.entries()) {
    for (const side of ['active', 'completed']) {
      const e = cache[side]
      if (!e) continue
      if (now >= e.expiresAt && !e.stale) {
        e.stale = true
        e.staleSince = now
      }
      if (e.stale && now - Number(e.staleSince || now) > LOTS_STALE_HARD_EVICT_MS) {
        delete cache[side]
      }
    }
    // Удаляем запись, если оба кэша пусты
    if (!cache.active && !cache.completed) {
      lotsCache.delete(token)
    }
  }
}, 60 * 1000) // Проверяем каждую минуту

setInterval(() => {
  if (!chatSnapshotsRepo) return
  try {
    const thresholdTs = Date.now() - CHATS_CACHE_TTL_MS * 3
    chatSnapshotsRepo.deleteExpiredChatSnapshots.run(thresholdTs)
  } catch (_) {
    // ignore chat snapshots cleanup errors
  }
}, 60 * 1000)

const { initLogger, getLogsBuffer } = require('./src/infra/logger')
initLogger()

// "Код от хеда": user-agent для запросов к Playerok берём из .env, чтобы не был захардкожен в коде.
const PLAYEROK_USER_AGENT =
  process.env.PLAYEROK_USER_AGENT == null ? '' : String(process.env.PLAYEROK_USER_AGENT).trim()
// Лимитер Playerok: PLAYEROK_MIN_REQUEST_GAP_MS; runPlayerokInteractive — только send/rescan/supercell в UI.

const { hashPassword, verifyPassword, encryptToken, decryptToken } = require('./src/infra/crypto/tokenCrypto')
const {
  withRetry,
  isPlayerokRateLimitError,
  isPlayerokPublishRetryable,
  sleep,
} = require('./src/infra/retry/withRetry')
const {
  initSessions,
  getSessionIdFromRequest,
  isSessionValid,
  getSessionUserId,
  createSession,
  destroySession,
  destroyUserSessions,
} = require('./src/infra/auth/sessions')

const FRONTEND_DIST = path.join(__dirname, '..', 'frontend', 'dist')
const {
  getSupercellGameByCategory,
  formatSupercellCodeRequestedMessage,
  extractSupercellEmailFromFields,
  getLatestBuyerEmailFromMessages,
  hasSupercellCodeRequestedMessage,
  isEmailValid,
  pickSupercellCategoryFromItemHints,
} = require('./src/functions/supercellHelpers')

const { createRequestSupercellCodeForChat } = require('./src/functions/supercellRequestCodeForChat')

const { createResolveEffectiveProductSettings } = require('./src/functions/resolveEffectiveProductSettings')

const { createProductSettingsKeyFns } = require('./src/functions/productSettingsKeys')

const { createProcessSingleSupercellFlow } = require('./src/functions/processSingleSupercellFlow')

const { createGetViewer } = require('./src/functions/playerokGetViewer')

const {
  parseIntSafe,
  clampInt,
  normalizeKeyPart,
  normalizeProductKey,
  buildProductKey,
} = require('./src/functions/keyUtils')

let resolveEffectiveProductSettings = null

const Database = require('better-sqlite3')
const DATA_DIR = path.join(__dirname, 'data')
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
const DB_PATH = path.join(DATA_DIR, 'product-settings.db')
const db = new Database(DB_PATH)

// WAL + synchronous=NORMAL: на слабом 1-CPU сервере дефолтный rollback-journal делает
// fsync на каждую запись и блокирует единственный поток. WAL переводит запись в журнал
// с редкими checkpoint'ами — резко меньше блокировок event loop и объёма дисковой записи.
db.pragma('journal_mode = WAL')
db.pragma('synchronous = NORMAL')
db.pragma('busy_timeout = 5000')

const { initDbSchema } = require('./src/db/schema/initDbSchema')
initDbSchema(db)

// Сессии в БД (переживают перезапуск контейнера/деплой — не разлогинивает).
initSessions(db)

// Включаем персистентный дедуп автосообщений (журнал в БД) — чтобы не было дублей
// после перезапуска/гонок и не терялись отправки.
const { setAutolistPersistenceDb } = require('./src/features/autolist/autolistState')
setAutolistPersistenceDb(db)

const getUserSupercellModule = db.prepare('SELECT module_supercell FROM users WHERE id = ?')
function isSupercellModuleEnabled(userId) {
  const row = getUserSupercellModule.get(userId)
  if (!row) return true
  return Number(row.module_supercell || 0) === 1
}

const { setupTokensRepo } = require('./src/db/tokensRepo')
const { setupChatSnapshotsRepo } = require('./src/db/chatSnapshotsRepo')
const { setupChatDbRepo } = require('./src/db/chatDbRepo')

const {
  getStoredToken,
  getAllStoredTokens,
  upsertStoredToken,
  deleteStoredToken,
  loadStoredTokenPlain,
  getTokenFromBodyOrStored,
  getTokenFromQueryOrStored,
} = setupTokensRepo(db)

const { setupApprouteRepo } = require('./src/db/approuteRepo')
const { loadApprouteApiKeyPlain, saveApprouteApiKey, getApprouteSettingsMeta } = setupApprouteRepo(db)

const { setupClodeRepo } = require('./src/db/clodeRepo')
const { loadClodeApiKeyPlain, saveClodeApiKey, getClodeSettingsMeta } = setupClodeRepo(db)

const { setupUsdRateService } = require('./src/features/fx/usdRateService')
const usdRateService = setupUsdRateService(db)

// Прогрев курсов USD в фоне — чтобы первые запросы статистики/чат-финансов
// не блокировались массовой загрузкой курсов с ЦБ (далее всё из кэша БД).
setTimeout(() => {
  try {
    const rows = db.prepare('SELECT DISTINCT sold_at FROM sales_history').all()
    const dates = [...new Set(rows.map((r) => usdRateService.ymdFromUnix(r.sold_at)).filter(Boolean))]
    if (dates.length > 0) void usdRateService.ensureRatesForDates(dates).catch(() => {})
  } catch (_) {}
}, 2000)

const { runApprouteAutodelivery } = require('./src/features/approute/runApprouteAutodelivery')

chatSnapshotsRepo = setupChatSnapshotsRepo(db)
const chatDbRepo = setupChatDbRepo(db)

const { setupProductSettingsRepo } = require('./src/db/productSettingsRepo')

const { getSettings, getAllSettings, upsertSettings, deleteSettings } = setupProductSettingsRepo(db)

const { setupPlayerokOutboundIpRepo } = require('./src/db/playerokOutboundIpRepo')
const {
  loadBindings: loadOutboundIpBindings,
  loadRotation: loadOutboundIpRotation,
  saveBindings: saveOutboundIpBindings,
  saveSettings: saveOutboundIpSettings,
} = setupPlayerokOutboundIpRepo(db)
const { setOutboundIpBindingsResolver, setOutboundRotationResolver } = require('./src/infra/playerokOutboundIp')
setOutboundIpBindingsResolver(loadOutboundIpBindings)
setOutboundRotationResolver(loadOutboundIpRotation)

const { setupHistoryRepo } = require('./src/db/historyRepo')
const { setupTableCodesRepo } = require('./src/db/tableCodesRepo')
const { setupTableTabsRepo } = require('./src/db/tableTabsRepo')
const { setupTableColumnsRepo } = require('./src/db/tableColumnsRepo')

const {
  insertBump,
  getBumpHistory,
  insertSale,
  getSalesHistory,
  getSalesHistoryAll,
  deleteSalesHistoryByUser,
  insertListingFee,
  getListingFees,
  upsertHiddenChat,
  deleteHiddenChat,
  getHiddenChats,
  getSalesYears,
  getSalesMonthsForYear,
} = setupHistoryRepo(db)

const {
  insertCode,
  insertCodesBulk,
  getCodesByUserAndCategory,
  updateCodeUsed,
  deleteCodeById,
  deleteCodesByCategory,
  getCodeById,
  claimNextUnusedCode,
  markCodeUsed,
  releaseCode,
} = setupTableCodesRepo(db)
const {
  getColumnsBySubtab,
  getColumnById,
  getMaxSortOrderBySubtab,
  insertColumn,
  updateColumnName,
  deleteColumnById,
  deleteColumnsBySubtabId,
  getValuesByCategory,
  upsertCellValue,
} = setupTableColumnsRepo(db)
const {
  getTabsByUser,
  getSubtabsByUser,
  insertTab,
  insertSubtab,
  getTabById,
  getSubtabById,
  getSubtabIdsByTabId,
  updateSubtabName,
  deleteSubtabTx,
  deleteTabTx,
  ensureDefaultTabsTx,
} = setupTableTabsRepo(db, { deleteCodesByCategory, deleteColumnsBySubtabId })

const { setupPartnersRepo } = require('./src/db/partnersRepo')
const {
  upsertInvite,
  deleteInvite,
  getInvite,
  confirmConnect,
  getPartnersForOwner,
  getDirectorsForWorker,
} = setupPartnersRepo(db)

const { setupRobloxAccountsRepo } = require('./src/db/robloxAccountsRepo')
const robloxAccountsRepo = setupRobloxAccountsRepo(db)

const { setupMicrosoftAccountsRepo } = require('./src/db/microsoftAccountsRepo')
const microsoftAccountsRepo = setupMicrosoftAccountsRepo(db)

const { setupRobloxOrdersRepo } = require('./src/db/robloxOrdersRepo')
const robloxOrdersRepo = setupRobloxOrdersRepo(db)

const CATEGORY_SETTINGS_PREFIX = '__category__::'
const GROUP_SETTINGS_PREFIX = '__group__::'

const { getCategorySettingsKey, getGroupSettingsKey } = createProductSettingsKeyFns({
  CATEGORY_SETTINGS_PREFIX,
  GROUP_SETTINGS_PREFIX,
})

resolveEffectiveProductSettings = createResolveEffectiveProductSettings({
  getSettings,
  getGroupSettingsKey,
})

const { sendJson } = require('./src/http/sendJson')
const { readJsonBody } = require('./src/http/readJsonBody')
const { dispatchPublicAuth, dispatchPrivateAuthAndSettings } = require('./src/http/dispatchAuthSettings')
const { dispatchFinance } = require('./src/http/dispatchFinance')
const { dispatchPlayerok } = require('./src/http/dispatchPlayerok')
const { dispatchChatDb } = require('./src/http/dispatchChatDb')
const { dispatchRoblox } = require('./src/http/dispatchRoblox')
const { dispatchDownload } = require('./src/http/dispatchDownload')
const { isAllActionsStopped } = require('./src/infra/runtimeControl')

const { processActiveSupercellFlows } = require('./src/features/autolist/processActiveSupercellFlows')
const { processActiveTopupFlows } = require('./src/features/autolist/processActiveTopupFlows')
const { createProcessSingleTopupFlow } = require('./src/features/approute/runApprouteTopup')
const {
  checkApprouteDtuOrder,
  createApprouteDtuOrderAndConfirm,
  isApprouteValidationError: isApprouteValidationErrorFn,
} = require('./src/integrations/approute/approuteClient')
const { processActiveClodeFlows } = require('./src/features/autolist/processActiveClodeFlows')
const { createProcessSingleClodeFlow } = require('./src/features/clode/runClodeRedeemFlow')
const {
  redeemClaudeAndConfirm,
  pollClaudeTask,
  isClodeValidationError,
  extractClaudeUserId,
  normalizeClodePlan,
} = require('./src/integrations/clode/clodeClient')
const { processActiveGptFlows } = require('./src/features/autolist/processActiveGptFlows')
const { createProcessSingleGptFlow } = require('./src/features/gpt/runGptRedeemFlow')
const {
  redeemGptAndConfirm,
  isGptTokenFaultError,
  isGptStockError,
  extractGoogleDocId,
  fetchGoogleDocText,
  extractGptAccessToken,
} = require('./src/integrations/gpt/gptClient')
const { scanCompletedAndRelist } = require('./src/features/autolist/scanCompletedAndRelist')
const { handlePaidChat } = require('./src/features/autolist/handlePaidChat')
const {
  handleOrderedStageAutomessage,
  handlePostPurchaseAutomessage,
  handleDealConfirmedAutomessage,
  handlePurchaseWindowAutomessage,
  handleImageAutomessage,
} = require('./src/features/autolist/handleChatAutomessage')
const { handleAutolistTick } = require('./src/features/autolist/handleAutolistTick')
const { handleRelistItem } = require('./src/features/playerok/relistItem/handleRelistItem')
const { handleItemPriorityStatuses } = require('./src/features/playerok/itemPriorityStatuses/handleItemPriorityStatuses')
const { handleCompletedLots } = require('./src/features/playerok/completedLots/handleCompletedLots')
const { handleCompletedDeals } = require('./src/features/playerok/completedDeals/handleCompletedDeals')
const { handleBump } = require('./src/features/playerok/bump/handleBump')
const { handleSendChatMessage } = require('./src/features/playerok/sendChatMessage/handleSendChatMessage')
const { handleDealChatMessages } = require('./src/features/playerok/dealChatMessages/handleDealChatMessages')
const { handleRequestSupercellCode } = require('./src/features/playerok/requestSupercellCode/handleRequestSupercellCode')
const { handleCancelDeal } = require('./src/features/playerok/dealsActions/handleCancelDeal')
const { handleConfirmDeal } = require('./src/features/playerok/dealsActions/handleConfirmDeal')
const { handleInProgressDeals } = require('./src/features/playerok/inProgressDeals/handleInProgressDeals')

const { handleGetProductSettings } = require('./src/features/productSettings/handleGetProductSettings')
const { handleGetProductSettingsList } = require('./src/features/productSettings/handleGetProductSettingsList')
const { handleUpsertProductSettings } = require('./src/features/productSettings/handleUpsertProductSettings')
const { handleDeleteProductSettings } = require('./src/features/productSettings/handleDeleteProductSettings')
const { handleCategoryCommandsList } = require('./src/features/productSettings/handleCategoryCommandsList')
const { handleCategoryCommandsUpsert } = require('./src/features/productSettings/handleCategoryCommandsUpsert')

const { computeProfitAnalyticsList } = require('./src/features/profit/computeProfitAnalyticsList')

const PAGE_SIZE = 24
const ITEMS_PERSISTED_HASH =
  '63eefcfd813442882ad846360d925279bc376e8bc85a577ebefbee0f9c78b557'

const VIEWER_QUERY =
  'query viewer { viewer { ...Viewer __typename } } fragment Viewer on User { id username email role hasFrozenBalance __typename }'

const AUTOBUMP_PRIORITY_STATUS_ID = '1f00f21b-7768-62a0-296f-75a31ee8ce72'
const ITEM_PRIORITY_STATUSES_PERSISTED_HASH =
  'b922220c6f979537e1b99de6af8f5c13727daeff66727f679f07f986ce1c025a'
const DEALS_PERSISTED_HASH =
  'c3b623b5fe0758cf91b2335ebf36ff65f8650a6672a792a3ca7a36d270d396fb'
const USER_CHATS_PERSISTED_HASH =
  '999f86b7c94a4cb525ed5549d8f24d0d24036214f02a213e8fd7cefc742bbd58'
const ITEM_PERSISTED_HASH =
  '37d2d9f947e950c09322e2f5e3056451ee5f12dc38565eb811423e915c094c22'
const DEAL_PERSISTED_HASH =
  '5652037a966d8da6d41180b0be8226051fe0ed1357d460c6ae348c3138a0fba3'
const CHAT_PERSISTED_HASH =
  '38efcc58bdc432cc05bc743345e9ef9653a3ca1c0f45db822f4166d0f0cc17c4'
const TRANSACTION_PROVIDERS_PERSISTED_HASH =
  '31960e5dd929834c1f85bc685db80657ff576373076f016b2578c0a34e6e9f42'
const TRANSACTIONS_PERSISTED_HASH =
  'e3c9d07ba6b2dd15cc82c5006449db50f8d9b88b0c4cb02d50d308ebee1276f6'
const VERIFIED_CARDS_PERSISTED_HASH =
  'eb338d8432981307a2b3d322b3310b2447cab3a6acf21aba4b8773b97e72d1aa'

const {
  AUTOLIST_LAST_CHAT_FRESH_SEC,
  AUTOLIST_MAX_CHATS_TO_SCAN,
  AUTOLIST_PROCESSED_TTL_SEC,
  AUTOLIST_SEEN_CHAT_TTL_SEC,
  AUTOLIST_ITEM_STATE_TTL_SEC,
  AUTOLIST_COMPLETED_SCAN_INTERVAL_SEC,
  autolistGetProcessedMap,
  autolistPruneProcessedMap,
  autolistWasProcessed,
  autolistMarkProcessed,
  autolistClearProcessed,
  autolistClearApprouteChatProcessed,
  autolistGetSeenChatsMap,
  autolistPruneSeenChatsMap,
  autolistWasChatSeen,
  autolistMarkChatSeen,
  autolistGetItemStateMap,
  autolistPruneItemStateMap,
  autolistSetItemState,
  autolistGetItemState,
  autolistGetCompletedScanMap,
  autolistGetLastChatMeta,
  autolistGetApprouteRetryMap,
  autolistGetSupercellFlowMap,
  autolistPruneSupercellFlowMap,
  autolistGetTopupFlowMap,
  autolistPruneTopupFlowMap,
  autolistGetClodeFlowMap,
  autolistPruneClodeFlowMap,
  autolistGetGptFlowMap,
  autolistPruneGptFlowMap,
  gptDealWasRedeemed,
  gptMarkDealRedeemed,
} = require('./src/features/autolist/autolistState')

const getViewer = createGetViewer({
  VIEWER_QUERY,
  PLAYEROK_USER_AGENT,
})

// Кэшированный getViewer для частых фоновых опросов (chatsSync 500мс,
// dealStatusWatch 6с): успешный viewer кэшируется на 60с, ошибки пробрасываются.
// Интерактивные пути (ddos-check, ручные обновления, dispatch-хендлеры)
// продолжают использовать «живой» getViewer выше.
const { createCachedGetViewer } = require('./src/functions/createCachedGetViewer')
const getViewerCached = createCachedGetViewer({ getViewer, ttlMs: 60000 })

const { createIncreaseItemPriorityStatus } = require('./src/functions/playerokIncreaseItemPriorityStatus')

const increaseItemPriorityStatus = createIncreaseItemPriorityStatus({
  AUTOBUMP_PRIORITY_STATUS_ID,
})

/** Выставить завершённый товар снова (relist) — тот же itemId, Playerok может вернуть новый id после публикации */
const { createPublishItem } = require('./src/functions/playerokPublishItem')

const publishItem = createPublishItem({
  AUTOBUMP_PRIORITY_STATUS_ID,
})

/** Отправить сообщение в чат */
const { createCreateChatMessage } = require('./src/functions/playerokCreateChatMessage')

const createChatMessage = createCreateChatMessage()

/** Отправить картинку в чат (автосообщение картинкой) */
const { createSendChatImage } = require('./src/functions/playerokSendChatImage')
const sendChatImage = createSendChatImage()
const { dispatchAutomessageImage } = require('./src/http/dispatchAutomessageImage')
const automessageImagesDir = path.join(DATA_DIR, 'automessage-images')

/** Обновить статус сделки (например, SENT / ROLLED_BACK) */
const { createUpdateDealStatus } = require('./src/functions/playerokUpdateDealStatus')

const updateDealStatus = createUpdateDealStatus()

const { createFetchItemPriorityStatuses } = require('./src/functions/playerokFetchItemPriorityStatuses')

const fetchItemPriorityStatuses = createFetchItemPriorityStatuses({
  ITEM_PRIORITY_STATUSES_PERSISTED_HASH,
})

const { createRequestItemsPage } = require('./src/functions/playerokRequestItemsPage')

const requestItemsPage = createRequestItemsPage({
  PAGE_SIZE,
  ITEMS_PERSISTED_HASH,
})

/** Сделки (продажи) со страницы /profile/.../sales — все статусы: выполнение, подтверждение, завершено, возврат */
const { createRequestDealsPage } = require('./src/functions/playerokRequestDealsPage')

const requestDealsPage = createRequestDealsPage({
  PAGE_SIZE,
  DEALS_PERSISTED_HASH,
})

const { createRequestUserChatsPage } = require('./src/functions/playerokRequestUserChatsPage')

const requestUserChatsPage = createRequestUserChatsPage({
  AUTOLIST_MAX_CHATS_TO_SCAN,
  USER_CHATS_PERSISTED_HASH,
})

const { createRequestChatById } = require('./src/functions/playerokRequestChatById')

const requestChatById = createRequestChatById({ CHAT_PERSISTED_HASH })

/** Страница сообщений чата (аналог get_chat_messages из PlayerokAPI) */
const { createRequestChatMessagesPage } = require('./src/functions/playerokRequestChatMessagesPage')

const requestChatMessagesPage = createRequestChatMessagesPage()

const { createRequestItemById } = require('./src/functions/playerokRequestItemById')

const requestItemById = createRequestItemById({ ITEM_PERSISTED_HASH })

const { createRequestDealById } = require('./src/functions/playerokRequestDealById')

const requestDealById = createRequestDealById({ DEAL_PERSISTED_HASH })

const { extractItemImageUrl } = require('./src/functions/extractItemImageUrl')

const { toUnixTs } = require('./src/functions/toUnixTs')
const { dealPurchaseUnixTs } = require('./src/functions/dealPurchaseUnixTs')

/** Продажи со страницы /profile/.../sales — ограничено для быстрой загрузки истории */
const SALES_HISTORY_LIMIT = 72

const { createFetchDealsFromPlayerok } = require('./src/functions/playerokFetchDealsFromPlayerok')

const fetchDealsFromPlayerok = createFetchDealsFromPlayerok({
  SALES_HISTORY_LIMIT,
  getViewer: getViewerCached,
  requestDealsPage,
})

/** Актуальные сделки в выполнении (напрямую с Playerok, без БД) */
const { createFetchInProgressDealsFromPlayerok } = require('./src/functions/playerokFetchInProgressDealsFromPlayerok')

const fetchInProgressDealsFromPlayerok = createFetchInProgressDealsFromPlayerok({
  getViewer: getViewerCached,
  requestDealsPage,
})

/** Завершённые сделки (SENT, CONFIRMED) — для блока «Непрочитанные чаты» */
const { createFetchCompletedDealsFromPlayerok } = require('./src/functions/playerokFetchCompletedDealsFromPlayerok')

const fetchCompletedDealsFromPlayerok = createFetchCompletedDealsFromPlayerok({
  getViewer: getViewerCached,
  requestDealsPage,
})

/** Все сообщения чата по chatId или по dealId (если chatId не передан). Подгружаем все страницы. */
const { createFetchDealChatMessagesFromPlayerok } = require('./src/functions/playerokFetchDealChatMessagesFromPlayerok')
const { createRequestChatDealIdPost } = require('./src/functions/playerokRequestChatDealIdPost')

const requestChatDealIdPost = createRequestChatDealIdPost()

const fetchDealChatMessagesFromPlayerok = createFetchDealChatMessagesFromPlayerok({
  requestDealById,
  requestChatById,
  requestChatDealIdPost,
  requestChatMessagesPage,
  extractItemImageUrl,
  extractSupercellEmailFromFields,
  getLatestBuyerEmailFromMessages,
})

const { createChatDbSyncService } = require('./src/features/chat-db/chatDbSyncService')
const chatDbSyncService = createChatDbSyncService({
  chatDbRepo,
  getViewer: getViewerCached,
  requestUserChatsPage,
  fetchDealChatMessagesFromPlayerok,
  userAgentProvider: () =>
    PLAYEROK_USER_AGENT ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  runAutomationForChat: async ({ userId, token, userAgent, chatId, dealId, dealItemId, prefetched }) => {
    if (!postLocalRef) return
    try {
      await postLocalRef('/api/playerok/deal-chat-messages', {
        userId,
        token,
        userAgent,
        chatId,
        ...(dealId ? { dealId } : {}),
        ...(dealItemId ? { dealItemId } : {}),
        ...(prefetched ? { prefetched } : {}),
      })
    } catch (_) {
      // ignore automation bridge errors
    }
  },
})

// Отправить текстовое сообщение в чат по chatId или dealId.
const { createSendChatMessageToPlayerok } = require('./src/functions/playerokSendChatMessageToPlayerok')

const sendChatMessageToPlayerok = createSendChatMessageToPlayerok({
  requestDealById,
  createChatMessage,
})

const { createFetchTransactionProviders } = require('./src/functions/playerokFetchTransactionProviders')
const fetchTransactionProviders = createFetchTransactionProviders({
  TRANSACTION_PROVIDERS_PERSISTED_HASH,
})

const { createFetchTransactions } = require('./src/functions/playerokFetchTransactions')
const fetchTransactions = createFetchTransactions({
  TRANSACTIONS_PERSISTED_HASH,
})

const { createFetchVerifiedCards } = require('./src/functions/playerokFetchVerifiedCards')
const fetchVerifiedCards = createFetchVerifiedCards({
  VERIFIED_CARDS_PERSISTED_HASH,
})

const { createRequestWithdrawal } = require('./src/functions/playerokRequestWithdrawal')
const requestWithdrawal = createRequestWithdrawal()

const { createRemoveTransaction } = require('./src/functions/playerokRemoveTransaction')
const removeTransaction = createRemoveTransaction()

const requestSupercellCodeForChat = createRequestSupercellCodeForChat({
  sendChatMessageToPlayerok,
})

/** Обработка одного конкретного Supercell flow чата */
const processSingleSupercellFlow = createProcessSingleSupercellFlow({
  autolistGetSupercellFlowMap,
  getSupercellGameByCategory,
  fetchDealChatMessagesFromPlayerok,
  hasSupercellCodeRequestedMessage,
  isEmailValid,
  withRetry,
  isPlayerokRateLimitError,
  createChatMessage,
  requestSupercellCodeForChat,
  chatDbRepo,
})

const processSingleTopupFlow = createProcessSingleTopupFlow({
  autolistGetTopupFlowMap,
  fetchDealChatMessagesFromPlayerok,
  withRetry,
  isPlayerokRateLimitError,
  createChatMessage,
  loadApprouteApiKeyPlain,
  checkApprouteDtuOrder,
  createApprouteDtuOrderAndConfirm,
  isApprouteValidationError: isApprouteValidationErrorFn,
  updateDealStatus,
  toUnixTs,
})

const processSingleClodeFlow = createProcessSingleClodeFlow({
  autolistGetClodeFlowMap,
  fetchDealChatMessagesFromPlayerok,
  withRetry,
  isPlayerokRateLimitError,
  createChatMessage,
  loadClodeApiKeyPlain,
  redeemClaudeAndConfirm,
  pollClaudeTask,
  extractClaudeUserId,
  normalizeClodePlan,
  isClodeValidationError,
  claimNextUnusedTableCode: claimNextUnusedCode,
  markTableCodeUsed: markCodeUsed,
  releaseTableCode: releaseCode,
  updateDealStatus,
  toUnixTs,
})

const processSingleGptFlow = createProcessSingleGptFlow({
  autolistGetGptFlowMap,
  fetchDealChatMessagesFromPlayerok,
  withRetry,
  isPlayerokRateLimitError,
  createChatMessage,
  extractGoogleDocId,
  fetchGoogleDocText,
  extractGptAccessToken,
  redeemGptAndConfirm,
  isGptTokenFaultError,
  isGptStockError,
  claimNextUnusedTableCode: claimNextUnusedCode,
  markTableCodeUsed: markCodeUsed,
  releaseTableCode: releaseCode,
  updateDealStatus,
  gptDealWasRedeemed,
  gptMarkDealRedeemed,
  toUnixTs,
})

/** Все сделки (продажи) с Playerok без лимита — для синхронизации в БД */
const { createFetchAllDealsFromPlayerok } = require('./src/functions/playerokFetchAllDealsFromPlayerok')

const fetchAllDealsFromPlayerok = createFetchAllDealsFromPlayerok({
  getViewer,
  requestDealsPage,
})

const { createFetchActiveItemsFromPlayerok } = require('./src/functions/playerokFetchActiveItemsFromPlayerok')

const fetchActiveItemsFromPlayerok = createFetchActiveItemsFromPlayerok({
  getViewer: getViewerCached,
  requestItemsPage,
  lotsCache,
  LOTS_CACHE_TTL_MS,
})

/** Завершённые товары: /profile/.../products/completed — на странице отображаются SOLD и EXPIRED. */
const { createFetchCompletedItemsFromPlayerok } = require('./src/functions/playerokFetchCompletedItemsFromPlayerok')

const fetchCompletedItemsFromPlayerok = createFetchCompletedItemsFromPlayerok({
  getViewer: getViewerCached,
  requestItemsPage,
  lotsCache,
  LOTS_CACHE_TTL_MS,
})

const handleHttpRequest = async (req, res) => {
  const origin = req.headers.origin
  // Для fetch с `credentials: 'include'` нельзя отдавать `*` в `Access-Control-Allow-Origin`.
  // Поэтому при наличии Origin — эхоим его и включаем `Access-Control-Allow-Credentials`,
  // credentials включаются для любого Origin.
  // Опциональный белый список источников (env CORS_ALLOWED_ORIGINS, через запятую).
  // Если задан — отражаем Origin и включаем credentials ТОЛЬКО для разрешённых доменов
  // (закрывает отражение любого Origin с credentials). Если НЕ задан — прежнее поведение
  // (отражаем любой Origin), чтобы не сломать доступ к панели.
  if (origin) {
    const corsAllowList = String(process.env.CORS_ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (corsAllowList.length === 0 || corsAllowList.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Access-Control-Allow-Credentials', 'true')
    }
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  // Базовые security-заголовки (defense-in-depth; nginx их сейчас не ставит). Referrer-Policy
  // важен для публичных /roblox/2fa|/captcha страниц (не утекать token в Referer на сторонние
  // скрипты Arkose). nosniff/SAMEORIGIN — против MIME-снифинга и кликджекинга.
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')

  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    return res.end()
  }

  const parsedUrl = new URL(req.url || '/', `http://localhost:${PORT}`)
  const pathname = parsedUrl.pathname
  const query = Object.fromEntries(parsedUrl.searchParams)
  const nowTs = Math.floor(Date.now() / 1000)

  // Лёгкий health-эндпоинт (до сессионной проверки) — для docker healthcheck и nginx
  // depends_on: condition: service_healthy. Не ходит в Playerok/БД, отвечает мгновенно.
  if (pathname === '/healthz') {
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    return res.end(JSON.stringify({ ok: true, version: process.env.APP_VERSION || 'dev' }))
  }

  // Публичный раздел «Загрузка» (скрипты для скачивания) — без сессии, до фронтенд-статики.
  {
    const handled = await dispatchDownload({ req, res, pathname })
    if (handled) return
  }

  // Auth endpoints (no session required): login/register
  {
    const handled = await dispatchPublicAuth({
      req,
      res,
      pathname,
      deps: { createSession, db, verifyPassword, hashPassword },
    })
    if (handled) return
  }

  // Сессия для /api/*: с не-localhost без cookie — 401. С localhost фоновые вызовы без сессии всё ещё проходят (userId по умолчанию 1 или из куки).
  let currentUserId = 1
  if (pathname.startsWith('/api/')) {
    // КРИТИЧНО (auth-bypass fix): nginx (network_mode:host) проксирует на 127.0.0.1:3000,
    // поэтому ВСЕ внешние запросы приходят с remoteAddress=127.0.0.1. По source-IP «локальность»
    // определять нельзя. Доверяем «внутренней» (без сессии) ТОЛЬКО self-call'у с правильным
    // X-Internal-Secret (его ставит postLocal; внешний клиент через nginx подделать не может —
    // секрет лежит только в памяти процесса). Всё остальное под /api/* требует валидную сессию.
    const isInternal = isTrustedInternalRequest(req)
    req.__trustedInternal = isInternal
    const sessionId = getSessionIdFromRequest(req)
    if (sessionId && isSessionValid(sessionId)) {
      const uid = getSessionUserId(sessionId)
      if (uid) currentUserId = uid
    }
    if (!isInternal) {
      if (!sessionId || !isSessionValid(sessionId) || !getSessionUserId(sessionId)) {
        return sendJson(res, 401, { error: 'Unauthorized' })
      }
    }
  }
  // Auth endpoints + settings (require currentUserId): me/logout/token/settings
  {
    const handled = await dispatchPrivateAuthAndSettings({
      req,
      res,
      pathname,
      query,
      currentUserId,
      deps: {
        db,
        hashPassword,
        verifyPassword,
        getSessionIdFromRequest,
        isSessionValid,
        getSessionUserId,
        destroySession,
        destroyUserSessions,
        loadStoredTokenPlain,
        encryptToken,
        upsertStoredToken,
        deleteStoredToken,
        getTokenFromQueryOrStored,
        getSettings,
        getAllSettings,
        upsertSettings,
        deleteSettings,
        CATEGORY_SETTINGS_PREFIX,
        getCategorySettingsKey,
        getTokenFromBodyOrStored,
        autolistClearApprouteChatProcessed,
        // partners
        upsertInvite,
        deleteInvite,
        getInvite,
        confirmConnect,
        getPartnersForOwner,
        getDirectorsForWorker,
        loadOutboundIpBindings,
        saveOutboundIpBindings,
        loadOutboundIpRotation,
        saveOutboundIpSettings,
        loadApprouteApiKeyPlain,
        saveApprouteApiKey,
        getApprouteSettingsMeta,
        loadClodeApiKeyPlain,
        saveClodeApiKey,
        getClodeSettingsMeta,
      },
    })
    if (handled) return
  }

  // Вкладка «Роблокс»: метод MS Store (аккаунты Roblox, MS-аккаунты, заказы, вход покупателя,
  // воркер). Маршруты /roblox/2fa/* и /roblox/worker/* — публичные (не под сессией сайта).
  {
    const handled = await dispatchRoblox({
      req,
      res,
      pathname,
      currentUserId,
      deps: {
        robloxAccountsRepo,
        microsoftAccountsRepo,
        robloxOrdersRepo,
        publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
        getCaptchaConfig: () => ({
          provider: String(process.env.ROBLOX_CAPTCHA_PROVIDER || '').trim(),
          apiKey: String(process.env.ROBLOX_CAPTCHA_API_KEY || '').trim(),
          proxy: String(process.env.ROBLOX_CAPTCHA_PROXY || '').trim(),
        }),
      },
    })
    if (handled) return
  }

  const { runWithPlayerokUser } = require('./src/infra/playerokRequestContext')
  return runWithPlayerokUser(currentUserId, async () => {
  if (pathname === '/api/playerok/ddos-cookie') {
    if (req.method === 'GET') {
      const value = getPlayerokDdosCookie()
      return sendJson(res, 200, {
        ok: true,
        configured: Boolean(value),
        length: value.length,
      })
    }
    if (req.method === 'POST') {
      try {
        const body = await readJsonBody(req, { fallback: {} })
        const nextCookie = String(body && body.cookie ? body.cookie : '').trim()
        setPlayerokDdosCookie(nextCookie)
        return sendJson(res, 200, {
          ok: true,
          configured: Boolean(nextCookie),
          length: nextCookie.length,
        })
      } catch (err) {
        const code = Number(err && err.statusCode) || 400
        return sendJson(res, code, { error: err && err.message ? err.message : 'Invalid request body' })
      }
    }
  }
  if (pathname === '/api/playerok/ddos-check' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req, { fallback: {} })
      const { token } = getTokenFromBodyOrStored(currentUserId, payload)
      const userAgent = payload && payload.userAgent
      if (!token) {
        return sendJson(res, 400, { ok: false, error: 'Token is required' })
      }
      const viewer = await getViewer(token, userAgent)
      return sendJson(res, 200, {
        ok: true,
        viewer: {
          id: viewer.id,
          username: viewer.username,
          email: viewer.email || null,
        },
      })
    } catch (err) {
      const message = err && err.message ? String(err.message) : 'Playerok check failed'
      const statusCode = Number(err && err.statusCode)
      const httpCode = statusCode >= 400 && statusCode < 600 ? statusCode : 500
      const isDdosGuard = /ddos-guard|js-challenge/i.test(message)
      return sendJson(res, httpCode, {
        ok: false,
        error: message,
        isDdosGuard,
      })
    }
  }

  // Загрузка/отдача картинок автосообщения
  {
    const handled = await dispatchAutomessageImage({
      req,
      res,
      pathname,
      currentUserId,
      deps: { automessageImagesDir },
    })
    if (handled) return
  }

  // Finance endpoints dispatcher (sales/bump/logs/profit)
  {
    const handled = await dispatchChatDb({
      req,
      res,
      pathname,
      currentUserId,
      deps: {
        chatDbRepo,
        chatDbSyncService,
        fetchDealChatMessagesFromPlayerok,
        requestDealById,
        getTokenFromBodyOrStored,
        getHiddenChats,
        getViewer,
        sendChatMessageToPlayerok,
        loadStoredTokenPlain,
        getAllStoredTokens,
        getSalesHistoryAll,
        getBumpHistory,
        getAllSettings,
        getListingFees,
        computeProfitAnalyticsList,
        usdRateService,
        resolveEffectiveProductSettings,
        automessageImagesDir,
      },
    })
    if (handled) return
  }

  // Finance endpoints dispatcher (sales/bump/logs/profit)
  {
    const handled = await dispatchFinance({
      req,
      res,
      pathname,
      query,
      currentUserId,
      deps: {
        getTokenFromQueryOrStored,
        getTokenFromBodyOrStored,
        getSalesHistory,
        deleteSalesHistoryByUser,
        fetchAllDealsFromPlayerok,
        requestDealById,
        insertSale,
        toUnixTs,
        dealPurchaseUnixTs,
        getViewer,
        requestDealsPage,
        getBumpHistory,
        getLogsBuffer,
        parseIntSafe,
        getSalesYears,
        getSalesMonthsForYear,
        getSalesHistoryAll,
        getAllSettings,
        getListingFees,
        computeProfitAnalyticsList,
        clampInt,
        usdRateService,
        insertCode,
        insertCodesBulk,
        getCodesByUserAndCategory,
        updateCodeUsed,
        deleteCodeById,
        getCodeById,
        getTabsByUser,
        getSubtabsByUser,
        insertTab,
        insertSubtab,
        getTabById,
        getSubtabById,
        updateSubtabName,
        getSubtabIdsByTabId,
        deleteSubtabTx,
        deleteTabTx,
        ensureDefaultTabsTx,
        getColumnsBySubtab,
        getColumnById,
        getMaxSortOrderBySubtab,
        insertColumn,
        updateColumnName,
        deleteColumnById,
        getValuesByCategory,
        upsertCellValue,
      },
    })
    if (handled) return
  }

  // Playerok endpoints dispatcher (bump..confirm-deal)
  {
    const handled = await dispatchPlayerok({
      req,
      res,
      pathname,
      currentUserId,
      nowTs,
      deps: {
        getTokenFromBodyOrStored,
        // IDOR-защита: внешнему запросу разрешаем body-userId только если это сам себя
        // или ПОДТВЕРЖДЁННЫЙ партнёр (директор→воркер, connect_status=2). Иначе игнор.
        isAuthorizedPartnerUserId: (directorId, targetId) => {
          try {
            const rows = getPartnersForOwner.all(Number(directorId)) || []
            return rows.some(
              (r) => Number(r.partner_user_id) === Number(targetId) && Number(r.connect_status) === 2
            )
          } catch {
            return false
          }
        },
        requestItemById,
        fetchItemPriorityStatuses,
        increaseItemPriorityStatus,
        insertBump,
        isPlayerokRateLimitError,
        isPlayerokPublishRetryable,
        withRetry,
        getViewer,
        requestUserChatsPage,
        AUTOLIST_MAX_CHATS_TO_SCAN,
        autolistGetCompletedScanMap,
        autolistGetLastChatMeta,
        autolistGetApprouteRetryMap,
        autolistPruneProcessedMap,
        autolistPruneSeenChatsMap,
        autolistPruneItemStateMap,
        autolistPruneSupercellFlowMap,
        AUTOLIST_COMPLETED_SCAN_INTERVAL_SEC,
        AUTOLIST_LAST_CHAT_FRESH_SEC,
        AUTOBUMP_PRIORITY_STATUS_ID,
        scanCompletedAndRelist,
        fetchCompletedItemsFromPlayerok,
        autolistGetItemState,
        autolistWasProcessed,
        autolistMarkProcessed,
        autolistClearProcessed,
        autolistSetItemState,
        getSettings,
        getGroupSettingsKey,
        publishItem,
        insertListingFee,
        normalizeKeyPart,
        buildProductKey,
        handlePaidChat,
        claimNextUnusedTableCode: claimNextUnusedCode,
        loadApprouteApiKeyPlain,
        runApprouteAutodelivery,
        requestDealById,
        requestChatDealIdPost,
        toUnixTs,
        dealPurchaseUnixTs,
        insertSale,
        resolveEffectiveProductSettings,
        getSupercellGameByCategory,
        pickSupercellCategoryFromItemHints,
        autolistGetSupercellFlowMap,
        autolistGetTopupFlowMap,
        autolistPruneTopupFlowMap,
        autolistGetClodeFlowMap,
        autolistPruneClodeFlowMap,
        autolistGetGptFlowMap,
        autolistPruneGptFlowMap,
        extractSupercellEmailFromFields,
        upsertSettings,
        createChatMessage,
        sleep,
        processActiveSupercellFlows,
        processSingleSupercellFlow,
        processActiveTopupFlows,
        processSingleTopupFlow,
        processActiveClodeFlows,
        processSingleClodeFlow,
        processActiveGptFlows,
        processSingleGptFlow,
        isSupercellModuleEnabled,
        handleOrderedStageAutomessage,
        handlePostPurchaseAutomessage,
        handleDealConfirmedAutomessage,
        handlePurchaseWindowAutomessage,
        handleImageAutomessage,
        sendChatImage,
        automessageImagesDir,
        fetchInProgressDealsFromPlayerok,
        fetchActiveItemsFromPlayerok,
        fetchCompletedDealsFromPlayerok,
        fetchCompletedItemsFromPlayerok,
        fetchDealsFromPlayerok,
        fetchDealChatMessagesFromPlayerok,
        sendChatMessageToPlayerok,
        requestSupercellCodeForChat,
        updateDealStatus,
        getHiddenChats,
        requestChatById,
        requestChatMessagesPage,
        extractItemImageUrl,
        upsertHiddenChat,
        deleteHiddenChat,
        fetchTransactionProviders,
        fetchTransactions,
        fetchVerifiedCards,
        requestWithdrawal,
        removeTransaction,
        getChatsSnapshotCache,
        setChatsSnapshotCache,
        isChatsSnapshotFresh,
        scheduleChatsSnapshotRefresh,
        isAllActionsStopped,
      },
    })

    if (handled) return
  }

  // Раздача фронтенда (статика из frontend/dist)
  if (req.method === 'GET' && pathname === '/favicon.ico') {
    const faviconPath = path.join(FRONTEND_DIST, 'favicon.ico')
    if (fs.existsSync(faviconPath)) {
      res.setHeader('Content-Type', 'image/x-icon')
      res.setHeader('Cache-Control', 'public, max-age=86400')
      res.statusCode = 200
      return res.end(fs.readFileSync(faviconPath))
    }
  }

  if (req.method === 'GET' && !pathname.startsWith('/api/')) {
    const safePath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '').replace(/\.\./g, '')
    const filePath = path.join(FRONTEND_DIST, safePath)
    if (fs.existsSync(FRONTEND_DIST) && fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath)
      if (stat.isFile()) {
        const ext = path.extname(filePath)
        const types = {
          '.html': 'text/html; charset=utf-8',
          '.js': 'application/javascript; charset=utf-8',
          '.css': 'text/css; charset=utf-8',
          '.ico': 'image/x-icon',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.svg': 'image/svg+xml',
          '.woff': 'font/woff',
          '.woff2': 'font/woff2',
        }
        res.setHeader('Content-Type', types[ext] || 'application/octet-stream')
        res.statusCode = 200
        return res.end(fs.readFileSync(filePath))
      }
    }
    // SPA: неизвестный путь — отдаём index.html (клиентский роутинг)
    const indexHtml = path.join(FRONTEND_DIST, 'index.html')
    if (fs.existsSync(indexHtml)) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.statusCode = 200
      return res.end(fs.readFileSync(indexHtml))
    }
  }

  sendJson(res, 404, { error: 'Not found' })
  })
}

// Обёртка над обработчиком: ловит любой throw/reject, чтобы (а) не было необработанного
// отказа промиса (который иначе залогируется глобально, но клиент повиснет) и (б) клиент
// получил быстрый 500, а не висел до nginx/requestTimeout.
const server = http.createServer((req, res) => {
  handleHttpRequest(req, res).catch((err) => {
    console.error('[server] необработанная ошибка запроса:', err && err.stack ? err.stack : err)
    try {
      if (!res.headersSent && !res.writableEnded) sendJson(res, 500, { error: 'internal' })
    } catch (_) {}
  })
})

// Таймауты на ВХОДЯЩИЕ соединения. Без них зависший обработчик (за общим гейтом, на
// timeout-less сокете или на медленном body) держит соединение, пока nginx сам не отдаст
// 504. Делаем приложение «быстро падающим»: ниже nginx-таймаута. Все значения — env-настройка.
server.requestTimeout = Number(process.env.SERVER_REQUEST_TIMEOUT_MS) || 45000
server.headersTimeout = Number(process.env.SERVER_HEADERS_TIMEOUT_MS) || 20000
server.keepAliveTimeout = Number(process.env.SERVER_KEEPALIVE_TIMEOUT_MS) || 65000

// Привязка к loopback по умолчанию: наружу порт 3000 не выставляется (nginx с network_mode:host
// и фоновые self-call'ы ходят через 127.0.0.1). Для бридж-сети контейнера задайте BIND_HOST=0.0.0.0.
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1'

server.listen(PORT, BIND_HOST, () => {
  console.log(`Server running at http://${BIND_HOST}:${PORT}/ (version ${process.env.APP_VERSION || 'dev'})`)

  const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'

  const { createPostLocal } = require('./src/functions/postLocal')
  const postLocal = createPostLocal({ PORT, http })
  postLocalRef = postLocal

  const { setupAutolistBackgroundJob } = require('./src/jobs/autolistBackgroundJob')
  const { setupAutobumpBackgroundJob } = require('./src/jobs/autobumpBackgroundJob')
  const { setupChatsWarmupBackgroundJob } = require('./src/jobs/chatsWarmupBackgroundJob')
  const { setupChatsSyncBackgroundJob } = require('./src/jobs/chatsSyncBackgroundJob')
  const { setupDealStatusWatchBackgroundJob } = require('./src/jobs/dealStatusWatchBackgroundJob')

  setupAutolistBackgroundJob({
    postLocal,
    getAllStoredTokens,
    loadStoredTokenPlain,
    getUserAgent: () => PLAYEROK_USER_AGENT || DEFAULT_USER_AGENT,
    isAllActionsStopped,
  })

  setupAutobumpBackgroundJob({
    getStoredToken,
    getAllSettings,
    getBumpHistory,
    getSalesHistoryAll,
    fetchActiveItemsFromPlayerok,
    buildProductKey,
    postLocal,
    getDefaultUserAgent: () => DEFAULT_USER_AGENT,
    isAllActionsStopped,
  })

  setupChatsWarmupBackgroundJob({
    postLocal,
    getAllStoredTokens,
    loadStoredTokenPlain,
    getUserAgent: () => PLAYEROK_USER_AGENT || DEFAULT_USER_AGENT,
    isAllActionsStopped,
    // Прогрев гонял ПОЛНЫЙ cold-веер handleChats ×6 страниц каждые 60с — это >потолка
    // серийного гейта (~210 req/мин) → постоянный таймаут postLocal 120с и конкуренция
    // с автолистом за гейт. 1 страница покрывает видимые чаты; глубже UI догрузит лениво.
    maxPagesPerUser: Number(process.env.CHATS_WARMUP_MAX_PAGES) || 1,
  })

  setupChatsSyncBackgroundJob({
    getAllStoredTokens,
    loadStoredTokenPlain,
    getUserAgent: () => PLAYEROK_USER_AGENT || DEFAULT_USER_AGENT,
    chatDbSyncService,
    chatDbRepo,
    isAllActionsStopped,
    // 500мс на 1-CPU + общий последовательный гейт перегружали очередь и провоцировали
    // 429/504. 1500мс достаточно «живо» для чата и втрое разгружает гейт. Настраивается env.
    intervalMs: Number(process.env.CHATS_SYNC_INTERVAL_MS) || 1500,
  })

  // Наблюдатель статусов сделок: триггерит автосообщения этапов «Отправка/Подтверждение
  // товара», когда продавец отмечает выполнение/подтверждает сделку прямо на playerok.com.
  setupDealStatusWatchBackgroundJob({
    getAllStoredTokens,
    loadStoredTokenPlain,
    getUserAgent: () => PLAYEROK_USER_AGENT || DEFAULT_USER_AGENT,
    getViewer: getViewerCached,
    requestDealsPage,
    chatDbRepo,
    isAllActionsStopped,
    intervalMs: 6000,
    triggerChatAutomation: async ({ userId, token, userAgent, chatId, dealId, dealItemId }) => {
      if (!postLocalRef || !chatId) return
      try {
        await postLocalRef('/api/playerok/deal-chat-messages', {
          userId,
          token,
          userAgent,
          chatId,
          ...(dealId ? { dealId } : {}),
          ...(dealItemId ? { dealItemId } : {}),
          automessagesOnly: true,
        })
      } catch (_) {
        // ignore automation bridge errors
      }
    },
  })
})

