'use strict'

function describeApprouteFailure(result) {
  if (!result || result.ok) return null

  const explicit = result.error != null ? String(result.error).trim() : ''
  if (explicit) return explicit

  switch (result.reason) {
    case 'delivery_pending':
      return 'Заказ в AppRoute принят, выдача ещё готовится. Подождите 1–2 минуты и нажмите «Рескан Api» снова.'
    case 'empty_delivery':
      return 'AppRoute не вернул текст выдачи. Проверьте заказ в кабинете AppRoute и настройки услуги/номинала.'
    case 'masked_delivery':
      return 'AppRoute вернул только маскированный PIN по API. Полный код для отправки в чат через API недоступен.'
    case 'no_api_key':
      return 'Укажите API-ключ AppRoute в настройках аккаунта.'
    case 'no_service_id':
      return 'В настройках товара не указана услуга AppRoute.'
    case 'no_variant_id':
      return 'В настройках товара не указан номинал AppRoute.'
    case 'order_failed':
      return 'Не удалось создать или получить заказ в AppRoute.'
    case 'deal_finished':
      return 'Сделка уже завершена или отменена.'
    case 'item_sent':
      return 'По статусу сделки товар уже отмечен как отправленный.'
    case 'delivery_marker':
      return 'В чате уже есть маркер отправки товара.'
    case 'deal_state':
      return 'Автовыдача пропущена из‑за статуса сделки.'
    default:
      if (result.skipped && result.reason) {
        return `Автовыдача пропущена: ${result.reason}`
      }
      if (result.reason) {
        return `Автовыдача Api не выполнена (${result.reason})`
      }
      return 'Автовыдача Api не выполнена'
  }
}

module.exports = { describeApprouteFailure }
