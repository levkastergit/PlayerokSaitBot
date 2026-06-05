'use strict'

const { logApprouteAutodelivery } = require('../../debug/approuteAutodeliveryLog')
const { resolveEffectiveDealIdForChat } = require('../../functions/supercellHelpers')
const { toUnixTs: defaultToUnixTs } = require('../../functions/toUnixTs')

// ---------------------------------------------------------------------------
// Чат-флоу «Автовыдача Clode» (активация Claude-кодов через CDK Reseller API).
// Покупатель пишет свой Claude user ID (UUID) -> бот извлекает UUID из сырого
// текста (Playerok шлёт его в кавычках/скобках) -> переспрашивает «верно ли ID?»
// -> на «да» берёт следующий CDK из привязанной таблицы и активирует через API,
// дожидаясь терминального статуса. При любом провале код возвращается в пул.
// Стадия хранится в in-memory flow-map (как topup/supercell), отправки защищены
// от дублей по тексту, двойная активация исключена стадией 'ordering'.
// ---------------------------------------------------------------------------

// Граница слова через негативный lookahead (а не \b): в JS \b не срабатывает
// после кириллицы, из-за чего «да»/«нет» не матчились бы голым словом.
const YES_RE = /^(да|ага|агась|верно|вер|все верно|всё верно|правильно|подтверждаю|подтвердить|ок|окей|ok|okay|yes|yep|yeah|y|\+)(?![\wа-яё])/i
const NO_RE = /^(нет|не верно|неверно|не правильно|неправильно|no|nope|n|-)(?![\wа-яё])/i

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

function formatConfirm(template, id) {
  const tpl = normText(template) || 'это ваш id: {id}, да/нет?'
  return tpl.split('{id}').join(String(id || '')).split('{ID}').join(String(id || ''))
}

