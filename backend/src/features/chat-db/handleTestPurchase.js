'use strict'

const path = require('path')

// Тест-покупка (интерактивная песочница): прогоняет РЕАЛЬНУЮ логику обработки
// оплаченной сделки (handlePaidChat + интерактивные флоу DTU/Supercell) с полностью
// заглушённым набором зависимостей. В отличие от прежней версии «одним махом»,
// здесь интерактивные сценарии управляются СООБЩЕНИЯМИ ПОЛЬЗОВАТЕЛЯ:
//   - start: имитирует оплату, запускает handlePaidChat и (для DTU) шлёт первый
//     запрос; возвращает sessionId + транскрипт + что ожидается от покупателя.
//   - message: принимает текст покупателя (ID/почта/«да») и продвигает реальный
//     флоу на один шаг, выдавая товар только после диалога.
// Ни одного реального сайд-эффекта; «Товар отправлен» показывается лишь при
// autoCompleteDeal (автозавершение сделки).

const { handlePaidChat } = require('../autolist/handlePaidChat')
const { createProcessSingleTopupFlow } = require('../approute/runApprouteTopup')
const { createProcessSingleClodeFlow } = require('../clode/runClodeRedeemFlow')
const { extractClaudeUserId, normalizeClodePlan } = require('../../integrations/clode/clodeClient')
const { createProcessSingleGptFlow } = require('../gpt/runGptRedeemFlow')
const { extractGoogleDocId, extractGptAccessToken } = require('../../integrations/gpt/gptClient')
const { createProcessSingleSupercellFlow } = require('../../functions/processSingleSupercellFlow')
const {
  getSupercellGameByCategory,
  formatSupercellCodeRequestedMessage,
  isEmailValid,
  hasSupercellCodeRequestedMessage,
  pickSupercellCategoryFromItemHints,
  extractSupercellEmailFromFields,
  isSupercellAutoRequestCodeEnabled,
  getSupercellCodeMessageTemplate,
} = require('../../functions/supercellHelpers')
const { normalizeKeyPart, buildProductKey, normalizeProductKey } = require('../../functions/keyUtils')
const { setLogBufferSuppressed } = require('../../infra/logger')
const {
  handleOrderedStageAutomessage,
  hasSystemMarkerForDeal,
  ITEM_SENT_MARKER,
  DEAL_CONFIRMED_MARKERS,
} = require('../autolist/handleChatAutomessage')

/** Пустые настройки (как у нового товара без сохранения в БД). */
function createEmptyProductSettings() {
  return {
    cost: 0,
    costUsd: 0,
    settingsLabel: '',
    groupName: '',
    autodelivery: { enabled: false, codes: [], messageOnPurchase: '', autoCompleteDeal: false },
    autodeliveryApi: {
      enabled: false,
      messageOnPurchase: '',
      deliveryMessage: '{delivery}',
      autoCompleteDeal: false,
    },
    autotopupApi: {
      enabled: false,
      askIdMessage: 'Для пополнения напишите ваш игровой ID/логин.',
      confirmTemplate: 'Подтвердите: ваш ID/логин — {id}. Всё верно? Напишите «да» или «нет».',
      invalidIdMessage: 'ID/логин не прошёл проверку. Пришлите, пожалуйста, корректный ID/логин ещё раз.',
      successMessage: 'Готово! Пополнение выполнено. Спасибо за покупку.',
      autoCompleteDeal: false,
    },
    autoclode: {
      enabled: false,
      tier: 'pro',
      askIdMessage: 'Напишите ваш Claude user ID (UUID) для активации подписки.',
      confirmTemplate: 'Это ваш id: {id}? Напишите «да» или «нет».',
      invalidIdMessage: 'Не получилось распознать ваш Claude user ID. Пришлите корректный UUID ещё раз.',
      successMessage: 'Готово! Подписка активирована. Спасибо за покупку.',
      noStockMessage: 'Извините, коды временно закончились.',
      failMessage: 'Не удалось активировать подписку. Проверьте ID и пришлите ещё раз.',
      autoCompleteDeal: false,
    },
    autogpt: {
      enabled: false,
      inputMode: 'link',
      askLinkMessage: 'Пришлите ссылку на Google-документ с вашим ChatGPT Access Token.',
      askIdMessage: 'Напишите ваш ChatGPT ID (app_user_id, UUID) для активации.',
      askAutoMessage: 'Пришлите ваш ChatGPT ID (UUID) или ссылку на Google-документ с токеном.',
      invalidLinkMessage: 'Не вижу ссылку на Google-документ. Пришлите корректную ссылку.',
      invalidIdMessage: 'Не получилось распознать ваш ID. Пришлите корректный UUID ещё раз.',
      invalidAutoMessage: 'Не распознал ввод. Пришлите ID (UUID) или ссылку на документ.',
      noAccessMessage: 'Нет доступа к документу. Откройте доступ «всем, у кого есть ссылка».',
      tokenNotFoundMessage: 'В документе не нашёл Access Token. Пришлите ссылку ещё раз.',
      successMessage: 'Готово! Подписка ChatGPT активирована. Спасибо за покупку.',
      noStockMessage: 'Извините, коды временно закончились.',
      failMessage: 'Не удалось активировать подписку. Пришлите данные ещё раз.',
      autoCompleteDeal: false,
    },
    autolist: { enabled: false },
    automessage: { enabled: false, messages: [] },
    postPurchaseAutomessage: { enabled: false, messages: [] },
    dealConfirmedAutomessage: { enabled: false, messages: [] },
    emailValidation: { enabled: false, invalidEmailMessage: '' },
    supercellAutoRequestCode: {
      enabled: true,
      requestCodeMessage:
        'Запросил код на вашу почту для $game_name, скиньте его пожалуйста сюда в чат, как придет',
    },
    autobump: { enabled: false, schedule: [], priorityStatusId: null },
  }
}

