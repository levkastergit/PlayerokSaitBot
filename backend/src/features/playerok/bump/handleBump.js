const crypto = require('crypto')

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
    isPlayerokRateLimitError,
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
  const tokenHash = token
  const reqId = crypto.randomBytes(6).toString('hex')

  console.info('[bump] старт', {
    reqId,
    tokenHash,
    productKey: String(productKey),
    itemId: String(itemId),
    productTitle: String(productTitle),
  })

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
        console.info('[bump] текущая цена обновлена (rawPrice для статусов)', {
          reqId,
          itemId,
          oldPrice: requestedPrice ?? 0,
          currentPrice,
          discountedPrice: currentItem.price,
          rawPrice: currentItem.rawPrice,
        })
      }
    }
  } catch (err) {
    console.warn('[bump] не удалось получить текущую цену', {
      reqId,
      itemId,
      error: err?.message,
      usingProvidedPrice: currentPrice,
    })
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
      console.warn('[bump] не найден допустимый priorityStatusId', {
        reqId,
        itemId,
        productKey: String(productKey || ''),
        availableStatuses: list.map((s) => ({ id: s?.id, price: s?.price })),
        requestedPriorityStatusId: userPriorityStatusId,
      })
      return {
        statusCode: 400,
        data: { error: 'Не удалось определить статус поднятия для товара', reqId },
      }
    }
  } catch (fetchErr) {
    console.warn('[bump] ошибка получения статусов', { reqId, itemId, error: fetchErr?.message })
    return {
      statusCode: 500,
      data: {
        error: fetchErr && fetchErr.message ? String(fetchErr.message) : 'Не удалось получить статусы поднятия',
        reqId,
      },
    }
  }

  try {
    const item = await increaseItemPriorityStatus(token, userAgent, itemId, {
      priorityStatusId,
      transactionProviderId,
      paymentMethodId,
    })

    const paymentURL = item?.statusPayment?.props?.paymentURL || null
    const statusDescription = item?.statusPayment?.statusDescription || null
    const status = item?.statusPayment?.status || null
    const price =
      typeof item?.priorityPrice === 'number'
        ? item.priorityPrice
        : typeof item?.statusPayment?.value === 'number'
          ? item.statusPayment.value
          : requestedPrice != null
            ? requestedPrice
            : 0

    if (paymentURL) {
      console.warn('[bump] требуется оплата', {
        reqId,
        tokenHash,
        productKey: String(productKey),
        itemId: String(itemId),
        priorityStatusId: String(priorityStatusId),
        transactionProviderId: String(transactionProviderId),
        status,
        statusDescription,
        paymentURL,
        price: Number(price) || 0,
      })
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
    console.info('[bump] успех', {
      reqId,
      tokenHash,
      productKey: String(productKey),
      itemId: String(itemId),
      priorityStatusId: String(priorityStatusId),
      transactionProviderId: String(transactionProviderId),
      bumpedAt,
      price: Number(price) || 0,
      status,
      statusDescription,
    })

    return { statusCode: 200, data: { ok: true, bumpedAt, price: Number(price) || 0 } }
  } catch (err) {
    const msg = err && err.message ? String(err.message) : String(err)
    const isInvalidBooster = msg.includes('некорректных бустеров') || msg.includes('BAD_REQUEST')

    console.warn('[bump] ошибка', {
      reqId,
      tokenHash,
      productKey: String(productKey),
      itemId: String(itemId),
      priorityStatusId: String(priorityStatusId),
      transactionProviderId: String(transactionProviderId),
      error: msg,
      isInvalidBooster,
    })

    if (isInvalidBooster) {
      // Если статус невалидный, пытаемся получить свежий список и повторить с другим доступным статусом
      try {
        const statuses = await fetchItemPriorityStatuses(token, userAgent, itemId, requestedPrice ?? 0)
        const list = Array.isArray(statuses) ? statuses : []
        console.warn('[bump] некорректный бустер — повтор со свежими статусами', {
          reqId,
          productKey: String(productKey),
          itemId: String(itemId),
          usedPriorityStatusId: String(priorityStatusId),
          availableStatuses: list.map((s) => ({ id: s?.id, price: s?.price, name: s?.name })),
        })

        if (list.length > 0) {
          const otherStatuses = list.filter((s) => String(s?.id || '') !== String(priorityStatusId))

          if (otherStatuses.length === 0) {
            console.warn('[bump] все доступные статусы недействительны', {
              reqId,
              productKey: String(productKey),
              itemId: String(itemId),
              availableStatuses: list.map((s) => ({ id: s?.id, price: s?.price, name: s?.name })),
            })
          } else {
            for (const statusOption of otherStatuses) {
              const retryStatusId = statusOption?.id
              if (!retryStatusId || String(retryStatusId) === String(priorityStatusId)) continue

              console.info('[bump] повтор с другим статусом', {
                reqId,
                oldPriorityStatusId: String(priorityStatusId),
                newPriorityStatusId: String(retryStatusId),
              })

              try {
                const item = await increaseItemPriorityStatus(token, userAgent, itemId, {
                  priorityStatusId: retryStatusId,
                  transactionProviderId,
                  paymentMethodId,
                })

                const paymentURL = item?.statusPayment?.props?.paymentURL || null
                const statusDescription = item?.statusPayment?.statusDescription || null
                const status = item?.statusPayment?.status || null
                const price =
                  typeof item?.priorityPrice === 'number'
                    ? item.priorityPrice
                    : typeof item?.statusPayment?.value === 'number'
                      ? item.statusPayment.value
                      : requestedPrice != null
                        ? requestedPrice
                        : 0

                if (paymentURL) {
                  console.warn('[bump] требуется оплата (повтор)', {
                    reqId,
                    tokenHash,
                    productKey: String(productKey),
                    itemId: String(itemId),
                    priorityStatusId: String(retryStatusId),
                    transactionProviderId: String(transactionProviderId),
                    status,
                    statusDescription,
                    paymentURL,
                    price: Number(price) || 0,
                  })
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

                console.info('[bump] успех (повтор)', {
                  reqId,
                  tokenHash,
                  productKey: String(productKey),
                  itemId: String(itemId),
                  priorityStatusId: String(retryStatusId),
                  transactionProviderId: String(transactionProviderId),
                  bumpedAt,
                  price: Number(price) || 0,
                  status,
                  statusDescription,
                })

                return { statusCode: 200, data: { ok: true, bumpedAt, price: Number(price) || 0 } }
              } catch (retryErr) {
                const retryMsg = retryErr && retryErr.message ? String(retryErr.message) : String(retryErr)
                const isRetryInvalidBooster =
                  retryMsg.includes('некорректных бустеров') || retryMsg.includes('BAD_REQUEST')

                console.warn('[bump] повтор не удался', {
                  reqId,
                  retryStatusId: String(retryStatusId),
                  error: retryMsg,
                  isRetryInvalidBooster,
                })

                if (!isRetryInvalidBooster) {
                  break
                }
              }
            }
          }
        }
      } catch (fetchErr) {
        console.warn('[bump] не удалось получить свежие статусы для повтора', { reqId, error: fetchErr?.message })
      }
    }

    return { statusCode: 500, data: { error: msg, reqId } }
  }
}

module.exports = { handleBump }

