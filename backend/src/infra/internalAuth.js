'use strict'

const crypto = require('crypto')

// Секрет для аутентификации ВНУТРЕННИХ self-call'ов (postLocal → собственный HTTP-сервер).
// Генерируется в памяти при старте процесса: postLocal и обработчик — один и тот же процесс,
// поэтому общий секрет доступен обоим через require этого модуля, без env и без БД.
//
// Зачем: фоновые задачи (autolist-tick, прогрев чатов, deal-chat-messages) ходят на свой же
// сервер и передают userId/token в теле. Доверять этому по source-IP (127.0.0.1) НЕЛЬЗЯ —
// nginx (network_mode:host) проксирует внешние запросы тоже с 127.0.0.1. Поэтому «доверенным»
// считаем только запрос с правильным X-Internal-Secret (его ставит postLocal; внешний клиент
// через nginx его подделать не может — секрет только в памяти процесса).
const INTERNAL_SECRET = crypto.randomBytes(32).toString('hex')

function getInternalSecret() {
  return INTERNAL_SECRET
}

function isTrustedInternalRequest(req) {
  const h = req && req.headers ? req.headers['x-internal-secret'] : ''
  const provided = typeof h === 'string' ? h : ''
  if (provided.length !== INTERNAL_SECRET.length) return false
  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(INTERNAL_SECRET))
  } catch {
    return false
  }
}

module.exports = { getInternalSecret, isTrustedInternalRequest }