const TEST_CHAT_ID = 'synthetic-test'
const TEST_VIEWER = '__test_seller__'
const TEST_BUYER = '__test_buyer__'

// --- In-memory хранилище интерактивных тест-сессий -------------------------
const sessions = new Map() // sessionId -> ctx
const SESSION_TTL_MS = 30 * 60 * 1000
const SESSION_MAX = 200
let sessionSeq = 0

function rand4() {
  return Math.random().toString(36).slice(2, 6).toUpperCase()
}

function newSessionId() {
  sessionSeq += 1
  return `tsess_${sessionSeq}_${rand4()}${rand4()}`
}

function pruneSessions(nowMs) {
  for (const [id, ctx] of sessions) {
    if (nowMs - (ctx.createdAt || 0) > SESSION_TTL_MS) sessions.delete(id)
  }
  if (sessions.size > SESSION_MAX) {
    const sorted = [...sessions.entries()].sort((a, b) => (a[1].createdAt || 0) - (b[1].createdAt || 0))
    for (let i = 0; i < sorted.length - SESSION_MAX; i += 1) sessions.delete(sorted[i][0])
  }
}

function splitProductKey(productKey) {
  const key = String(productKey || '').trim()
  const sep = key.indexOf('::')
  if (sep > 0) {
    return { game: key.slice(0, sep).trim(), title: key.slice(sep + 2).trim() }
  }
  return { game: '', title: key }
}

// Что сейчас ожидается от покупателя ('game_id' | 'confirm' | 'email' | null=готово).
function computeWaiting(ctx) {
  const tp = ctx.topupMap[TEST_CHAT_ID]
  if (tp && tp.active) return tp.stage === 'await_confirm' ? 'confirm' : 'game_id'
  const cl = ctx.clodeMap[TEST_CHAT_ID]
  if (cl && cl.active) return cl.stage === 'await_confirm' ? 'confirm' : 'game_id'
  const gp = ctx.gptMap[TEST_CHAT_ID]
  if (gp && gp.active) return 'game_id'
  const sc = ctx.supercellMap[TEST_CHAT_ID]
  if (sc && sc.active) return 'email'
  return null
}

function getActiveDealId(ctx) {
  return ctx.activeDealId || ctx.dealId || null
}

// Настройки и новая сделка в рамках одной тест-сессии (чат с несколькими покупками).
function configureCtxForProduct(ctx, productKey, currentUserId, resolveEffectiveProductSettings) {
  const normalizedKey = normalizeProductKey(productKey)
  if (!normalizedKey) return false

  const resolved = resolveEffectiveProductSettings(currentUserId, normalizedKey)
  const settings = resolved.effectiveSettings || createEmptyProductSettings()
  const { game: gamePart, title: titlePart } = splitProductKey(normalizedKey)
  const categoryName = gamePart || titlePart
  const isSupercell = Boolean(getSupercellGameByCategory(categoryName))
  const cfgDelivery = (settings.autodeliveryApi && typeof settings.autodeliveryApi === 'object') ? settings.autodeliveryApi : {}
  const cfgTopup = (settings.autotopupApi && typeof settings.autotopupApi === 'object') ? settings.autotopupApi : {}
  const cfgClode = (settings.autoclode && typeof settings.autoclode === 'object') ? settings.autoclode : {}
  const cfgGpt = (settings.autogpt && typeof settings.autogpt === 'object') ? settings.autogpt : {}

  const resolveForTest = (_userId, key) => {
    if (normalizeProductKey(key) === normalizedKey) {
      return { effectiveSettings: settings, effectiveKey: resolved.effectiveKey || normalizedKey }
    }
    return resolveEffectiveProductSettings(_userId, key)
  }

  const nextDealId = `test-deal-${rand4()}`
  ctx.userId = currentUserId
  ctx.productKey = normalizedKey
  ctx.settings = settings
  ctx.categoryName = categoryName
  ctx.gamePart = gamePart
  ctx.titlePart = titlePart
  ctx.isSupercell = isSupercell
  ctx.cfgDelivery = cfgDelivery
  ctx.cfgTopup = cfgTopup
  ctx.deliveryAutoComplete = Boolean(
    cfgDelivery.enabled &&
      (cfgDelivery.autoCompleteDeal || settings.autodelivery?.autoCompleteDeal)
  )
  ctx.topupAutoComplete = Boolean(
    cfgTopup.enabled &&
      (cfgTopup.autoCompleteDeal || settings.autodelivery?.autoCompleteDeal)
  )
  ctx.cfgClode = cfgClode
  ctx.clodeAutoComplete = Boolean(
    cfgClode.enabled &&
      (cfgClode.autoCompleteDeal || settings.autodelivery?.autoCompleteDeal)
  )
  ctx.cfgGpt = cfgGpt
  ctx.gptAutoComplete = Boolean(
    cfgGpt.enabled &&
      (cfgGpt.autoCompleteDeal || settings.autodelivery?.autoCompleteDeal)
  )
  ctx.resolveEffectiveProductSettings = resolveForTest
  ctx.dealId = nextDealId
  ctx.activeDealId = nextDealId
  ctx.nowTs = (Number(ctx.nowTs) > 0 ? Number(ctx.nowTs) : 1_000_000) + 30
  rememberDealSnapshot(ctx)
  return true
}

