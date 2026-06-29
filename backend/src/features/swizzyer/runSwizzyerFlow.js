'use strict'

const { logApprouteAutodelivery } = require('../../debug/approuteAutodeliveryLog')
const { resolveEffectiveDealIdForChat } = require('../../functions/supercellHelpers')
const { toUnixTs: defaultToUnixTs } = require('../../functions/toUnixTs')
const { isDealDeliveredOrFinished, isDealRefunded } = require('../approute/approuteAutodeliveryGuards')

// ---------------------------------------------------------------------------
// Чат-флоу «Автовыдача Roblox» через Swizzyer (rbcode.net), Режим B (диалоговый).
//
// 1) await_credentials — бот просит логин+пароль; из сообщения покупателя
//    разбирает credentials и создаёт заказ (mode:'conversational').
// 2) verifying — бот ведёт 2FA по next_action:
//      • provide_input (digits/recovery_code) — пересылает запрос кода в чат,
//        ждёт ответ покупателя, шлёт /respond;
//      • choose_one / choose_many — показывает варианты, принимает выбор;
//      • credentials_retry — пароль отвергнут, просит логин+пароль заново;
//      • push_approval (passkey) — просит подтвердить вход в приложении, опрашивает;
//      • wait — опрашивает GET /orders/:id.
// 3) Терминал: completed/partially_delivered → успех (+ автозавершение сделки),
//    failed/cancelled/expired → сообщение об ошибке.
//
// Стадия и orderId хранятся в in-memory flow-map (как gpt/topup); order_id ещё и
// в БД (swizzyer_orders) — для резюма после перезапуска БЕЗ повторного создания
// заказа (заказ = реальное списание, дубль недопустим). Пароль держим в памяти
// только до создания заказа, затем стираем.
// ---------------------------------------------------------------------------

const SWIZZYER_POLL_THROTTLE_SEC = Math.max(1, Number(process.env.SWIZZYER_POLL_THROTTLE_SEC) || 3)
const SWIZZYER_CREATE_RETRY_SEC = Math.max(5, Number(process.env.SWIZZYER_CREATE_RETRY_SEC) || 20)

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

