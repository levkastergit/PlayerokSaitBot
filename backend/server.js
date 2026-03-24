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

const PORT = parseInt(process.env.PORT, 10) || 3000

// Вход только через регистрацию на сайте (SQLite `users`). Учётные данные в .env не задаются.

// Кэш для лотов: уменьшает количество запросов к Playerok API и предотвращает rate limit
const LOTS_CACHE_TTL_MS = 2 * 60 * 1000 // 2 минуты
const lotsCache = new Map() // token -> { active: { data, expiresAt }, completed: { data, expiresAt } }

// Периодическая очистка устаревших записей из кэша
setInterval(() => {
  const now = Date.now()
  let cleaned = 0
  for (const [token, cache] of lotsCache.entries()) {
    if (cache.active && now >= cache.active.expiresAt) {
      delete cache.active
    }
    if (cache.completed && now >= cache.completed.expiresAt) {
      delete cache.completed
    }
    // Удаляем запись, если оба кэша пусты
    if (!cache.active && !cache.completed) {
      lotsCache.delete(token)
      cleaned++
    }
  }
  if (cleaned > 0) {
    console.log('[cache] очищены устаревшие записи кэша', { cleaned, remaining: lotsCache.size })
  }
}, 60 * 1000) // Проверяем каждую минуту

const { initLogger, getLogsBuffer } = require('./src/infra/logger')
initLogger()

// "Код от хеда": user-agent для запросов к Playerok берём из .env, чтобы не был захардкожен в коде.
const PLAYEROK_USER_AGENT =
  process.env.PLAYEROK_USER_AGENT == null ? '' : String(process.env.PLAYEROK_USER_AGENT).trim()

const { hashPassword, verifyPassword, encryptToken, decryptToken } = require('./src/infra/crypto/tokenCrypto')
const { withRetry, isPlayerokRateLimitError, sleep } = require('./src/infra/retry/withRetry')
const {
  getSessionIdFromRequest,
  isSessionValid,
  getSessionUserId,
  createSession,
  destroySession,
} = require('./src/infra/auth/sessions')

const FRONTEND_DIST = path.join(__dirname, '..', 'frontend', 'dist')
const {
  getSupercellGameByCategory,
  formatSupercellCodeRequestedMessage,
  extractSupercellEmailFromFields,
  getLatestBuyerEmailFromMessages,
  hasSupercellCodeRequestedMessage,
  isEmailValid,
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

const { initDbSchema } = require('./src/db/schema/initDbSchema')
initDbSchema(db)

const getUserSupercellModule = db.prepare('SELECT module_supercell FROM users WHERE id = ?')
function isSupercellModuleEnabled(userId) {
  const row = getUserSupercellModule.get(userId)
  if (!row) return true
  return Number(row.module_supercell || 0) === 1
}

const { setupTokensRepo } = require('./src/db/tokensRepo')

const {
  getStoredToken,
  getAllStoredTokens,
  upsertStoredToken,
  deleteStoredToken,
  loadStoredTokenPlain,
  getTokenFromBodyOrStored,
  getTokenFromQueryOrStored,
} = setupTokensRepo(db)

const { setupProductSettingsRepo } = require('./src/db/productSettingsRepo')

const { getSettings, getAllSettings, upsertSettings, deleteSettings } = setupProductSettingsRepo(db)

const { setupHistoryRepo } = require('./src/db/historyRepo')

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

const { processActiveSupercellFlows } = require('./src/features/autolist/processActiveSupercellFlows')
const { scanCompletedAndRelist } = require('./src/features/autolist/scanCompletedAndRelist')
const { handlePaidChat } = require('./src/features/autolist/handlePaidChat')
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
  autolistGetSupercellFlowMap,
  autolistPruneSupercellFlowMap,
} = require('./src/features/autolist/autolistState')

const getViewer = createGetViewer({
  VIEWER_QUERY,
  PLAYEROK_USER_AGENT,
})

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

/** Продажи со страницы /profile/.../sales — ограничено для быстрой загрузки истории */
const SALES_HISTORY_LIMIT = 72

const { createFetchDealsFromPlayerok } = require('./src/functions/playerokFetchDealsFromPlayerok')

const fetchDealsFromPlayerok = createFetchDealsFromPlayerok({
  SALES_HISTORY_LIMIT,
  getViewer,
  requestDealsPage,
})

/** Актуальные сделки в выполнении (напрямую с Playerok, без БД) */
const { createFetchInProgressDealsFromPlayerok } = require('./src/functions/playerokFetchInProgressDealsFromPlayerok')

const fetchInProgressDealsFromPlayerok = createFetchInProgressDealsFromPlayerok({
  getViewer,
  requestDealsPage,
})

