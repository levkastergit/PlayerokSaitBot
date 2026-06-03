'use strict'

// Тест-покупка: прогоняет РЕАЛЬНУЮ логику обработки оплаченной сделки
// (handlePaidChat + интерактивные флоу DTU/Supercell) с полностью заглушённым
// набором зависимостей и возвращает «транскрипт» сообщений, которые увидел бы
// покупатель. Ни одного реального сайд-эффекта: ничего не пишется в баланс,
// историю продаж, журнал автосообщений и буфер логов; реальные вызовы в
// Playerok / Approute / OTP-плагин не выполняются (см. ../chat/AGENTS sidewise).

const { handlePaidChat } = require('../autolist/handlePaidChat')
const { createProcessSingleTopupFlow } = require('../approute/runApprouteTopup')
const { createProcessSingleSupercellFlow } = require('../../functions/processSingleSupercellFlow')
const {
  getSupercellGameByCategory,
  formatSupercellCodeRequestedMessage,
  isEmailValid,
  hasSupercellCodeRequestedMessage,
  pickSupercellCategoryFromItemHints,
  extractSupercellEmailFromFields,
} = require('../../functions/supercellHelpers')
const { normalizeKeyPart, buildProductKey } = require('../../functions/keyUtils')
const { setLogBufferSuppressed } = require('../../infra/logger')

const TEST_CHAT_ID = 'synthetic-test'
const TEST_VIEWER = '__test_seller__'
const TEST_BUYER = '__test_buyer__'
const TEST_BUYER_EMAIL = 'buyer@example.com'
const TEST_TOPUP_ID = '123456789'

function rand4() {
  return Math.random().toString(36).slice(2, 6).toUpperCase()
}

function splitProductKey(productKey) {
  const key = String(productKey || '').trim()
  const sep = key.indexOf('::')
  if (sep > 0) {
    return { game: key.slice(0, sep).trim(), title: key.slice(sep + 2).trim() }
  }
  return { game: '', title: key }
}

