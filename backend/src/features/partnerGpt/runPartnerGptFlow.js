'use strict'

const { logApprouteAutodelivery } = require('../../debug/approuteAutodeliveryLog')
const { resolveEffectiveDealIdForChat } = require('../../functions/supercellHelpers')
const { toUnixTs: defaultToUnixTs } = require('../../functions/toUnixTs')
const { isDealDeliveredOrFinished, isDealRefunded } = require('../approute/approuteAutodeliveryGuards')

// ---------------------------------------------------------------------------
// Чат-флоу «Автовыдача ChatGPT (партнёрский API)» — admin.rootchatgptplus.com.
//
// Покупатель присылает свой ChatGPT account_id (UUID). Бот берёт следующий
// card_code из привязанной таблицы и гасит его на этот account_id через
// POST /redemptions с опросом до терминального статуса. При провале:
//   • вина данных покупателя (invalid account_id) -> снова await_id;
//   • вина нашей карты (использована/просрочена/нет стока) -> карта в пул,
//     await_stock (авто-ретрай со следующей картой).
//
// Стадия в in-memory flow-map (как gpt/clode); двойное гашение исключено
// стадией 'ordering' + идемпотентным ключом по card_code.
// ---------------------------------------------------------------------------

const PARTNER_GPT_STOCK_RETRY_SEC = Math.max(5, Number(process.env.PARTNER_GPT_STOCK_RETRY_SEC) || 20)

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
    redeemPartnerGptAndConfirm,
    isPartnerGptAccountFault,
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

    const askIdMessage =
      normText(cfg.askIdMessage) ||
      'Напишите, пожалуйста, ваш ChatGPT Account ID (UUID) — на него активируем подписку.'
    const invalidIdMessage =
      normText(cfg.invalidIdMessage) ||
      'Не получилось распознать Account ID. Пришлите, пожалуйста, корректный UUID ещё раз.'
    const successMessage =
      normText(cfg.successMessage) || 'Готово! Подписка ChatGPT активирована. Спасибо за покупку.'
    const noStockMessage =
      normText(cfg.noStockMessage) ||
      'Извините, коды временно закончились. Мы скоро пополним и активируем вашу подписку.'
    const failMessage =
      normText(cfg.failMessage) ||
      'Не удалось активировать подписку. Пришлите, пожалуйста, Account ID ещё раз или подождите — мы повторим.'

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

      const runActivation = async (accountId, { notify = true } = {}) => {
        done(flowMap, chatId, state, nowTs, { stage: 'ordering', accountId })

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
          done(flowMap, chatId, state, nowTs, { stage: 'await_stock', accountId, lastActivateTs: nowTs })
          return { ran: true, action: 'no_stock', chatId: String(chatId), dealId }
        }

        const releaseClaimed = () => {
          if (typeof releaseTableCode === 'function' && claimed?.id) {
            try {
              releaseTableCode(state.userId, claimed.id, { nowTs })
            } catch (e) {
              logApprouteAutodelivery('partner-gpt: release code failed', {
                chatId: String(chatId),
                dealId,
                codeId: claimed.id,
                error: e?.message || String(e),
              })
            }
          }
        }

        const idemKey = `pgpt-${state.userId}-${redeemDealKey || chatId}-${claimed.id}`
        try {
          const result = await redeemPartnerGptAndConfirm(apiKey, { cardCode, accountId, idempotencyKey: idemKey })

          if (result.succeeded) {
            if (typeof markTableCodeUsed === 'function' && claimed?.id != null) {
              try {
                markTableCodeUsed(state.userId, claimed.id, { nowTs })
              } catch (e) {
                logApprouteAutodelivery('partner-gpt: mark code used failed', {
                  chatId: String(chatId), dealId, codeId: claimed.id, error: e?.message || String(e),
                })
              }
            }
            const successAlready = sellerMessageTs(messages, successMessage, viewer, toUnixTs)
            if (!successAlready) await sendChat(token, userAgent, chatId, successMessage, 'pgpt-success')

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
                logApprouteAutodelivery('partner-gpt: auto-complete failed', {
                  chatId: String(chatId), dealId, error: err?.message || String(err),
                })
              }
            }
            if (redeemDealKey) {
              try {
                partnerGptMarkDealRedeemed(state.userId, chatId, redeemDealKey, nowTs)
              } catch (_) {}
            }
            done(flowMap, chatId, state, nowTs, { stage: 'done', active: false, redeemed: true })
            logApprouteAutodelivery('partner-gpt: completed', {
              chatId: String(chatId), dealId, codeId: claimed.id, autoCompleteDealDone,
            })
            return { ran: true, action: 'redeemed', chatId: String(chatId), dealId, autoCompleteDealDone }
          }

          // failed / inProgress -> карту в пул.
          releaseClaimed()
          if (result.accountFault) {
            // Невалидный account_id покупателя — просим прислать снова.
            await sendChat(token, userAgent, chatId, invalidIdMessage, 'pgpt-account-fault')
            done(flowMap, chatId, state, nowTs, { stage: 'await_id', askMsgTs: nowTs, accountId: '' })
            return { ran: true, action: 'account_fault', chatId: String(chatId), dealId }
          }
          // Карта/сток/таймаут — авто-ретрай со следующей картой, accountId сохраняем.
          if (notify) await sendChat(token, userAgent, chatId, failMessage, 'pgpt-redeem-failed')
          done(flowMap, chatId, state, nowTs, { stage: 'await_stock', accountId, lastActivateTs: nowTs })
          logApprouteAutodelivery('partner-gpt: redeem not completed', {
            chatId: String(chatId), dealId, codeId: claimed.id,
            inProgress: Boolean(result.inProgress), failureCode: result.failureCode || null,
          })
          return { ran: true, action: result.inProgress ? 'redeem_timeout' : 'redeem_failed', chatId: String(chatId), dealId }
        } catch (err) {
          releaseClaimed()
          if (isPartnerGptAccountFault && isPartnerGptAccountFault(err)) {
            await sendChat(token, userAgent, chatId, invalidIdMessage, 'pgpt-create-account-fault')
            done(flowMap, chatId, state, nowTs, { stage: 'await_id', askMsgTs: nowTs, accountId: '' })
            return { ran: true, action: 'account_fault', chatId: String(chatId), dealId }
          }
          if (notify) await sendChat(token, userAgent, chatId, failMessage, 'pgpt-create-error')
          done(flowMap, chatId, state, nowTs, { stage: 'await_stock', accountId, lastActivateTs: nowTs })
          logApprouteAutodelivery('partner-gpt: redeem error', {
            chatId: String(chatId), dealId, codeId: claimed?.id, error: err?.message || String(err),
          })
          return { ran: true, action: 'error', reason: err?.message || String(err), chatId: String(chatId), dealId }
        }
      }

      const stage = String(state.stage || 'await_id')

      // Товар отправлен/подтверждён вручную -> закрываем флоу.
      if (isDealDeliveredOrFinished(chatData?.dealStatus)) {
        done(flowMap, chatId, state, nowTs, { active: false, stage: 'aborted' })
        return { ran: true, action: 'skipped_deal_done', chatId: String(chatId), dealId }
      }

      // --- Стадия 1: запрос account_id ---------------------------------------
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
        const accountId = extractAccountId(buyer.message.text)
        if (!accountId) {
          await sendChat(token, userAgent, chatId, invalidIdMessage, 'pgpt-invalid-id')
          done(flowMap, chatId, state, nowTs, { stage: 'await_id', askMsgTs: nowTs })
          return { ran: true, action: 'id_invalid', chatId: String(chatId), dealId }
        }
        return runActivation(accountId, { notify: true })
      }

      // --- Стадия 2: авто-ретрай (сток/сбой), accountId уже есть -------------
      if (stage === 'await_stock') {
        const accountId = normText(state.accountId)
        if (!accountId) {
          done(flowMap, chatId, state, nowTs, { stage: 'await_id', askMsgTs: nowTs })
          return { ran: true, action: 'reask_id', reason: 'no_account', chatId: String(chatId), dealId }
        }
        // Покупатель мог прислать новый ID.
        const lastTry = Number(state.lastActivateTs || 0)
        const buyer = latestBuyerMessageAfter(messages, lastTry, viewer, toUnixTs)
        if (buyer) {
          const newId = extractAccountId(buyer.message.text)
          if (newId && newId !== accountId) return runActivation(newId, { notify: true })
        }
        if (!buyer && nowTs - lastTry < PARTNER_GPT_STOCK_RETRY_SEC) {
          return { ran: true, action: 'waiting_stock', chatId: String(chatId), dealId }
        }
        return runActivation(accountId, { notify: false })
      }

      return { ran: true, action: 'skipped', reason: `stage_${stage}`, chatId: String(chatId), dealId }
    } catch (err) {
      return { ran: true, action: 'error', reason: err?.message || String(err), chatId: String(chatId), dealId }
    }
  }

  // Глобальный per-(token,chatId) лок (как gpt) — против параллельного прогона.
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
