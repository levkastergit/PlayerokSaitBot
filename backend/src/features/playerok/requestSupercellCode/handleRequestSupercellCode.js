const {
  pickSupercellCategoryFromDeal,
  logSupercellDebug,
  getSupercellGameByCategory,
} = require('../../../functions/supercellHelpers')
const { playerokErrorResponse } = require('../../../infra/playerokErrorResponse')
const { withRetry, isPlayerokRateLimitError } = require('../../../infra/retry/withRetry')

async function handleRequestSupercellCode({ payload, currentUserId, deps }) {
  const {
    getTokenFromBodyOrStored,
    getSupercellGameByCategory,
    requestSupercellCodeForChat,
    isSupercellModuleEnabled,
    requestDealById,
  } = deps

  const { token } = getTokenFromBodyOrStored(currentUserId, payload)
  const userAgent = payload.userAgent
  const dealId = payload.dealId || null
  const chatId = payload.chatId || null
  const email = String(payload.email || '').trim()
  let category = String(payload.category || '').trim()

  if (!token) {
    return { statusCode: 400, data: { error: 'token is required' } }
  }
  if (!isSupercellModuleEnabled(currentUserId)) {
    return { statusCode: 403, data: { error: 'Модуль Supercell отключен для пользователя' } }
  }
  if (!dealId && !chatId) {
    return { statusCode: 400, data: { error: 'dealId or chatId is required' } }
  }
  if (!email) {
    return { statusCode: 400, data: { error: 'email is required' } }
  }

  if (!getSupercellGameByCategory(category) && dealId && typeof requestDealById === 'function') {
    try {
      const fullDeal = await withRetry(() => requestDealById(token, userAgent, dealId), {
        retries: 3,
        shouldRetry: isPlayerokRateLimitError,
        label: 'requestSupercellCode:resolveCategory',
      })
      const picked = pickSupercellCategoryFromDeal(fullDeal)
      if (picked && getSupercellGameByCategory(picked)) category = picked
    } catch (_) {
      // оставляем category с клиента
    }
  }

  if (!getSupercellGameByCategory(category)) {
    logSupercellDebug('requestSupercellCode:rejectCategory', {
      dealId,
      chatId,
      categoryFromClient: payload.category || null,
      categoryResolved: category,
    })
    return { statusCode: 400, data: { error: 'Категория не поддерживает запрос кода Supercell' } }
  }

  logSupercellDebug('requestSupercellCode:start', {
    dealId,
    chatId,
    category,
    emailDomain: email.includes('@') ? email.split('@')[1] : null,
  })

  try {
    const result = await requestSupercellCodeForChat({
      token,
      userAgent,
      dealId,
      chatId,
      email,
      category,
    })
    return { statusCode: 200, data: result }
  } catch (err) {
    return playerokErrorResponse(err, 'Не удалось запросить код Supercell')
  }
}

module.exports = { handleRequestSupercellCode }

