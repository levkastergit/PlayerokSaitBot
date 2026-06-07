'use strict'

const { logApprouteAutodelivery } = require('../../debug/approuteAutodeliveryLog')
const { resolveEffectiveDealIdForChat } = require('../../functions/supercellHelpers')
const { toUnixTs: defaultToUnixTs } = require('../../functions/toUnixTs')
const { isDealDeliveredOrFinished } = require('../approute/approuteAutodeliveryGuards')

// ---------------------------------------------------------------------------
// Чат-флоу «Автовыдача GPT» (активация ChatGPT-подписок через api.987ai.vip).
//
// Покупатель присылает ССЫЛКУ на Google-документ со своим Access Token (токен
// длинный и не влезает в одно сообщение Playerok). Бот:
//   1) await_link   — просит ссылку; из сообщения достаёт ID Google-дока;
//   2) скачивает документ:
//        • нет доступа          → пишет «откройте доступ», уходит в await_access;
//        • документа/токена нет → просит прислать корректную ссылку;
//        • ок                   → достаёт токен и сразу активирует (БЕЗ подтверждения);
//   3) await_access — периодически (с троттлингом) перепроверяет документ; как
//        только доступ открыли — достаёт токен и активирует;
//   4) активация    — берёт следующий card_key из привязанной таблицы и создаёт
//        задачу в API с опросом до терминального статуса. При провале код
//        возвращается в пул; ошибка токена → снова await_link, иначе await_stock.
//   5) await_stock  — авто-ретрай активации (троттлинг) при пустом складе/сбое,
//        токен уже сохранён в состоянии.
//
// Подтверждения «да/нет» нет — активируем сразу после получения токена.
// Стадия хранится в in-memory flow-map (как clode/topup), отправки защищены от
// дублей по тексту/стадии, двойная активация исключена стадией 'ordering'.
// ---------------------------------------------------------------------------

const GPT_DOC_RECHECK_SEC = Math.max(3, Number(process.env.GPT_DOC_RECHECK_SEC) || 8)
const GPT_STOCK_RETRY_SEC = Math.max(5, Number(process.env.GPT_STOCK_RETRY_SEC) || 20)

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

