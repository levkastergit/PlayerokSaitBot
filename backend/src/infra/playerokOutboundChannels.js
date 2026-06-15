'use strict'

/** Значение в bindings: категория отключена, запросы к Playerok для неё не выполняются. */
const PLAYEROK_OUTBOUND_DISABLED = '__disabled__'

/**
 * Значение в bindings: категория крутит исходящий IP по кругу (round-robin) из пула
 * доступных IPv4 сервера. Помогает против 429 — соседние запросы уходят с разных IP,
 * а повтор после 429 берёт другой IP (см. playerokOutboundRotation).
 */
const PLAYEROK_OUTBOUND_ROTATE = '__rotate__'

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

function isOutboundRotateBindingValue(v) {
  return String(v || '').trim() === PLAYEROK_OUTBOUND_ROTATE
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
    if (isOutboundRotateBindingValue(trimmed)) {
      out[ch.id] = PLAYEROK_OUTBOUND_ROTATE
      continue
    }
    out[ch.id] = trimmed
  }
  return out
}

const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/

/** Конфиг ротации IP (на пользователя): { enabled, excludedIps }.
 *  enabled=true → категории на «Автовыборе» («») тоже крутят IP по пулу, как при
 *  значении __rotate__. excludedIps — IP, вручную исключённые из пула ротации
 *  пользователем (не участвуют в чередовании, пока их не вернут обратно). */
function normalizeRotationConfig(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const seen = new Set()
  const excludedIps = []
  if (Array.isArray(src.excludedIps)) {
    for (const v of src.excludedIps) {
      const ip = String(v || '').trim()
      if (!ip || seen.has(ip) || !IPV4_RE.test(ip)) continue
      seen.add(ip)
      excludedIps.push(ip)
    }
  }
  return { enabled: Boolean(src.enabled), excludedIps }
}

module.exports = {
  PLAYEROK_OUTBOUND_DISABLED,
  PLAYEROK_OUTBOUND_ROTATE,
  PLAYEROK_OUTBOUND_CHANNELS,
  CHANNEL_IDS,
  isValidOutboundChannelId,
  isOutboundDisabledBindingValue,
  isOutboundRotateBindingValue,
  normalizeOutboundBindings,
  normalizeRotationConfig,
}