/** Завершённые сделки (SENT, CONFIRMED) — для блока «Непрочитанные чаты» */
const { createFetchCompletedDealsFromPlayerok } = require('./src/functions/playerokFetchCompletedDealsFromPlayerok')

const fetchCompletedDealsFromPlayerok = createFetchCompletedDealsFromPlayerok({
  getViewer,
  requestDealsPage,
})

/** Все сообщения чата по chatId или по dealId (если chatId не передан). Подгружаем все страницы. */
const { createFetchDealChatMessagesFromPlayerok } = require('./src/functions/playerokFetchDealChatMessagesFromPlayerok')

const fetchDealChatMessagesFromPlayerok = createFetchDealChatMessagesFromPlayerok({
  requestDealById,
  requestChatMessagesPage,
  extractItemImageUrl,
  extractSupercellEmailFromFields,
  getLatestBuyerEmailFromMessages,
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
})

/** Все сделки (продажи) с Playerok без лимита — для синхронизации в БД */
const { createFetchAllDealsFromPlayerok } = require('./src/functions/playerokFetchAllDealsFromPlayerok')

const fetchAllDealsFromPlayerok = createFetchAllDealsFromPlayerok({
  getViewer,
  requestDealsPage,
})

const { createFetchActiveItemsFromPlayerok } = require('./src/functions/playerokFetchActiveItemsFromPlayerok')

const fetchActiveItemsFromPlayerok = createFetchActiveItemsFromPlayerok({
  getViewer,
  requestItemsPage,
  lotsCache,
  LOTS_CACHE_TTL_MS,
})

/** Завершённые товары: /profile/.../products/completed — на странице отображаются SOLD и EXPIRED. */
const { createFetchCompletedItemsFromPlayerok } = require('./src/functions/playerokFetchCompletedItemsFromPlayerok')

const fetchCompletedItemsFromPlayerok = createFetchCompletedItemsFromPlayerok({
  getViewer,
  requestItemsPage,
  lotsCache,
  LOTS_CACHE_TTL_MS,
})

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin
  // Для fetch с `credentials: 'include'` нельзя отдавать `*` в `Access-Control-Allow-Origin`.
  // Поэтому при наличии Origin — эхоим его и включаем `Access-Control-Allow-Credentials`,
  // credentials включаются для любого Origin.
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Access-Control-Allow-Credentials', 'true')
  } else {
    res.setHeader('Access-Control-Allow-Origin', '*')
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    return res.end()
  }

  const parsedUrl = new URL(req.url || '/', `http://localhost:${PORT}`)
  const pathname = parsedUrl.pathname
  const query = Object.fromEntries(parsedUrl.searchParams)
  const nowTs = Math.floor(Date.now() / 1000)

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
    const remote = req.socket.remoteAddress || ''
    const isLocal = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
    const sessionId = getSessionIdFromRequest(req)
    if (sessionId && isSessionValid(sessionId)) {
      const uid = getSessionUserId(sessionId)
      if (uid) currentUserId = uid
    }
    if (!isLocal) {
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
        requestItemById,
        fetchItemPriorityStatuses,
        increaseItemPriorityStatus,
        insertBump,
        isPlayerokRateLimitError,
        withRetry,
        getViewer,
        requestUserChatsPage,
        AUTOLIST_MAX_CHATS_TO_SCAN,
        autolistGetCompletedScanMap,
        autolistGetLastChatMeta,
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
        autolistSetItemState,
        getSettings,
        getGroupSettingsKey,
        publishItem,
        insertListingFee,
        normalizeKeyPart,
        buildProductKey,
        handlePaidChat,
        requestDealById,
        toUnixTs,
        insertSale,
        resolveEffectiveProductSettings,
        getSupercellGameByCategory,
        autolistGetSupercellFlowMap,
        extractSupercellEmailFromFields,
        upsertSettings,
        createChatMessage,
        sleep,
        processActiveSupercellFlows,
        processSingleSupercellFlow,
        isSupercellModuleEnabled,
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
      },
    })

    if (handled) return
  }

  // Раздача фронтенда (статика из frontend/dist)
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

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`)

  const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'

  const { createPostLocal } = require('./src/functions/postLocal')
  const postLocal = createPostLocal({ PORT, http })

  const { setupAutolistBackgroundJob } = require('./src/jobs/autolistBackgroundJob')
  const { setupAutobumpBackgroundJob } = require('./src/jobs/autobumpBackgroundJob')

  setupAutolistBackgroundJob({
    postLocal,
    getAllStoredTokens,
    loadStoredTokenPlain,
    isSupercellModuleEnabled,
    getUserAgent: () => PLAYEROK_USER_AGENT || DEFAULT_USER_AGENT,
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
  })
})