function createProcessSingleClodeFlow(deps) {
  const {
    autolistGetClodeFlowMap,
    fetchDealChatMessagesFromPlayerok,
    withRetry,
    isPlayerokRateLimitError,
    createChatMessage,
    loadClodeApiKeyPlain,
    redeemClaudeAndConfirm,
    extractClaudeUserId,
    normalizeClodePlan,
    isClodeValidationError,
    claimNextUnusedTableCode,
    releaseTableCode,
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

  return async function processSingleClodeFlow(chatId, token, userAgent, viewerUsername, nowTs) {
    const tokenHash = token
    const flowMap = autolistGetClodeFlowMap(tokenHash)
    const state = flowMap[String(chatId)]
    if (!state || !state.active) {
      return { ran: false, action: 'skipped', reason: 'flow_inactive', chatId: String(chatId) }
    }

    const cfg = state.cfg && typeof state.cfg === 'object' ? state.cfg : {}
    const dealId = state.dealId || null
    const subtabId = state.subtabId != null ? String(state.subtabId).trim() : ''
    const expectedPlan =
      typeof normalizeClodePlan === 'function' ? normalizeClodePlan(cfg.tier) : null

    if (!cfg.enabled || !subtabId) {
      done(flowMap, chatId, state, nowTs, { active: false })
      return { ran: true, action: 'skipped', reason: 'no_config', chatId: String(chatId) }
    }

    const apiKey = typeof loadClodeApiKeyPlain === 'function' ? loadClodeApiKeyPlain(state.userId) : ''
    if (!apiKey) {
      return { ran: true, action: 'skipped', reason: 'no_api_key', chatId: String(chatId) }
    }

    const askIdMessage =
      normText(cfg.askIdMessage) || 'Напишите, пожалуйста, ваш Claude user ID (UUID) для активации.'
    const invalidIdMessage =
      normText(cfg.invalidIdMessage) ||
      'Не получилось распознать ваш Claude user ID. Пришлите, пожалуйста, корректный UUID ещё раз.'
    const successMessage =
      normText(cfg.successMessage) || 'Готово! Подписка активирована. Спасибо за покупку.'
    const noStockMessage =
      normText(cfg.noStockMessage) ||
      'Извините, коды временно закончились. Мы скоро пополним и активируем вашу подписку.'
    const failMessage =
      normText(cfg.failMessage) ||
      'Не удалось активировать подписку по этому ID. Проверьте ID и пришлите его ещё раз.'

    const category = `subtab:${subtabId}`

    try {
      const chatData = await fetchDealChatMessagesFromPlayerok(token, userAgent, dealId, chatId, {
        viewerUsername: viewerUsername || null,
      })
      const messages = Array.isArray(chatData?.messages) ? chatData.messages : []
      const viewer = viewerUsername || chatData?.viewerUsername || null
      const effectiveDealId = resolveEffectiveDealIdForChat({ dealIdFromRequest: dealId, messages }) || dealId

      let stage = String(state.stage || 'await_id')

      // --- Стадия 1: запрос Claude user ID у покупателя -----------------------
      if (stage === 'await_id') {
        let askTs = Number(state.askMsgTs || 0)
        if (!askTs) {
          askTs = sellerMessageTs(messages, askIdMessage, viewer, toUnixTs)
          if (!askTs) {
            await sendChat(token, userAgent, chatId, askIdMessage, 'clode-ask-id')
            done(flowMap, chatId, state, nowTs, { stage: 'await_id', askMsgTs: nowTs })
            logApprouteAutodelivery('clode: asked for id', { chatId: String(chatId), dealId })
            return { ran: true, action: 'asked_id', chatId: String(chatId), dealId }
          }
          done(flowMap, chatId, state, nowTs, { stage: 'await_id', askMsgTs: askTs })
        }

        const buyer = latestBuyerMessageAfter(messages, askTs, viewer, toUnixTs)
        if (!buyer) {
          done(flowMap, chatId, state, nowTs, { stage: 'await_id', askMsgTs: askTs })
          return { ran: true, action: 'waiting_id', chatId: String(chatId), dealId }
        }

        // Локальная валидация: извлекаем UUID из сырого текста (кавычки/скобки/мусор).
        const candidateId = extractClaudeUserId(buyer.message.text)
        if (!candidateId) {
          await sendChat(token, userAgent, chatId, invalidIdMessage, 'clode-invalid-id')
          done(flowMap, chatId, state, nowTs, { stage: 'await_id', askMsgTs: nowTs, candidateId: '' })
          logApprouteAutodelivery('clode: id invalid', { chatId: String(chatId), dealId })
          return { ran: true, action: 'id_invalid', chatId: String(chatId), dealId }
        }

        const confirmMessage = formatConfirm(cfg.confirmTemplate, candidateId)
        await sendChat(token, userAgent, chatId, confirmMessage, 'clode-confirm-ask')
        done(flowMap, chatId, state, nowTs, {
          stage: 'await_confirm',
          candidateId,
          confirmMsgTs: nowTs,
        })
        logApprouteAutodelivery('clode: id valid, asking confirm', { chatId: String(chatId), dealId })
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
          await sendChat(token, userAgent, chatId, askIdMessage, 'clode-reask-id')
          done(flowMap, chatId, state, nowTs, { stage: 'await_id', askMsgTs: nowTs, candidateId: '' })
          return { ran: true, action: 'reask_id', chatId: String(chatId), dealId }
        }

        if (!YES_RE.test(reply)) {
          // Возможно, прислали исправленный ID вместо «да/нет» — пробуем извлечь UUID.
          const corrected = extractClaudeUserId(reply)
          if (!corrected) {
            return { ran: true, action: 'waiting_confirm', chatId: String(chatId), dealId }
          }
          const confirmMessage = formatConfirm(cfg.confirmTemplate, corrected)
          await sendChat(token, userAgent, chatId, confirmMessage, 'clode-confirm-ask')
          done(flowMap, chatId, state, nowTs, { stage: 'await_confirm', candidateId: corrected, confirmMsgTs: nowTs })
          return { ran: true, action: 'confirm_asked', chatId: String(chatId), dealId }
        }

        // «да» -> активация. Берём UUID из состояния.
        const claudeUserId = normText(state.candidateId)
        if (!claudeUserId) {
          done(flowMap, chatId, state, nowTs, { stage: 'await_id', askMsgTs: nowTs })
          return { ran: true, action: 'reask_id', reason: 'no_candidate', chatId: String(chatId), dealId }
        }

        // Защита от повторной активации в рамках процесса.
        done(flowMap, chatId, state, nowTs, { stage: 'ordering' })

        // Берём CDK из привязанной таблицы только сейчас (после подтверждения).
        const claimed =
          typeof claimNextUnusedTableCode === 'function'
            ? claimNextUnusedTableCode(state.userId, category, {
                dealId: effectiveDealId || null,
                itemId: state.itemId || null,
                chatId: String(chatId),
                nowTs,
              })
            : null
        const cdk = claimed?.code ? String(claimed.code).trim() : ''
        if (!cdk) {
          await sendChat(token, userAgent, chatId, noStockMessage, 'clode-no-stock')
          done(flowMap, chatId, state, nowTs, { stage: 'await_confirm', confirmMsgTs: Number(state.confirmMsgTs || nowTs) })
          logApprouteAutodelivery('clode: no free codes', { chatId: String(chatId), dealId, subtabId })
          return { ran: true, action: 'no_stock', chatId: String(chatId), dealId }
        }

        const releaseClaimed = () => {
          if (typeof releaseTableCode === 'function' && claimed?.id) {
            try {
              releaseTableCode(state.userId, claimed.id, { nowTs })
            } catch (e) {
              logApprouteAutodelivery('clode: release code failed', {
                chatId: String(chatId),
                dealId,
                codeId: claimed.id,
                error: e?.message || String(e),
              })
            }
          }
        }

        try {
          let result
          try {
            result = await redeemClaudeAndConfirm(apiKey, { cdk, claudeUserId, expectedPlan, force: false })
          } catch (err) {
            // 409 ACCOUNT_RECENTLY_CHARGED — один ретрай с force=true тем же кодом.
            if (err?.code === 'ACCOUNT_RECENTLY_CHARGED' || err?.httpStatus === 409) {
              result = await redeemClaudeAndConfirm(apiKey, { cdk, claudeUserId, expectedPlan, force: true })
            } else {
              throw err
            }
          }

          if (result.failed || result.inProgress) {
            // failed: сервер откатил CDK на своей стороне; inProgress: таймаут ожидания.
            // В обоих случаях возвращаем наш табличный код в пул и просим повторить.
            releaseClaimed()
            await sendChat(token, userAgent, chatId, failMessage, 'clode-redeem-failed')
            done(flowMap, chatId, state, nowTs, { stage: 'await_confirm', confirmMsgTs: nowTs, candidateId: claudeUserId })
            logApprouteAutodelivery('clode: redeem not completed', {
              chatId: String(chatId),
              dealId,
              codeId: claimed.id,
              inProgress: Boolean(result.inProgress),
              message: result.message || null,
            })
            return { ran: true, action: result.inProgress ? 'redeem_timeout' : 'redeem_failed', chatId: String(chatId), dealId }
          }

          // Успех.
          await sendChat(token, userAgent, chatId, successMessage, 'clode-success')

          let autoCompleteDealDone = false
          if (cfg.autoCompleteDeal && (effectiveDealId || dealId) && typeof updateDealStatus === 'function') {
            try {
              await withRetry(() => updateDealStatus(token, userAgent, effectiveDealId || dealId, 'SENT'), {
                label: 'updateDealStatus(clode autoComplete)',
                retries: 2,
                shouldRetry: isPlayerokRateLimitError,
              })
              autoCompleteDealDone = true
            } catch (err) {
              logApprouteAutodelivery('clode: auto-complete failed', {
                chatId: String(chatId),
                dealId,
                error: err?.message || String(err),
              })
            }
          }

          done(flowMap, chatId, state, nowTs, { stage: 'done', active: false, redeemed: true })
          logApprouteAutodelivery('clode: completed', {
            chatId: String(chatId),
            dealId,
            codeId: claimed.id,
            autoCompleteDealDone,
          })
          return { ran: true, action: 'redeemed', chatId: String(chatId), dealId, autoCompleteDealDone }
        } catch (err) {
          // Сетевой/иной сбой активации — возвращаем код в пул, ждём повторного «да».
          releaseClaimed()
          if (isClodeValidationError && isClodeValidationError(err)) {
            await sendChat(token, userAgent, chatId, invalidIdMessage, 'clode-invalid-id')
            done(flowMap, chatId, state, nowTs, { stage: 'await_id', askMsgTs: nowTs, candidateId: '' })
            return { ran: true, action: 'id_invalid', chatId: String(chatId), dealId }
          }
          done(flowMap, chatId, state, nowTs, { stage: 'await_confirm', confirmMsgTs: nowTs, candidateId: claudeUserId })
          logApprouteAutodelivery('clode: redeem error', {
            chatId: String(chatId),
            dealId,
            codeId: claimed.id,
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

module.exports = { createProcessSingleClodeFlow }
