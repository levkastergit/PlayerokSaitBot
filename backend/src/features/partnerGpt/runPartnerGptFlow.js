'use strict'

const { logApprouteAutodelivery } = require('../../debug/approuteAutodeliveryLog')
const { resolveEffectiveDealIdForChat } = require('../../functions/supercellHelpers')
const { toUnixTs: defaultToUnixTs } = require('../../functions/toUnixTs')
const { isDealDeliveredOrFinished, isDealRefunded } = require('../approute/approuteAutodeliveryGuards')

// ---------------------------------------------------------------------------
// Чат-флоу «Автовыдача ChatGPT / Claude (партнёрский API)» — rootchatgptplus.com.
//
// Карта определяет продукт (plus/pro5x/pro20x/plusyear/claude_pro). Целевой
// идентификатор зависит от типа (cfg.targetType):
//   • chatgpt -> account_id (UUID ChatGPT-аккаунта);
//   • claude  -> organization_id (UUID организации Claude, claude.ai/settings/account).
//
// Поток: await_id (UUID из чата) -> claim card_code из таблицы -> POST /redemptions
//   -> await_result (поллинг GET /redemptions/:order_no ПО ТИКАМ, БЕЗ повторного
//      создания — дока запрещает resubmit) -> succeeded | failed | review.
//
// Карта помечается used при succeeded/failed/review (она потреблена поставщиком);
// возвращается в пул только если заказ НЕ был создан (account-fault/сток/транзиент).
// Плохая карта (invalid/expired/used) помечается used и берётся следующая.
// ---------------------------------------------------------------------------

const PARTNER_GPT_STOCK_RETRY_SEC = Math.max(5, Number(process.env.PARTNER_GPT_STOCK_RETRY_SEC) || 20)
const PARTNER_GPT_RESULT_POLL_SEC = Math.max(2, Number(process.env.PARTNER_GPT_RESULT_POLL_SEC) || 3)

function normText(t) {
  return String(t == null ? '' : t).trim()
}

function isSystemMarkerText(t) {
  return /\{\{[^}]*\}\}/.test(String(t || ''))
}

function senderUsername(m) {
  return String((m && m.user && (m.user.username || m.user.name)) || '').trim()
}

function isFromSeller(m, viewerUsername) {
  const u = senderUsername(m)
  const v = String(viewerUsername || '').trim()
  return Boolean(u && v && u.toLowerCase() === v.toLowerCase())
}

function isFromBuyer(m, viewerUsername) {
  if (!m) return false
  if (isSystemMarkerText(m.text)) return false
  const u = senderUsername(m)
  if (!u) return false
  const v = String(viewerUsername || '').trim()
  if (v && u.toLowerCase() === v.toLowerCase()) return false
  return true
}

function sellerMessageTs(messages, text, viewerUsername, toUnixTs) {
  const expected = normText(text)
  if (!expected) return 0
  let ts = 0
  for (const m of messages) {
    if (!isFromSeller(m, viewerUsername)) continue
    if (normText(m.text) !== expected) continue
    const t = toUnixTs(m.createdAt) || 0
    if (t > ts) ts = t
  }
  return ts
}

function latestBuyerMessageAfter(messages, afterTs, viewerUsername, toUnixTs) {
  let best = null
  let bestTs = Number(afterTs) || 0
  for (const m of messages) {
    if (!isFromBuyer(m, viewerUsername)) continue
    const t = toUnixTs(m.createdAt) || 0
    if (t > bestTs) {
      bestTs = t
      best = m
    }
  }
  return best ? { message: best, ts: bestTs } : null
}