function rememberDealSnapshot(ctx) {
  if (!ctx.dealsById) ctx.dealsById = {}
  const id = getActiveDealId(ctx)
  if (!id) return
  ctx.dealsById[id] = {
    productKey: ctx.productKey,
    gamePart: ctx.gamePart,
    titlePart: ctx.titlePart,
    categoryName: ctx.categoryName,
    productLabel: buildProductLabel(ctx),
  }
}

function loadDealContext(ctx, dealId, resolveEffectiveProductSettings) {
  const id = String(dealId || '').trim()
  const snap = ctx.dealsById && ctx.dealsById[id]
  if (!id || !snap) return false

  const normalizedKey = normalizeProductKey(snap.productKey)
  if (!normalizedKey) return false

  const resolved = resolveEffectiveProductSettings(ctx.userId, normalizedKey)
  const settings = resolved.effectiveSettings || createEmptyProductSettings()
  const gamePart = snap.gamePart || ''
  const titlePart = snap.titlePart || ''
  const categoryName = snap.categoryName || gamePart || titlePart
  const isSupercell = Boolean(getSupercellGameByCategory(categoryName))
  const cfgDelivery = (settings.autodeliveryApi && typeof settings.autodeliveryApi === 'object') ? settings.autodeliveryApi : {}
  const cfgTopup = (settings.autotopupApi && typeof settings.autotopupApi === 'object') ? settings.autotopupApi : {}
  const cfgClode = (settings.autoclode && typeof settings.autoclode === 'object') ? settings.autoclode : {}
  const cfgGpt = (settings.autogpt && typeof settings.autogpt === 'object') ? settings.autogpt : {}

  const resolveForTest = (_userId, key) => {
    if (normalizeProductKey(key) === normalizedKey) {
      return { effectiveSettings: settings, effectiveKey: resolved.effectiveKey || normalizedKey }
    }
    return resolveEffectiveProductSettings(_userId, key)
  }

  ctx.productKey = normalizedKey
  ctx.settings = settings
  ctx.categoryName = categoryName
  ctx.gamePart = gamePart
  ctx.titlePart = titlePart
  ctx.isSupercell = isSupercell
  ctx.cfgDelivery = cfgDelivery
  ctx.cfgTopup = cfgTopup
  ctx.deliveryAutoComplete = Boolean(
    cfgDelivery.enabled &&
      (cfgDelivery.autoCompleteDeal || settings.autodelivery?.autoCompleteDeal)
  )
  ctx.topupAutoComplete = Boolean(
    cfgTopup.enabled &&
      (cfgTopup.autoCompleteDeal || settings.autodelivery?.autoCompleteDeal)
  )
  ctx.cfgClode = cfgClode
  ctx.clodeAutoComplete = Boolean(
    cfgClode.enabled &&
      (cfgClode.autoCompleteDeal || settings.autodelivery?.autoCompleteDeal)
  )
  ctx.cfgGpt = cfgGpt
  ctx.gptAutoComplete = Boolean(
    cfgGpt.enabled &&
      (cfgGpt.autoCompleteDeal || settings.autodelivery?.autoCompleteDeal)
  )
  ctx.resolveEffectiveProductSettings = resolveForTest
  ctx.dealId = id
  ctx.activeDealId = id
  return true
}

// --- Построение песочницы (без запуска) ------------------------------------
function createSandbox({ productKey, currentUserId, resolveEffectiveProductSettings }) {
  const ctx = {
    supercellMap: {},
    topupMap: {},
    clodeMap: {},
    gptMap: {},
    testTokenHash: `TEST::${rand4()}${rand4()}`,
    seq: 0,
    captured: [],
    transcript: [],
    createdAt: 0,
  }
  if (!configureCtxForProduct(ctx, productKey, currentUserId, resolveEffectiveProductSettings)) return null

  ctx.captureChatMessage = async (_token, _ua, _chatId, text) => {
    const t = String(text == null ? '' : text).trim()
    if (t) ctx.captured.push({ role: 'bot', text: t })
    return { id: `test-${ctx.seq++}`, text: String(text || ''), createdAt: new Date().toISOString() }
  }

  return ctx
}

function buildProductLabel(ctx) {
  const game = String(ctx.gamePart || '').trim()
  const title = String(ctx.titlePart || '').trim()
  return game ? `${game} — ${title}` : title || String(ctx.productKey || '')
}

function appendTranscript(ctx, entries) {
  if (!Array.isArray(ctx.transcript)) ctx.transcript = []
  for (const entry of entries) {
    const text = entry && entry.text != null ? String(entry.text) : ''
    const imageUrl = entry && entry.imageUrl != null ? String(entry.imageUrl).trim() : ''
    if (!text.trim() && !imageUrl && entry?.role !== 'system') continue
    const row = {
      role:
        entry.role === 'buyer' || entry.role === 'seller' || entry.role === 'system' ? entry.role : 'bot',
      text,
    }
    if (imageUrl) row.imageUrl = imageUrl
    const dealId =
      entry && entry.dealId != null
        ? String(entry.dealId).trim()
        : getActiveDealId(ctx)
    if (dealId) row.dealId = dealId
    ctx.transcript.push(row)
  }
}

function messageDealIdForTest(m, fallbackDealId) {
  if (m?.dealId != null && String(m.dealId).trim()) return String(m.dealId).trim()
  if (m?.deal?.id != null && String(m.deal.id).trim()) return String(m.deal.id).trim()
  return fallbackDealId != null ? String(fallbackDealId).trim() : ''
}

function filterTestMessagesByDeal(messages, targetDealId) {
  const id = targetDealId != null ? String(targetDealId).trim() : ''
  if (!id) return messages
  return messages.filter((m) => messageDealIdForTest(m, '') === id)
}

