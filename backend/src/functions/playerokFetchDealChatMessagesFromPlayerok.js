'use strict'

const {
  pickSupercellCategoryFromDeal,
  getSupercellGameByCategory,
  pickBuyerEmailFromFieldsForSupercellDeal,
  pickBuyerEmailFromDeepGraphqlScan,
  collectDeepScanEmailCandidates,
  getLatestPlausibleEmailFromNonViewerMessages,
  resolveEffectiveDealIdForChat,
  logSupercellDebug,
  isEmailValid,
} = require('./supercellHelpers')

function isDealEmailDebugEnabled() {
  const v = String(process.env.PLAYEROK_DEAL_EMAIL_DEBUG || '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

function logDealEmailDebug(label, payload) {
  if (!isDealEmailDebugEnabled()) return
  const ts = new Date().toISOString()
  if (payload !== undefined) {
    console.log(`[PLAYEROK_DEAL_EMAIL_DEBUG] ${ts} ${label}`, payload)
  } else {
    console.log(`[PLAYEROK_DEAL_EMAIL_DEBUG] ${ts} ${label}`)
  }
}

function safeJsonSnippet(value, maxLen = 2000) {
  try {
    const s = JSON.stringify(value)
    if (s.length <= maxLen) return s
    return `${s.slice(0, maxLen)}…(len=${s.length})`
  } catch (e) {
    return `[unserializable: ${e && e.message ? e.message : String(e)}]`
  }
}

function summarizeMessagesForEmailDebug(messages, limit = 15) {
  const list = Array.isArray(messages) ? messages : []
  const tail = list.slice(-Math.max(1, limit))
  return tail.map((m) => ({
    id: m && m.id,
    createdAt: m && m.createdAt,
    username: (m && m.user && (m.user.username || m.user.name)) || null,
    textLen: String((m && m.text) || '').length,
    textPreview: String((m && m.text) || '')
      .slice(0, 160)
      .replace(/\s+/g, ' ')
      .trim(),
    hasAt: String((m && m.text) || '').includes('@'),
    dealId: m && m.dealId,
  }))
}

function categoryHintFromFullDeal(fullDeal) {
  if (!fullDeal || typeof fullDeal !== 'object') return null
  const picked = pickSupercellCategoryFromDeal(fullDeal)
  const s = String(picked || '').trim()
  if (s) return s
  if (typeof fullDeal.category === 'string') {
    const c = fullDeal.category.trim()
    if (c) return c
  }
  return null
}

const MESSAGE_INTERNAL_KEYS = ['dealItemTitle', 'dealItemImageUrl', 'itemCategory']

function stripInternalMessageFields(message) {
  if (!message || typeof message !== 'object') return message
  const out = { ...message }
  for (const k of MESSAGE_INTERNAL_KEYS) {
    if (k in out) delete out[k]
  }
  return out
}

/** PlayerOK иногда отдаёт поля массивом, иногда connection `{ edges: [{ node }] }`. */
function asFieldRowArray(raw) {
  if (raw == null) return []
  if (Array.isArray(raw)) {
    if (
      raw.length > 0 &&
      raw[0] &&
      typeof raw[0] === 'object' &&
      Object.prototype.hasOwnProperty.call(raw[0], 'node')
    ) {
      return raw.map((e) => e && e.node).filter(Boolean)
    }
    return raw
  }
  if (typeof raw === 'object' && Array.isArray(raw.edges)) {
    return raw.edges.map((e) => e && e.node).filter(Boolean)
  }
  return []
}

function pickDealIdFromChatNode(chat) {
  if (!chat || typeof chat !== 'object') return null
  const candidates = [
    chat.deal && chat.deal.id,
    chat.dealId,
    chat.activeDeal && chat.activeDeal.id,
    chat.itemDeal && chat.itemDeal.id,
    chat.lastDeal && chat.lastDeal.id,
  ]
  for (const c of candidates) {
    if (c != null && String(c).trim()) return String(c).trim()
  }
  return null
}

function createFetchDealChatMessagesFromPlayerok({
  requestDealById,
  requestChatById,
  requestChatDealIdPost,
  requestChatMessagesPage,
  extractItemImageUrl,
  extractSupercellEmailFromFields,
  getLatestBuyerEmailFromMessages,
}) {
  if (typeof requestDealById !== 'function') throw new Error('requestDealById must be a function')
  if (requestChatById != null && typeof requestChatById !== 'function') {
    throw new Error('requestChatById must be a function when provided')
  }
  if (requestChatDealIdPost != null && typeof requestChatDealIdPost !== 'function') {
    throw new Error('requestChatDealIdPost must be a function when provided')
  }
  if (typeof requestChatMessagesPage !== 'function') {
    throw new Error('requestChatMessagesPage must be a function')
  }
  if (typeof extractItemImageUrl !== 'function') {
    throw new Error('extractItemImageUrl must be a function')
  }
  if (typeof extractSupercellEmailFromFields !== 'function') {
    throw new Error('extractSupercellEmailFromFields must be a function')
  }
  if (typeof getLatestBuyerEmailFromMessages !== 'function') {
    throw new Error('getLatestBuyerEmailFromMessages must be a function')
  }

  return async function fetchDealChatMessagesFromPlayerok(
    token,
    userAgent,
    dealId,
    chatIdFromDeal,
    opts = {}
  ) {
    const tokenHint =
      token && typeof token === 'string' ? `${token.slice(0, 8)}…(len=${token.length})` : String(token)
    logDealEmailDebug('START', {
      dealId: dealId || null,
      chatIdFromRequest: chatIdFromDeal || null,
      categoryHint: opts.categoryHint || null,
      buyerUsername: opts.buyerUsername || null,
      viewerUsername: opts.viewerUsername || null,
      tokenHint,
    })

    let chatId = chatIdFromDeal || null
    if (!chatId && dealId) {
      try {
        const fullDeal = await requestDealById(token, userAgent, dealId)
        chatId = fullDeal?.chat?.id || fullDeal?.chatId || null
        logDealEmailDebug('resolveChatIdFromDeal', {
          dealId,
          gotChatId: chatId,
          dealTopKeys: fullDeal && typeof fullDeal === 'object' ? Object.keys(fullDeal).sort() : null,
        })
      } catch (err) {
        logDealEmailDebug('resolveChatIdFromDeal:ERROR', {
          dealId,
          message: err && err.message ? String(err.message) : String(err),
        })
        throw err
      }
    }

    if (!chatId) {
      console.warn('[PLAYEROK_DEAL_EMAIL] нет chatId — прерываем загрузку сообщений', {
        dealId: dealId || null,
        chatIdFromDeal: chatIdFromDeal || null,
      })
      return {
        messages: [],
        buyerSupercellEmail: null,
        dealBuyerSupercellEmail: null,
        buyerMessageSupercellEmail: null,
        itemTitle: null,
        itemImageUrl: null,
        itemCategory: null,
      }
    }

    const referer = dealId ? `https://playerok.com/deal/${dealId}` : undefined
    const allMessages = []
    let afterCursor = null
    const maxPages = 10
    let pageCount = 0

    do {
      const page = await requestChatMessagesPage(
        token,
        userAgent,
        chatId,
        afterCursor,
        24,
        { referer }
      )
      allMessages.push(...(page.messages || []))
      afterCursor = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null
      pageCount++
    } while (afterCursor && pageCount < maxPages)

    logDealEmailDebug('chatMessages:loaded', {
      chatId,
      pages: pageCount,
      messageCount: allMessages.length,
      tail: summarizeMessagesForEmailDebug(allMessages, 12),
    })

    let hintTitle = null
    let hintImage = null
    let hintCategory = null
    for (const m of allMessages) {
      if (!hintTitle && m.dealItemTitle) hintTitle = m.dealItemTitle
      if (!hintImage && m.dealItemImageUrl) hintImage = m.dealItemImageUrl
      if (!hintCategory && m.itemCategory) hintCategory = m.itemCategory
    }

    const categoryFromChatList =
      typeof opts.categoryHint === 'string' && opts.categoryHint.trim()
        ? opts.categoryHint.trim()
        : null
    if (!hintCategory && categoryFromChatList) hintCategory = categoryFromChatList

    logDealEmailDebug('hints:afterMessagesAndList', {
      hintTitle,
      hintCategory,
      categoryFromChatList,
    })

    // Пытаемся определить сделку и вытащить почту Supercell ID и данные товара.
    // При нескольких сделках в одном чате dealId из списка чатов часто устаревший.
    const dealIdBeforeResolve = dealId || null
    let effectiveDealId = resolveEffectiveDealIdForChat({
      dealIdFromRequest: dealId,
      messages: allMessages,
    })
    if (dealIdBeforeResolve && effectiveDealId && String(dealIdBeforeResolve) !== String(effectiveDealId)) {
      logSupercellDebug('effectiveDealId:overriddenFromMessages', {
        chatId,
        dealIdFromRequest: dealIdBeforeResolve,
        effectiveDealId,
        messageCount: allMessages.length,
      })
      console.warn('[PLAYEROK_DEAL_EMAIL] dealId из списка чатов заменён на актуальный из сообщений', {
        chatId,
        dealIdFromRequest: dealIdBeforeResolve,
        effectiveDealId,
      })
    }
    const refererDealEarly =
      (dealId && String(dealId).trim()) ||
      (effectiveDealId && String(effectiveDealId).trim()) ||
      null
    const chatRefererBase = refererDealEarly
      ? `https://playerok.com/deal/${refererDealEarly}`
      : 'https://playerok.com/chats'

    let cachedChatById = null
    if (!effectiveDealId && chatId && typeof requestChatById === 'function') {
      try {
        cachedChatById = await requestChatById(token, userAgent, chatId, {
          referer: chatRefererBase,
        })
        const fromChat = pickDealIdFromChatNode(cachedChatById)
        if (fromChat) effectiveDealId = fromChat
      } catch (_) {
        // ignore: чат без сделки или временная ошибка API
      }
    }
    if (!effectiveDealId && chatId && typeof requestChatDealIdPost === 'function') {
      try {
        const fromPost = await requestChatDealIdPost(token, userAgent, chatId)
        if (fromPost) effectiveDealId = fromPost
      } catch (_) {
        // ignore
      }
    }

    logDealEmailDebug('effectiveDealId:resolved', {
      effectiveDealId,
      hadCachedChatForDealPick: Boolean(cachedChatById),
      chatTopKeys:
        cachedChatById && typeof cachedChatById === 'object'
          ? Object.keys(cachedChatById).sort()
          : null,
    })

    let dealBuyerSupercellEmail = null
    let dealBuyerUsername = null
    let itemTitle = hintTitle || null
    let itemImageUrl = hintImage || null
    let itemCategory = hintCategory || null
    let supercellGameForEmail =
      getSupercellGameByCategory(itemCategory) || getSupercellGameByCategory(hintCategory)

    logDealEmailDebug('supercellGame:initial', {
      supercellGameForEmail: Boolean(supercellGameForEmail),
      itemCategory,
      hintCategory,
    })

    if (effectiveDealId) {
      try {
        const fullDeal = await requestDealById(token, userAgent, effectiveDealId)
        logDealEmailDebug('requestDealById:ok', {
          effectiveDealId,
          fullDealIsNull: fullDeal == null,
          topKeys: fullDeal && typeof fullDeal === 'object' ? Object.keys(fullDeal).sort() : [],
          itemKeys:
            fullDeal && fullDeal.item && typeof fullDeal.item === 'object'
              ? Object.keys(fullDeal.item).sort()
              : [],
        })

        const item = fullDeal && fullDeal.item ? fullDeal.item : null
        if (fullDeal?.buyer && typeof fullDeal.buyer === 'object') {
          const bu = fullDeal.buyer.username || fullDeal.buyer.name
          if (bu) dealBuyerUsername = String(bu).trim()
        }
        itemTitle =
          (item && (item.title || item.name)) || fullDeal?.productTitle || itemTitle
        itemImageUrl = extractItemImageUrl(item) || itemImageUrl
        const fromDeal = categoryHintFromFullDeal(fullDeal)
        if (fromDeal) itemCategory = fromDeal

        const fieldArrays = []
        const fieldSources = []
        const pushFieldArr = (a, label) => {
          const list = asFieldRowArray(a)
          if (list.length) {
            fieldArrays.push(list)
            fieldSources.push({ label, count: list.length })
          }
        }
        pushFieldArr(fullDeal?.obtainingFields, 'fullDeal.obtainingFields')
        pushFieldArr(fullDeal?.dataFields, 'fullDeal.dataFields')
        pushFieldArr(fullDeal?.obtainingFieldValues, 'fullDeal.obtainingFieldValues')
        pushFieldArr(fullDeal?.formFields, 'fullDeal.formFields')
        pushFieldArr(fullDeal?.userInputs, 'fullDeal.userInputs')
        if (fullDeal?.obtaining && typeof fullDeal.obtaining === 'object') {
          pushFieldArr(fullDeal.obtaining.fields, 'fullDeal.obtaining.fields')
          pushFieldArr(fullDeal.obtaining.values, 'fullDeal.obtaining.values')
        }
        pushFieldArr(item?.dataFields, 'item.dataFields')
        pushFieldArr(item?.obtainingFields, 'item.obtainingFields')
        pushFieldArr(item?.fields, 'item.fields')
        pushFieldArr(item?.templateFields, 'item.templateFields')
        if (item?.obtaining && typeof item.obtaining === 'object') {
          pushFieldArr(item.obtaining.fields, 'item.obtaining.fields')
          pushFieldArr(item.obtaining.values, 'item.obtaining.values')
        }
        const fields = fieldArrays.length > 0 ? fieldArrays.flat() : []

        const pickedCat = fullDeal ? pickSupercellCategoryFromDeal(fullDeal) : ''
        supercellGameForEmail =
          getSupercellGameByCategory(pickedCat) ||
          getSupercellGameByCategory(itemCategory) ||
          getSupercellGameByCategory(hintCategory) ||
          getSupercellGameByCategory(categoryFromChatList)

        logDealEmailDebug('deal:fieldsAndCategory', {
          fieldSources,
          fieldsFlatCount: fields.length,
          pickSupercellCategoryFromDeal: pickedCat || null,
          itemCategoryAfterDeal: itemCategory,
          supercellGameForEmail: Boolean(supercellGameForEmail),
          dealBuyerUsername,
        })

        if (fields.length > 0) {
          const sample = fields.slice(0, 6).map((f) => ({
            keys: f && typeof f === 'object' ? Object.keys(f).sort() : [],
            snippet: safeJsonSnippet(f, 700),
          }))
          logDealEmailDebug('deal:fieldsSample', sample)
        }

        const fromExtractSupercell = extractSupercellEmailFromFields(fields)
        dealBuyerSupercellEmail = fromExtractSupercell
        logDealEmailDebug('step:extractSupercellEmailFromFields', { result: fromExtractSupercell })

        if (!dealBuyerSupercellEmail && supercellGameForEmail) {
          const fromPick = pickBuyerEmailFromFieldsForSupercellDeal(fields)
          dealBuyerSupercellEmail = fromPick
          logDealEmailDebug('step:pickBuyerEmailFromFieldsForSupercellDeal', { result: fromPick })
        } else if (!supercellGameForEmail) {
          logDealEmailDebug('step:pickBuyerEmailFromFields SKIPPED', { reason: 'not supercellGameForEmail' })
        }

        if (!dealBuyerSupercellEmail && supercellGameForEmail && fullDeal) {
          let fromTop = null
          for (const k of ['buyerEmail', 'buyerSupercellEmail', 'contactEmail', 'email']) {
            const v = fullDeal[k]
            if (typeof v === 'string' && isEmailValid(v)) {
              fromTop = String(v).trim()
              dealBuyerSupercellEmail = fromTop
              break
            }
          }
          logDealEmailDebug('step:fullDealTopLevelEmailKeys', { result: fromTop })
        }

        if (!dealBuyerSupercellEmail && supercellGameForEmail && fullDeal) {
          const deepInfo = collectDeepScanEmailCandidates(fullDeal)
          const top = deepInfo.candidates.slice(0, 12)
          logDealEmailDebug('step:deepScan(fullDeal)', {
            visitedNodes: deepInfo.visitedNodes,
            truncatedByNodes: deepInfo.truncatedByNodes,
            truncatedByDepth: deepInfo.truncatedByDepth,
            candidateCount: deepInfo.candidates.length,
            topCandidates: top,
          })
          const deep = deepInfo.candidates.length ? deepInfo.candidates[0].email : null
          if (deep) dealBuyerSupercellEmail = deep
          logDealEmailDebug('step:pickBuyerEmailFromDeepGraphqlScan(fullDeal)', { result: deep })
        }
      } catch (err) {
        logDealEmailDebug('requestDealById:FAILED', {
          effectiveDealId,
          message: err && err.message ? String(err.message) : String(err),
        })
        console.warn('[PLAYEROK_DEAL_EMAIL] ошибка загрузки deal', {
          effectiveDealId,
          message: err && err.message ? String(err.message) : String(err),
        })
      }
    } else {
      logDealEmailDebug('skip:requestDealById', { reason: 'no effectiveDealId' })
    }

    const buyerUsernameForMsgs =
      (opts.buyerUsername && String(opts.buyerUsername).trim()) || dealBuyerUsername || null
    logDealEmailDebug('messages:buyerUsernameForMsgs', {
      fromOpts: opts.buyerUsername || null,
      dealBuyerUsername,
      resolved: buyerUsernameForMsgs,
      viewerUsername: opts.viewerUsername || null,
    })

    let buyerMessageSupercellEmail = getLatestBuyerEmailFromMessages(
      allMessages,
      opts.viewerUsername || null,
      buyerUsernameForMsgs
    )
    logDealEmailDebug('step:getLatestBuyerEmailFromMessages', { result: buyerMessageSupercellEmail })

    if (!buyerMessageSupercellEmail && supercellGameForEmail) {
      buyerMessageSupercellEmail = getLatestPlausibleEmailFromNonViewerMessages(
        allMessages,
        opts.viewerUsername || null
      )
      logDealEmailDebug('step:getLatestPlausibleEmailFromNonViewerMessages', {
        result: buyerMessageSupercellEmail,
      })
    }

    const dealEmailLooksValid =
      Boolean(dealBuyerSupercellEmail) &&
      isEmailValid(String(dealBuyerSupercellEmail).trim())
    const msgEmailLooksValid =
      Boolean(buyerMessageSupercellEmail) &&
      isEmailValid(String(buyerMessageSupercellEmail).trim())

    const chatRefererForDeal =
      (effectiveDealId || dealId) && String(effectiveDealId || dealId).trim()
        ? `https://playerok.com/deal/${String(effectiveDealId || dealId).trim()}`
        : chatRefererBase

    if (
      supercellGameForEmail &&
      chatId &&
      typeof requestChatById === 'function' &&
      !dealEmailLooksValid &&
      !msgEmailLooksValid
    ) {
      try {
        const usedCache = Boolean(cachedChatById)
        const fullChat =
          cachedChatById ||
          (await requestChatById(token, userAgent, chatId, { referer: chatRefererForDeal }))
        cachedChatById = fullChat
        logDealEmailDebug('requestChatById:forEmail', {
          chatId,
          usedCache,
          chatTopKeys:
            fullChat && typeof fullChat === 'object' ? Object.keys(fullChat).sort() : [],
        })
        const chatDeep = collectDeepScanEmailCandidates(fullChat)
        logDealEmailDebug('step:deepScan(fullChat)', {
          visitedNodes: chatDeep.visitedNodes,
          truncatedByNodes: chatDeep.truncatedByNodes,
          truncatedByDepth: chatDeep.truncatedByDepth,
          candidateCount: chatDeep.candidates.length,
          topCandidates: chatDeep.candidates.slice(0, 12),
        })
        const fromChat =
          chatDeep.candidates.length > 0 ? chatDeep.candidates[0].email : null
        if (fromChat) dealBuyerSupercellEmail = fromChat
        logDealEmailDebug('step:pickBuyerEmailFromDeepGraphqlScan(fullChat)', { result: fromChat })
      } catch (err) {
        logDealEmailDebug('requestChatById:forEmail:FAILED', {
          chatId,
          message: err && err.message ? String(err.message) : String(err),
        })
        console.warn('[PLAYEROK_DEAL_EMAIL] ошибка загрузки chat для почты', {
          chatId,
          message: err && err.message ? String(err.message) : String(err),
        })
      }
    }

    const dealEmailTrimmed = dealBuyerSupercellEmail ? String(dealBuyerSupercellEmail).trim() : ''
    const msgEmailTrimmed = buyerMessageSupercellEmail
      ? String(buyerMessageSupercellEmail).trim()
      : ''
    let buyerSupercellEmail = null
    if (isEmailValid(dealEmailTrimmed)) {
      buyerSupercellEmail = dealEmailTrimmed
    } else if (isEmailValid(msgEmailTrimmed)) {
      buyerSupercellEmail = msgEmailTrimmed
    } else {
      buyerSupercellEmail = dealEmailTrimmed || msgEmailTrimmed || null
    }

    logDealEmailDebug('FINAL:merge', {
      dealBuyerSupercellEmail,
      buyerMessageSupercellEmail,
      dealEmailTrimmed,
      msgEmailTrimmed,
      buyerSupercellEmail,
      dealValid: isEmailValid(dealEmailTrimmed),
      msgValid: isEmailValid(msgEmailTrimmed),
    })

    if (supercellGameForEmail && !buyerSupercellEmail) {
      console.warn('[PLAYEROK_DEAL_EMAIL_MISSING] Supercell-чат, почта не найдена после всех шагов', {
        chatId,
        effectiveDealId: effectiveDealId || null,
        categoryFromChatList: categoryFromChatList || null,
        hintCategory: hintCategory || null,
        itemCategory: itemCategory || null,
        dealBuyerSupercellEmail,
        buyerMessageSupercellEmail,
        messageCount: allMessages.length,
        buyerUsernameForMsgs,
        viewerUsername: opts.viewerUsername || null,
        hint:
          'Включите подробные логи: в .env или окружении задайте PLAYEROK_DEAL_EMAIL_DEBUG=1 и перезапустите сервер.',
      })
    }

    const messages = allMessages.map(stripInternalMessageFields)

    logDealEmailDebug('DONE', {
      buyerSupercellEmail,
      itemTitle,
      itemCategory,
    })

    return {
      messages,
      buyerSupercellEmail,
      dealBuyerSupercellEmail,
      buyerMessageSupercellEmail,
      itemTitle,
      itemImageUrl,
      itemCategory,
    }
  }
}

module.exports = { createFetchDealChatMessagesFromPlayerok }