function createProcessSinglePartnerGptFlow(deps) {
  const {
    autolistGetPartnerGptFlowMap,
    fetchDealChatMessagesFromPlayerok,
    withRetry,
    isPlayerokRateLimitError,
    createChatMessage,
    loadPartnerGptApiKeyPlain,
    extractAccountId,
    createRedemption,
    getRedemption,
    isPartnerGptAccountFault,
    isPartnerGptBadCard,
    isPartnerGptStockFault,
    isPartnerGptTransientError,
    isPartnerGptTerminalStatus,
    claimNextUnusedTableCode,
    markTableCodeUsed,
    releaseTableCode,
    updateDealStatus,
    partnerGptDealWasRedeemed = () => false,
    partnerGptMarkDealRedeemed = () => {},
    toUnixTs = defaultToUnixTs,
  } = deps

  const sendChat = (token, userAgent, chatId, text, label) =>
    withRetry(() => createChatMessage(token, userAgent, String(chatId), text), {
      label: `createChatMessage(${label})`,
      retries: 3,
      shouldRetry: isPlayerokRateLimitError,
    })

  const done = (flowMap, chatId, state, nowTs, patch = {}) => {
    flowMap[String(chatId)] = { ...state, ...patch, updatedAt: nowTs }
  }

  const runFlow = async function processSinglePartnerGptFlowInner(chatId, token, userAgent, viewerUsername, nowTs) {
    const tokenHash = token
    const flowMap = autolistGetPartnerGptFlowMap(tokenHash)
    const state = flowMap[String(chatId)]
    if (!state || !state.active) {
      return { ran: false, action: 'skipped', reason: 'flow_inactive', chatId: String(chatId) }
    }

    const cfg = state.cfg && typeof state.cfg === 'object' ? state.cfg : {}
    const dealId = state.dealId || null
    const subtabId = state.subtabId != null ? String(state.subtabId).trim() : ''

    if (!cfg.enabled || !subtabId) {
      done(flowMap, chatId, state, nowTs, { active: false })
      return { ran: true, action: 'skipped', reason: 'no_config', chatId: String(chatId) }
    }

    const apiKey = typeof loadPartnerGptApiKeyPlain === 'function' ? loadPartnerGptApiKeyPlain(state.userId) : ''
    if (!apiKey) {
      return { ran: true, action: 'skipped', reason: 'no_api_key', chatId: String(chatId) }
    }

    const targetType = String(cfg.targetType || 'chatgpt').toLowerCase() === 'claude' ? 'claude' : 'chatgpt'
    const isClaude = targetType === 'claude'

    const defaultAsk = isClaude
      ? 'Напишите, пожалуйста, ваш Claude Organization ID (UUID) из настроек аккаунта (https://claude.ai/settings/account) — на него активируем Claude Pro.'
      : 'Напишите, пожалуйста, ваш ChatGPT Account ID (UUID) — на него активируем подписку.'
    const askIdMessage = normText(cfg.askIdMessage) || defaultAsk
    const invalidIdMessage =
      normText(cfg.invalidIdMessage) ||
      (isClaude
        ? 'Не получилось распознать Organization ID. Пришлите, пожалуйста, корректный UUID ещё раз.'
        : 'Не получилось распознать Account ID. Пришлите, пожалуйста, корректный UUID ещё раз.')
    const successMessage =
      normText(cfg.successMessage) || 'Готово! Подписка активирована. Спасибо за покупку.'
    const noStockMessage =
      normText(cfg.noStockMessage) ||
      'Извините, коды временно закончились. Мы скоро пополним и активируем вашу подписку.'
    const failMessage =
      normText(cfg.failMessage) ||
      'Не удалось активировать подписку. Напишите, пожалуйста, продавцу — поможем вручную.'
    const reviewMessage =
      normText(cfg.reviewMessage) ||
      'Заявка отправлена и проверяется поставщиком — это может занять время. Мы сообщим, как только активируется.'

    const category = `subtab:${subtabId}`

    try {
      const chatData = await fetchDealChatMessagesFromPlayerok(token, userAgent, dealId, chatId, {
        viewerUsername: viewerUsername || null,
      })
      const messages = Array.isArray(chatData?.messages) ? chatData.messages : []
      const viewer = viewerUsername || chatData?.viewerUsername || null
      const effectiveDealId = resolveEffectiveDealIdForChat({ dealIdFromRequest: dealId, messages }) || dealId
      const redeemDealKey = dealId || effectiveDealId || null

      if (isDealRefunded(chatData?.dealStatus)) {
        done(flowMap, chatId, state, nowTs, { active: false, stage: 'aborted_refund' })
        return { ran: true, action: 'skipped_refund', chatId: String(chatId), dealId }
      }

      if (redeemDealKey && partnerGptDealWasRedeemed(state.userId, chatId, redeemDealKey)) {
        done(flowMap, chatId, state, nowTs, { active: false, stage: 'done', redeemed: true })
        return { ran: true, action: 'skipped_already_redeemed', chatId: String(chatId), dealId: redeemDealKey }
      }

      const markUsed = (cardId) => {
        if (typeof markTableCodeUsed === 'function' && cardId != null) {
          try {
            markTableCodeUsed(state.userId, cardId, { nowTs })
          } catch (e) {
            logApprouteAutodelivery('partner-gpt: mark used failed', { chatId: String(chatId), dealId, cardId, error: e?.message || String(e) })
          }
        }
      }
      const release = (cardId) => {
        if (typeof releaseTableCode === 'function' && cardId != null) {
          try {
            releaseTableCode(state.userId, cardId, { nowTs })
          } catch (e) {
            logApprouteAutodelivery('partner-gpt: release failed', { chatId: String(chatId), dealId, cardId, error: e?.message || String(e) })
          }
        }
      }

      // Терминальный результат заказа (карта уже потреблена поставщиком).
      const finishOrder = async (status, cardId) => {
        markUsed(cardId)
        if (status === 'succeeded') {
          const already = sellerMessageTs(messages, successMessage, viewer, toUnixTs)
          if (!already) await sendChat(token, userAgent, chatId, successMessage, 'pgpt-success')
          let autoCompleteDealDone = false
          if (cfg.autoCompleteDeal && (effectiveDealId || dealId) && typeof updateDealStatus === 'function') {
            try {
              await withRetry(() => updateDealStatus(token, userAgent, effectiveDealId || dealId, 'SENT'), {
                label: 'updateDealStatus(partner-gpt autoComplete)',
                retries: 2,
                shouldRetry: isPlayerokRateLimitError,
              })
              autoCompleteDealDone = true
            } catch (err) {
              logApprouteAutodelivery('partner-gpt: auto-complete failed', { chatId: String(chatId), dealId, error: err?.message || String(err) })
            }
          }
          if (redeemDealKey) {
            try { partnerGptMarkDealRedeemed(state.userId, chatId, redeemDealKey, nowTs) } catch (_) {}
          }
          done(flowMap, chatId, state, nowTs, { stage: 'done', active: false, redeemed: true })
          logApprouteAutodelivery('partner-gpt: completed', { chatId: String(chatId), dealId, cardId, autoCompleteDealDone })
          return { ran: true, action: 'redeemed', chatId: String(chatId), dealId, autoCompleteDealDone }
        }
        if (status === 'review') {
          await sendChat(token, userAgent, chatId, reviewMessage, 'pgpt-review')
          done(flowMap, chatId, state, nowTs, { stage: 'review', active: false })
          logApprouteAutodelivery('partner-gpt: review', { chatId: String(chatId), dealId, cardId })
          return { ran: true, action: 'review', chatId: String(chatId), dealId }
        }
        // failed
        await sendChat(token, userAgent, chatId, failMessage, 'pgpt-failed')
        done(flowMap, chatId, state, nowTs, { stage: 'failed', active: false })
        logApprouteAutodelivery('partner-gpt: failed', { chatId: String(chatId), dealId, cardId })
        return { ran: true, action: 'failed', chatId: String(chatId), dealId }
      }

      // Поллинг результата по order_no (без повторного создания заказа).
      const pollResult = async () => {
        const orderNo = String(state.orderNo || '').trim()
        const cardId = state.cardId != null ? state.cardId : null
        if (!orderNo) {
          done(flowMap, chatId, state, nowTs, { stage: 'await_id', askMsgTs: nowTs })
          return { ran: true, action: 'reask_id', reason: 'no_order', chatId: String(chatId), dealId }
        }
        let res
        try {
          res = await getRedemption(apiKey, orderNo)
        } catch (err) {
          // Транзиентный сбой опроса — повторим на следующем тике.
          done(flowMap, chatId, state, nowTs, { stage: 'await_result', lastPollTs: nowTs })
          return { ran: true, action: 'poll_error', reason: err?.message || String(err), chatId: String(chatId), dealId }
        }
        if (isPartnerGptTerminalStatus(res.status)) {
          return finishOrder(res.status, cardId)
        }
        // pending | processing — продолжаем опрос.
        done(flowMap, chatId, state, nowTs, { stage: 'await_result', lastPollTs: nowTs })
        return { ran: true, action: 'awaiting_result', chatId: String(chatId), dealId }
      }

      // Создание заказа: claim карты + POST /redemptions.
      const runCreate = async (target, { notify = true } = {}) => {
        done(flowMap, chatId, state, nowTs, { stage: 'ordering', accountId: target })
        const claimed =
          typeof claimNextUnusedTableCode === 'function'
            ? claimNextUnusedTableCode(state.userId, category, {
                dealId: effectiveDealId || null,
                itemId: state.itemId || null,
                chatId: String(chatId),
                nowTs,
                pending: true,
              })
            : null
        const cardCode = claimed?.code ? String(claimed.code).trim() : ''
        if (!cardCode) {
          if (notify) await sendChat(token, userAgent, chatId, noStockMessage, 'pgpt-no-stock')
          done(flowMap, chatId, state, nowTs, { stage: 'await_stock', accountId: target, lastActivateTs: nowTs })
          return { ran: true, action: 'no_stock', chatId: String(chatId), dealId }
        }
        const idemKey = `pgpt-${state.userId}-${redeemDealKey || chatId}-${claimed.id}`
        try {
          const created = await createRedemption(apiKey, {
            cardCode,
            accountId: isClaude ? undefined : target,
            organizationId: isClaude ? target : undefined,
            confirmOverwrite: true,
            idempotencyKey: idemKey,
          })
          const orderNo = String(created.orderNo || '').trim()
          if (!orderNo) {
            // Нет order_no — считаем плохой картой, помечаем used, пробуем следующую.
            markUsed(claimed.id)
            done(flowMap, chatId, state, nowTs, { stage: 'await_stock', accountId: target, lastActivateTs: nowTs })
            return { ran: true, action: 'no_order_no', chatId: String(chatId), dealId }
          }
          // Заказ создан — карта потреблена; держим её claimed, переходим к поллингу.
          done(flowMap, chatId, state, nowTs, {
            stage: 'await_result',
            accountId: target,
            orderNo,
            cardId: claimed.id != null ? claimed.id : null,
            lastPollTs: 0,
          })
          state.orderNo = orderNo
          state.cardId = claimed.id != null ? claimed.id : null
          logApprouteAutodelivery('partner-gpt: order created', { chatId: String(chatId), dealId, orderNo, cardId: claimed.id, targetType })
          // Если create уже вернул терминальный статус — обработаем сразу.
          if (isPartnerGptTerminalStatus(created.status)) {
            return finishOrder(created.status, claimed.id)
          }
          return pollResult()
        } catch (err) {
          if (isPartnerGptAccountFault && isPartnerGptAccountFault(err)) {
            release(claimed.id)
            await sendChat(token, userAgent, chatId, invalidIdMessage, 'pgpt-account-fault')
            done(flowMap, chatId, state, nowTs, { stage: 'await_id', askMsgTs: nowTs, accountId: '' })
            return { ran: true, action: 'account_fault', chatId: String(chatId), dealId }
          }
          if (isPartnerGptBadCard && isPartnerGptBadCard(err)) {
            // Плохая карта — помечаем used (skip), берём следующую на ретрае.
            markUsed(claimed.id)
            done(flowMap, chatId, state, nowTs, { stage: 'await_stock', accountId: target, lastActivateTs: nowTs })
            logApprouteAutodelivery('partner-gpt: bad card, skipping', { chatId: String(chatId), dealId, cardId: claimed.id, code: err?.partnerCode || null })
            return { ran: true, action: 'bad_card', chatId: String(chatId), dealId }
          }
          // Сток/транзиент/прочее — карту в пул, повторим позже.
          release(claimed.id)
          if (notify && isPartnerGptStockFault && isPartnerGptStockFault(err)) {
            await sendChat(token, userAgent, chatId, noStockMessage, 'pgpt-stock')
          } else if (notify && !(isPartnerGptTransientError && isPartnerGptTransientError(err))) {
            await sendChat(token, userAgent, chatId, failMessage, 'pgpt-create-error')
          }
          done(flowMap, chatId, state, nowTs, { stage: 'await_stock', accountId: target, lastActivateTs: nowTs })
          logApprouteAutodelivery('partner-gpt: create transient/error', { chatId: String(chatId), dealId, cardId: claimed.id, error: err?.message || String(err), code: err?.partnerCode || null })
          return { ran: true, action: 'create_retry', chatId: String(chatId), dealId }
        }
      }

      const stage = String(state.stage || 'await_id')

      if (isDealDeliveredOrFinished(chatData?.dealStatus)) {
        done(flowMap, chatId, state, nowTs, { active: false, stage: 'aborted' })
        return { ran: true, action: 'skipped_deal_done', chatId: String(chatId), dealId }
      }

      // --- await_result: опрос созданного заказа ----------------------------
      if (stage === 'await_result') {
        const lastPoll = Number(state.lastPollTs || 0)
        if (lastPoll && nowTs - lastPoll < PARTNER_GPT_RESULT_POLL_SEC) {
          return { ran: true, action: 'awaiting_result', chatId: String(chatId), dealId }
        }
        return pollResult()
      }

      // --- await_id: запрос целевого UUID -----------------------------------
      if (stage === 'await_id') {
        let askTs = Number(state.askMsgTs || 0)
        if (!askTs) {
          askTs = sellerMessageTs(messages, askIdMessage, viewer, toUnixTs)
          if (!askTs) {
            await sendChat(token, userAgent, chatId, askIdMessage, 'pgpt-ask-id')
            done(flowMap, chatId, state, nowTs, { stage: 'await_id', askMsgTs: nowTs })
            return { ran: true, action: 'asked_id', chatId: String(chatId), dealId }
          }
          done(flowMap, chatId, state, nowTs, { stage: 'await_id', askMsgTs: askTs })
        }
        const buyer = latestBuyerMessageAfter(messages, askTs, viewer, toUnixTs)
        if (!buyer) {
          done(flowMap, chatId, state, nowTs, { stage: 'await_id', askMsgTs: askTs })
          return { ran: true, action: 'waiting_id', chatId: String(chatId), dealId }
        }
        const target = extractAccountId(buyer.message.text)
        if (!target) {
          await sendChat(token, userAgent, chatId, invalidIdMessage, 'pgpt-invalid-id')
          done(flowMap, chatId, state, nowTs, { stage: 'await_id', askMsgTs: nowTs })
          return { ran: true, action: 'id_invalid', chatId: String(chatId), dealId }
        }
        return runCreate(target, { notify: true })
      }

      // --- await_stock: нет карты / сток / транзиент — ретрай создания ------
      if (stage === 'await_stock') {
        const target = normText(state.accountId)
        if (!target) {
          done(flowMap, chatId, state, nowTs, { stage: 'await_id', askMsgTs: nowTs })
          return { ran: true, action: 'reask_id', reason: 'no_target', chatId: String(chatId), dealId }
        }
        const lastTry = Number(state.lastActivateTs || 0)
        const buyer = latestBuyerMessageAfter(messages, lastTry, viewer, toUnixTs)
        if (buyer) {
          const newId = extractAccountId(buyer.message.text)
          if (newId && newId !== target) return runCreate(newId, { notify: true })
        }
        if (!buyer && nowTs - lastTry < PARTNER_GPT_STOCK_RETRY_SEC) {
          return { ran: true, action: 'waiting_stock', chatId: String(chatId), dealId }
        }
        return runCreate(target, { notify: false })
      }

      // ordering или неизвестная стадия — подождём следующий тик.
      return { ran: true, action: 'skipped', reason: `stage_${stage}`, chatId: String(chatId), dealId }
    } catch (err) {
      return { ran: true, action: 'error', reason: err?.message || String(err), chatId: String(chatId), dealId }
    }
  }

  return function processSinglePartnerGptFlow(chatId, token, userAgent, viewerUsername, nowTs) {
    const flowLockKey = `${String(token)}::${String(chatId)}`
    global.__partnerGptFlowInFlight = global.__partnerGptFlowInFlight || new Set()
    if (global.__partnerGptFlowInFlight.has(flowLockKey)) {
      return Promise.resolve({ ran: false, action: 'skipped', reason: 'in_flight', chatId: String(chatId) })
    }
    global.__partnerGptFlowInFlight.add(flowLockKey)
    return Promise.resolve()
      .then(() => runFlow(chatId, token, userAgent, viewerUsername, nowTs))
      .finally(() => {
        global.__partnerGptFlowInFlight.delete(flowLockKey)
      })
  }
}

module.exports = { createProcessSinglePartnerGptFlow }