function buildTestMessagesForAutomessage(ctx, targetDealId = null) {
  const baseTs = Number(ctx.createdAt) || Date.now()
  const scopeId =
    targetDealId != null ? String(targetDealId).trim() : String(getActiveDealId(ctx) || '').trim()
  const list = (Array.isArray(ctx.transcript) ? ctx.transcript : []).map((m, i) => {
    const dealId = messageDealIdForTest(m, scopeId)
    return {
      text: m.text,
      createdAt: new Date(baseTs + i * 1000).toISOString(),
      dealId: dealId || null,
      deal: dealId ? { id: dealId } : null,
      user:
        m.role === 'buyer'
          ? { username: TEST_BUYER }
          : m.role === 'seller' || m.role === 'bot'
            ? { username: TEST_VIEWER }
            : null,
    }
  })
  return filterTestMessagesByDeal(list, targetDealId)
}

function createTestSendChatImage(ctx) {
  return async (_token, _ua, _chatId, { filePath, filename } = {}) => {
    const fileName =
      (filePath ? path.basename(String(filePath)) : '') ||
      (filename && String(filename).trim()) ||
      ''
    const userId = Number(ctx.userId)
    const imageUrl =
      fileName && Number.isFinite(userId) && userId > 0
        ? `/api/automessage-image/${userId}/${fileName}`
        : ''
    ctx.captured.push({ role: 'bot', text: '', imageUrl })
    return { ok: true }
  }
}

function buildTestAutomessageParams(ctx, deps, targetDealId = null) {
  const dealId = String(targetDealId || getActiveDealId(ctx) || '').trim()
  const messages = buildTestMessagesForAutomessage(ctx, dealId)
  const automessageImagesDir = deps && deps.automessageImagesDir
  return {
    currentUserId: ctx.userId,
    tokenHash: ctx.testTokenHash,
    token: ctx.testTokenHash,
    userAgent: 'TEST',
    nowTs: (ctx.nowTs += 10),
    chatId: TEST_CHAT_ID,
    dealId,
    dealItemId: 'test-item',
    messages,
    itemTitle: ctx.titlePart || 'Товар',
    itemCategory: ctx.categoryName,
    viewerUsername: TEST_VIEWER,
    withRetry: async (fn) => fn(),
    isPlayerokRateLimitError: () => false,
    requestDealById: async () => ({
      user: { username: TEST_BUYER },
      item: { title: ctx.titlePart, game: ctx.gamePart, name: ctx.titlePart },
      productKey: ctx.productKey,
    }),
    requestItemById: async () => ({
      title: ctx.titlePart,
      name: ctx.titlePart,
      game: ctx.gamePart,
    }),
    resolveEffectiveProductSettings: ctx.resolveEffectiveProductSettings,
    createChatMessage: ctx.captureChatMessage,
    normalizeKeyPart,
    buildProductKey,
    sendChatImage: createTestSendChatImage(ctx),
    automessageImagesDir: automessageImagesDir || null,
  }
}

async function runTestStageAutomations(ctx, stage, deps, targetDealId = null) {
  const automessageImagesDir = deps && deps.automessageImagesDir
  if (!automessageImagesDir) return

  const dealId = String(targetDealId || getActiveDealId(ctx) || '').trim()
  if (!dealId) return

  ctx.captured = []
  const messages = buildTestMessagesForAutomessage(ctx, dealId)
  const base = buildTestAutomessageParams(ctx, deps, dealId)

  if (stage === 'purchase') {
    await handleOrderedStageAutomessage(base, 'purchase', { skipMarkerCheck: true })
  } else if (stage === 'item_sent') {
    if (!hasSystemMarkerForDeal(messages, dealId, [ITEM_SENT_MARKER])) return
    await handleOrderedStageAutomessage(base, 'sent')
  } else if (stage === 'deal_confirmed') {
    if (!hasSystemMarkerForDeal(messages, dealId, DEAL_CONFIRMED_MARKERS)) return
    await handleOrderedStageAutomessage(base, 'confirmed')
  }

  appendTranscript(
    ctx,
    ctx.captured.map((m) => ({
      role: 'bot',
      text: m.text != null ? String(m.text) : '',
      imageUrl: m.imageUrl != null ? String(m.imageUrl) : '',
      dealId,
    }))
  )
}

