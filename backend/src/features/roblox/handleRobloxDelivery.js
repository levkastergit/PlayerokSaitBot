'use strict'

const roblox = require('../../integrations/roblox/robloxClient')

// Из ссылки/строки вытаскиваем числовой ID гейм-пасса.
// Поддержка: "123456", "https://www.roblox.com/game-pass/123456/Name", "?gamePassId=123456".
function parseGamePassId(input) {
  const raw = String(input || '').trim()
  if (!raw) return null
  if (/^\d+$/.test(raw)) return Number(raw)
  const byPath = raw.match(/game-pass\/(\d+)/i)
  if (byPath) return Number(byPath[1])
  const byQuery = raw.match(/gamePassId=(\d+)/i)
  if (byQuery) return Number(byQuery[1])
  const anyNum = raw.match(/(\d{4,})/)
  return anyNum ? Number(anyNum[1]) : null
}

// Данные гейм-пасса для предпросмотра перед выдачей (цена/продавец/в продаже ли).
async function handleRobloxGamepassInfo({ payload }) {
  const gamePassId = parseGamePassId(payload && payload.gamePass)
  if (!gamePassId) {
    return { statusCode: 400, data: { ok: false, error: 'Укажите ID или ссылку на гейм-пасс' } }
  }
  try {
    const info = await roblox.getGamePassProductInfo(gamePassId)
    return { statusCode: 200, data: { ok: true, info } }
  } catch (err) {
    const code = err && err.code
    const status = code === 'GAMEPASS_NOT_FOUND' || code === 'BAD_GAMEPASS' ? 404 : 502
    return { statusCode: status, data: { ok: false, error: err && err.message ? err.message : 'Ошибка запроса' } }
  }
}

// Тестовая выдача: выбранный аккаунт покупает гейм-пасс покупателя = перевод Robux.
async function handleRobloxDeliverTest({ payload, currentUserId, deps }) {
  const { robloxAccountsRepo } = deps

  const accountId = payload && payload.accountId != null ? Number(payload.accountId) : null
  const gamePassId = parseGamePassId(payload && payload.gamePass)
  const maxPriceRaw = payload && payload.maxPrice != null ? Number(payload.maxPrice) : null

  if (!Number.isFinite(accountId)) {
    return { statusCode: 400, data: { ok: false, error: 'Выберите аккаунт для выдачи' } }
  }
  if (!gamePassId) {
    return { statusCode: 400, data: { ok: false, error: 'Укажите ID или ссылку на гейм-пасс' } }
  }

  const account = robloxAccountsRepo.getAccount(currentUserId, accountId)
  if (!account) {
    return { statusCode: 404, data: { ok: false, error: 'Аккаунт не найден' } }
  }
  const cookie = robloxAccountsRepo.getAccountCookie(currentUserId, accountId)
  if (!cookie) {
    return { statusCode: 400, data: { ok: false, error: 'У аккаунта нет cookie' } }
  }

  let info
  try {
    info = await roblox.getGamePassProductInfo(gamePassId)
  } catch (err) {
    const code = err && err.code
    const status = code === 'GAMEPASS_NOT_FOUND' || code === 'BAD_GAMEPASS' ? 404 : 502
    return { statusCode: status, data: { ok: false, error: err && err.message ? err.message : 'Ошибка запроса гейм-пасса' } }
  }

  if (info.productId == null || info.sellerId == null || info.priceInRobux == null) {
    return { statusCode: 422, data: { ok: false, error: 'У гейм-пасса нет цены/продавца — он не настроен для продажи', info } }
  }
  if (info.isForSale === false || info.priceInRobux <= 0) {
    return { statusCode: 422, data: { ok: false, error: 'Гейм-пасс не выставлен на продажу', info } }
  }
  if (Number.isFinite(maxPriceRaw) && info.priceInRobux > maxPriceRaw) {
    return {
      statusCode: 422,
      data: {
        ok: false,
        error: `Цена гейм-пасса ${info.priceInRobux} R$ выше лимита ${maxPriceRaw} R$`,
        info,
      },
    }
  }
  if (Number(info.sellerId) === Number(account.robloxUserId)) {
    return { statusCode: 422, data: { ok: false, error: 'Нельзя купить собственный гейм-пасс', info } }
  }
  if (account.robux != null && account.robux < info.priceInRobux) {
    return {
      statusCode: 422,
      data: {
        ok: false,
        error: `Недостаточно Robux: на аккаунте ${account.robux}, нужно ${info.priceInRobux}`,
        info,
      },
    }
  }

  let result
  try {
    result = await roblox.purchaseProduct(cookie, {
      productId: info.productId,
      expectedPrice: info.priceInRobux,
      expectedSellerId: info.sellerId,
    })
  } catch (err) {
    return { statusCode: 502, data: { ok: false, error: err && err.message ? err.message : 'Ошибка покупки', info } }
  }

  // После покупки обновляем баланс аккаунта (best-effort).
  let updatedAccount = account
  try {
    const robux = await roblox.getRobuxBalance(cookie, account.robloxUserId)
    updatedAccount = robloxAccountsRepo.updateAccountState(currentUserId, accountId, {
      username: account.username,
      displayName: account.displayName,
      robux,
      isPremium: account.isPremium,
      avatarUrl: account.avatarUrl,
      status: 'active',
      lastError: null,
    })
  } catch (_) {
    // ignore balance refresh errors
  }

  return {
    statusCode: 200,
    data: {
      ok: result.purchased,
      purchased: result.purchased,
      reason: result.reason || null,
      price: result.price != null ? result.price : info.priceInRobux,
      info,
      account: updatedAccount,
    },
  }
}

module.exports = {
  parseGamePassId,
  handleRobloxGamepassInfo,
  handleRobloxDeliverTest,
}
