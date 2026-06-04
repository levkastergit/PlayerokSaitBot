'use strict'

const fs = require('fs')
const { resolveEffectiveDealIdForChat, scopeMessagesToDeal } = require('../../functions/supercellHelpers')
const { toUnixTs: defaultToUnixTs } = require('../../functions/toUnixTs')
const { automessageImagePath, EXT_TO_MIME } = require('../../http/dispatchAutomessageImage')
const {
  buildPostPurchaseAutomessageEventKey,
  buildDealConfirmedAutomessageEventKey,
  buildPurchaseWindowAutomessageEventKey,
  buildImageAutomessageEventKey,
  buildOrderedStageStepEventKey,
  tryBeginChatAutomessageSend,
  finishChatAutomessageSend,
  autolistMarkProcessed,
  autolistWasAutomessageSent,
  autolistMarkAutomessageSent,
  CHAT_AUTOMESSAGE_MAX_TRIGGER_AGE_SEC,
} = require('./autolistState')

const ITEM_PAID_MARKER = '{{ITEM_PAID}}'
const ITEM_SENT_MARKER = '{{ITEM_SENT}}'
const DEAL_CONFIRMED_MARKERS = ['{{DEAL_CONFIRMED}}', '{{DEAL_CONFIRMED_AUTOMATICALLY}}']

// Окно времени автосообщения по покупке считаем в МСК (Europe/Moscow, UTC+3),
// как и расписание автоподнятия — независимо от часового пояса сервера.
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000

/** "HH:MM" -> минуты от начала суток, либо null если формат неверный. */
function parseHmToMinutes(value) {
  const s = String(value == null ? '' : value).trim()
  const m = /^(\d{1,2}):(\d{2})$/.exec(s)
  if (!m) return null
  const h = parseInt(m[1], 10)
  const min = parseInt(m[2], 10)
  if (!(h >= 0 && h <= 23) || !(min >= 0 && min <= 59)) return null
  return h * 60 + min
}

/**
 * Покупка (момент маркера {{ITEM_PAID}}) попала в окно [start, end) по МСК?
 * Поддерживает окна через полночь (start > end). Пустое окно (start === end) — нет.
 */
function isWithinPurchaseWindow(cfg, triggerTs) {
  const ts = Number(triggerTs)
  if (!Number.isFinite(ts) || ts <= 0) return false
  const start = parseHmToMinutes(cfg?.start)
  const end = parseHmToMinutes(cfg?.end)
  if (start == null || end == null || start === end) return false
  const msk = new Date(ts * 1000 + MSK_OFFSET_MS)
  const mins = msk.getUTCHours() * 60 + msk.getUTCMinutes()
  return start < end ? mins >= start && mins < end : mins >= start || mins < end
}

function messageDealIdForMarkerMatch(m) {
  if (m?.dealId != null) return String(m.dealId).trim()
  if (m?.deal?.id != null) return String(m.deal.id).trim()
  return ''
}

function findLatestSystemMarkerMessage(messages, dealId, markers) {
  const targetDealId = dealId != null ? String(dealId).trim() : ''
  const markerList = Array.isArray(markers) ? markers : []
  if (markerList.length === 0) return null

  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i]
    const text = String(m?.text || '')
    if (!markerList.some((marker) => text.includes(marker))) continue
    if (targetDealId) {
      const msgDealId = messageDealIdForMarkerMatch(m)
      if (msgDealId && msgDealId !== targetDealId) continue
    }
    return m
  }
  return null
}

function hasSystemMarkerForDeal(messages, dealId, markers) {
  return findLatestSystemMarkerMessage(messages, dealId, markers) != null
}

function getSystemMarkerTriggerUnixTs(messages, dealId, markers, toUnixTsFn = defaultToUnixTs) {
  const tu = typeof toUnixTsFn === 'function' ? toUnixTsFn : defaultToUnixTs
  const m = findLatestSystemMarkerMessage(messages, dealId, markers)
  if (!m) return 0
  return tu(m.createdAt) || 0
}

function hasSellerMessageText(messages, text, _viewerUsername) {
  const expected = String(text || '').trim()
  if (!expected) return false
  const list = Array.isArray(messages) ? messages : []
  return list.some((msg) => String(msg?.text || '').trim() === expected)
}

function automessageTextsFromConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return []
  const raw = cfg.messages
  if (Array.isArray(raw)) {
    return raw.map((m) => String(m).trim()).filter(Boolean)
  }
  const legacy = String(cfg.message || '').trim()
  if (legacy) return [legacy]
  if (typeof raw === 'string' && raw.trim()) {
    return raw.split('\n').map((line) => line.trim()).filter(Boolean)
  }
  return []
}

function delayMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const ORDERED_STAGE_META = {
  purchase: {
    markers: [ITEM_PAID_MARKER],
    textField: 'automessage',
    legacyTextKind: 'lot_automessage',
  },
  sent: {
    markers: [ITEM_SENT_MARKER],
    textField: 'postPurchaseAutomessage',
    legacyTextKind: 'post_purchase',
  },
  confirmed: {
    markers: DEAL_CONFIRMED_MARKERS,
    textField: 'dealConfirmedAutomessage',
    legacyTextKind: 'deal_confirmed',
  },
}

function stageHasTimeBlock(settings) {
  return Boolean(settings?.purchaseWindowAutomessage?.enabled)
}

function stageTextMessagesForOrder(stage, settings) {
  if (!settings) return []
  if (stage === 'purchase') {
    return Array.isArray(settings.automessage?.messages) ? settings.automessage.messages : []
  }
  if (stage === 'sent') {
    return Array.isArray(settings.postPurchaseAutomessage?.messages)
      ? settings.postPurchaseAutomessage.messages
      : []
  }
  if (stage === 'confirmed') {
    return Array.isArray(settings.dealConfirmedAutomessage?.messages)
      ? settings.dealConfirmedAutomessage.messages
      : []
  }
  return []
}

function imageAutomessageEntriesForStage(items, stage) {
  return (Array.isArray(items) ? items : [])
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => (row?.trigger ?? 'purchase') === stage)
}

