'use strict'

const { logSupercellDebug } = require('./supercellHelpers')

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
}) {
  const EMAIL_FETCH_RETRIES = 2
  const EMAIL_FETCH_DELAY_MS = 1200

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  return async function processSingleSupercellFlow(chatId, token, userAgent, viewerUsername, nowTs) {
    const tokenHash = token
    const flowMap = autolistGetSupercellFlowMap(tokenHash)
    const state = flowMap[String(chatId)]
    if (!state || !state.active) return false

    let category = String(state.category || '').trim()
    logSupercellDebug('flow:start', {
      chatId,
      dealId: state.dealId || null,
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
          state.dealId || null,
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
          console.warn('[processSingleSupercellFlow] повтор получения email', {
            reason: emailRetryReason,
            chatId,
            dealId: state.dealId || null,
            attempt: emailFetchAttempt + 1,
            maxAttempts: EMAIL_FETCH_RETRIES + 1,
            category,
          })
          await sleep(EMAIL_FETCH_DELAY_MS * (emailFetchAttempt + 1))
        }
      }

      const game = getSupercellGameByCategory(category)
      if (!game) {
        console.warn('[processSingleSupercellFlow] пропуск: категория не Supercell', {
          chatId,
          category,
          categoryFromState: state.category,
          itemCategoryFromFetch: chatData?.itemCategory || null,
          dealId: state.dealId || null,
        })
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
        return false
      }

      const messages = Array.isArray(chatData?.messages) ? chatData.messages : []

      const alreadyRequested = hasSupercellCodeRequestedMessage(
        messages,
        viewerUsername || null,
        game.gameName
      )

      if (alreadyRequested) {
        console.warn('[processSingleSupercellFlow] пропуск', {
          reason: 'already_requested_message_found',
          chatId,
          dealId: state.dealId || null,
          category,
          gameName: game.gameName,
        })
        flowMap[String(chatId)] = {
          ...state,
          requestCodeRequested: true,
          active: false,
          updatedAt: nowTs,
        }
        return false
      }

      const invalidEmailMessage = String(state.invalidEmailMessage || '').trim()
      // Используем email из чата/сделки; если в chatData нет — берём из state (был сохранён при создании flow из полей сделки)
      const emailFromChat = String(chatData?.buyerSupercellEmail || '').trim() || null
      const nextState = {
        ...state,
        latestEmail: emailFromChat || state.latestEmail || null,
      }

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
      }

      const effectiveEmail = String(nextState.latestEmail || '').trim()
      const emailIsValid = isEmailValid(effectiveEmail)
      if (!emailIsValid) {
        console.warn('[processSingleSupercellFlow] пропуск: нет или неверный email', {
          reason: emailRetryReason || 'email_invalid_or_missing',
          chatId,
          dealId: state.dealId || null,
          category,
          emailFetchAttempts: emailFetchAttempt + 1,
          hasEmailFromChat: Boolean(emailFromChat),
          hasEmailInState: Boolean(state.latestEmail),
        })
        flowMap[String(chatId)] = {
          ...nextState,
          updatedAt: nowTs,
        }
        return false
      }

      logSupercellDebug('flow:requestingCode', {
        chatId,
        dealId: state.dealId || null,
        category,
        gameKey: game.gameKey,
        emailDomain: effectiveEmail.includes('@') ? effectiveEmail.split('@')[1] : null,
      })

      await requestSupercellCodeForChat({
        token,
        userAgent,
        dealId: state.dealId || null,
        chatId,
        email: effectiveEmail,
        category,
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
      return true
    } catch (err) {
      console.warn('[processSingleSupercellFlow] ошибка', {
        reason: 'supercell_request_flow_failed',
        chatId,
        dealId: state.dealId || null,
        category,
        error: err?.message || String(err),
      })
      return false
    }
  }
}

module.exports = { createProcessSingleSupercellFlow }

