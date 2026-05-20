'use strict'

/** Значение в bindings: категория отключена, запросы к Playerok для неё не выполняются. */
const PLAYEROK_OUTBOUND_DISABLED = '__disabled__'

/** Категории исходящих запросов к Playerok — для каждой можно задать свой IPv4. */
const PLAYEROK_OUTBOUND_CHANNELS = [
  {
    id: 'default',
    label: 'По умолчанию',
    hint: 'Если для категории IP не выбран, используется этот адрес.',
  },
  {
    id: 'lots',
    label: 'Лоты и поднятие',
    hint: 'Активные и завершённые лоты, публикация, статусы и bump.',
  },
  {
    id: 'chats',
    label: 'Чаты',
    hint: 'Список чатов, сообщения, отправка в чат, автодоставка.',
  },
  {
    id: 'deals',
    label: 'Сделки',
    hint: 'Сделки в работе, подтверждение, отмена, история продаж.',
  },
  {
    id: 'finance',
    label: 'Финансы',
    hint: 'Баланс, транзакции, вывод, карты.',
  },
  {
    id: 'sync',
    label: 'Профиль и проверки',
    hint: 'Проверка токена, viewer, синхронизация.',
  },
]

const CHANNEL_IDS = new Set(PLAYEROK_OUTBOUND_CHANNELS.map((c) => c.id))

function isValidOutboundChannelId(id) {
  return CHANNEL_IDS.has(String(id || '').trim())
}

function isOutboundDisabledBindingValue(v) {
  return String(v || '').trim() === PLAYEROK_OUTBOUND_DISABLED
}

function normalizeOutboundBindings(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const ch of PLAYEROK_OUTBOUND_CHANNELS) {
    if (!Object.prototype.hasOwnProperty.call(raw, ch.id)) continue
    const v = raw[ch.id]
    if (v == null || v === '') {
      out[ch.id] = ''
      continue
    }
    const trimmed = String(v).trim()
    if (isOutboundDisabledBindingValue(trimmed)) {
      out[ch.id] = PLAYEROK_OUTBOUND_DISABLED
      continue
    }
    out[ch.id] = trimmed
  }
  return out
}

module.exports = {
  PLAYEROK_OUTBOUND_DISABLED,
  PLAYEROK_OUTBOUND_CHANNELS,
  CHANNEL_IDS,
  isValidOutboundChannelId,
  isOutboundDisabledBindingValue,
  normalizeOutboundBindings,
}