// Прогон handlePaidChat (имитация оплаты) — заполняет флоу-карты и captured.
async function runPaidChat(ctx) {
  ctx.captured = []
  const withRetry = async (fn) => fn()
  const noop = () => {}
  const asyncNoop = async () => ({})

  const fakeRunApprouteAutodelivery = async ({ settings: s, lastChat, token, userAgent, createChatMessage }) => {
    const cfg = (s && s.autodeliveryApi) || {}
    const chatId = lastChat && lastChat.id
    const messageOnPurchase = (cfg.messageOnPurchase && String(cfg.messageOnPurchase).trim()) || ''
    if (messageOnPurchase) await createChatMessage(token, userAgent, chatId, messageOnPurchase)
    const tpl = String(cfg.deliveryMessage || '').trim()
    const delivery = `TEST-DELIVERY-${rand4()}`
    const kod = 'TEST-PIN'
    const text = tpl
      ? tpl.split('{delivery}').join(delivery).split('{Kod}').join(kod).split('{kod}').join(kod)
      : delivery
    await createChatMessage(token, userAgent, chatId, text)
    return { ok: true, markApprouteOrderDone: true, markApprouteChatDone: true }
  }

  const fullDealSnapshot = {
    productKey: ctx.productKey,
    status: 'PAID',
    category: ctx.categoryName,
    item: {
      id: 'test-item',
      title: ctx.titlePart || 'Товар',
      game: ctx.gamePart || ctx.categoryName,
      status: 'PAID',
      category: { name: ctx.categoryName },
    },
    obtainingFields: [],
  }

  const claimNextUnusedTableCode = (_userId, _category) => {
    const codes = Array.isArray(ctx.settings?.autodelivery?.codes)
      ? ctx.settings.autodelivery.codes
      : []
    if (codes.length === 0) return null
    const code = String(codes[0]).trim()
    if (!code) return null
    ctx.settings = {
      ...ctx.settings,
      autodelivery: { ...(ctx.settings.autodelivery || {}), codes: codes.slice(1) },
    }
    return { id: 0, code }
  }

  await handlePaidChat({
    currentUserId: ctx.userId,
    tokenHash: ctx.testTokenHash,
    token: ctx.testTokenHash,
    userAgent: 'TEST',
    nowTs: ctx.nowTs,
    dealId: ctx.dealId,
    dealItemId: 'test-item',
    dealTs: ctx.nowTs,
    dealStatus: 'PAID',
    lastChat: { id: TEST_CHAT_ID, lastMessage: null },
    fullDealSnapshot,
    relistedByScanIds: [],
    AUTOBUMP_PRIORITY_STATUS_ID: null,
    withRetry,
    isPlayerokRateLimitError: () => false,
    isPlayerokPublishRetryable: () => false,
    requestItemById: async () => null,
    fetchItemPriorityStatuses: async () => [],
    publishItem: async () => ({ id: 'test-item', listingFee: 0 }),
    insertListingFee: { run: noop },
    autolistMarkProcessed: noop,
    autolistWasProcessed: () => false,
    autolistSetItemState: noop,
    insertSale: { run: noop },
    normalizeKeyPart,
    buildProductKey,
    requestDealById: async () => ({ user: { username: TEST_BUYER }, status: 'PAID' }),
    resolveEffectiveProductSettings: ctx.resolveEffectiveProductSettings,
    getSupercellGameByCategory,
    pickSupercellCategoryFromItemHints,
    autolistGetSupercellFlowMap: () => ctx.supercellMap,
    autolistGetTopupFlowMap: () => ctx.topupMap,
    autolistGetClodeFlowMap: () => ctx.clodeMap,
    autolistGetGptFlowMap: () => ctx.gptMap,
    extractSupercellEmailFromFields,
    upsertSettings: { run: noop },
    createChatMessage: ctx.captureChatMessage,
    sleep: async () => {},
    supercellModuleEnabled: true,
    claimNextUnusedTableCode,
    loadApprouteApiKeyPlain: () => 'TEST',
    runApprouteAutodelivery: fakeRunApprouteAutodelivery,
    updateDealStatus: asyncNoop,
    deliveryOnly: true,
    skipRelist: true,
    chatMessages: [],
    viewerUsername: TEST_VIEWER,
    autolistWasAutomessageSent: () => false,
    autolistMarkAutomessageSent: noop,
  })
}

// Один шаг DTU-флоу с сообщением покупателя (или null — для первичного запроса ID).
async function stepTopup(ctx, buyerText) {
  ctx.captured = []
  const withRetry = async (fn) => fn()
  const st = ctx.topupMap[TEST_CHAT_ID] || {}
  const stage = String(st.stage || 'await_id')
  const baseTs = stage === 'await_confirm' ? Number(st.confirmMsgTs || 0) : Number(st.askMsgTs || 0)
  const text = buyerText != null ? String(buyerText) : ''

  const fetchTopup = async () => {
    const messages = []
    if (text.trim()) {
      messages.push({ user: { username: TEST_BUYER }, text, createdAt: (baseTs || ctx.nowTs) + 1 })
    }
    return { messages, viewerUsername: TEST_VIEWER }
  }

  const proc = createProcessSingleTopupFlow({
    autolistGetTopupFlowMap: () => ctx.topupMap,
    fetchDealChatMessagesFromPlayerok: fetchTopup,
    withRetry,
    isPlayerokRateLimitError: () => false,
    createChatMessage: ctx.captureChatMessage,
    loadApprouteApiKeyPlain: () => 'TEST',
    checkApprouteDtuOrder: async () => ({ ok: true }),
    createApprouteDtuOrderAndConfirm: async () => ({ failed: false, completed: true, orderStatus: 'completed' }),
    isApprouteValidationError: () => false,
    updateDealStatus: async () => ({}),
    toUnixTs: (v) => Number(v) || 0,
  })
  ctx.nowTs += 10
  return proc(TEST_CHAT_ID, ctx.testTokenHash, 'TEST', TEST_VIEWER, ctx.nowTs)
}

// Один шаг Clode-флоу с сообщением покупателя (или null — для первичного запроса ID).
async function stepClode(ctx, buyerText) {
  ctx.captured = []
  const withRetry = async (fn) => fn()
  const st = ctx.clodeMap[TEST_CHAT_ID] || {}
  const stage = String(st.stage || 'await_id')
  const baseTs = stage === 'await_confirm' ? Number(st.confirmMsgTs || 0) : Number(st.askMsgTs || 0)
  const text = buyerText != null ? String(buyerText) : ''

  const fetchClode = async () => {
    const messages = []
    if (text.trim()) {
      messages.push({ user: { username: TEST_BUYER }, text, createdAt: (baseTs || ctx.nowTs) + 1 })
    }
    return { messages, viewerUsername: TEST_VIEWER }
  }

  const proc = createProcessSingleClodeFlow({
    autolistGetClodeFlowMap: () => ctx.clodeMap,
    fetchDealChatMessagesFromPlayerok: fetchClode,
    withRetry,
    isPlayerokRateLimitError: () => false,
    createChatMessage: ctx.captureChatMessage,
    loadClodeApiKeyPlain: () => 'TEST',
    redeemClaudeAndConfirm: async () => ({ completed: true, failed: false }),
    extractClaudeUserId,
    normalizeClodePlan,
    isClodeValidationError: () => false,
    claimNextUnusedTableCode: () => ({ id: 1, code: 'bbc-TEST' }),
    markTableCodeUsed: () => true,
    releaseTableCode: () => true,
    pollClaudeTask: async () => ({ status: 'success' }),
    updateDealStatus: async () => ({}),
    toUnixTs: (v) => Number(v) || 0,
  })
  ctx.nowTs += 10
  return proc(TEST_CHAT_ID, ctx.testTokenHash, 'TEST', TEST_VIEWER, ctx.nowTs)
}

