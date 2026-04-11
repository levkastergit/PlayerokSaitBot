const { pickSupercellCategoryFromDeal } = require('../../../functions/supercellHelpers')

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
      const fullDeal = await requestDealById(token, userAgent, dealId)
      const picked = pickSupercellCategoryFromDeal(fullDeal)
      if (picked && getSupercellGameByCategory(picked)) category = picked
    } catch (_) {
      // оставляем category с клиента
    }
  }

  if (!getSupercellGameByCategory(category)) {
    return { statusCode: 400, data: { error: 'Категория не поддерживает запрос кода Supercell' } }
  }

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
    return {
      statusCode: 500,
      data: {
        error: err && err.message ? String(err.message) : 'Не удалось запросить код Supercell',
      },
    }
  }
}

module.exports = { handleRequestSupercellCode }