function dedupePlacementOrder(order) {
  const seen = new Set()
  return order.filter((key) => {
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function buildPlacementOrderForStage(stage, settings) {
  if (!settings) return []
  const order = []
  stageTextMessagesForOrder(stage, settings).forEach((_, i) => order.push(`t:${i}`))
  if (stage === 'purchase' && stageHasTimeBlock(settings)) order.push('w')
  imageAutomessageEntriesForStage(settings.imageAutomessage?.items, stage).forEach(({ index }) => {
    order.push(`i:${index}`)
  })
  return order
}

function mergePlacementOrder(prevOrder, builtOrder) {
  const builtSet = new Set(builtOrder)
  const kept = (prevOrder || []).filter((k) => builtSet.has(k))
  const keptSet = new Set(kept)
  const added = builtOrder.filter((k) => !keptSet.has(k))
  return [...kept, ...added]
}

function getStagePlacementOrder(stage, settings) {
  const built = buildPlacementOrderForStage(stage, settings)
  const stored = settings?.autoPlacementOrder?.[stage]
  if (!Array.isArray(stored) || stored.length === 0) return built
  return mergePlacementOrder(stored, built)
}

function orderedStepPersistKind(stage, placeKey) {
  return `ordered:${stage}:${placeKey}`
}

function wasLegacyOrderedStepSent(userId, chatId, dealId, stage, placeKey, settings) {
  if (placeKey.startsWith('t:')) {
    const legacyKind = ORDERED_STAGE_META[stage]?.legacyTextKind
    if (legacyKind && autolistWasAutomessageSent(userId, chatId, dealId, legacyKind)) {
      return true
    }
  }
  if (placeKey === 'w' && stage === 'purchase') {
    if (autolistWasAutomessageSent(userId, chatId, dealId, 'purchase_window')) {
      return true
    }
  }
  if (placeKey.startsWith('i:')) {
    const idx = parseInt(placeKey.slice(2), 10)
    const items = settings?.imageAutomessage?.items
    const row = Array.isArray(items) ? items[idx] : null
    const imageId = row && String(row.imageId || '').trim()
    if (imageId) {
      const imgKind = 'image:' + imageId
      if (autolistWasAutomessageSent(userId, chatId, dealId, imgKind)) {
        return true
      }
    }
  }
  return false
}

function resolveOrderedStageSteps(stage, settings) {
  const order = dedupePlacementOrder(getStagePlacementOrder(stage, settings))
  const steps = []
  const texts = stageTextMessagesForOrder(stage, settings)
  const items = settings?.imageAutomessage?.items

  for (const placeKey of order) {
    if (placeKey.startsWith('t:')) {
      const cfg = settings[ORDERED_STAGE_META[stage]?.textField]
      if (!cfg?.enabled) continue
      const idx = parseInt(placeKey.slice(2), 10)
      const text = texts[idx]
      const trimmed = text != null ? String(text).trim() : ''
      if (!trimmed) continue
      steps.push({ placeKey, type: 'text', text: trimmed })
    } else if (placeKey === 'w' && stage === 'purchase') {
      const cfg = settings.purchaseWindowAutomessage
      if (!cfg?.enabled) continue
      const trimmed = String(cfg.message || '').trim()
      if (!trimmed) continue
      steps.push({ placeKey, type: 'window', text: trimmed, windowCfg: cfg })
    } else if (placeKey.startsWith('i:')) {
      const imgCfg = settings.imageAutomessage
      if (!imgCfg?.enabled) continue
      const idx = parseInt(placeKey.slice(2), 10)
      const row = Array.isArray(items) ? items[idx] : null
      if (!row || (row.trigger ?? 'purchase') !== stage) continue
      const imageId = String(row.imageId || '').trim()
      const ext = String(row.ext || '').trim()
      if (!imageId || !ext) continue
      steps.push({
        placeKey,
        type: 'image',
        imageId,
        ext,
        filename: String(row.filename || '').trim(),
      })
    }
  }

  return steps
}

function lastMessageHasAnyMarker(text, markers) {
  const value = String(text || '')
  return (Array.isArray(markers) ? markers : []).some((marker) => value.includes(marker))
}

function messagesForDealAutomessage(messages, dealId) {
  const requested = dealId != null ? String(dealId).trim() : ''
  const list = Array.isArray(messages) ? messages : []
  if (!requested) return list
  return scopeMessagesToDeal(list, requested)
}

async function runChatAutomessage({
  kind,
  settingsField,
  systemMarkers,
  buildEventKey,
  logLabel,
  currentUserId,
  tokenHash,
  token,
  userAgent,
  nowTs,
  chatId,
  dealId,
  dealItemId,
  messages,
  itemTitle,
  itemCategory,
  viewerUsername,
  withRetry,
  isPlayerokRateLimitError,
  requestDealById,
  requestItemById,
  resolveEffectiveProductSettings,
  createChatMessage,
  normalizeKeyPart,
  buildProductKey,
  toUnixTs = defaultToUnixTs,
  shouldSendForConfig = null,
}) {
  if (!token || !chatId) return { sent: false, reason: 'missing_chat' }

  const dealScopedMessages = messagesForDealAutomessage(messages, dealId)

  const effectiveDealId = resolveEffectiveDealIdForChat({
    dealIdFromRequest: dealId,
    messages: dealScopedMessages,
  })
  const eventKey = buildEventKey(chatId, effectiveDealId)
  if (!eventKey) return { sent: false, reason: 'no_event_key' }

  if (!hasSystemMarkerForDeal(dealScopedMessages, effectiveDealId || null, systemMarkers)) {
    return { sent: false, reason: 'no_system_marker' }
  }

  const effectiveNowTs = Number(nowTs) > 0 ? Number(nowTs) : Math.floor(Date.now() / 1000)
  const triggerTs = getSystemMarkerTriggerUnixTs(
    dealScopedMessages,
    effectiveDealId || null,
    systemMarkers,
    toUnixTs
  )
  if (
    triggerTs > 0 &&
    effectiveNowTs - triggerTs > CHAT_AUTOMESSAGE_MAX_TRIGGER_AGE_SEC
  ) {
    autolistMarkProcessed(tokenHash, eventKey, effectiveNowTs)
    return { sent: false, reason: 'trigger_expired' }
  }

  if (!tryBeginChatAutomessageSend(tokenHash, eventKey)) {
    return { sent: false, reason: 'locked_or_processed' }
  }

  let finishSuccess = false

  try {
    let rawTitle = typeof itemTitle === 'string' ? itemTitle.trim() : ''
    let rawGame = typeof itemCategory === 'string' ? itemCategory.trim() : ''

    if (dealItemId || effectiveDealId) {
      try {
        if (dealItemId) {
          const item = await withRetry(() => requestItemById(token, userAgent, dealItemId), {
            label: `itemById(${logLabel})`,
            retries: 2,
            shouldRetry: isPlayerokRateLimitError,
          })
          if (item) {
            rawTitle = rawTitle || item.title || item.name || ''
            if (!rawGame) {
              rawGame =
                typeof item?.game === 'string'
                  ? item.game
                  : (item?.game?.name && typeof item.game.name === 'string' ? item.game.name : '') ||
                    item?.game_name ||
                    ''
            }
          }
        } else if (effectiveDealId) {
          const fullDeal = await withRetry(() => requestDealById(token, userAgent, effectiveDealId), {
            label: `dealById(${logLabel})`,
            retries: 2,
            shouldRetry: isPlayerokRateLimitError,
          })
          const dealItem = fullDeal?.item || null
          if (dealItem) {
            rawTitle = rawTitle || dealItem.title || dealItem.name || ''
            if (!rawGame) {
              rawGame =
                typeof dealItem?.game === 'string'
                  ? dealItem.game
                  : (dealItem?.game?.name && typeof dealItem.game.name === 'string'
                      ? dealItem.game.name
                      : '') || ''
            }
          }
          if (!rawGame && fullDeal && typeof fullDeal.productKey === 'string') {
            const sep = fullDeal.productKey.indexOf('::')
            if (sep > 0) rawGame = fullDeal.productKey.slice(0, sep).trim()
          }
        }
      } catch (err) {
        console.warn(`[${logLabel}] не удалось загрузить товар/сделку`, {
          dealId: effectiveDealId || null,
          dealItemId: dealItemId || null,
          error: err?.message || String(err),
        })
      }
    }

    const title = normalizeKeyPart(rawTitle)
    const game = normalizeKeyPart(rawGame)
    const productKey = buildProductKey(game, title)
    if (!productKey) {
      return { sent: false, reason: 'no_product_key' }
    }

    const { effectiveSettings } = resolveEffectiveProductSettings(currentUserId, productKey)
    const cfg =
      effectiveSettings?.[settingsField] && typeof effectiveSettings[settingsField] === 'object'
        ? effectiveSettings[settingsField]
        : null

    if (!cfg?.enabled) {
      return { sent: false, reason: 'disabled' }
    }

    const textsToSend = automessageTextsFromConfig(cfg)
    if (textsToSend.length === 0) {
      return { sent: false, reason: 'empty_message' }
    }

    // Доп. условие отправки (например, окно времени покупки). Если оно не выполнено —
    // считаем задание выполненным (помечаем processed) и сообщение не отправляем.
    if (typeof shouldSendForConfig === 'function') {
      let pass = false
      try {
        pass = shouldSendForConfig(cfg, { triggerTs, nowTs: effectiveNowTs })
      } catch (_) {
        pass = false
      }
      if (!pass) {
        finishSuccess = true
        return { sent: false, reason: 'condition_not_met' }
      }
    }

    // Персистентный дедуп (журнал в БД): надёжно не даёт повторно отправить это же
    // автосообщение по этой сделке даже после перезапуска / на устаревших сообщениях.
    if (autolistWasAutomessageSent(currentUserId, chatId, effectiveDealId, kind)) {
      finishSuccess = true
      return { sent: false, reason: 'already_sent_persisted' }
    }

    // Дубль ищем ТОЛЬКО в рамках текущей сделки (повторные покупки в одном чате):
    // иначе автосообщение из прошлой сделки покупателя ошибочно считается уже
    // отправленным, и для новой сделки сообщение не уходит.
    const dupScopeMessages = scopeMessagesToDeal(messages, effectiveDealId || null)
    const allAlreadyInChat =
      textsToSend.length > 0 &&
      dupScopeMessages.length > 0 &&
      textsToSend.every((line) => hasSellerMessageText(dupScopeMessages, line, viewerUsername))

    if (allAlreadyInChat) {
      finishSuccess = true
      autolistMarkAutomessageSent(currentUserId, chatId, effectiveDealId, kind, effectiveNowTs)
      return { sent: false, reason: 'already_in_chat' }
    }

    let sentCount = 0
    let failedIndex = -1

    for (let i = 0; i < textsToSend.length; i++) {
      if (
        dupScopeMessages.length > 0 &&
        hasSellerMessageText(dupScopeMessages, textsToSend[i], viewerUsername)
      ) {
        sentCount += 1
        continue
      }
      try {
        await withRetry(
          () => createChatMessage(token, userAgent, String(chatId), textsToSend[i]),
          { label: `createChatMessage(${logLabel})`, retries: 3, shouldRetry: isPlayerokRateLimitError }
        )
        sentCount += 1
        if (i < textsToSend.length - 1) {
          await delayMs(900)
        }
      } catch (sendErr) {
        failedIndex = i
        console.warn(`[${logLabel}] отправка не удалась`, {
          chatId,
          dealId: effectiveDealId || null,
          index: i,
          error: sendErr?.message || String(sendErr),
        })
        break
      }
    }

    finishSuccess = sentCount === textsToSend.length && failedIndex < 0
    if (finishSuccess) {
      autolistMarkAutomessageSent(currentUserId, chatId, effectiveDealId, kind, effectiveNowTs)
    }
    return finishSuccess ? { sent: true, kind } : { sent: false, reason: 'send_failed' }
  } catch (err) {
    console.warn(`[${logLabel}] отправка не удалась`, {
      chatId,
      dealId: effectiveDealId || null,
      error: err?.message || String(err),
    })
    return { sent: false, reason: 'send_failed' }
  } finally {
    finishChatAutomessageSend(tokenHash, eventKey, {
      success: finishSuccess,
      nowTs,
    })
  }
}

async function handleOrderedStageAutomessage(params, stage, options = {}) {
  const meta = ORDERED_STAGE_META[stage]
  if (!meta) return { sent: false, reason: 'unknown_stage' }

  const {
    currentUserId,
    tokenHash,
    token,
    userAgent,
    nowTs,
    chatId,
    dealId,
    dealItemId,
    messages,
    itemTitle,
    itemCategory,
    viewerUsername,
    withRetry,
    isPlayerokRateLimitError,
    requestDealById,
    requestItemById,
    resolveEffectiveProductSettings,
    createChatMessage,
    normalizeKeyPart,
    buildProductKey,
    toUnixTs = defaultToUnixTs,
    sendChatImage,
    automessageImagesDir,
    skipMarkerCheck = false,
  } = params

  const skipMarker = options.skipMarkerCheck === true || skipMarkerCheck === true

  if (!token || !chatId) return { sent: false, reason: 'missing_chat' }

  const dealScopedMessages = messagesForDealAutomessage(messages, dealId)
  const effectiveDealId = resolveEffectiveDealIdForChat({
    dealIdFromRequest: dealId,
    messages: dealScopedMessages,
  })

  if (!skipMarker && !hasSystemMarkerForDeal(dealScopedMessages, effectiveDealId || null, meta.markers)) {
    return { sent: false, reason: 'no_system_marker' }
  }

  const effectiveNowTs = Number(nowTs) > 0 ? Number(nowTs) : Math.floor(Date.now() / 1000)
  const triggerTs = skipMarker
    ? effectiveNowTs
    : getSystemMarkerTriggerUnixTs(
        dealScopedMessages,
        effectiveDealId || null,
        meta.markers,
        toUnixTs
      )

  if (
    !skipMarker &&
    triggerTs > 0 &&
    effectiveNowTs - triggerTs > CHAT_AUTOMESSAGE_MAX_TRIGGER_AGE_SEC
  ) {
    return { sent: false, reason: 'trigger_expired' }
  }

  let rawTitle = typeof itemTitle === 'string' ? itemTitle.trim() : ''
  let rawGame = typeof itemCategory === 'string' ? itemCategory.trim() : ''

  if ((!rawTitle || !rawGame) && (dealItemId || effectiveDealId)) {
    try {
      if (dealItemId) {
        const item = await withRetry(() => requestItemById(token, userAgent, dealItemId), {
          label: `itemById(ordered-${stage})`,
          retries: 2,
          shouldRetry: isPlayerokRateLimitError,
        })
        if (item) {
          rawTitle = rawTitle || item.title || item.name || ''
          if (!rawGame) {
            rawGame =
              typeof item?.game === 'string'
                ? item.game
                : (item?.game?.name && typeof item.game.name === 'string' ? item.game.name : '') ||
                  item?.game_name ||
                  ''
          }
        }
      } else if (effectiveDealId) {
        const fullDeal = await withRetry(() => requestDealById(token, userAgent, effectiveDealId), {
          label: `dealById(ordered-${stage})`,
          retries: 2,
          shouldRetry: isPlayerokRateLimitError,
        })
        const dealItem = fullDeal?.item || null
        if (dealItem) {
          rawTitle = rawTitle || dealItem.title || dealItem.name || ''
          if (!rawGame) {
            rawGame =
              typeof dealItem?.game === 'string'
                ? dealItem.game
                : (dealItem?.game?.name && typeof dealItem.game.name === 'string'
                    ? dealItem.game.name
                    : '') || ''
          }
        }
        if (!rawGame && fullDeal && typeof fullDeal.productKey === 'string') {
          const sep = fullDeal.productKey.indexOf('::')
          if (sep > 0) rawGame = fullDeal.productKey.slice(0, sep).trim()
        }
      }
    } catch (err) {
      console.warn(`[ordered-${stage}-automessage] не удалось загрузить товар/сделку`, {
        dealId: effectiveDealId || null,
        dealItemId: dealItemId || null,
        error: err?.message || String(err),
      })
    }
  }

  const productKey = buildProductKey(normalizeKeyPart(rawGame), normalizeKeyPart(rawTitle))
  if (!productKey) return { sent: false, reason: 'no_product_key' }

  const { effectiveSettings } = resolveEffectiveProductSettings(currentUserId, productKey)
  if (!effectiveSettings) return { sent: false, reason: 'no_settings' }

  const steps = resolveOrderedStageSteps(stage, effectiveSettings)
  if (steps.length === 0) return { sent: false, reason: 'no_steps' }

  const dupScopeMessages = scopeMessagesToDeal(messages, effectiveDealId || null)
  const logLabel = `ordered-${stage}-automessage`

  let sentAny = false
  let lastResult = { sent: false, reason: 'no_steps_sent' }

  for (let si = 0; si < steps.length; si++) {
    const step = steps[si]
    const stepKind = orderedStepPersistKind(stage, step.placeKey)
    const eventKey = buildOrderedStageStepEventKey(stage, chatId, effectiveDealId, step.placeKey)
    if (!eventKey || !tryBeginChatAutomessageSend(tokenHash, eventKey)) {
      continue
    }

    let finishSuccess = false
    let sentThisStep = false

    try {
      const alreadySent =
        autolistWasAutomessageSent(currentUserId, chatId, effectiveDealId, stepKind) ||
        wasLegacyOrderedStepSent(
          currentUserId,
          chatId,
          effectiveDealId,
          stage,
          step.placeKey,
          effectiveSettings
        )

      if (alreadySent) {
        finishSuccess = true
      } else if (step.type === 'text' || step.type === 'window') {
        if (
          step.type === 'window' &&
          !isWithinPurchaseWindow(step.windowCfg, triggerTs)
        ) {
          finishSuccess = false
        } else if (
          dupScopeMessages.length > 0 &&
          hasSellerMessageText(dupScopeMessages, step.text, viewerUsername)
        ) {
          finishSuccess = true
          autolistMarkAutomessageSent(
            currentUserId,
            chatId,
            effectiveDealId,
            stepKind,
            effectiveNowTs
          )
        } else {
          await withRetry(
            () => createChatMessage(token, userAgent, String(chatId), step.text),
            {
              label: `createChatMessage(${logLabel})`,
              retries: 3,
              shouldRetry: isPlayerokRateLimitError,
            }
          )
          autolistMarkAutomessageSent(
            currentUserId,
            chatId,
            effectiveDealId,
            stepKind,
            effectiveNowTs
          )
          sentThisStep = true
          sentAny = true
          finishSuccess = true
          lastResult = { sent: true, kind: stepKind }
        }
      } else if (step.type === 'image') {
        if (typeof sendChatImage !== 'function' || !automessageImagesDir) {
          finishSuccess = false
        } else {
          const filePath = automessageImagePath(
            automessageImagesDir,
            currentUserId,
            step.imageId,
            step.ext
          )
          if (!filePath || !fs.existsSync(filePath)) {
            finishSuccess = true
          } else {
            await withRetry(
              () =>
                sendChatImage(token, userAgent, String(chatId), {
                  filePath,
                  filename: step.filename || `image.${step.ext}`,
                  mime: EXT_TO_MIME[step.ext] || 'image/png',
                }),
              {
                label: `sendChatImage(${logLabel})`,
                retries: 2,
                shouldRetry: isPlayerokRateLimitError,
              }
            )
            autolistMarkAutomessageSent(
              currentUserId,
              chatId,
              effectiveDealId,
              stepKind,
              effectiveNowTs
            )
            sentThisStep = true
            sentAny = true
            finishSuccess = true
            lastResult = { sent: true, kind: stepKind, imageId: step.imageId }
          }
        }
      }
    } catch (err) {
      console.warn(`[${logLabel}] отправка не удалась`, {
        chatId,
        dealId: effectiveDealId || null,
        placeKey: step.placeKey,
        error: err?.message || String(err),
      })
      finishSuccess = false
      lastResult = { sent: false, reason: 'send_failed' }
    } finally {
      finishChatAutomessageSend(tokenHash, eventKey, {
        success: finishSuccess,
        nowTs: effectiveNowTs,
      })
    }

    if (sentThisStep && si < steps.length - 1) {
      await delayMs(900)
    }
  }

  return sentAny ? lastResult : { sent: false, reason: 'no_steps_sent' }
}

async function handlePostPurchaseAutomessage(params) {
  return handleOrderedStageAutomessage(params, 'sent')
}

async function handleDealConfirmedAutomessage(params) {
  return handleOrderedStageAutomessage(params, 'confirmed')
}

async function handlePurchaseWindowAutomessage(params) {
  return handleOrderedStageAutomessage(params, 'purchase')
}

// ── Автосообщение картинкой ──────────────────────────────────────────────────
const IMAGE_TRIGGER_MARKERS = {
  purchase: [ITEM_PAID_MARKER],
  sent: [ITEM_SENT_MARKER],
  confirmed: DEAL_CONFIRMED_MARKERS,
}

function normalizeImageAutomessageItems(cfg) {
  if (!cfg || typeof cfg !== 'object') return []
  if (Array.isArray(cfg.items)) {
    return cfg.items
      .filter((row) => row && typeof row === 'object')
      .map((row, index) => {
        const imageId = String(row.imageId || '').trim()
        const ext = String(row.ext || '').trim()
        if (!imageId || !ext) return null
        const trigger = ['purchase', 'sent', 'confirmed'].includes(row.trigger) ? row.trigger : 'purchase'
        return {
          trigger,
          imageId,
          ext,
          filename: String(row.filename || '').trim(),
          itemKey: imageId || String(index),
        }
      })
      .filter(Boolean)
  }
  const imageId = String(cfg.imageId || '').trim()
  const ext = String(cfg.ext || '').trim()
  if (!imageId || !ext) return []
  const trigger = ['purchase', 'sent', 'confirmed'].includes(cfg.trigger) ? cfg.trigger : 'purchase'
  return [
    {
      trigger,
      imageId,
      ext,
      filename: String(cfg.filename || '').trim(),
      itemKey: imageId,
    },
  ]
}

async function handleImageAutomessage(params) {
  let lastResult = { sent: false, reason: 'no_matching_item' }
  for (const stage of ['purchase', 'sent', 'confirmed']) {
    const r = await handleOrderedStageAutomessage(params, stage)
    if (r?.sent) lastResult = r
  }
  return lastResult
}

module.exports = {
  handleOrderedStageAutomessage,
  handlePostPurchaseAutomessage,
  handleDealConfirmedAutomessage,
  handlePurchaseWindowAutomessage,
  handleImageAutomessage,
  hasSellerMessageText,
  hasSystemMarkerForDeal,
  getSystemMarkerTriggerUnixTs,
  lastMessageHasAnyMarker,
  isWithinPurchaseWindow,
  ITEM_PAID_MARKER,
  ITEM_SENT_MARKER,
  DEAL_CONFIRMED_MARKERS,
}
