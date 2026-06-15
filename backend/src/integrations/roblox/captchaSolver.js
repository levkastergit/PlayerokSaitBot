'use strict'

// Подключаемый солвер Arkose/FunCaptcha для логина Roblox.
// Логин Roblox почти всегда требует FunCaptcha (public key 476068BF-9607-4799-B53D-966BE98E2B81,
// host roblox-api.arkoselabs.com). Надёжно решать его в масштабе можно только платным сервисом
// (Capsolver/2Captcha) + резидентные прокси. Здесь — интерфейс, а не встроенный обход:
// ключ и провайдер берутся из настроек; без них логин честно отдаёт «нужен солвер».
//
// Реальная интеграция провайдера добавляется в Фазе 3. Сейчас это заглушка с чётким контрактом,
// чтобы остальной флоу логина/2FA собирался и работал для аккаунтов без капчи.

const ROBLOX_LOGIN_ARKOSE_PUBLIC_KEY = '476068BF-9607-4799-B53D-966BE98E2B81'

/**
 * @param {object} opts
 * @param {string} opts.provider  'capsolver' | '2captcha' | '' (none)
 * @param {string} opts.apiKey
 * @param {string} opts.blob      dataExchangeBlob из метаданных challenge
 * @param {string} [opts.proxy]
 * @returns {Promise<{ok:boolean, token?:string, error?:string}>}
 */
async function solveLoginFunCaptcha({ provider, apiKey, blob, proxy } = {}) {
  if (!provider || !apiKey) {
    return { ok: false, error: 'CAPTCHA_SOLVER_NOT_CONFIGURED' }
  }
  // TODO (Фаза 3): реальный вызов провайдера (Capsolver/2Captcha) с publicKey=ROBLOX_LOGIN_ARKOSE_PUBLIC_KEY,
  // siteURL=https://www.roblox.com, data.blob=blob, прокси=proxy; вернуть полученный captchaToken.
  return { ok: false, error: `CAPTCHA_PROVIDER_NOT_IMPLEMENTED:${provider}` }
}

module.exports = { ROBLOX_LOGIN_ARKOSE_PUBLIC_KEY, solveLoginFunCaptcha }