// Один шаг GPT-флоу с сообщением покупателя (или null — для первичного запроса ссылки).
// Скачивание Google-дока и активация заглушены (счастливый путь): любой документ
// «доступен» и содержит валидный токен, активация всегда успешна.
async function stepGpt(ctx, buyerText) {
  ctx.captured = []
  const withRetry = async (fn) => fn()
  const st = ctx.gptMap[TEST_CHAT_ID] || {}
  const baseTs = Math.max(
    Number(st.askMsgTs || 0),
    Number(st.lastCheckTs || 0),
    Number(st.lastActivateTs || 0)
  )
  const text = buyerText != null ? String(buyerText) : ''

  const fetchGpt = async () => {
    const messages = []
    if (text.trim()) {
      messages.push({ user: { username: TEST_BUYER }, text, createdAt: (baseTs || ctx.nowTs) + 1 })
    }
    return { messages, viewerUsername: TEST_VIEWER }
  }

  const proc = createProcessSingleGptFlow({
    autolistGetGptFlowMap: () => ctx.gptMap,
    fetchDealChatMessagesFromPlayerok: fetchGpt,
    withRetry,
    isPlayerokRateLimitError: () => false,
    createChatMessage: ctx.captureChatMessage,
    // Извлечение реальное (ID/ссылка распознаются как в проде); скачивание дока
    // и активация заглушены — любой документ «доступен» и содержит валидный токен.
    extractGoogleDocId,
    fetchGoogleDocText: async () => ({ ok: true, text: 'token eyJtest.payload.signature here' }),
    extractGptAccessToken,
    redeemGptAndConfirm: async () => ({ completed: true, failed: false }),
    isGptTokenFaultError: () => false,
    isGptStockError: () => false,
    claimNextUnusedTableCode: () => ({ id: 1, code: 'gpt-TEST' }),
    markTableCodeUsed: () => true,
    releaseTableCode: () => true,
    updateDealStatus: async () => ({}),
    toUnixTs: (v) => Number(v) || 0,
  })
  ctx.nowTs += 10
  return proc(TEST_CHAT_ID, ctx.testTokenHash, 'TEST', TEST_VIEWER, ctx.nowTs)
}

// Один шаг Supercell-флоу: текст покупателя трактуется как почта.
async function stepSupercell(ctx, buyerText) {
  ctx.captured = []
  const withRetry = async (fn) => fn()
  const email = buyerText != null ? String(buyerText).trim() : ''

  const fetchSupercell = async () => ({
    messages: email ? [{ user: { username: TEST_BUYER }, text: email, createdAt: ctx.nowTs + 1 }] : [],
    itemCategory: String(ctx.supercellMap[TEST_CHAT_ID]?.category || ctx.categoryName),
    buyerSupercellEmail: email,
    viewerUsername: TEST_VIEWER,
  })
  const fakeRequestCode = async ({ email: e, category, requestCodeMessageTemplate }) => {
    const game = getSupercellGameByCategory(String(category || ''))
    const tpl =
      requestCodeMessageTemplate || getSupercellCodeMessageTemplate(ctx.settings)
    if (ctx.captured) {
      ctx.captured.push({
        role: 'bot',
        text: formatSupercellCodeRequestedMessage(
          game ? game.gameName : String(category || ''),
          tpl
        ),
      })
    }
    return { ok: true, gameKey: game && game.gameKey, gameName: game && game.gameName, email: e }
  }
  const proc = createProcessSingleSupercellFlow({
    autolistGetSupercellFlowMap: () => ctx.supercellMap,
    getSupercellGameByCategory,
    fetchDealChatMessagesFromPlayerok: fetchSupercell,
    hasSupercellCodeRequestedMessage,
    isEmailValid,
    withRetry,
    isPlayerokRateLimitError: () => false,
    createChatMessage: ctx.captureChatMessage,
    requestSupercellCodeForChat: fakeRequestCode,
  })
  ctx.nowTs += 10
  return proc(TEST_CHAT_ID, ctx.testTokenHash, 'TEST', TEST_VIEWER, ctx.nowTs)
}

function computeModes(settings, isSupercell) {
  const modes = []
  if (settings.automessage && settings.automessage.enabled) modes.push('automessage')
  if (settings.autodelivery && settings.autodelivery.enabled) modes.push('autodelivery')
  if (settings.autodeliveryApi && settings.autodeliveryApi.enabled) modes.push('autodeliveryApi')
  if (settings.autotopupApi && settings.autotopupApi.enabled) modes.push('autotopupApi')
  if (settings.autoclode && settings.autoclode.enabled) modes.push('autoclode')
  if (settings.autogpt && settings.autogpt.enabled) modes.push('autogpt')
  if (settings.imageAutomessage && settings.imageAutomessage.enabled) modes.push('imageAutomessage')
  if (isSupercell && isSupercellAutoRequestCodeEnabled(settings)) modes.push('supercell')
  return modes
}

