'use strict'

const {
  logSupercellDebug,
  resolveEffectiveDealIdForChat,
} = require('./supercellHelpers')
const { isDealRefunded } = require('../features/approute/approuteAutodeliveryGuards')

function createProcessSingleSupercellFlow({
  autolistGetSupercellFlowMap,
  getSupercellGameByCategory,
  fetchDealChatMessagesFromPlayerok,
  hasSupercellCodeRequestedMessage,
  isEmailValid,
  withRetry,
  isPlayerokRateLimitError,
  createChatMessage,
  requestSupercellCodeForChat,
  chatDbRepo = null,
}) {
  const EMAIL_FETCH_RETRIES = 2
  const EMAIL_FETCH_DELAY_MS = 1200

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  const skipResult = (chatId, dealId, reason, extra = {}) => ({
    ran: true,
    action: 'skipped',
    reason,
    chatId: String(chatId),
    dealId: dealId || null,
    category: extra.category || null,
    ...extra,
  })

  return async function processSingleSupercellFlow(chatId, token, userAgent, viewerUsername, nowTs, currentUserId = null) {
    const tokenHash = token
    const flowMap = autolistGetSupercellFlowMap(tokenHash)
    const state = flowMap[String(chatId)]
    if (!state || !state.active) {
      return {
        ran: false,
        action: 'skipped',
        reason: 'flow_inactive',
        chatId: String(chatId),
        dealId: state?.dealId || null,
        category: state?.category || null,
      }
    }

    let category = String(state.category || '').trim()
    const dealId = state.dealId || null
    logSupercellDebug('flow:start', {
      chatId,
      dealId,
      categoryFromState: category,
      requestCodeRequested: Boolean(state.requestCodeRequested),
      hasLatestEmail: Boolean(state.latestEmail),
    })

    try {
      let chatData = null
      let emailFetchAttempt = 0
      let emailRetryReason = null
      for (emailFetchAttempt = 0; emailFetchAttempt <= EMAIL_FETCH_RETRIES; emailFetchAttempt += 1) {
        chatData = await fetchDealChatMessagesFromPlayerok(
          token,
          userAgent,
          dealId,
          chatId,
          { viewerUsername: viewerUsername || null, categoryHint: category || null }
        )
        const categoryFromFetch = String(chatData?.itemCategory || '').trim()
        if (categoryFromFetch && getSupercellGameByCategory(categoryFromFetch)) {
          if (categoryFromFetch !== category) {
            logSupercellDebug('flow:categoryRefreshedFromMessages', {
              chatId,
              previous: category,
              resolved: categoryFromFetch,
            })
          }
          category = categoryFromFetch
        }
        const candidateEmail = String(chatData?.buyerSupercellEmail || '').trim()
        if (candidateEmail) break
        if (emailFetchAttempt < EMAIL_FETCH_RETRIES) {
          emailRetryReason = 'email_missing_from_deal_or_messages'
          await sleep(EMAIL_FETCH_DELAY_MS * (emailFetchAttempt + 1))
        }
      }

      // Возврат/откат сделки — не запрашиваем код у поставщика и ничего не шлём.
      if (isDealRefunded(chatData?.dealStatus)) {
        flowMap[String(chatId)] = { ...state, active: false, updatedAt: nowTs }
        logSupercellDebug('flow:skipRefunded', {
          chatId,
          dealId,
          dealStatus: chatData?.dealStatus || null,
        })
        return skipResult(chatId, dealId, 'deal_refunded', { category })
      }

      const game = getSupercellGameByCategory(category)
      if (!game) {
        logSupercellDebug('flow:skipInvalidCategory', {
          chatId,
          category,
          categoryFromState: state.category,
          itemCategoryFromFetch: chatData?.itemCategory || null,
        })
        flowMap[String(chatId)] = {
          ...state,
          active: false,
          updatedAt: nowTs,
        }
        return skipResult(chatId, dealId, 'invalid_category', { category })
      }

      const messages = Array.isArray(chatData?.messages) ? chatData.messages : []
      const effectiveDealId =
        resolveEffectiveDealIdForChat({
          dealIdFromRequest: dealId,
          messages,
        }) || dealId

      const requestCodeMessageTemplate = String(state.requestCodeMessage || '').trim() || null

      const alreadyRequested = hasSupercellCodeRequestedMessage(
        messages,
        viewerUsername || null,
        game.gameName,
        effectiveDealId,
        requestCodeMessageTemplate
      )

      if (alreadyRequested) {
        flowMap[String(chatId)] = {
          ...state,
          requestCodeRequested: true,
          active: false,
          updatedAt: nowTs,
        }
        return skipResult(chatId, dealId, 'already_requested_message_found', {
          category,
          gameKey: game.gameKey,
        })
      }

      const invalidEmailMessage = String(state.invalidEmailMessage || '').trim()
      const emailFromChat = String(chatData?.buyerSupercellEmail || '').trim() || null
      const nextState = {
        ...state,
        latestEmail: emailFromChat || state.latestEmail || null,
      }

      let invalidEmailSent = false
      if (!nextState.invalidMessageSent && invalidEmailMessage) {
        await withRetry(
          () => createChatMessage(token, userAgent, chatId, invalidEmailMessage),
          {
            label: 'createChatMessage(supercell-invalid-email)',
            retries: 3,
            shouldRetry: isPlayerokRateLimitError,
          }
        )
        nextState.invalidMessageSent = true
        nextState.updatedAt = nowTs
        flowMap[String(chatId)] = nextState
        invalidEmailSent = true
      }

      const effectiveEmail = String(nextState.latestEmail || '').trim()
      const emailIsValid = isEmailValid(effectiveEmail)
      if (!emailIsValid) {
        flowMap[String(chatId)] = {
          ...nextState,
          updatedAt: nowTs,
        }
        return {
          ran: true,
          action: invalidEmailSent ? 'invalid_email_sent' : 'skipped',
          reason: emailRetryReason || 'email_invalid_or_missing',
          chatId: String(chatId),
          dealId,
          category,
          invalidEmailSent,
        }
      }

      // ПЕРСИСТ ПОЧТЫ: autolist добыл валидную почту — сохраняем её в БД СРАЗУ (до запроса кода),
      // чтобы чат показал почту даже если запрос кода упадёт. Раньше autolist почту НЕ персистил,
      // и у новой Supercell-сделки в чате почта не появлялась (чат читает БД). UPSERT в
      // setDealSupercellEmail создаёт строку chat_deals, если её ещё нет (гонка с синком).
      if (chatDbRepo && typeof chatDbRepo.setDealSupercellEmail === 'function' && currentUserId != null) {
        try { chatDbRepo.setDealSupercellEmail(currentUserId, effectiveDealId, effectiveEmail) } catch (_) {}
      }

      logSupercellDebug('flow:requestingCode', {
        chatId,
        dealId,
        category,
        gameKey: game.gameKey,
        emailDomain: effectiveEmail.includes('@') ? effectiveEmail.split('@')[1] : null,
      })

      await requestSupercellCodeForChat({
        token,
        userAgent,
        dealId,
        chatId,
        email: effectiveEmail,
        category,
        requestCodeMessageTemplate,
      })

      flowMap[String(chatId)] = {
        ...nextState,
        category,
        latestEmail: effectiveEmail,
        requestCodeRequested: true,
        active: false,
        updatedAt: nowTs,
      }

      logSupercellDebug('flow:codeRequestedOk', { chatId, category, gameKey: game.gameKey })
      return {
        ran: true,
        action: 'code_requested',
        reason: null,
        chatId: String(chatId),
        dealId,
        category,
        gameKey: game.gameKey,
      }
    } catch (err) {
      return {
        ran: true,
        action: 'error',
        reason: err?.message || String(err),
        chatId: String(chatId),
        dealId,
        category,
      }
    }
  }
}

module.exports = { createProcessSingleSupercellFlow }
