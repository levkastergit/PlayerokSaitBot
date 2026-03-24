async function handleRequestWithdrawal({ payload, currentUserId, deps }) {
  const { getTokenFromBodyOrStored, requestWithdrawal } = deps
  const { token } = getTokenFromBodyOrStored(currentUserId, payload)
  const userAgent = payload.userAgent
  const providerId = payload.providerId || payload.provider
  const account = payload.account
  const value = Number(payload.value)

  if (!token || !providerId || !account || !Number.isFinite(value) || value <= 0) {
    return { statusCode: 400, data: { error: 'token, providerId, account, value are required' } }
  }

  try {
    const transaction = await requestWithdrawal(token, userAgent, {
      providerId,
      account,
      value,
      paymentMethodId: payload.paymentMethodId || null,
      sbpBankMemberId: payload.sbpBankMemberId || null,
    })
    return { statusCode: 200, data: { ok: true, transaction } }
  } catch (err) {
    return { statusCode: 500, data: { error: err?.message || 'Не удалось создать вывод средств' } }
  }
}

module.exports = { handleRequestWithdrawal }
