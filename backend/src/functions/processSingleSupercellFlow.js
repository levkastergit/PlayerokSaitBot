'use strict'

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
  return async function processSingleSupercellFlow(chatId, token, userAgent, viewerUsername, nowTs) {
    const tokenHash = token
    const flowMap = autolistGetSupercellFlowMap(tokenHash)
    const state = flowMap[String(chatId)]
    if (!state || !state.active) return false

    const category = String(state.category || '').trim()
    const game = getSupercellGameByCategory(category)
    if (!game) {
      console.warn('[processSingleSupercellFlow] пропуск: категория не Supercell', { chatId, category })
      flowMap[String(chatId)] = {
        ...state,
        active: false,
        updatedAt: nowTs,
      }
      return false
    }

    try {
      const chatData = await fetchDealChatMessagesFromPlayerok(
        token,
        userAgent,
        state.dealId || null,
        chatId,
        { viewerUsername: viewerUsername || null }
      )
      const messages = Array.isArray(chatData?.messages) ? chatData.messages : []

      const alreadyRequested = hasSupercellCodeRequestedMessage(
        messages,
        viewerUsername || null,
        game.gameName
      )

      if (alreadyRequested) {
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
          chatId,
          dealId: state.dealId || null,
          category,
          hasEmailFromChat: Boolean(emailFromChat),
          hasEmailInState: Boolean(state.latestEmail),
        })
        flowMap[String(chatId)] = {
          ...nextState,
          updatedAt: nowTs,
        }
        return false
      }

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
        latestEmail: effectiveEmail,
        requestCodeRequested: true,
        active: false,
        updatedAt: nowTs,
      }

      return true
    } catch (err) {
      console.warn('[processSingleSupercellFlow] ошибка', {
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