function createProcessSingleGptFlow(deps) {
  const {
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
    claimNextUnusedTableCode,
    markTableCodeUsed,
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

  return async function processSingleGptFlow(chatId, token, userAgent, viewerUsername, nowTs) {
    const tokenHash = token
    const flowMap = autolistGetGptFlowMap(tokenHash)
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

    // Режим ввода: 'link' (ссылка на Google-док), 'id' (прямой app_user_id/токен),
    // 'auto' (принимаем и ссылку, и прямой ID/токен — что пришлёт покупатель).
    const mode = ['link', 'id', 'auto'].includes(String(cfg.inputMode || '').toLowerCase())
      ? String(cfg.inputMode).toLowerCase()
      : 'link'
    const allowLink = mode === 'link' || mode === 'auto'
    const allowId = mode === 'id' || mode === 'auto'

    const askLinkMessage =
      normText(cfg.askLinkMessage) ||
      'Пришлите, пожалуйста, ссылку на Google-документ с вашим ChatGPT Access Token (документ должен быть открыт для просмотра «всем, у кого есть ссылка»).'
    const askIdMessage =
      normText(cfg.askIdMessage) ||
      'Напишите, пожалуйста, ваш ChatGPT ID (app_user_id в формате UUID) для активации подписки.'
    const askAutoMessage =
      normText(cfg.askAutoMessage) ||
      'Для активации пришлите ваш ChatGPT ID (UUID) или ссылку на Google-документ с вашим Access Token (документ открыт для просмотра «всем, у кого есть ссылка»).'
    const invalidLinkMessage =
      normText(cfg.invalidLinkMessage) ||
      'Не вижу ссылку на Google-документ. Пришлите, пожалуйста, корректную ссылку вида https://docs.google.com/document/...'
    const invalidIdMessage =
      normText(cfg.invalidIdMessage) ||
      'Не получилось распознать ваш ChatGPT ID. Пришлите, пожалуйста, корректный app_user_id (UUID) ещё раз.'
    const invalidAutoMessage =
      normText(cfg.invalidAutoMessage) ||
      'Не распознал ввод. Пришлите, пожалуйста, ваш ChatGPT ID (UUID) или ссылку на Google-документ с токеном.'
    const noAccessMessage =
      normText(cfg.noAccessMessage) ||
      'Нет доступа к документу. Откройте доступ «всем, у кого есть ссылка» (просмотр) — я продолжу активацию автоматически.'
    const tokenNotFoundMessage =
      normText(cfg.tokenNotFoundMessage) ||
      'В документе не нашёл Access Token (строку вида eyJ...). Проверьте содержимое и пришлите ссылку ещё раз.'
    const successMessage =
      normText(cfg.successMessage) || 'Готово! Подписка ChatGPT активирована. Спасибо за покупку.'
    const noStockMessage =
      normText(cfg.noStockMessage) ||
      'Извините, коды временно закончились. Мы скоро пополним и активируем вашу подписку.'
    const failMessage =
      normText(cfg.failMessage) ||
      'Не удалось активировать подписку. Пришлите, пожалуйста, ваши данные ещё раз или подождите — мы повторим.'

    // Сообщение-запрос и «не распознал» зависят от выбранного режима.
    const askMessage = mode === 'id' ? askIdMessage : mode === 'auto' ? askAutoMessage : askLinkMessage
    const invalidMessage =
      mode === 'id' ? invalidIdMessage : mode === 'auto' ? invalidAutoMessage : invalidLinkMessage

    const category = `subtab:${subtabId}`

    try {
      const chatData = await fetchDealChatMessagesFromPlayerok(token, userAgent, dealId, chatId, {
        viewerUsername: viewerUsername || null,
      })
      const messages = Array.isArray(chatData?.messages) ? chatData.messages : []
      const viewer = viewerUsername || chatData?.viewerUsername || null
      const effectiveDealId = resolveEffectiveDealIdForChat({ dealIdFromRequest: dealId, messages }) || dealId

      // --- Активация: берём card_key из таблицы и создаём задачу в API --------
      // notify=false подавляет повторную отправку служебных сообщений при авто-ретраях.
      const runActivation = async (accessToken, { notify = true } = {}) => {
        done(flowMap, chatId, state, nowTs, { stage: 'ordering' })

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
        const cardKey = claimed?.code ? String(claimed.code).trim() : ''
        if (!cardKey) {
          if (notify) await sendChat(token, userAgent, chatId, noStockMessage, 'gpt-no-stock')
          done(flowMap, chatId, state, nowTs, { stage: 'await_stock', accessToken, lastActivateTs: nowTs })
          logApprouteAutodelivery('gpt: no free codes', { chatId: String(chatId), dealId, subtabId })
          return { ran: true, action: 'no_stock', chatId: String(chatId), dealId }
        }

        const releaseClaimed = () => {
          if (typeof releaseTableCode === 'function' && claimed?.id) {
            try {
              releaseTableCode(state.userId, claimed.id, { nowTs })
            } catch (e) {
              logApprouteAutodelivery('gpt: release code failed', {
                chatId: String(chatId),
                dealId,
                codeId: claimed.id,
                error: e?.message || String(e),
              })
            }
          }
        }

        try {
          const result = await redeemGptAndConfirm({ cardKey, accessToken })

          if (result.completed) {
            // Подтверждённый успех: фиксируем card_key как 'used' ('pending' → 'used').
            if (typeof markTableCodeUsed === 'function' && claimed?.id != null) {
              try {
                markTableCodeUsed(state.userId, claimed.id, { nowTs })
              } catch (e) {
                logApprouteAutodelivery('gpt: mark code used failed', {
                  chatId: String(chatId),
                  dealId,
                  codeId: claimed.id,
                  error: e?.message || String(e),
                })
              }
            }
            await sendChat(token, userAgent, chatId, successMessage, 'gpt-success')

            let autoCompleteDealDone = false
            if (cfg.autoCompleteDeal && (effectiveDealId || dealId) && typeof updateDealStatus === 'function') {
              try {
                await withRetry(() => updateDealStatus(token, userAgent, effectiveDealId || dealId, 'SENT'), {
                  label: 'updateDealStatus(gpt autoComplete)',
                  retries: 2,
                  shouldRetry: isPlayerokRateLimitError,
                })
                autoCompleteDealDone = true
              } catch (err) {
                logApprouteAutodelivery('gpt: auto-complete failed', {
                  chatId: String(chatId),
                  dealId,
                  error: err?.message || String(err),
                })
              }
            }

            done(flowMap, chatId, state, nowTs, { stage: 'done', active: false, redeemed: true })
            logApprouteAutodelivery('gpt: completed', {
              chatId: String(chatId),
              dealId,
              codeId: claimed.id,
              autoCompleteDealDone,
            })
            return { ran: true, action: 'redeemed', chatId: String(chatId), dealId, autoCompleteDealDone }
          }

          // failed / inProgress: возвращаем card_key в пул.
          releaseClaimed()
          if (result.tokenFault) {
            // Токен/аккаунт покупателя — просим прислать новую ссылку.
            await sendChat(token, userAgent, chatId, failMessage, 'gpt-redeem-token-fault')
            done(flowMap, chatId, state, nowTs, { stage: 'await_link', askMsgTs: nowTs, accessToken: '', docId: '' })
            logApprouteAutodelivery('gpt: redeem token fault', {
              chatId: String(chatId),
              dealId,
              codeId: claimed.id,
              message: result.message || null,
            })
            return { ran: true, action: 'token_fault', chatId: String(chatId), dealId }
          }
          // Склад/таймаут/прочее — авто-ретрай позже, токен сохраняем.
          if (notify) await sendChat(token, userAgent, chatId, failMessage, 'gpt-redeem-failed')
          done(flowMap, chatId, state, nowTs, { stage: 'await_stock', accessToken, lastActivateTs: nowTs })
          logApprouteAutodelivery('gpt: redeem not completed', {
            chatId: String(chatId),
            dealId,
            codeId: claimed.id,
            inProgress: Boolean(result.inProgress),
            message: result.message || null,
          })
          return { ran: true, action: result.inProgress ? 'redeem_timeout' : 'redeem_failed', chatId: String(chatId), dealId }
        } catch (err) {
          // Синхронная ошибка создания задачи — код в пул.
          releaseClaimed()
          if (isGptTokenFaultError && isGptTokenFaultError(err)) {
            await sendChat(token, userAgent, chatId, failMessage, 'gpt-create-token-fault')
            done(flowMap, chatId, state, nowTs, { stage: 'await_link', askMsgTs: nowTs, accessToken: '', docId: '' })
            return { ran: true, action: 'token_fault', chatId: String(chatId), dealId }
          }
          if (isGptStockError && isGptStockError(err)) {
            if (notify) await sendChat(token, userAgent, chatId, noStockMessage, 'gpt-no-stock')
            done(flowMap, chatId, state, nowTs, { stage: 'await_stock', accessToken, lastActivateTs: nowTs })
            return { ran: true, action: 'no_stock', chatId: String(chatId), dealId }
          }
          if (notify) await sendChat(token, userAgent, chatId, failMessage, 'gpt-create-error')
          done(flowMap, chatId, state, nowTs, { stage: 'await_stock', accessToken, lastActivateTs: nowTs })
          logApprouteAutodelivery('gpt: redeem error', {
            chatId: String(chatId),
            dealId,
            codeId: claimed.id,
            error: err?.message || String(err),
          })
          return { ran: true, action: 'error', reason: err?.message || String(err), chatId: String(chatId), dealId }
        }
      }

      // Скачиваем документ и при наличии токена сразу активируем.
      const processDoc = async (docId, { notify = true } = {}) => {
        const doc = await fetchGoogleDocText(docId)
        if (doc.ok) {
          const accessToken = extractGptAccessToken(doc.text)
          if (!accessToken) {
            await sendChat(token, userAgent, chatId, tokenNotFoundMessage, 'gpt-token-not-found')
            done(flowMap, chatId, state, nowTs, { stage: 'await_link', askMsgTs: nowTs, docId: '' })
            return { ran: true, action: 'token_not_found', chatId: String(chatId), dealId }
          }
          return runActivation(accessToken, { notify: true })
        }
        // Документ не найден — ссылка точно неверная, просим прислать другую.
        if (doc.notFound) {
          await sendChat(token, userAgent, chatId, invalidMessage, 'gpt-doc-unreadable')
          done(flowMap, chatId, state, nowTs, { stage: 'await_link', askMsgTs: nowTs, docId: '' })
          return { ran: true, action: 'link_invalid', chatId: String(chatId), dealId }
        }
        // Нет доступа или временная ошибка сети — ждём и перепроверяем сами.
        if (notify) await sendChat(token, userAgent, chatId, noAccessMessage, 'gpt-no-access')
        done(flowMap, chatId, state, nowTs, { stage: 'await_access', docId, lastCheckTs: nowTs })
        logApprouteAutodelivery('gpt: doc no access', {
          chatId: String(chatId),
          dealId,
          docId,
          error: doc.error || null,
        })
        return { ran: true, action: 'no_access', chatId: String(chatId), dealId }
      }

      const stage = String(state.stage || 'await_link')

      // Issue #1: если сделка уже завершена/подтверждена/товар отправлен — на
      // «запрашивающих»/ретрай-стадиях ничего у покупателя не спрашиваем и не
      // активируем (после резерва кода в 'ordering' код не удерживается между
      // тиками, поэтому 'pending' здесь не зависнет).
      if (
        (stage === 'await_link' || stage === 'await_access' || stage === 'await_stock') &&
        isDealDeliveredOrFinished(chatData?.dealStatus)
      ) {
        done(flowMap, chatId, state, nowTs, { active: false, stage: 'aborted' })
        logApprouteAutodelivery('gpt: skip — deal already delivered/finished', {
          chatId: String(chatId),
          dealId,
          dealStatus: chatData?.dealStatus || null,
        })
        return {
          ran: true,
          action: 'skipped_deal_done',
          reason: String(chatData?.dealStatus || '').toUpperCase() || 'finished',
          chatId: String(chatId),
          dealId,
        }
      }

      // --- Стадия 1: запрос ввода (ID и/или ссылка на Google-док) -------------
      if (stage === 'await_link') {
        let askTs = Number(state.askMsgTs || 0)
        if (!askTs) {
          askTs = sellerMessageTs(messages, askMessage, viewer, toUnixTs)
          if (!askTs) {
            await sendChat(token, userAgent, chatId, askMessage, 'gpt-ask-input')
            done(flowMap, chatId, state, nowTs, { stage: 'await_link', askMsgTs: nowTs })
            logApprouteAutodelivery('gpt: asked for input', { chatId: String(chatId), dealId, mode })
            return { ran: true, action: 'asked_input', chatId: String(chatId), dealId }
          }
          done(flowMap, chatId, state, nowTs, { stage: 'await_link', askMsgTs: askTs })
        }

        const buyer = latestBuyerMessageAfter(messages, askTs, viewer, toUnixTs)
        if (!buyer) {
          done(flowMap, chatId, state, nowTs, { stage: 'await_link', askMsgTs: askTs })
          return { ran: true, action: 'waiting_input', chatId: String(chatId), dealId }
        }

        // Сначала пробуем ссылку на Google-док (более специфичный формат), затем
        // прямой ID/токен из сообщения — в зависимости от режима лота.
        if (allowLink) {
          const docId = extractGoogleDocId(buyer.message.text)
          if (docId) return processDoc(docId, { notify: true })
        }
        if (allowId) {
          const direct = extractGptAccessToken(buyer.message.text)
          if (direct) return runActivation(direct, { notify: true })
        }

        await sendChat(token, userAgent, chatId, invalidMessage, 'gpt-invalid-input')
        done(flowMap, chatId, state, nowTs, { stage: 'await_link', askMsgTs: nowTs })
        logApprouteAutodelivery('gpt: input invalid', { chatId: String(chatId), dealId, mode })
        return { ran: true, action: 'input_invalid', chatId: String(chatId), dealId }
      }

      // --- Стадия 2: ждём, пока откроют доступ к документу --------------------
      if (stage === 'await_access') {
        // Покупатель мог прислать новую ссылку — или (в режиме auto) сразу ID.
        const buyer = latestBuyerMessageAfter(
          messages,
          Math.max(Number(state.askMsgTs || 0), Number(state.lastCheckTs || 0)),
          viewer,
          toUnixTs
        )
        if (buyer && allowId) {
          const direct = extractGptAccessToken(buyer.message.text)
          if (direct) return runActivation(direct, { notify: true })
        }
        const newDocId = buyer ? extractGoogleDocId(buyer.message.text) : ''
        const docId = newDocId || String(state.docId || '').trim()
        if (!docId) {
          done(flowMap, chatId, state, nowTs, { stage: 'await_link', askMsgTs: nowTs })
          return { ran: true, action: 'reask_link', chatId: String(chatId), dealId }
        }

        const lastCheck = Number(state.lastCheckTs || 0)
        if (!newDocId && nowTs - lastCheck < GPT_DOC_RECHECK_SEC) {
          return { ran: true, action: 'waiting_access', chatId: String(chatId), dealId }
        }
        // Перепроверяем доступ молча (сообщение «нет доступа» уже отправлено).
        return processDoc(docId, { notify: false })
      }

      // --- Стадия 3: авто-ретрай активации (склад/сбой), токен уже есть -------
      if (stage === 'await_stock') {
        const accessToken = normText(state.accessToken)
        if (!accessToken) {
          done(flowMap, chatId, state, nowTs, { stage: 'await_link', askMsgTs: nowTs })
          return { ran: true, action: 'reask_link', reason: 'no_token', chatId: String(chatId), dealId }
        }
        const lastTry = Number(state.lastActivateTs || 0)
        const buyer = latestBuyerMessageAfter(messages, lastTry, viewer, toUnixTs)
        if (!buyer && nowTs - lastTry < GPT_STOCK_RETRY_SEC) {
          return { ran: true, action: 'waiting_stock', chatId: String(chatId), dealId }
        }
        return runActivation(accessToken, { notify: false })
      }

      return { ran: true, action: 'skipped', reason: `stage_${stage}`, chatId: String(chatId), dealId }
    } catch (err) {
      return { ran: true, action: 'error', reason: err?.message || String(err), chatId: String(chatId), dealId }
    }
  }
}

module.exports = { createProcessSingleGptFlow }
