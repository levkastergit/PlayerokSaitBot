const crypto = require('crypto')
const { playerokErrorResponse } = require('../../../infra/playerokErrorResponse')

async function handleBump({
  payload,
  currentUserId,
  deps,
}) {
  const {
    getTokenFromBodyOrStored,
    requestItemById,
    fetchItemPriorityStatuses,
    increaseItemPriorityStatus,
    insertBump,
  } = deps

  const { token } = getTokenFromBodyOrStored(currentUserId, payload)
  const productKey = payload.productKey
  const productTitle = payload.productTitle || 'Товар'
  const itemId = payload.itemId
  const userAgent = payload.userAgent

  const requestedPrice = typeof payload.price === 'number' ? payload.price : null
  const userPriorityStatusId = payload.priorityStatusId || null
  const transactionProviderId = payload.transactionProviderId || 'LOCAL'
  const paymentMethodId = Object.prototype.hasOwnProperty.call(payload, 'paymentMethodId')
    ? payload.paymentMethodId
    : null

  if (!token || !productKey || !itemId) {
    return { statusCode: 400, data: { error: 'token, productKey and itemId are required' } }
  }

  const bumpedAt = Math.floor(Date.now() / 1000)
  const reqId = crypto.randomBytes(6).toString('hex')

  // ВСЕГДА получаем актуальную цену товара перед запросом статусов
  // Для получения статусов поднятия нужно использовать ОРИГИНАЛЬНУЮ цену (rawPrice), а не цену со скидкой
  let currentPrice = requestedPrice ?? 0
  try {
    const currentItem = await requestItemById(token, userAgent, itemId)
    if (currentItem) {
      const itemPrice =
        typeof currentItem.rawPrice === 'number' && currentItem.rawPrice > 0
          ? currentItem.rawPrice
          : typeof currentItem.price === 'number' && currentItem.price > 0
            ? currentItem.price
            : null

      if (itemPrice != null && itemPrice > 0) {
        currentPrice = itemPrice
      }
    }
  } catch (_err) {
    // используем requestedPrice / 0
  }

  // ВСЕГДА получаем актуальный список статусов поднятия
  let priorityStatusId = null
  try {
    const statuses = await fetchItemPriorityStatuses(token, userAgent, itemId, currentPrice)
    const list = Array.isArray(statuses) ? statuses : []
    if (list.length === 0) {
      return {
        statusCode: 400,
        data: {
          error: 'Нет доступных статусов поднятия для этого товара. Проверьте, что товар активен.',
          reqId,
        },
      }
    }

    // Если передан userPriorityStatusId, проверяем его валидность в актуальном списке
    const found = userPriorityStatusId
      ? list.find((s) => String(s?.id || '') === String(userPriorityStatusId))
      : null

    // Используем переданный статус только если он валиден, иначе выбираем из актуального списка
    priorityStatusId = (found || list[0])?.id || null
    if (!priorityStatusId) {
      return {
        statusCode: 400,
        data: { error: 'Не удалось определить статус поднятия для товара', reqId },
      }
    }
  } catch (fetchErr) {
    const resp = playerokErrorResponse(fetchErr, 'Не удалось получить статусы поднятия')
    resp.data.reqId = reqId
    return resp
  }

  try {
    const item = await increaseItemPriorityStatus(token, userAgent, itemId, {
      priorityStatusId,
      transactionProviderId,
      paymentMethodId,
    })

    const paymentURL = item?.statusPayment?.props?.paymentURL || null
    const statusDescription = item?.statusPayment?.statusDescription || null
    const price =
      typeof item?.priorityPrice === 'number'
        ? item.priorityPrice
        : typeof item?.statusPayment?.value === 'number'
          ? item.statusPayment.value
          : requestedPrice != null
            ? requestedPrice
            : 0

    if (paymentURL) {
      return {
        statusCode: 402,
        data: { error: statusDescription || 'Требуется оплата поднятия', paymentURL },
      }
    }

    // Сохраняем фактическую стоимость поднятия для вкладки "Действия".
    insertBump.run(
      currentUserId,
      String(productKey),
      String(productTitle),
      bumpedAt,
      Number(price) || 0,
      itemId ? String(itemId) : null
    )

    return { statusCode: 200, data: { ok: true, bumpedAt, price: Number(price) || 0 } }
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err)
    const isInvalidBooster = msg.includes('некорректных бустеров') || msg.includes('BAD_REQUEST')

    if (isInvalidBooster) {
      // Если статус невалидный, пытаемся получить свежий список и повторить с другим доступным статусом
      try {
        const statuses = await fetchItemPriorityStatuses(token, userAgent, itemId, requestedPrice ?? 0)
        const list = Array.isArray(statuses) ? statuses : []

        if (list.length > 0) {
          const otherStatuses = list.filter((s) => String(s?.id || '') !== String(priorityStatusId))

          if (otherStatuses.length > 0) {
            for (const statusOption of otherStatuses) {
              const retryStatusId = statusOption?.id
              if (!retryStatusId || String(retryStatusId) === String(priorityStatusId)) continue

              try {
                const item = await increaseItemPriorityStatus(token, userAgent, itemId, {
                  priorityStatusId: retryStatusId,
                  transactionProviderId,
                  paymentMethodId,
                })

                const paymentURL = item?.statusPayment?.props?.paymentURL || null
                const statusDescription = item?.statusPayment?.statusDescription || null
                const price =
                  typeof item?.priorityPrice === 'number'
                    ? item.priorityPrice
                    : typeof item?.statusPayment?.value === 'number'
                      ? item.statusPayment.value
                      : requestedPrice != null
                        ? requestedPrice
                        : 0

                if (paymentURL) {
                  return {
                    statusCode: 402,
                    data: { error: statusDescription || 'Требуется оплата поднятия', paymentURL },
                  }
                }

                // Сохраняем фактическую стоимость поднятия для вкладки "Действия".
                insertBump.run(
                  currentUserId,
                  String(productKey),
                  String(productTitle),
                  bumpedAt,
                  Number(price) || 0,
                  itemId ? String(itemId) : null
                )

                return { statusCode: 200, data: { ok: true, bumpedAt, price: Number(price) || 0 } }
              } catch (retryErr) {
                const retryMsg = retryErr && retryErr.message ? String(retryErr.message) : String(retryErr)
                const isRetryInvalidBooster =
                  retryMsg.includes('некорректных бустеров') || retryMsg.includes('BAD_REQUEST')

                if (!isRetryInvalidBooster) {
                  break
                }
              }
            }
          }
        }
      } catch (_fetchErr) {
        // не удалось получить свежие статусы для повтора
      }
    }

    const resp = playerokErrorResponse(err, msg)
    resp.data.reqId = reqId
    return resp
  }
}

module.exports = { handleBump }