// --- START: имитация оплаты + первый шаг -----------------------------------
async function handleTestPurchaseStart({ payload, currentUserId, deps }) {
  const productKey = String(payload?.productKey || '').trim()
  if (!productKey) return { statusCode: 400, data: { error: 'productKey is required' } }

  const resolveEffectiveProductSettings = deps && deps.resolveEffectiveProductSettings
  if (typeof resolveEffectiveProductSettings !== 'function') {
    return { statusCode: 500, data: { error: 'resolveEffectiveProductSettings unavailable' } }
  }

  const sessionIdIn = String(payload?.sessionId || '').trim()
  let ctx
  let sessionId
  let append = false

  if (sessionIdIn && sessions.has(sessionIdIn)) {
    ctx = sessions.get(sessionIdIn)
    if (ctx.userId !== currentUserId) return { statusCode: 403, data: { error: 'forbidden' } }
    if (!configureCtxForProduct(ctx, productKey, currentUserId, resolveEffectiveProductSettings)) {
      return { statusCode: 400, data: { error: 'Некорректный ключ товара' } }
    }
    sessionId = sessionIdIn
    append = true
  } else {
    ctx = createSandbox({ productKey, currentUserId, resolveEffectiveProductSettings })
    if (!ctx) return { statusCode: 400, data: { error: 'Некорректный ключ товара' } }
    sessionId = newSessionId()
    ctx.createdAt = Date.now()
    ctx.transcript = []
    sessions.set(sessionId, ctx)
    pruneSessions(ctx.createdAt)
  }

  setLogBufferSuppressed(true)
  try {
    await runPaidChat(ctx)
    const initial = [...ctx.captured]

    // DTU: первый шаг отправляет запрос ID (Supercell ждёт почту — без шага).
    if (ctx.topupMap[TEST_CHAT_ID] && ctx.topupMap[TEST_CHAT_ID].active) {
      await stepTopup(ctx, null)
      initial.push(...ctx.captured)
    }
    if (ctx.clodeMap[TEST_CHAT_ID] && ctx.clodeMap[TEST_CHAT_ID].active) {
      await stepClode(ctx, null)
      initial.push(...ctx.captured)
    }
    if (ctx.gptMap[TEST_CHAT_ID] && ctx.gptMap[TEST_CHAT_ID].active) {
      await stepGpt(ctx, null)
      initial.push(...ctx.captured)
    }

    const waiting = computeWaiting(ctx)
    const done = !waiting
    const productLabel = buildProductLabel(ctx)
    const dealId = getActiveDealId(ctx)
    const chunk = [
      { role: 'system', text: '{{ITEM_PAID}}', dealId },
      { role: 'system', text: `Покупка товара: ${productLabel}`, dealId },
      ...initial.map((m) => ({ ...m, dealId })),
    ]
    // Немедленная выдача (autodeliveryApi): «Товар отправлен» лишь при autoCompleteDeal.
    if (done && ctx.deliveryAutoComplete && initial.some((m) => m.role === 'bot')) {
      chunk.push({ role: 'system', text: '{{ITEM_SENT}}', dealId })
    }

    const chunkStart = ctx.transcript.length
    appendTranscript(ctx, chunk)

    await runTestStageAutomations(ctx, 'purchase', deps, dealId)
    if (hasSystemMarkerForDeal(buildTestMessagesForAutomessage(ctx, dealId), dealId, [ITEM_SENT_MARKER])) {
      await runTestStageAutomations(ctx, 'item_sent', deps, dealId)
    }
    const transcript = ctx.transcript.slice(chunkStart)

    return {
      statusCode: 200,
      data: {
        ok: true,
        sessionId,
        append,
        activeDealId: dealId,
        productKey: ctx.productKey,
        productLabel,
        modes: computeModes(ctx.settings, ctx.isSupercell),
        transcript,
        waiting,
        done,
      },
    }
  } catch (err) {
    return { statusCode: 500, data: { error: err && err.message ? String(err.message) : 'test purchase failed' } }
  } finally {
    setLogBufferSuppressed(false)
  }
}

