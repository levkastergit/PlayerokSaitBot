'use strict'

// Протокол Windows-воркера: опрос очереди и отчёт о шагах. Воркер — доверенная инфраструктура
// (ваша Windows-машина), аутентификация по общему секрету X-Worker-Token (см. dispatchRoblox).
//
// При захвате заказа воркеру отдаются СЕКРЕТЫ, нужные для выполнения покупки:
//   - cookie .ROBLOSECURITY покупателя (куда зачисляем Robux),
//   - учётные данные Microsoft-аккаунта (чем оплачиваем в MS Store),
//   - количество Robux.
// Это осознанно: иначе воркер не сможет провести покупку. Канал — HTTPS + секретный токен.

// Воркер забирает следующий готовый заказ.
async function handleWorkerPoll({ workerId, deps }) {
  const { robloxOrdersRepo, robloxAccountsRepo, microsoftAccountsRepo } = deps
  const order = robloxOrdersRepo.claimNextReady(workerId || 'worker')
  if (!order) return { statusCode: 200, data: { ok: true, order: null } }

  const buyerCookie = order.buyerAccountId
    ? robloxAccountsRepo.getAccountCookie(order.userId, order.buyerAccountId)
    : null
  const msCreds = order.microsoftAccountId
    ? microsoftAccountsRepo.getAccountCreds(order.userId, order.microsoftAccountId)
    : null
  const msAccount = order.microsoftAccountId
    ? microsoftAccountsRepo.getAccount(order.userId, order.microsoftAccountId)
    : null

  robloxOrdersRepo.workerReport(order.id, {
    status: 'claimed',
    phase: 'claimed',
    logMessage: `Заказ взят воркером ${workerId || 'worker'}`,
  })

  return {
    statusCode: 200,
    data: {
      ok: true,
      order: {
        id: order.id,
        publicId: order.publicId,
        robuxAmount: order.robuxAmount,
        buyerUsername: order.buyerUsername,
        buyerCookie: buyerCookie || null,
        microsoft: msAccount
          ? { id: msAccount.id, email: msAccount.email, region: msAccount.region, creds: msCreds || null }
          : null,
      },
    },
  }
}

// Воркер отчитывается о шаге/итоге заказа.
async function handleWorkerReport({ payload, deps }) {
  const { robloxOrdersRepo } = deps
  const id = payload && payload.orderId != null ? Number(payload.orderId) : null
  if (!Number.isFinite(id)) return { statusCode: 400, data: { ok: false, error: 'Не передан orderId' } }
  const status = payload && payload.status != null ? String(payload.status) : undefined
  const phase = payload && payload.phase != null ? String(payload.phase) : undefined
  const lastError = payload && payload.error != null ? String(payload.error) : undefined
  const logMessage = payload && payload.message != null ? String(payload.message) : undefined
  const order = robloxOrdersRepo.workerReport(id, { status, phase, lastError, logMessage })
  if (!order) return { statusCode: 404, data: { ok: false, error: 'Заказ не найден' } }
  return { statusCode: 200, data: { ok: true, order: { id: order.id, status: order.status, phase: order.phase } } }
}

module.exports = { handleWorkerPoll, handleWorkerReport }