/** ts (unix sec) последнего сообщения продавца, текст которого начинается с prefix. */
function sellerMessageTsByPrefix(messages, prefix, viewerUsername, toUnixTs) {
  const p = normText(prefix)
  if (!p) return 0
  let ts = 0
  for (const m of messages) {
    if (!isFromSeller(m, viewerUsername)) continue
    if (!normText(m.text).startsWith(p.slice(0, 24))) continue
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

// --- Разбор логина/пароля из сообщения покупателя ---------------------------

/**
 * Достаёт { username, password } из текста. Поддерживает форматы:
 *   логин:пароль · login: x / password: y · две строки · «логин пароль».
 * Возвращает null, если уверенно распознать не удалось.
 */
function parseRobloxCredentials(text) {
  const raw = String(text == null ? '' : text)
  const clean = raw.replace(/ /g, ' ').trim()
  if (!clean) return null

  const grab = (re) => {
    const m = clean.match(re)
    return m ? m[1].trim() : ''
  }
  // Явные метки.
  let username = grab(/(?:логин|лог|login|username|user|ник)\s*[:=\-]?\s*([^\s:]{3,30})/i)
  let password = grab(/(?:пароль|пасс|пас|password|pass|pwd)\s*[:=\-]?\s*(\S{3,})/i)
  if (username && password) return { username, password }

  // Одна строка вида user:pass / user / pass / user|pass / user;pass
  const oneLine = clean.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
  if (oneLine.length === 1) {
    const parts = oneLine[0].split(/\s*[:|;/\\]\s*|\s{1,}/).filter(Boolean)
    if (parts.length === 2 && /^[A-Za-z0-9_.]{3,30}$/.test(parts[0]) && parts[1].length >= 3) {
      return { username: parts[0], password: parts[1] }
    }
  }
  // Две строки: логин на первой, пароль на второй.
  if (oneLine.length >= 2) {
    const u = oneLine[0].replace(/^(?:логин|login|username|user|ник)\s*[:=\-]?\s*/i, '').trim()
    const p = oneLine[1].replace(/^(?:пароль|password|pass|pwd)\s*[:=\-]?\s*/i, '').trim()
    if (/^[A-Za-z0-9_.]{3,30}$/.test(u) && p.length >= 3) {
      return { username: u, password: p }
    }
  }
  return null
}

/** Извлекает OTP-код (4–8 цифр) из текста (пробелы/дефисы внутри кода игнорируются). */
function extractDigitsCode(text) {
  const compact = String(text == null ? '' : text).replace(/[\s\-]/g, '')
  const m = compact.match(/\d{4,8}/)
  return m ? m[0] : ''
}

/** Извлекает recovery/backup-код (буквенно-цифровой) из текста. */
function extractRecoveryCode(text) {
  const s = String(text == null ? '' : text).trim()
  const m = s.match(/[A-Za-z0-9][A-Za-z0-9\-]{6,20}/)
  return m ? m[0] : ''
}

function createProcessSingleSwizzyerFlow(deps) {
  const {
    autolistGetSwizzyerFlowMap,
    fetchDealChatMessagesFromPlayerok,
    withRetry,
    isPlayerokRateLimitError,
    createChatMessage,
    loadSwizzyerApiKeyPlain,
    // Swizzyer client
    createSwizzyerOrder,
    getSwizzyerOrder,
    respondSwizzyerVerification,
    extractSwizzyerNextAction,
    extractSwizzyerStatus,
    isSwizzyerTerminalStatus,
    isSwizzyerSuccessStatus,
    isSwizzyerErrorCode,
    isSwizzyerTransientError,
    pickI18n,
    // catalog
    getSwizzyerItems,
    getSwizzyerDenomination,
    // durable order tracking
    getSwizzyerOrderByDeal = () => null,
    upsertSwizzyerOrder = () => {},
    // persistent «уже выдано» journal
    swizzyerDealWasDelivered = () => false,
    swizzyerMarkDealDelivered = () => {},
    updateDealStatus,
    toUnixTs = defaultToUnixTs,
  } = deps

  const sendChat = (token, userAgent, chatId, text, label) =>
    withRetry(() => createChatMessage(token, userAgent, String(chatId), text), {
      label: `createChatMessage(${label})`,
      retries: 3,
      shouldRetry: isPlayerokRateLimitError,
    })

  const save = (flowMap, chatId, state, nowTs, patch = {}) => {
    flowMap[String(chatId)] = { ...state, ...patch, updatedAt: nowTs }
    return flowMap[String(chatId)]
  }

  // Текст подсказки для покупателя по next_action.
  function buildPromptText(nextAction, cfg) {
    const base = pickI18n(nextAction.prompt, 'ru') || 'Подтвердите вход в Roblox.'
    const type = String(nextAction.type || '')
    const parts = [base]

    if (type === 'provide_input') {
      if (nextAction.email_hint) parts.push(`(отправлено на ${nextAction.email_hint})`)
      const attempt = Number(nextAction.attempt || 0)
      const maxA = Number(nextAction.max_attempts || 0)
      if (attempt > 1 && maxA) parts.push(`Попытка ${attempt} из ${maxA}.`)
    } else if (type === 'choose_one' || type === 'choose_many') {
      const opts = Array.isArray(nextAction.options) ? nextAction.options : []
      const lines = opts.map((o, i) => `${i + 1}) ${pickI18n(o.label, 'ru') || o.id}`)
      if (lines.length) parts.push(lines.join('\n'))
      parts.push(type === 'choose_many' ? 'Напишите номера через запятую.' : 'Напишите номер варианта.')
    } else if (type === 'credentials_retry') {
      const attempt = Number(nextAction.attempt || 0)
      const maxA = Number(nextAction.max_attempts || 0)
      const tail = attempt > 1 && maxA ? ` (попытка ${attempt} из ${maxA})` : ''
      parts.push(`Пришлите логин и пароль ещё раз одним сообщением в формате логин:пароль${tail}.`)
    }
    return parts.join('\n')
  }

  // Строит тело /respond по next_action и ответу покупателя.
  // Возвращает { body } либо { hint } (нераспознанный ввод — подсказать формат).
  function buildRespondBody(nextAction, buyerText, version) {
    const type = String(nextAction.type || '')
    if (type === 'provide_input') {
      const format = String(nextAction.input?.format || 'digits')
      if (format === 'recovery_code') {
        const code = extractRecoveryCode(buyerText)
        if (!code) return { hint: 'Не вижу резервный код. Пришлите один из ваших резервных (backup) кодов.' }
        return { body: { if_version: version, input: code } }
      }
      const code = extractDigitsCode(buyerText)
      if (!code) return { hint: 'Не вижу код. Пришлите, пожалуйста, цифровой код подтверждения.' }
      return { body: { if_version: version, input: code } }
    }
    if (type === 'choose_one') {
      const opts = Array.isArray(nextAction.options) ? nextAction.options : []
      const choice = matchChoice(buyerText, opts)
      if (!choice) return { hint: 'Не понял выбор. Напишите номер варианта (например, 1).' }
      return { body: { if_version: version, choice_id: choice } }
    }
    if (type === 'choose_many') {
      const opts = Array.isArray(nextAction.options) ? nextAction.options : []
      const ids = String(buyerText || '')
        .split(/[,\s]+/)
        .map((tok) => matchChoice(tok, opts))
        .filter(Boolean)
      if (!ids.length) return { hint: 'Не понял выбор. Напишите номера вариантов через запятую.' }
      return { body: { if_version: version, choice_ids: Array.from(new Set(ids)) } }
    }
    if (type === 'credentials_retry') {
      const creds = parseRobloxCredentials(buyerText)
      if (!creds) return { hint: 'Не разобрал логин и пароль. Пришлите в формате логин:пароль.' }
      return { body: { if_version: version, credentials: { username: creds.username, password: creds.password } } }
    }
    return { hint: '' }
  }

  function matchChoice(text, options) {
    const s = String(text || '').trim().toLowerCase()
    if (!s || !Array.isArray(options) || !options.length) return ''
    const num = s.match(/(\d+)/)
    if (num) {
      const idx = Number(num[1]) - 1
      if (idx >= 0 && idx < options.length) return options[idx].id
    }
    for (const o of options) {
      const label = pickI18n(o.label, 'ru').toLowerCase()
      const labelEn = pickI18n(o.label, 'en').toLowerCase()
      if ((label && s.includes(label)) || (labelEn && s.includes(labelEn))) return o.id
    }
    return ''
  }

  const runFlow = async function processSingleSwizzyerFlowInner(chatId, token, userAgent, viewerUsername, nowTs) {
    const tokenHash = token
    const flowMap = autolistGetSwizzyerFlowMap(tokenHash)
    const state = flowMap[String(chatId)]
    if (!state || !state.active) {
      return { ran: false, action: 'skipped', reason: 'flow_inactive', chatId: String(chatId) }
    }

    const cfg = state.cfg && typeof state.cfg === 'object' ? state.cfg : {}
    const dealId = state.dealId || null
    const denomination = getSwizzyerDenomination(cfg.denominationId)
    const items = getSwizzyerItems(cfg.denominationId)

    if (!cfg.enabled || !items || !items.length) {
      save(flowMap, chatId, state, nowTs, { active: false })
      return { ran: true, action: 'skipped', reason: 'no_config', chatId: String(chatId) }
    }

    const apiKey = typeof loadSwizzyerApiKeyPlain === 'function' ? loadSwizzyerApiKeyPlain(state.userId) : ''
    if (!apiKey) {
      return { ran: true, action: 'skipped', reason: 'no_api_key', chatId: String(chatId) }
    }

    const askCredentialsMessage =
      normText(cfg.askCredentialsMessage) ||
      'Для выдачи Robux пришлите, пожалуйста, логин и пароль от вашего Roblox-аккаунта одним сообщением в формате:\nлогин:пароль'
    const invalidCredentialsMessage =
      normText(cfg.invalidCredentialsMessage) ||
      'Не разобрал логин и пароль. Пришлите их одним сообщением в формате логин:пароль.'
    const successMessageTpl =
      normText(cfg.successMessage) || 'Готово! ✅ {robux} Robux зачислены на аккаунт {username}. Спасибо за покупку!'
    const failMessage =
      normText(cfg.failMessage) ||
      'Не удалось завершить выдачу. Проверьте, пожалуйста, данные и напишите продавцу — поможем вручную.'

    const fillTpl = (tpl, username) =>
      String(tpl || '')
        .split('{robux}').join(String(denomination?.robux ?? ''))
        .split('{username}').join(String(username || state.username || ''))
        .split('{premium}').join(denomination?.premium ? 'Premium + ' : '')

    try {
      const chatData = await fetchDealChatMessagesFromPlayerok(token, userAgent, dealId, chatId, {
        viewerUsername: viewerUsername || null,
      })
      const messages = Array.isArray(chatData?.messages) ? chatData.messages : []
      const viewer = viewerUsername || chatData?.viewerUsername || null
      const effectiveDealId = resolveEffectiveDealIdForChat({ dealIdFromRequest: dealId, messages }) || dealId
      const redeemDealKey = dealId || effectiveDealId || null

      // Возврат сделки — прекращаем всё (списанный заказ Swizzyer довыдаст сам по
      // recovery-пути, отменить мы его уже не можем; un-charge невозможен).
      if (isDealRefunded(chatData?.dealStatus)) {
        save(flowMap, chatId, state, nowTs, { active: false, stage: 'aborted_refund', password: '' })
        return { ran: true, action: 'skipped_refund', chatId: String(chatId), dealId }
      }

      // Уже выдано (персистентный журнал) — ничего не делаем.
      if (redeemDealKey && swizzyerDealWasDelivered(state.userId, chatId, redeemDealKey)) {
        save(flowMap, chatId, state, nowTs, { active: false, stage: 'done', password: '', redeemed: true })
        return { ran: true, action: 'skipped_already_delivered', chatId: String(chatId), dealId }
      }

      // Резюм после перезапуска: order_id потерян в памяти, но есть в БД.
      if (!state.orderId) {
        const durable = getSwizzyerOrderByDeal(state.userId, redeemDealKey)
        if (durable && durable.order_id) {
          save(flowMap, chatId, state, nowTs, {
            orderId: durable.order_id,
            stage: 'verifying',
            actionType: 'wait',
            lastPollTs: 0,
            username: durable.roblox_username || state.username || '',
          })
          state.orderId = durable.order_id
          state.stage = 'verifying'
          state.actionType = 'wait'
        }
      }

      const idemCreate = `swz-order-${state.userId}-${redeemDealKey || chatId}`

      // Финализаторы.
      const finishSuccess = async (orderPayload) => {
        const username =
          (orderPayload && orderPayload.roblox_username) || state.username || ''
        if (redeemDealKey) {
          upsertSwizzyerOrder(state.userId, redeemDealKey, {
            chatId: String(chatId),
            orderId: state.orderId || null,
            status: extractSwizzyerStatus(orderPayload) || 'completed',
            robloxUsername: username || null,
          })
        }
        const successMessage = fillTpl(successMessageTpl, username)
        const already = sellerMessageTsByPrefix(messages, successMessage, viewer, toUnixTs)
        if (!already) await sendChat(token, userAgent, chatId, successMessage, 'swizzyer-success')

        let autoCompleteDealDone = false
        if (cfg.autoCompleteDeal && (effectiveDealId || dealId) && typeof updateDealStatus === 'function') {
          try {
            await withRetry(() => updateDealStatus(token, userAgent, effectiveDealId || dealId, 'SENT'), {
              label: 'updateDealStatus(swizzyer autoComplete)',
              retries: 2,
              shouldRetry: isPlayerokRateLimitError,
            })
            autoCompleteDealDone = true
          } catch (err) {
            logApprouteAutodelivery('swizzyer: auto-complete failed', {
              chatId: String(chatId),
              dealId,
              error: err?.message || String(err),
            })
          }
        }
        if (redeemDealKey) {
          try {
            swizzyerMarkDealDelivered(state.userId, chatId, redeemDealKey, nowTs)
          } catch (_) {}
        }
        save(flowMap, chatId, state, nowTs, { stage: 'done', active: false, password: '', redeemed: true })
        logApprouteAutodelivery('swizzyer: completed', { chatId: String(chatId), dealId, autoCompleteDealDone })
        return { ran: true, action: 'delivered', chatId: String(chatId), dealId, autoCompleteDealDone }
      }

      const finishFail = async (reasonCode, customMsg) => {
        if (redeemDealKey) {
          upsertSwizzyerOrder(state.userId, redeemDealKey, {
            chatId: String(chatId),
            orderId: state.orderId || null,
            status: 'failed',
            failureCode: reasonCode || null,
          })
        }
        await sendChat(token, userAgent, chatId, customMsg || failMessage, 'swizzyer-fail')
        save(flowMap, chatId, state, nowTs, { stage: 'failed', active: false, password: '' })
        logApprouteAutodelivery('swizzyer: failed', { chatId: String(chatId), dealId, reasonCode: reasonCode || null })
        return { ran: true, action: 'failed', reason: reasonCode || 'failed', chatId: String(chatId), dealId }
      }

      // Применяет ответ create/respond/GET: терминал → финал; next_action → подсказка/опрос.
      const applyPayload = async (payload, { postPrompt = true } = {}) => {
        const status = extractSwizzyerStatus(payload)
        if (isSwizzyerTerminalStatus(status)) {
          if (isSwizzyerSuccessStatus(status)) return finishSuccess(payload)
          const fr = payload && payload.failure_reason
          const reasonCode = fr && fr.code ? String(fr.code) : status
          return finishFail(reasonCode)
        }
        const next = extractSwizzyerNextAction(payload)
        if (!next) {
          // Заказ в обработке без подсказки — опрашиваем.
          save(flowMap, chatId, state, nowTs, { stage: 'verifying', actionType: 'wait', lastPollTs: nowTs })
          return { ran: true, action: 'processing', chatId: String(chatId), dealId }
        }
        const type = String(next.type || '')
        const version = Number(next.version || state.version || 1)

        if (type === 'wait') {
          save(flowMap, chatId, state, nowTs, { stage: 'verifying', actionType: 'wait', version, lastPollTs: nowTs })
          return { ran: true, action: 'waiting', chatId: String(chatId), dealId }
        }
        if (type === 'push_approval') {
          if (postPrompt) {
            await sendChat(token, userAgent, chatId, buildPromptText(next, cfg), 'swizzyer-push')
          }
          save(flowMap, chatId, state, nowTs, {
            stage: 'verifying',
            actionType: 'push_approval',
            version,
            promptMsgTs: nowTs,
            lastPollTs: nowTs,
          })
          return { ran: true, action: 'push_approval', chatId: String(chatId), dealId }
        }
        // Типы, требующие ответа покупателя.
        if (postPrompt) {
          await sendChat(token, userAgent, chatId, buildPromptText(next, cfg), `swizzyer-prompt-${type}`)
        }
        save(flowMap, chatId, state, nowTs, {
          stage: 'verifying',
          actionType: type,
          inputFormat: String(next.input?.format || ''),
          options: Array.isArray(next.options) ? next.options : [],
          prompt: next.prompt || null,
          attempt: Number(next.attempt || 0),
          maxAttempts: Number(next.max_attempts || 0),
          emailHint: next.email_hint || '',
          version,
          promptMsgTs: nowTs,
        })
        return { ran: true, action: `prompt_${type}`, chatId: String(chatId), dealId }
      }

      // ─── Стадия 1: сбор логина/пароля и создание заказа ──────────────────
      if (!state.orderId) {
        let askTs = Number(state.askMsgTs || 0)
        if (!askTs) {
          askTs = sellerMessageTsByPrefix(messages, askCredentialsMessage, viewer, toUnixTs)
          if (!askTs) {
            await sendChat(token, userAgent, chatId, askCredentialsMessage, 'swizzyer-ask-creds')
            save(flowMap, chatId, state, nowTs, { stage: 'await_credentials', askMsgTs: nowTs })
            return { ran: true, action: 'asked_credentials', chatId: String(chatId), dealId }
          }
          save(flowMap, chatId, state, nowTs, { stage: 'await_credentials', askMsgTs: askTs })
        }

        // Транзиентный ретрай создания (429/503/timeout/concurrent) с троттлингом.
        if (state.stage === 'await_create_retry') {
          const lastTry = Number(state.lastCreateTs || 0)
          if (nowTs - lastTry < SWIZZYER_CREATE_RETRY_SEC && state.password) {
            return { ran: true, action: 'waiting_create_retry', chatId: String(chatId), dealId }
          }
        }

        let creds = null
        if (state.password && state.username) {
          creds = { username: state.username, password: state.password }
        } else {
          const buyer = latestBuyerMessageAfter(messages, askTs, viewer, toUnixTs)
          if (!buyer) {
            return { ran: true, action: 'waiting_credentials', chatId: String(chatId), dealId }
          }
          creds = parseRobloxCredentials(buyer.message.text)
          if (!creds) {
            await sendChat(token, userAgent, chatId, invalidCredentialsMessage, 'swizzyer-invalid-creds')
            save(flowMap, chatId, state, nowTs, { stage: 'await_credentials', askMsgTs: nowTs })
            return { ran: true, action: 'credentials_invalid', chatId: String(chatId), dealId }
          }
        }

        // Мутируем in-place: иначе транзиентный сбой create (save со стейл-базы)
        // потеряет креды, и ретрай не сможет повторить заказ из памяти.
        state.username = creds.username
        state.password = creds.password
        // Защита от двойного создания внутри процесса.
        save(flowMap, chatId, state, nowTs, {
          stage: 'creating',
          username: creds.username,
          password: creds.password,
          lastCreateTs: nowTs,
        })
        try {
          const created = await createSwizzyerOrder(apiKey, {
            mode: 'conversational',
            credentials: creds,
            items,
            language: 'ru',
            metadata: { external_deal_id: String(redeemDealKey || ''), chat_id: String(chatId) },
            idempotencyKey: idemCreate,
          })
          const orderId = created && created.id ? String(created.id) : ''
          if (!orderId) throw new Error('Swizzyer create-order did not return an order id')

          // Мутируем in-place, чтобы последующий applyPayload (который строит
          // следующее состояние из `state`) гарантированно нёс orderId и пустой пароль.
          state.orderId = orderId
          state.username = creds.username
          state.password = ''
          state.stage = 'verifying'
          state.version = 1
          if (redeemDealKey) {
            upsertSwizzyerOrder(state.userId, redeemDealKey, {
              chatId: String(chatId),
              orderId,
              denominationId: cfg.denominationId,
              robloxUsername: creds.username,
              status: extractSwizzyerStatus(created) || 'requires_action',
            })
          }
          // Пароль больше не нужен — стираем из памяти.
          save(flowMap, chatId, state, nowTs, { orderId, password: '', stage: 'verifying', version: 1 })
          logApprouteAutodelivery('swizzyer: order created', {
            chatId: String(chatId),
            dealId,
            orderId,
            denominationId: cfg.denominationId,
          })
          return await applyPayload(created, { postPrompt: true })
        } catch (err) {
          // Концуррентный лимит / транзиент — повторим позже, креды держим.
          if (
            isSwizzyerErrorCode(err, 'buyer_concurrent_orders_limit_exceeded') ||
            isSwizzyerTransientError(err)
          ) {
            save(flowMap, chatId, state, nowTs, { stage: 'await_create_retry', lastCreateTs: nowTs })
            logApprouteAutodelivery('swizzyer: create transient, will retry', {
              chatId: String(chatId),
              dealId,
              code: err?.swizzyerCode || null,
              error: err?.message || String(err),
            })
            return { ran: true, action: 'create_retry', chatId: String(chatId), dealId }
          }
          // Прочее (квота/подписка/невалидный ключ) — сообщаем и закрываем.
          if (isSwizzyerErrorCode(err, 'transactions_quota_exceeded', 'subscription_required', 'subscription_expired')) {
            return finishFail(err.swizzyerCode, failMessage)
          }
          return finishFail(err?.swizzyerCode || 'create_error', failMessage)
        }
      }

      // ─── Стадия 2: ведение 2FA по next_action ────────────────────────────
      // Доп. защита: продавец сам отметил «отправлено»/«подтверждено» → закрываем.
      if (isDealDeliveredOrFinished(chatData?.dealStatus)) {
        save(flowMap, chatId, state, nowTs, { active: false, stage: 'aborted', password: '' })
        return { ran: true, action: 'skipped_deal_done', chatId: String(chatId), dealId }
      }

      const actionType = String(state.actionType || 'wait')

      // Опросные типы — GET /orders/:id (с троттлингом).
      if (actionType === 'wait' || actionType === 'push_approval') {
        // На push_approval покупатель может ничего не писать — опрашиваем.
        const lastPoll = Number(state.lastPollTs || 0)
        if (nowTs - lastPoll < SWIZZYER_POLL_THROTTLE_SEC) {
          return { ran: true, action: 'waiting_poll', chatId: String(chatId), dealId }
        }
        let order
        try {
          order = await getSwizzyerOrder(apiKey, state.orderId)
        } catch (err) {
          if (isSwizzyerErrorCode(err, 'order_not_found')) {
            return finishFail('order_not_found', failMessage)
          }
          save(flowMap, chatId, state, nowTs, { lastPollTs: nowTs })
          return { ran: true, action: 'poll_error', reason: err?.message || String(err), chatId: String(chatId), dealId }
        }
        return await applyPayload(order, { postPrompt: true })
      }

      // Типы, требующие ответа покупателя: ждём сообщение после промпта.
      const promptTs = Number(state.promptMsgTs || 0)
      const buyer = latestBuyerMessageAfter(messages, promptTs, viewer, toUnixTs)
      if (!buyer) {
        // Покупатель молчит — иногда состояние меняется на стороне Swizzyer
        // (истёк шаг и т.п.). Изредка опрашиваем, чтобы поймать терминал/смену шага.
        const lastPoll = Number(state.lastPollTs || 0)
        if (nowTs - lastPoll >= 15) {
          let order = null
          try {
            order = await getSwizzyerOrder(apiKey, state.orderId)
          } catch (_) {
            order = null
          }
          save(flowMap, chatId, state, nowTs, { lastPollTs: nowTs })
          if (order) {
            const status = extractSwizzyerStatus(order)
            if (isSwizzyerTerminalStatus(status)) {
              return applyPayload(order, { postPrompt: true })
            }
            const next = extractSwizzyerNextAction(order)
            // Сервер выдал НОВЫЙ шаг (версия выросла) — пере-спросим.
            if (next && Number(next.version || 0) > Number(state.version || 0)) {
              return applyPayload(order, { postPrompt: true })
            }
          }
        }
        return { ran: true, action: 'waiting_reply', chatId: String(chatId), dealId }
      }

      const currentNextAction = {
        type: actionType,
        input: { format: state.inputFormat || '' },
        options: Array.isArray(state.options) ? state.options : [],
        prompt: state.prompt || null,
      }
      const version = Number(state.version || 1)
      const mapped = buildRespondBody(currentNextAction, buyer.message.text, version)
      if (mapped.hint) {
        await sendChat(token, userAgent, chatId, mapped.hint, 'swizzyer-hint')
        // promptMsgTs двигаем на это сообщение, чтобы ждать СЛЕДУЮЩИЙ ответ.
        save(flowMap, chatId, state, nowTs, { promptMsgTs: nowTs })
        return { ran: true, action: 'hint', chatId: String(chatId), dealId }
      }

      const idemRespond = `swz-resp-${state.orderId}-${version}`
      try {
        const resp = await respondSwizzyerVerification(apiKey, state.orderId, mapped.body, idemRespond)
        return await applyPayload(resp, { postPrompt: true })
      } catch (err) {
        // Версия рассинхронилась — перечитаем заказ и пере-спросим по текущему шагу.
        if (isSwizzyerErrorCode(err, 'verification_state_changed', 'verification_not_ready')) {
          try {
            const order = await getSwizzyerOrder(apiKey, state.orderId)
            return await applyPayload(order, { postPrompt: true })
          } catch (_) {
            return { ran: true, action: 'respond_resync_failed', chatId: String(chatId), dealId }
          }
        }
        if (isSwizzyerErrorCode(err, 'invalid_credentials_exhausted')) {
          return finishFail('invalid_credentials_exhausted', failMessage)
        }
        if (
          isSwizzyerErrorCode(err, 'verification_step_expired', 'verification_session_expired', 'prompt_timeout')
        ) {
          // Шаг/сессия истекли — перечитаем; вероятно терминал.
          try {
            const order = await getSwizzyerOrder(apiKey, state.orderId)
            return await applyPayload(order, { postPrompt: true })
          } catch (_) {
            return finishFail(err.swizzyerCode, failMessage)
          }
        }
        if (isSwizzyerTransientError(err)) {
          save(flowMap, chatId, state, nowTs, { promptMsgTs: Number(state.promptMsgTs || nowTs) })
          return { ran: true, action: 'respond_transient', reason: err?.message || String(err), chatId: String(chatId), dealId }
        }
        return { ran: true, action: 'error', reason: err?.message || String(err), chatId: String(chatId), dealId }
      }
    } catch (err) {
      return { ran: true, action: 'error', reason: err?.message || String(err), chatId: String(chatId), dealId }
    }
  }

  // Глобальный per-(token,chatId) лок: исключает параллельный прогон одного флоу из
  // tick-пути и deal-chat-пути (как в gpt). Без лока возможны двойной /respond и гонки.
  return function processSingleSwizzyerFlow(chatId, token, userAgent, viewerUsername, nowTs) {
    const flowLockKey = `${String(token)}::${String(chatId)}`
    global.__swizzyerFlowInFlight = global.__swizzyerFlowInFlight || new Set()
    if (global.__swizzyerFlowInFlight.has(flowLockKey)) {
      return Promise.resolve({ ran: false, action: 'skipped', reason: 'in_flight', chatId: String(chatId) })
    }
    global.__swizzyerFlowInFlight.add(flowLockKey)
    return Promise.resolve()
      .then(() => runFlow(chatId, token, userAgent, viewerUsername, nowTs))
      .finally(() => {
        global.__swizzyerFlowInFlight.delete(flowLockKey)
      })
  }
}

module.exports = { createProcessSingleSwizzyerFlow, parseRobloxCredentials }