async function handleTestPurchase({ payload, currentUserId, deps }) {
  const productKey = String(payload?.productKey || '').trim()
  if (!productKey) {
    return { statusCode: 400, data: { error: 'productKey is required' } }
  }

  const resolveEffectiveProductSettings = deps && deps.resolveEffectiveProductSettings
  if (typeof resolveEffectiveProductSettings !== 'function') {
    return { statusCode: 500, data: { error: 'resolveEffectiveProductSettings unavailable' } }
  }

  const { effectiveSettings: settings } = resolveEffectiveProductSettings(currentUserId, productKey)
  const { game: gamePart, title: titlePart } = splitProductKey(productKey)
  const categoryName = gamePart || titlePart
  const isSupercell = Boolean(getSupercellGameByCategory(categoryName))

  if (!settings) {
    return { statusCode: 400, data: { error: 'Для этого товара нет сохранённых настроек' } }
  }

  // --- Песочница: только захват/no-op, реальные deps НЕ подмешиваются --------
  const captured = []
  const pushBot = (text) => {
    const t = String(text == null ? '' : text).trim()
    if (t) captured.push({ role: 'bot', text: t })
  }
  const nowIso = () => new Date().toISOString()
  let seq = 0
  const captureChatMessage = async (_token, _ua, _chatId, text) => {
    pushBot(text)
    return { id: `test-${seq++}`, text: String(text || ''), createdAt: nowIso() }
  }
  const withRetry = async (fn) => fn()
  const noop = () => {}
  const asyncNoop = async () => ({})

  const localSupercellMap = {}
  const localTopupMap = {}

  // Заглушка автовыдачи Approute: НЕ создаёт реальный заказ, формирует сообщение
  // по шаблону deliveryMessage (как реальная выдача), захватывает его.
  const fakeRunApprouteAutodelivery = async ({ settings: s, lastChat, token, userAgent, createChatMessage }) => {
    const cfg = (s && s.autodeliveryApi) || {}
    const chatId = lastChat && lastChat.id
    const messageOnPurchase = (cfg.messageOnPurchase && String(cfg.messageOnPurchase).trim()) || ''
    if (messageOnPurchase) {
      await createChatMessage(token, userAgent, chatId, messageOnPurchase)
    }
    const tpl = String(cfg.deliveryMessage || '').trim()
    const delivery = `TEST-DELIVERY-${rand4()}`
    const kod = 'TEST-PIN'
    const text = tpl
      ? tpl.split('{delivery}').join(delivery).split('{Kod}').join(kod).split('{kod}').join(kod)
      : delivery
    await createChatMessage(token, userAgent, chatId, text)
    return { ok: true, markApprouteOrderDone: true, markApprouteChatDone: true }
  }

  const testTokenHash = `TEST::${rand4()}${rand4()}`
  let nowTs = 1_000_000
  const dealId = `test-deal-${rand4()}`

  const fullDealSnapshot = {
    productKey,
    status: 'PAID',
    category: categoryName,
    item: {
      id: 'test-item',
      title: titlePart || 'Товар',
      game: gamePart || categoryName,
      status: 'PAID',
      category: { name: categoryName },
    },
    obtainingFields: [],
  }

  // --- Прогон с подавлением буфера логов -------------------------------------
  setLogBufferSuppressed(true)
  try {
    await handlePaidChat({
      currentUserId,
      tokenHash: testTokenHash,
      token: testTokenHash,
      userAgent: 'TEST',
      nowTs,
      dealId,
      dealItemId: 'test-item',
      dealTs: nowTs,
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
      resolveEffectiveProductSettings,
      getSupercellGameByCategory,
      pickSupercellCategoryFromItemHints,
      autolistGetSupercellFlowMap: () => localSupercellMap,
      autolistGetTopupFlowMap: () => localTopupMap,
      extractSupercellEmailFromFields,
      upsertSettings: { run: noop },
      createChatMessage: captureChatMessage,
      sleep: async () => {},
      supercellModuleEnabled: true,
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

    // --- Догон интерактивного Supercell-флоу (валидный email -> запрос кода) ---
    if (localSupercellMap[TEST_CHAT_ID] && localSupercellMap[TEST_CHAT_ID].active) {
      const fetchSupercell = async () => ({
        messages: [],
        itemCategory: String(localSupercellMap[TEST_CHAT_ID].category || categoryName),
        buyerSupercellEmail: TEST_BUYER_EMAIL,
        viewerUsername: TEST_VIEWER,
      })
      const fakeRequestCode = async ({ email, category }) => {
        const game = getSupercellGameByCategory(String(category || ''))
        pushBot(formatSupercellCodeRequestedMessage(game ? game.gameName : String(category || '')))
        return { ok: true, gameKey: game && game.gameKey, gameName: game && game.gameName, email }
      }
      const processSingleSupercellFlow = createProcessSingleSupercellFlow({
        autolistGetSupercellFlowMap: () => localSupercellMap,
        getSupercellGameByCategory,
        fetchDealChatMessagesFromPlayerok: fetchSupercell,
        hasSupercellCodeRequestedMessage,
        isEmailValid,
        withRetry,
        isPlayerokRateLimitError: () => false,
        createChatMessage: captureChatMessage,
        requestSupercellCodeForChat: fakeRequestCode,
      })
      for (let i = 0; i < 6; i += 1) {
        const st = localSupercellMap[TEST_CHAT_ID]
        if (!st || !st.active) break
        nowTs += 10
        const r = await processSingleSupercellFlow(TEST_CHAT_ID, testTokenHash, 'TEST', TEST_VIEWER, nowTs)
        if (!r || r.ran === false || r.action === 'error') break
      }
    }

    // --- Догон интерактивного DTU-флоу (ID -> подтверждение -> выдача) ---------
    if (localTopupMap[TEST_CHAT_ID] && localTopupMap[TEST_CHAT_ID].active) {
      let idPushed = false
      let yesPushed = false
      const fetchTopup = async () => {
        const st = localTopupMap[TEST_CHAT_ID] || {}
        const stage = String(st.stage || 'await_id')
        const messages = []
        if (stage === 'await_id' && Number(st.askMsgTs) > 0) {
          messages.push({ user: { username: TEST_BUYER }, text: TEST_TOPUP_ID, createdAt: Number(st.askMsgTs) + 1 })
          if (!idPushed) {
            captured.push({ role: 'buyer', text: TEST_TOPUP_ID })
            idPushed = true
          }
        } else if (stage === 'await_confirm' && Number(st.confirmMsgTs) > 0) {
          // Подтверждение «ok»: движок (YES_RE) из-за \b принимает только латиницу
          // («да»/«ок» не матчатся), поэтому имитируем согласие токеном, который
          // реальная логика распознаёт, чтобы сценарий дошёл до выдачи.
          messages.push({ user: { username: TEST_BUYER }, text: 'ok', createdAt: Number(st.confirmMsgTs) + 1 })
          if (!yesPushed) {
            captured.push({ role: 'buyer', text: 'ok' })
            yesPushed = true
          }
        }
        return { messages, viewerUsername: TEST_VIEWER }
      }
      const processSingleTopupFlow = createProcessSingleTopupFlow({
        autolistGetTopupFlowMap: () => localTopupMap,
        fetchDealChatMessagesFromPlayerok: fetchTopup,
        withRetry,
        isPlayerokRateLimitError: () => false,
        createChatMessage: captureChatMessage,
        loadApprouteApiKeyPlain: () => 'TEST',
        checkApprouteDtuOrder: async () => ({ ok: true }),
        createApprouteDtuOrderAndConfirm: async () => ({ failed: false, completed: true, orderStatus: 'completed' }),
        isApprouteValidationError: () => false,
        updateDealStatus: asyncNoop,
        toUnixTs: (v) => Number(v) || 0,
      })
      for (let i = 0; i < 8; i += 1) {
        const st = localTopupMap[TEST_CHAT_ID]
        if (!st || !st.active) break
        nowTs += 10
        const r = await processSingleTopupFlow(TEST_CHAT_ID, testTokenHash, 'TEST', TEST_VIEWER, nowTs)
        if (!r || r.ran === false) break
        if (r.action === 'waiting_id' || r.action === 'waiting_confirm' || r.action === 'error') break
      }
    }
  } catch (err) {
    return { statusCode: 500, data: { error: err && err.message ? String(err.message) : 'test purchase failed' } }
  } finally {
    setLogBufferSuppressed(false)
  }

  const modes = []
  if (settings.automessage && settings.automessage.enabled) modes.push('automessage')
  if (settings.autodelivery && settings.autodelivery.enabled) modes.push('autodelivery')
  if (settings.autodeliveryApi && settings.autodeliveryApi.enabled) modes.push('autodeliveryApi')
  if (settings.autotopupApi && settings.autotopupApi.enabled) modes.push('autotopupApi')
  if (isSupercell) modes.push('supercell')

  return {
    statusCode: 200,
    data: { ok: true, productKey, modes, transcript: captured },
  }
}

module.exports = { handleTestPurchase }