// --- CHAT: свободные сообщения продавца/покупателя + шаг интерактивного флоу ----
async function handleTestPurchaseChat({ payload, currentUserId, deps }) {
  const sessionId = String(payload?.sessionId || '').trim()
  const text = payload?.text != null ? String(payload.text) : ''
  const asRole = payload?.asRole === 'seller' ? 'seller' : 'buyer'
  if (!sessionId) return { statusCode: 400, data: { error: 'sessionId is required' } }
  if (!text.trim()) return { statusCode: 400, data: { error: 'text is required' } }

  const ctx = sessions.get(sessionId)
  if (!ctx) return { statusCode: 404, data: { error: 'Тест-сессия не найдена или истекла. Запустите тест заново.' } }
  if (ctx.userId !== currentUserId) return { statusCode: 403, data: { error: 'forbidden' } }

  setLogBufferSuppressed(true)
  try {
    const dealId = getActiveDealId(ctx)
    const out = [{ role: asRole, text, dealId }]
    appendTranscript(ctx, out)

    const waitingBefore = asRole === 'buyer' ? computeWaiting(ctx) : null
    if (waitingBefore) {
      if (waitingBefore === 'email') {
        await stepSupercell(ctx, text)
      } else if (ctx.clodeMap[TEST_CHAT_ID] && ctx.clodeMap[TEST_CHAT_ID].active) {
        await stepClode(ctx, text)
      } else if (ctx.gptMap[TEST_CHAT_ID] && ctx.gptMap[TEST_CHAT_ID].active) {
        await stepGpt(ctx, text)
      } else {
        await stepTopup(ctx, text)
      }
      const botLines = ctx.captured.map((m) => ({
        role: 'bot',
        text: m.text != null ? String(m.text) : '',
        imageUrl: m.imageUrl != null ? String(m.imageUrl) : '',
        dealId,
      }))
      out.push(...botLines)
      appendTranscript(ctx, botLines)

      const waitingAfter = computeWaiting(ctx)
      if (!waitingAfter && waitingBefore !== 'email' && (ctx.topupAutoComplete || ctx.clodeAutoComplete || ctx.gptAutoComplete)) {
        const sent = { role: 'system', text: '{{ITEM_SENT}}', dealId }
        out.push(sent)
        appendTranscript(ctx, [sent])
        await runTestStageAutomations(ctx, 'item_sent', deps, dealId)
        out.push(
          ...ctx.captured.map((m) => ({
            role: 'bot',
            text: m.text != null ? String(m.text) : '',
            imageUrl: m.imageUrl != null ? String(m.imageUrl) : '',
          }))
        )
      }
    }

    const waiting = computeWaiting(ctx)
    const done = !waiting

    return {
      statusCode: 200,
      data: {
        ok: true,
        transcript: out,
        waiting,
        done,
        activeDealId: dealId,
        productLabel: buildProductLabel(ctx),
      },
    }
  } catch (err) {
    return { statusCode: 500, data: { error: err && err.message ? String(err.message) : 'test message failed' } }
  } finally {
    setLogBufferSuppressed(false)
  }
}

// --- EVENT: «Товар отправлен» (продавец) / «Сделка подтверждена» (покупатель) ---
async function handleTestPurchaseEvent({ payload, currentUserId, deps }) {
  const sessionId = String(payload?.sessionId || '').trim()
  const event = String(payload?.event || '').trim()
  if (!sessionId) return { statusCode: 400, data: { error: 'sessionId is required' } }
  if (event !== 'item_sent' && event !== 'deal_confirmed') {
    return { statusCode: 400, data: { error: 'event must be item_sent or deal_confirmed' } }
  }

  const ctx = sessions.get(sessionId)
  if (!ctx) return { statusCode: 404, data: { error: 'Тест-сессия не найдена или истекла. Запустите тест заново.' } }
  if (ctx.userId !== currentUserId) return { statusCode: 403, data: { error: 'forbidden' } }

  const resolveEffectiveProductSettings = deps && deps.resolveEffectiveProductSettings
  if (typeof resolveEffectiveProductSettings !== 'function') {
    return { statusCode: 500, data: { error: 'resolveEffectiveProductSettings unavailable' } }
  }

  const targetDealId =
    String(payload?.dealId || '').trim() || String(getActiveDealId(ctx) || '').trim()
  if (!targetDealId) return { statusCode: 409, data: { error: 'Укажите сделку' } }
  if (!loadDealContext(ctx, targetDealId, resolveEffectiveProductSettings)) {
    return { statusCode: 400, data: { error: 'Неизвестная сделка в тест-сессии' } }
  }

  const dealId = targetDealId

  if (event === 'deal_confirmed') {
    const messages = buildTestMessagesForAutomessage(ctx)
    if (!hasSystemMarkerForDeal(messages, dealId, [ITEM_SENT_MARKER])) {
      return {
        statusCode: 409,
        data: { error: 'Сначала отправьте товар (кнопка «Отправить Товар» у продавца)' },
      }
    }
    if (hasSystemMarkerForDeal(messages, dealId, DEAL_CONFIRMED_MARKERS)) {
      return { statusCode: 409, data: { error: 'Сделка уже подтверждена' } }
    }
  }

  if (event === 'item_sent') {
    const messages = buildTestMessagesForAutomessage(ctx)
    if (!hasSystemMarkerForDeal(messages, dealId, [ITEM_PAID_MARKER])) {
      return { statusCode: 409, data: { error: 'Сначала должна быть оплата по этой сделке' } }
    }
    if (hasSystemMarkerForDeal(messages, dealId, [ITEM_SENT_MARKER])) {
      return { statusCode: 409, data: { error: 'Товар по этой сделке уже отмечен как отправленный' } }
    }
  }

  const marker = event === 'item_sent' ? '{{ITEM_SENT}}' : '{{DEAL_CONFIRMED}}'
  const stage = event === 'item_sent' ? 'item_sent' : 'deal_confirmed'

  setLogBufferSuppressed(true)
  try {
    const out = [{ role: 'system', text: marker, dealId }]
    appendTranscript(ctx, out)
    await runTestStageAutomations(ctx, stage, deps, dealId)
    const botLines = ctx.captured.map((m) => ({
      role: 'bot',
      text: m.text != null ? String(m.text) : '',
      imageUrl: m.imageUrl != null ? String(m.imageUrl) : '',
      dealId,
    }))
    out.push(...botLines)

    return {
      statusCode: 200,
      data: {
        ok: true,
        transcript: out,
        waiting: computeWaiting(ctx),
        done: !computeWaiting(ctx),
        activeDealId: dealId,
        productLabel: buildProductLabel(ctx),
      },
    }
  } catch (err) {
    return { statusCode: 500, data: { error: err && err.message ? String(err.message) : 'test event failed' } }
  } finally {
    setLogBufferSuppressed(false)
  }
}

module.exports = {
  handleTestPurchaseStart,
  handleTestPurchaseChat,
  handleTestPurchaseEvent,
  handleTestPurchaseMessage: handleTestPurchaseChat,
}
