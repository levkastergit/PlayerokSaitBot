'use strict'

const { logApprouteAutodelivery } = require('../../debug/approuteAutodeliveryLog')
const { resolveEffectiveDealIdForChat } = require('../../functions/supercellHelpers')
const { toUnixTs: defaultToUnixTs } = require('../../functions/toUnixTs')

// ---------------------------------------------------------------------------
// Чат-флоу прямого пополнения (AppRoute DTU).
// Покупатель пишет ID/логин -> бот проверяет через AppRoute (checkOnly, без
// списания) -> переспрашивает «верно ли ID?» -> на «да» делает реальный заказ
// (idempotent по referenceId=dealId) -> подтверждает успех.
// Стадия хранится в in-memory flow-map (как supercell), отправки защищены от
// дублей по тексту, двойное списание исключено идемпотентностью AppRoute.
// ---------------------------------------------------------------------------

const YES_RE = /^(да|ага|агась|верно|вер|все верно|всё верно|правильно|подтверждаю|подтвердить|ок|окей|ok|okay|yes|yep|yeah|y|\+)\b/i
const NO_RE = /^(нет|не верно|неверно|не правильно|неправильно|no|nope|n|\-)\b/i

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

/** ts (unix sec) последнего сообщения продавца с точно таким текстом, иначе 0. */
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

/** Последнее сообщение покупателя строго позже afterTs. */
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

function resolveDenominationId(cfg) {
  const pick = (v) => (v != null && String(v).trim() ? String(v).trim() : '')
  return (
    pick(cfg.denominationId) ||
    pick(cfg.variantId) ||
    pick(cfg.variantOrderServiceId) ||
    pick(cfg.serviceId)
  )
}

function formatConfirm(template, id) {
  const tpl = normText(template) || 'Подтвердите: ваш ID/логин — {id}. Всё верно? Напишите «да» или «нет».'
  return tpl.split('{id}').join(String(id || '')).split('{ID}').join(String(id || ''))
}

