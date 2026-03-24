// Logger middleware: перехватывает console.log/warn/error и складывает последние записи в буфер.
// Буфер используется в endpoint `GET /api/logs`.
const LOGS_BUFFER_SIZE = 10000
const logsBuffer = []

let initialized = false

function addLogToBuffer(level, args) {
  const timestamp = new Date().toISOString()

  // Определяем тег из первого аргумента, если он есть
  let tag = level
  let messageParts = []
  let rawObject = null

  if (args.length > 0) {
    // Если первый аргумент - строка с тегом [tag]
    if (typeof args[0] === 'string' && args[0].startsWith('[') && args[0].includes(']')) {
      const match = args[0].match(/^\[([^\]]+)\]/)
      if (match) {
        tag = match[1]
        const restOfFirstArg = args[0].substring(match[0].length).trim()
        if (restOfFirstArg) {
          messageParts.push(restOfFirstArg)
        }
      } else {
        messageParts.push(args[0])
      }
    } else {
      messageParts.push(String(args[0]))
    }

    // Обрабатываем остальные аргументы
    for (let i = 1; i < args.length; i++) {
      const arg = args[i]
      if (typeof arg === 'object' && arg !== null) {
        // Если это объект, сохраняем его как raw для красивого форматирования
        if (rawObject === null) {
          rawObject = arg
        } else {
          // Если уже есть raw объект, объединяем их
          try {
            messageParts.push(JSON.stringify(arg, null, 2))
          } catch {
            messageParts.push(String(arg))
          }
        }
      } else {
        messageParts.push(String(arg))
      }
    }
  }

  // Формируем финальное сообщение
  let message = messageParts.join(' ')
  if (rawObject !== null && messageParts.length === 0) {
    // Если только объект без текста, форматируем его
    try {
      message = JSON.stringify(rawObject, null, 2)
    } catch {
      message = String(rawObject)
    }
  } else if (rawObject !== null) {
    // Если есть и текст, и объект, добавляем объект в конец
    try {
      message += '\n' + JSON.stringify(rawObject, null, 2)
    } catch {
      message += ' ' + String(rawObject)
    }
  }

  const logEntry = {
    timestamp,
    level,
    tag,
    message,
    raw: rawObject,
  }

  logsBuffer.push(logEntry)

  // Ограничиваем размер буфера
  if (logsBuffer.length > LOGS_BUFFER_SIZE) {
    logsBuffer.shift()
  }
}

function initLogger() {
  if (initialized) return
  initialized = true

  // Сохраняем оригинальные методы
  const originalConsoleLog = console.log
  const originalConsoleWarn = console.warn
  const originalConsoleError = console.error

  // Перехватываем console.log, console.warn, console.error
  console.log = function (...args) {
    addLogToBuffer('info', args)
    originalConsoleLog.apply(console, args)
  }

  console.warn = function (...args) {
    addLogToBuffer('warn', args)
    originalConsoleWarn.apply(console, args)
  }

  console.error = function (...args) {
    addLogToBuffer('error', args)
    originalConsoleError.apply(console, args)
  }
}

function getLogsBuffer(limit = 1000) {
  const safeLimit = Number.isFinite(limit) ? limit : 1000
  return logsBuffer.slice(-Math.max(0, safeLimit))
}

module.exports = { initLogger, getLogsBuffer, addLogToBuffer }