function createProcessSingleTopupFlow(deps) {
  const {
    autolistGetTopupFlowMap,
    fetchDealChatMessagesFromPlayerok,
    withRetry,
    isPlayerokRateLimitError,
    createChatMessage,
    loadApprouteApiKeyPlain,
    checkApprouteDtuOrder,
    createApprouteDtuOrderAndConfirm,
    isApprouteValidationError,
    updateDealStatus,
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

  return async function processSingleTopupFlow(chatId, token, userAgent, viewerUsername, nowTs) {
    const tokenHash = token
    const flowMap = autolistGetTopupFlowMap(tokenHash)
    const state = flowMap[String(chatId)]
    if (!state || !state.active) {
      return { ran: false, action: 'skipped', reason: 'flow_inactive', chatId: String(chatId) }
    }

    const cfg = state.cfg && typeof state.cfg === 'object' ? state.cfg : {}
    const dealId = state.dealId || null
    const denominationId = resolveDenominationId(cfg)

    if (!cfg.enabled || !denominationId) {
      done(flowMap, chatId, state, nowTs, { active: false })
      return { ran: true, action: 'skipped', reason: 'no_config', chatId: String(chatId) }
    }

    const apiKey = typeof loadApprouteApiKeyPlain === 'function' ? loadApprouteApiKeyPlain(state.userId) : ''
    if (!apiKey) {
      return { ran: true, action: 'skipped', reason: 'no_api_key', chatId: String(chatId) }
    }

    const askIdMessage = normText(cfg.askIdMessage) || 'Для пополнения напишите ваш игровой ID/логин.'
    const invalidIdMessage =
      normText(cfg.invalidIdMessage) || 'ID/логин не прошёл проверку. Пришлите, пожалуйста, корректный ID/логин.'
    const successMessage = normText(cfg.successMessage) || 'Готово! Пополнение выполнено. Спасибо за покупку.'

    const orderInput = {
      denominationId,
      quantity: cfg.quantity,
      amountCurrencyCode: cfg.amountCurrencyCode || 'RUB',
      amount: cfg.amount != null && String(cfg.amount).trim() ? cfg.amount : undefined,
      dealId: dealId || undefined,
      referenceId: dealId || undefined,
    }

    try {
      const chatData = await fetchDealChatMessagesFromPlayerok(token, userAgent, dealId, chatId, {
        viewerUsername: viewerUsername || null,
      })
      const messages = Array.isArray(chatData?.messages) ? chatData.messages : []
      const viewer = viewerUsername || chatData?.viewerUsername || null
      const effectiveDealId = resolveEffectiveDealIdForChat({ dealIdFromRequest: dealId, messages }) || dealId
      if (effectiveDealId && orderInput.dealId == null) {
        orderInput.dealId = effectiveDealId
        orderInput.referenceId = effectiveDealId
      }

      let stage = String(state.stage || 'await_id')

      // --- Стадия 1: запрос ID у покупателя -----------------------------------
      if (stage === 'await_id') {
        let askTs = Number(state.askMsgTs || 0)
        if (!askTs) {
          askTs = sellerMessageTs(messages, askIdMessage, viewer, toUnixTs)
          if (!askTs) {
            await sendChat(token, userAgent, chatId, askIdMessage, 'topup-ask-id')
            done(flowMap, chatId, state, nowTs, { stage: 'await_id', askMsgTs: nowTs })
            logApprouteAutodelivery('topup: asked for id', { chatId: String(chatId), dealId })
            return { ran: true, action: 'asked_id', chatId: String(chatId), dealId }
          }
          done(flowMap, chatId, state, nowTs, { stage: 'await_id', askMsgTs: askTs })
        }

        const buyer = latestBuyerMessageAfter(messages, askTs, viewer, toUnixTs)
        if (!buyer) {
          done(flowMap, chatId, state, nowTs, { stage: 'await_id', askMsgTs: askTs })
          return { ran: true, action: 'waiting_id', chatId: String(chatId), dealId }
        }

        const candidateId = normText(buyer.message.text)
        if (!candidateId) {
          return { ran: true, action: 'waiting_id', chatId: String(chatId), dealId }
        }

        // Проверка ID без списания.
        try {
          await checkApprouteDtuOrder(apiKey, { ...orderInput, accountReference: candidateId })
        } catch (err) {
          if (isApprouteValidationError(err)) {
            await sendChat(token, userAgent, chatId, invalidIdMessage, 'topup-invalid-id')
            done(flowMap, chatId, state, nowTs, { stage: 'await_id', askMsgTs: nowTs, candidateId: '' })
            logApprouteAutodelivery('topup: id invalid', {
              chatId: String(chatId),
              dealId,
              error: err?.message || String(err),
            })
            return { ran: true, action: 'id_invalid', chatId: String(chatId), dealId }
          }
          // Прочие ошибки (сеть/средства/наличие) — не вина покупателя, повторим позже.
          logApprouteAutodelivery('topup: check failed (transient)', {
            chatId: String(chatId),
            dealId,
            error: err?.message || String(err),
          })
          return { ran: true, action: 'error', reason: err?.message || String(err), chatId: String(chatId), dealId }
        }

        const confirmMessage = formatConfirm(cfg.confirmTemplate, candidateId)
        await sendChat(token, userAgent, chatId, confirmMessage, 'topup-confirm-ask')
        done(flowMap, chatId, state, nowTs, {
          stage: 'await_confirm',
          candidateId,
          confirmMsgTs: nowTs,
        })
        logApprouteAutodelivery('topup: id valid, asking confirm', { chatId: String(chatId), dealId })
        return { ran: true, action: 'confirm_asked', chatId: String(chatId), dealId }
      }

      // --- Стадия 2: ожидание подтверждения «да/нет» --------------------------
      if (stage === 'await_confirm') {
        const confirmTs = Number(state.confirmMsgTs || 0)
        const buyer = latestBuyerMessageAfter(messages, confirmTs, viewer, toUnixTs)
        if (!buyer) {
          return { ran: true, action: 'waiting_confirm', chatId: String(chatId), dealId }
        }
        const reply = normText(buyer.message.text)

        if (NO_RE.test(reply)) {
          await sendChat(token, userAgent, chatId, askIdMessage, 'topup-reask-id')
          done(flowMap, chatId, state, nowTs, { stage: 'await_id', askMsgTs: nowTs, candidateId: '' })
          return { ran: true, action: 'reask_id', chatId: String(chatId), dealId }
        }

        if (!YES_RE.test(reply)) {
          // Похоже, покупатель прислал исправленный ID вместо «да/нет» — валидируем заново.
          try {
            await checkApprouteDtuOrder(apiKey, { ...orderInput, accountReference: reply })
          } catch (err) {
            if (isApprouteValidationError(err)) {
              return { ran: true, action: 'waiting_confirm', chatId: String(chatId), dealId }
            }
            return { ran: true, action: 'error', reason: err?.message || String(err), chatId: String(chatId), dealId }
          }
          const confirmMessage = formatConfirm(cfg.confirmTemplate, reply)
          await sendChat(token, userAgent, chatId, confirmMessage, 'topup-confirm-ask')
          done(flowMap, chatId, state, nowTs, { stage: 'await_confirm', candidateId: reply, confirmMsgTs: nowTs })
          return { ran: true, action: 'confirm_asked', chatId: String(chatId), dealId }
        }

        // «да» -> реальный заказ (идемпотентно по referenceId=dealId).
        const accountReference = normText(state.candidateId)
        if (!accountReference) {
          done(flowMap, chatId, state, nowTs, { stage: 'await_id', askMsgTs: nowTs })
          return { ran: true, action: 'reask_id', reason: 'no_candidate', chatId: String(chatId), dealId }
        }

        // Защита от повторной отправки в рамках процесса.
        done(flowMap, chatId, state, nowTs, { stage: 'ordering' })
        try {
          const result = await createApprouteDtuOrderAndConfirm(apiKey, { ...orderInput, accountReference })
          if (result.failed) {
            logApprouteAutodelivery('topup: order failed', {
              chatId: String(chatId),
              dealId,
              status: result.orderStatus || null,
            })
            await sendChat(token, userAgent, chatId, invalidIdMessage, 'topup-order-failed')
            done(flowMap, chatId, state, nowTs, { stage: 'await_id', askMsgTs: nowTs, candidateId: '' })
            return { ran: true, action: 'order_failed', chatId: String(chatId), dealId }
          }

          await sendChat(token, userAgent, chatId, successMessage, 'topup-success')

          let autoCompleteDealDone = false
          if (cfg.autoCompleteDeal && dealId && typeof updateDealStatus === 'function') {
            try {
              await withRetry(() => updateDealStatus(token, userAgent, dealId, 'SENT'), {
                label: 'updateDealStatus(topup autoComplete)',
                retries: 2,
                shouldRetry: isPlayerokRateLimitError,
              })
              autoCompleteDealDone = true
            } catch (err) {
              logApprouteAutodelivery('topup: auto-complete failed', {
                chatId: String(chatId),
                dealId,
                error: err?.message || String(err),
              })
            }
          }

          done(flowMap, chatId, state, nowTs, { stage: 'done', active: false, orderPlaced: true })
          logApprouteAutodelivery('topup: completed', {
            chatId: String(chatId),
            dealId,
            status: result.orderStatus || null,
            autoCompleteDealDone,
          })
          return { ran: true, action: 'topped_up', chatId: String(chatId), dealId, autoCompleteDealDone }
        } catch (err) {
          // Заказ не оформлен — возвращаем стадию ожидания подтверждения для повторной попытки.
          done(flowMap, chatId, state, nowTs, { stage: 'await_confirm', confirmMsgTs: Number(state.confirmMsgTs || nowTs) })
          logApprouteAutodelivery('topup: order error', {
            chatId: String(chatId),
            dealId,
            error: err?.message || String(err),
          })
          return { ran: true, action: 'error', reason: err?.message || String(err), chatId: String(chatId), dealId }
        }
      }

      return { ran: true, action: 'skipped', reason: `stage_${stage}`, chatId: String(chatId), dealId }
    } catch (err) {
      return { ran: true, action: 'error', reason: err?.message || String(err), chatId: String(chatId), dealId }
    }
  }
}

module.exports = { createProcessSingleTopupFlow }
